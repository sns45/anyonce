package conformance

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
)

// embedded holds go/conformance/vectors, a byte for byte copy of the repository's conformance/vectors kept inside
// the module so the module zip carries it. A parity test fails when the two trees differ.
//
//go:embed vectors
var embedded embed.FS

// DefaultVectors returns every core and profile vector embedded in this package, sorted by id. It works wherever
// the module is used, inside the repository or from the module cache. Options.VectorsDir overrides it in Run.
func DefaultVectors() ([]Vector, error) {
	sub, err := fs.Sub(embedded, "vectors")
	if err != nil {
		return nil, fmt.Errorf("conformance: embedded vectors: %w", err)
	}
	return LoadVectorsFS(sub)
}

// LoadVectors reads every core and profile vector under dir, sorted by id.
func LoadVectors(dir string) ([]Vector, error) {
	return LoadVectorsFS(os.DirFS(dir))
}

// LoadVectorsFS reads every core and profile vector under the core and profile directories of fsys, sorted by id.
func LoadVectorsFS(fsys fs.FS) ([]Vector, error) {
	var vectors []Vector
	for _, tier := range []string{"core", "profile"} {
		entries, err := fs.ReadDir(fsys, tier)
		if err != nil {
			return nil, fmt.Errorf("conformance: read %s: %w", tier, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := fs.ReadFile(fsys, path.Join(tier, entry.Name()))
			if err != nil {
				return nil, fmt.Errorf("conformance: read %s: %w", entry.Name(), err)
			}
			var v Vector
			if err := json.Unmarshal(data, &v); err != nil {
				return nil, fmt.Errorf("conformance: parse %s: %w", entry.Name(), err)
			}
			vectors = append(vectors, v)
		}
	}
	sort.Slice(vectors, func(i, j int) bool { return vectors[i].ID < vectors[j].ID })
	return vectors, nil
}
