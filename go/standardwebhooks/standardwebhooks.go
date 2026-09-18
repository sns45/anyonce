// Package standardwebhooks implements the Standard Webhooks signature check (REQ-WH-6). The wire format is
// recorded in docs/reference/anyhook-signing.md: the signed content is "<id>.<timestamp>.<payload>", the MAC is
// HMAC-SHA256, each signature entry is "v1," plus standard base64 of the MAC, entries are space joined, and the
// timestamp must be within the tolerance. It depends only on the standard library.
package standardwebhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SecretPrefix is the optional prefix on a Standard Webhooks secret.
const SecretPrefix = "whsec_"

// DefaultTolerance is the timestamp skew the specification allows.
const DefaultTolerance = 300 * time.Second

// maxTimestampSeconds bounds the header timestamp before it is converted to an int64. Converting a float64
// outside the int64 range is undefined in Go, and any timestamp this far out is outside every tolerance
// anyway, so it is rejected as a skew failure rather than reaching time.Unix.
const maxTimestampSeconds = 1 << 62

// ErrVerification wraps every failure Verify reports. errors.Is against it is the only classification a caller
// gets, and it is the only one a caller should act on: the wrapped message text does name which check failed,
// but it is there for a log line, never for a response body, since telling a sender which check failed hands an
// attacker an oracle.
var ErrVerification = errors.New("standardwebhooks: the signature did not verify")

// ParseSecret strips the whsec_ prefix and decodes the standard base64 remainder. A secret that decodes to zero
// bytes is an error too, matching the TypeScript twin: an empty HMAC key is a configuration mistake, not a key.
func ParseSecret(secret string) ([]byte, error) {
	raw := strings.TrimPrefix(secret, SecretPrefix)
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("standardwebhooks: the secret is not valid base64: %w", err)
	}
	if len(key) == 0 {
		return nil, errors.New("standardwebhooks: the secret is empty")
	}
	return key, nil
}

// Verifier holds one or more secrets, so a rotation is a matter of listing both.
type Verifier struct {
	keys      [][]byte
	tolerance time.Duration
	now       func() time.Time
}

// New builds a verifier over one or more secrets. It fails when a secret does not decode.
func New(secrets ...string) (*Verifier, error) {
	if len(secrets) == 0 {
		return nil, errors.New("standardwebhooks: at least one secret is required")
	}
	keys := make([][]byte, 0, len(secrets))
	for _, s := range secrets {
		key, err := ParseSecret(s)
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return &Verifier{keys: keys, tolerance: DefaultTolerance, now: time.Now}, nil
}

// WithTolerance returns a copy that accepts a different timestamp skew.
func (v *Verifier) WithTolerance(d time.Duration) *Verifier {
	out := *v
	out.tolerance = d
	return &out
}

// WithClock returns a copy that reads the current time from now, for tests.
func (v *Verifier) WithClock(now func() time.Time) *Verifier {
	out := *v
	out.now = now
	return &out
}

// Verify checks the three headers against body. Every failure returns an error wrapping ErrVerification, so the
// middleware can map the whole class to one 401 without inspecting which check failed.
func (v *Verifier) Verify(h http.Header, body []byte) error {
	id := h.Get("webhook-id")
	ts := h.Get("webhook-timestamp")
	sig := h.Get("webhook-signature")
	if id == "" || ts == "" || sig == "" {
		return fmt.Errorf("%w: a required header is missing", ErrVerification)
	}
	seconds, err := strconv.ParseFloat(ts, 64)
	if err != nil || math.IsInf(seconds, 0) || math.IsNaN(seconds) {
		return fmt.Errorf("%w: the timestamp is not a number", ErrVerification)
	}
	// A fractional timestamp is accepted and the truncated integer is what was signed, matching anyhook.
	truncated := math.Trunc(seconds)
	if truncated > maxTimestampSeconds || truncated < -maxTimestampSeconds {
		return fmt.Errorf("%w: the timestamp is outside the tolerance", ErrVerification)
	}
	stamp := time.Unix(int64(truncated), 0)
	if delta := v.now().Sub(stamp); delta > v.tolerance || delta < -v.tolerance {
		return fmt.Errorf("%w: the timestamp is outside the tolerance", ErrVerification)
	}

	// The presented entries are decoded once, before any MAC is computed, so the decoding work depends only on
	// the header and never on which secret or which entry ends up matching.
	var presented [][]byte
	for _, entry := range strings.Split(sig, " ") {
		candidate, ok := strings.CutPrefix(entry, "v1,")
		if !ok {
			continue
		}
		got, decodeErr := base64.StdEncoding.DecodeString(candidate)
		if decodeErr != nil {
			continue
		}
		presented = append(presented, got)
	}
	if len(presented) == 0 {
		return fmt.Errorf("%w: no signature entry matched", ErrVerification)
	}

	stampSeconds := strconv.FormatInt(int64(truncated), 10)
	content := make([]byte, 0, len(id)+len(stampSeconds)+len(body)+2)
	content = append(content, id...)
	content = append(content, '.')
	content = append(content, stampSeconds...)
	content = append(content, '.')
	content = append(content, body...)

	// Both loops run to completion rather than breaking on the first match, so the work does not depend on
	// which secret or which entry matched, and hmac.Equal is the constant time comparison.
	matched := false
	for _, key := range v.keys {
		mac := hmac.New(sha256.New, key)
		mac.Write(content)
		want := mac.Sum(nil)
		for _, candidate := range presented {
			if hmac.Equal(want, candidate) {
				matched = true
			}
		}
	}
	if !matched {
		return fmt.Errorf("%w: no signature entry matched", ErrVerification)
	}
	return nil
}

// VerifyFunc adapts the verifier to webhookmw.Options.Verify: a verification failure is a false first result,
// and any other error is returned so the door answers 500 configuration-error rather than 401.
func (v *Verifier) VerifyFunc() func(*http.Request, []byte) (bool, error) {
	return func(r *http.Request, body []byte) (bool, error) {
		if err := v.Verify(r.Header, body); err != nil {
			if errors.Is(err, ErrVerification) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}
}
