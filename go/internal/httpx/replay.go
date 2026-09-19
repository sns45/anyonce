package httpx

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// RetryAfter is the Retry-After value for a claim held until leaseUntil, at least one second, measured against
// the policy clock when one is set.
func RetryAfter(leaseUntil time.Time, policy anyonce.Policy) string {
	now := time.Now()
	if policy.Clock != nil {
		now = policy.Clock()
	}
	seconds := int64(math.Ceil(leaseUntil.Sub(now).Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}

// WriteReplay is REQ-HTTP-9 and D12. A nil rec (which the store contract should never produce for a replayed
// result, but callers should not have to trust that) is treated as an empty 200 with the replay header.
func WriteReplay(w http.ResponseWriter, rec *anyonce.Record) {
	h := w.Header()
	status := http.StatusOK
	var body []byte
	var omitted bool
	if rec != nil {
		omitted = rec.ResultOmitted
		if rec.Result != nil {
			if rec.Result.Status != 0 {
				status = rec.Result.Status
			}
			for _, kv := range rec.Result.Headers {
				h.Add(kv[0], kv[1])
			}
			if !rec.ResultOmitted {
				body = rec.Result.Body
			}
		}
	}
	h.Set("Idempotency-Replayed", "true")
	if omitted {
		h.Set("Idempotency-Replay", "omitted")
	}
	if len(body) > 0 {
		h.Set("Content-Length", strconv.Itoa(len(body)))
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
