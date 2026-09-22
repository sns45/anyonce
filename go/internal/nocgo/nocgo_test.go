package nocgo

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// listed is the slice of `go list -json` output this check reads.
type listed struct {
	ImportPath string
	Standard   bool
	CgoFiles   []string
}

// goBinary is the go command that built this test, falling back to whatever go is on PATH.
func goBinary(t *testing.T) string {
	t.Helper()
	//nolint:staticcheck // SA1019: the toolchain that built the test is the one whose module graph is checked.
	candidate := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	path, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("no go binary under GOROOT or on PATH: %v", err)
	}
	return path
}

// TestNFR_5_NoNonStandardPackageInTheModuleGraphHasCgoFiles walks every package the module builds, its store
// clients and their dependencies included, and fails naming each one outside the standard library that carries
// cgo files. The standard library is excluded because net and os/user ship cgo files that CGO_ENABLED=0
// switches off. The listing runs with cgo enabled, so a dependency's cgo files are visible rather than hidden by
// the build constraints a cgo-free build applies.
func TestNFR_5_NoNonStandardPackageInTheModuleGraphHasCgoFiles(t *testing.T) {
	goCmd := goBinary(t)
	env := append(os.Environ(), "CGO_ENABLED=1")

	gomod := exec.Command(goCmd, "env", "GOMOD")
	gomod.Env = env
	out, err := gomod.Output()
	if err != nil {
		t.Fatalf("go env GOMOD: %v", err)
	}
	modFile := strings.TrimSpace(string(out))
	if modFile == "" || modFile == os.DevNull {
		t.Fatalf("go env GOMOD reported %q, want the module's go.mod", modFile)
	}

	list := exec.Command(goCmd, "list", "-deps", "-json", "./...")
	list.Dir = filepath.Dir(modFile)
	list.Env = env
	var stderr bytes.Buffer
	list.Stderr = &stderr
	stream, err := list.Output()
	if err != nil {
		t.Fatalf("go list -deps -json ./...: %v\n%s", err, stderr.String())
	}

	decoder := json.NewDecoder(bytes.NewReader(stream))
	var offenders []string
	seen := 0
	for {
		var pkg listed
		if err := decoder.Decode(&pkg); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatalf("decode go list output: %v", err)
		}
		seen++
		if !pkg.Standard && len(pkg.CgoFiles) > 0 {
			offenders = append(offenders, pkg.ImportPath+" ("+strings.Join(pkg.CgoFiles, ", ")+")")
		}
	}
	if seen == 0 {
		t.Fatal("go list reported no packages, so nothing was checked")
	}
	if len(offenders) > 0 {
		t.Fatalf("NFR-5: %d non-standard packages carry cgo files:\n%s", len(offenders), strings.Join(offenders, "\n"))
	}
}
