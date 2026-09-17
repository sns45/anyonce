package anyonce

import (
	"crypto/sha256"
	"encoding/hex"
)

// SHA256Hex returns the lowercase hex SHA-256 of b.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// HTTPFingerprint is the D9 default: SHA-256 over method, LF, path, LF, body. The method is hashed as given.
func HTTPFingerprint(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{'\n'})
	h.Write([]byte(path))
	h.Write([]byte{'\n'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// JCSFingerprint is SHA-256 over the RFC 8785 canonical form of v.
func JCSFingerprint(v any) (string, error) {
	canonical, err := Canonicalize(v)
	if err != nil {
		return "", err
	}
	return SHA256Hex(canonical), nil
}
