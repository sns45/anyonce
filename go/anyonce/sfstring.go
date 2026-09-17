package anyonce

import (
	"fmt"
	"strings"
)

// ParseSfString parses one RFC 9651 sf-string: a DQUOTE, printable ASCII with backslash escapes for DQUOTE and
// backslash only, and a closing DQUOTE. Surrounding spaces are discarded; anything after the closing quote is an
// error because the key is the whole field value. Errors wrap ErrInvalidKey.
func ParseSfString(input string) (string, error) {
	s := strings.Trim(input, " ")
	if s == "" || s[0] != '"' {
		return "", fmt.Errorf("%w: not an sf-string: missing opening quote", ErrInvalidKey)
	}
	var out strings.Builder
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\':
			i++
			if i >= len(s) {
				return "", fmt.Errorf("%w: unterminated escape", ErrInvalidKey)
			}
			if s[i] != '"' && s[i] != '\\' {
				return "", fmt.Errorf("%w: invalid escape \\%c", ErrInvalidKey, s[i])
			}
			out.WriteByte(s[i])
		case c == '"':
			if i+1 < len(s) {
				return "", fmt.Errorf("%w: trailing characters after the closing quote", ErrInvalidKey)
			}
			return out.String(), nil
		case c < 0x20 || c > 0x7e:
			return "", fmt.Errorf("%w: non-printable or non-ASCII character in sf-string", ErrInvalidKey)
		default:
			out.WriteByte(c)
		}
	}
	return "", fmt.Errorf("%w: unterminated quote", ErrInvalidKey)
}
