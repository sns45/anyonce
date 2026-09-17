package anyonce_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestParseSfString(t *testing.T) {
	ok := []struct{ in, want string }{
		{`"abc"`, "abc"},
		{`"hello world"`, "hello world"},
		{`"foo \"bar\" \\ baz"`, `foo "bar" \ baz`},
		{`"a\"b"`, `a"b`},
		{`""`, ""},
		{`  "padded"  `, "padded"},
	}
	for _, tc := range ok {
		t.Run("REQ-CORE-3: accepts "+tc.in, func(t *testing.T) {
			got, err := anyonce.ParseSfString(tc.in)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	bad := []string{`abc`, ``, `"abc`, `"abc"x`, `"abc";a=1`, `"a\nb"`, `"a\`, "\"café\"", "\"tab\there\"", "\"del\x7f\""}
	for _, in := range bad {
		t.Run("REQ-CORE-3: rejects "+in, func(t *testing.T) {
			if _, err := anyonce.ParseSfString(in); !errors.Is(err, anyonce.ErrInvalidKey) {
				t.Fatalf("want ErrInvalidKey, got %v", err)
			}
		})
	}
	t.Run("REQ-CORE-3: an invalid escape error carries the index and never the escaped character", func(t *testing.T) {
		_, err := anyonce.ParseSfString(`"a\qb"`)
		if err == nil {
			t.Fatal("want an error")
		}
		msg := err.Error()
		if !strings.Contains(msg, "index") {
			t.Fatalf("want the message to contain index, got %q", msg)
		}
		if strings.Contains(msg, "q") {
			t.Fatalf("want the message to never contain the escaped character, got %q", msg)
		}
	})
}
