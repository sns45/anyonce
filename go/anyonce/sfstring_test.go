package anyonce_test

import (
	"errors"
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
}
