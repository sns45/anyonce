package anyonce

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// RedactKey returns the only form of a key that may reach a log line (NFR-2): the first 8 bytes plus an ellipsis.
func RedactKey(key string) string {
	if len(key) > 8 {
		key = key[:8]
	}
	return key + "…"
}

// NewKey returns a fresh UUID version 4 built from crypto/rand (REQ-CORE-5).
func NewKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("anyonce: newKey: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}
