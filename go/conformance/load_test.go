package conformance

import (
	"bytes"
	"io/fs"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

func TestLoad(t *testing.T) {
	t.Run("REQ-CONF-6: loads every core and profile vector sorted by id with requires and concurrency parsed", func(t *testing.T) {
		vectors, err := DefaultVectors()
		if err != nil {
			t.Fatal(err)
		}
		if len(vectors) != 20 {
			t.Fatalf("got %d vectors", len(vectors))
		}
		for i := 1; i < len(vectors); i++ {
			if vectors[i-1].ID >= vectors[i].ID {
				t.Fatalf("not sorted at %d: %s %s", i, vectors[i-1].ID, vectors[i].ID)
			}
		}
		byID := map[string]Vector{}
		for _, v := range vectors {
			byID[v.ID] = v
		}
		if exp := byID["core/expiry-executes-again"]; len(exp.Requires) != 1 || exp.Requires[0] != "short-ttl" || exp.Steps[1].DelayMs != 2500 {
			t.Fatalf("%+v", exp)
		}
		if c := byID["core/concurrent-409"]; len(c.Steps[1].ConcurrentWith) != 1 || c.Steps[1].ConcurrentWith[0] != "original" || *c.Steps[1].Expect.HandlerInvocations != 1 {
			t.Fatalf("%+v", c)
		}
		retry := byID["core/retry-replays"].Steps[1].Expect
		if retry.BodyEquals == nil || retry.BodyEquals.SameAs != "first" {
			t.Fatalf("%+v", retry)
		}
		ra := byID["profile/retry-after-on-409"].Steps[1].Expect.Headers["Retry-After"]
		if ra.Regex != "^[1-9][0-9]*$" || ra.Exact != nil {
			t.Fatalf("%+v", ra)
		}
		absent := byID["profile/5xx-not-stored"].Steps[1].Expect.Headers["Idempotency-Replayed"]
		if !absent.Absent {
			t.Fatalf("%+v", absent)
		}
		if got := byID["core/get-ignored"].Steps[0].Expect.BodyJSON["count"]; got != float64(0) {
			t.Fatalf("%v", got)
		}
	})
}

// repoVectorsDir is the repository's conformance/vectors, the source of truth that go/conformance/vectors
// copies so the module zip carries (and embeds) the vectors.
const repoVectorsDir = "../../conformance/vectors"

// vectorFiles maps every file under root, by slash separated relative path, to its bytes.
func vectorFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = data
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestREQ_CONF_6_VectorsCopyMatchesRepository(t *testing.T) {
	repo := vectorFiles(t, repoVectorsDir)
	local := vectorFiles(t, "vectors")
	if len(repo) == 0 {
		t.Fatal("no vectors under " + repoVectorsDir)
	}
	for name, want := range repo {
		got, ok := local[name]
		if !ok {
			t.Errorf("go/conformance/vectors/%s is missing; copy conformance/vectors again", name)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("go/conformance/vectors/%s differs from conformance/vectors/%s; copy conformance/vectors again", name, name)
		}
	}
	for name := range local {
		if _, ok := repo[name]; !ok {
			t.Errorf("go/conformance/vectors/%s has no counterpart in conformance/vectors", name)
		}
	}
}

func TestREQ_CONF_6_EmbeddedVectors(t *testing.T) {
	t.Run("REQ-CONF-6: DefaultVectors reads the embedded copy, equal to loading conformance/vectors from disk", func(t *testing.T) {
		embedded, err := DefaultVectors()
		if err != nil {
			t.Fatal(err)
		}
		fromDisk, err := LoadVectors(repoVectorsDir)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(embedded, fromDisk) {
			t.Fatalf("embedded %d vectors differ from the %d on disk", len(embedded), len(fromDisk))
		}
	})
	t.Run("REQ-CONF-6: Options.VectorsDir still overrides the embedded vectors", func(t *testing.T) {
		dir := t.TempDir()
		for _, tier := range []string{"core", "profile"} {
			if err := os.MkdirAll(filepath.Join(dir, tier), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		one := vectorFiles(t, repoVectorsDir)["core/get-ignored.json"]
		if err := os.WriteFile(filepath.Join(dir, "core", "get-ignored.json"), one, 0o600); err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		summary := Run(t, srv.URL, Options{VectorsDir: dir})
		if len(summary.Results) != 1 || summary.Results[0].ID != "core/get-ignored" {
			t.Fatalf("%+v", summary)
		}
	})
}
