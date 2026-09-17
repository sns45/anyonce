package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// DefaultVectorsDir is conformance/vectors at the repository root, resolved from this file's location. Callers
// outside the repository pass Options.VectorsDir.
func DefaultVectorsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "conformance", "vectors")
}

// LoadVectors reads every core and profile vector under dir, sorted by id.
func LoadVectors(dir string) ([]Vector, error) {
	var vectors []Vector
	for _, tier := range []string{"core", "profile"} {
		entries, err := os.ReadDir(filepath.Join(dir, tier))
		if err != nil {
			return nil, fmt.Errorf("conformance: read %s: %w", tier, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, tier, entry.Name()))
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
