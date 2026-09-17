package anyonce_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestValidateKey(t *testing.T) {
	t.Run("REQ-CORE-2: accepts printable ASCII from 1 to 255 bytes", func(t *testing.T) {
		for _, k := range []string{"a", "!~", strings.Repeat("a", anyonce.MaxKeyBytes)} {
			if err := anyonce.ValidateKey(k, false); err != nil {
				t.Fatalf("%q: %v", k, err)
			}
		}
	})
	rejected := map[string]string{
		"empty":                   "",
		"256 bytes":               strings.Repeat("a", 256),
		"space without sf-string": "a b",
		"control char":            "a\x01b",
		"tab":                     "a\tb",
		"DEL":                     "a\x7fb",
		"non-ASCII":               "café",
	}
	for name, key := range rejected {
		t.Run("REQ-CORE-2: rejects "+name, func(t *testing.T) {
			if err := anyonce.ValidateKey(key, false); !errors.Is(err, anyonce.ErrInvalidKey) {
				t.Fatalf("want ErrInvalidKey, got %v", err)
			}
		})
	}
	t.Run("REQ-CORE-2: allows space only when allowSpace is set", func(t *testing.T) {
		if err := anyonce.ValidateKey("a b", true); err != nil {
			t.Fatal(err)
		}
		if err := anyonce.ValidateKey("a b", false); err == nil {
			t.Fatal("expected rejection")
		}
	})
}

func TestParseKey(t *testing.T) {
	cases := []struct {
		name, in string
		syntax   anyonce.Syntax
		want     string
		wantErr  bool
	}{
		{"REQ-CORE-2: lenient accepts a bare token", "abc-123", anyonce.SyntaxLenient, "abc-123", false},
		{"REQ-CORE-2: lenient trims spaces", "  abc  ", anyonce.SyntaxLenient, "abc", false},
		{"REQ-CORE-3: lenient strips quotes and unescapes", `"a\"b"`, anyonce.SyntaxLenient, `a"b`, false},
		{"REQ-CORE-3: lenient keeps a space inside an sf-string", `"with space"`, anyonce.SyntaxLenient, "with space", false},
		{"REQ-CORE-3: strict accepts an sf-string", `"abc"`, anyonce.SyntaxStrict, "abc", false},
		{"REQ-CORE-3: strict rejects a bare token", "abc", anyonce.SyntaxStrict, "", true},
		{"REQ-CORE-3: unterminated quote is invalid in strict", `"abc`, anyonce.SyntaxStrict, "", true},
		{"REQ-CORE-3: unterminated quote is invalid in lenient", `"abc`, anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: empty sf-string is invalid", `""`, anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: 256 byte bare key is invalid", strings.Repeat("a", 256), anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: quoted key over 255 bytes is invalid", `"` + strings.Repeat("a", 256) + `"`, anyonce.SyntaxStrict, "", true},
		{"REQ-CORE-2: surrounding spaces and tabs are optional whitespace and are discarded", "\t abc \t", anyonce.SyntaxLenient, "abc", false},
		{"REQ-CORE-2: other whitespace around the value is not optional whitespace and is rejected", "\x0babc", anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: a non-breaking space around a quoted key is rejected", "\xc2\xa0\"abc\"", anyonce.SyntaxStrict, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := anyonce.ParseKey(tc.in, tc.syntax)
			if tc.wantErr {
				if !errors.Is(err, anyonce.ErrInvalidKey) {
					t.Fatalf("want ErrInvalidKey, got %v", err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
