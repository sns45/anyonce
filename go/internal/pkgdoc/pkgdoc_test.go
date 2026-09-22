package pkgdoc

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// moduleRoot walks up from the test's working directory to the directory holding go.mod.
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no go.mod above the test directory")
		}
		dir = parent
	}
}

// packageDocs parses the non-test Go files of one directory and reports the package name and whether any file
// carries a doc comment of the form pkg.go.dev renders as the package synopsis. A directory with no non-test
// Go file reports an empty name.
func packageDocs(t *testing.T, dir string) (name string, documented bool) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, entry := range entries {
		file := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(file, ".go") || strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, filepath.Join(dir, file), nil, parser.ParseComments|parser.PackageClauseOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", filepath.Join(dir, file), err)
		}
		name = parsed.Name.Name
		if parsed.Doc == nil {
			continue
		}
		want := "Package " + name
		if name == "main" {
			want = "Command "
		}
		if strings.HasPrefix(parsed.Doc.Text(), want) {
			documented = true
		}
	}
	return name, documented
}

// TestREQ_REL_3_EveryPackageHasAPackageDocComment walks the module and requires every package to carry a doc
// comment starting "Package <name>" (or "Command <name>" for a main package), which is what pkg.go.dev renders
// as its synopsis. It skips testdata, hidden and underscore directories, directories holding only tests, and
// any nested module (a directory below the root with a go.mod of its own, such as webhookmw/interop).
func TestREQ_REL_3_EveryPackageHasAPackageDocComment(t *testing.T) {
	root := moduleRoot(t)
	var missing []string
	checked := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		if path != root {
			base := d.Name()
			if base == "testdata" || strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
				return filepath.SkipDir
			}
			if _, err := os.Stat(filepath.Join(path, "go.mod")); err == nil {
				return filepath.SkipDir
			}
		}
		name, documented := packageDocs(t, path)
		if name == "" {
			return nil
		}
		checked++
		if !documented {
			rel, _ := filepath.Rel(root, path)
			missing = append(missing, filepath.ToSlash(rel)+" (package "+name+")")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked == 0 {
		t.Fatal("no package was found, so nothing was checked")
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("REQ-REL-3: %d packages have no package doc comment:\n%s", len(missing), strings.Join(missing, "\n"))
	}
}
