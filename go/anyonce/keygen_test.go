package anyonce_test

import (
	"regexp"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestRedactKey(t *testing.T) {
	t.Run("NFR-2: keeps the first 8 characters and appends an ellipsis", func(t *testing.T) {
		if got := anyonce.RedactKey("8e03978e-40d5-43e8-bc93-6894a57f9324"); got != "8e03978e…" {
			t.Fatalf("got %q", got)
		}
		if got := anyonce.RedactKey("short"); got != "short…" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestNewKey(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	t.Run("REQ-CORE-5: returns a lowercase UUID version 4", func(t *testing.T) {
		k, err := anyonce.NewKey()
		if err != nil || !re.MatchString(k) {
			t.Fatalf("%q %v", k, err)
		}
	})
	t.Run("REQ-CORE-5: 10000 keys are unique", func(t *testing.T) {
		seen := make(map[string]struct{}, 10000)
		for i := 0; i < 10000; i++ {
			k, err := anyonce.NewKey()
			if err != nil {
				t.Fatal(err)
			}
			seen[k] = struct{}{}
		}
		if len(seen) != 10000 {
			t.Fatalf("%d unique", len(seen))
		}
	})
}
