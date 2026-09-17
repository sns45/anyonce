package anyonce

import (
	"fmt"
	"strings"
)

// MaxKeyBytes is the D7 key length limit (a profile choice; the draft sets none).
const MaxKeyBytes = 255

// Syntax selects lenient (bare token or sf-string) or strict (sf-string only) key parsing (D7).
type Syntax string

const (
	SyntaxLenient Syntax = "lenient"
	SyntaxStrict  Syntax = "strict"
)

// ValidateKey enforces REQ-CORE-2: 1 to 255 bytes of printable ASCII (0x21..0x7E); space only when allowSpace.
func ValidateKey(key string, allowSpace bool) error {
	if key == "" {
		return fmt.Errorf("%w: key is empty", ErrInvalidKey)
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if c == 0x20 && allowSpace {
			continue
		}
		if c < 0x21 || c > 0x7e {
			return fmt.Errorf("%w: key contains a character outside printable ASCII at index %d", ErrInvalidKey, i)
		}
	}
	if len(key) > MaxKeyBytes {
		return fmt.Errorf("%w: key exceeds %d bytes", ErrInvalidKey, MaxKeyBytes)
	}
	return nil
}

// trimOWS strips HTTP optional whitespace (space 0x20 and tab 0x09) from both ends of s. Unlike
// strings.TrimSpace, it leaves every other whitespace character in place so ParseKey rejects it
// instead of silently normalizing it away.
func trimOWS(s string) string {
	start := 0
	for start < len(s) && (s[start] == 0x20 || s[start] == 0x09) {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == 0x20 || s[end-1] == 0x09) {
		end--
	}
	return s[start:end]
}

// ParseKey applies D7: lenient accepts a bare token or a quoted sf-string, strict accepts only an sf-string.
// The resulting key must satisfy ValidateKey; space is allowed only inside an sf-string.
func ParseKey(headerValue string, syntax Syntax) (string, error) {
	trimmed := trimOWS(headerValue)
	quoted := strings.HasPrefix(trimmed, `"`)
	if syntax == SyntaxStrict || quoted {
		value, err := ParseSfString(trimmed)
		if err != nil {
			return "", err
		}
		if err := ValidateKey(value, true); err != nil {
			return "", err
		}
		return value, nil
	}
	if err := ValidateKey(trimmed, false); err != nil {
		return "", err
	}
	return trimmed, nil
}
