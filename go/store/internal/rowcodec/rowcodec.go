// Package rowcodec is the flat row shape shared by the Go stores and the JSON codec for result metadata.
package rowcodec

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// Row mirrors the TypeScript RecordRow: epoch milliseconds, JSON meta, raw body bytes, 0 or 1 for omitted.
type Row struct {
	Scope         string
	Key           string
	Fingerprint   string
	State         string
	Fence         int64
	LeaseUntil    int64
	CreatedAt     int64
	ExpiresAt     int64
	ResultMeta    *string
	ResultBody    []byte
	ResultOmitted int64
}

// messageError is the wire shape of anyonce.MessageError, which carries no JSON tags of its own; the field names
// must match what the TypeScript codec writes so a row written by either language reads back in the other.
type messageError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

type meta struct {
	Kind    anyonce.Kind     `json:"kind"`
	Status  *int             `json:"status,omitempty"`
	Headers [][2]string      `json:"headers,omitempty"`
	Outcome *anyonce.Outcome `json:"outcome,omitempty"`
	Error   *messageError    `json:"error,omitempty"`
}

// EncodeMeta serializes everything but the body; the omitted form encodes the same way.
func EncodeMeta(r anyonce.StoredResult) (string, error) {
	m := meta{Kind: r.Kind, Headers: r.Headers}
	if r.Status != 0 {
		s := r.Status
		m.Status = &s
	}
	if r.Outcome != "" {
		o := r.Outcome
		m.Outcome = &o
	}
	if r.Error != nil {
		m.Error = &messageError{Name: r.Error.Name, Message: r.Error.Message}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("rowcodec: encode meta: %w", err)
	}
	return string(b), nil
}

// DecodeMeta parses what EncodeMeta wrote; Body stays nil.
func DecodeMeta(text string) (anyonce.StoredResult, error) {
	var m meta
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		return anyonce.StoredResult{}, fmt.Errorf("rowcodec: decode meta: %w", err)
	}
	out := anyonce.StoredResult{Kind: m.Kind, Headers: m.Headers}
	if m.Status != nil {
		out.Status = *m.Status
	}
	if m.Outcome != nil {
		out.Outcome = *m.Outcome
	}
	if m.Error != nil {
		out.Error = &anyonce.MessageError{Name: m.Error.Name, Message: m.Error.Message}
	}
	return out, nil
}

// ToRecord decodes a row; a malformed meta yields a record without a result rather than an error, because a
// store must still report the claim state.
func ToRecord(row Row) anyonce.Record {
	rec := anyonce.Record{
		Scope: row.Scope, Key: row.Key, Fingerprint: row.Fingerprint, State: anyonce.State(row.State), Fence: row.Fence,
		LeaseUntil: time.UnixMilli(row.LeaseUntil).UTC(), CreatedAt: time.UnixMilli(row.CreatedAt).UTC(), ExpiresAt: time.UnixMilli(row.ExpiresAt).UTC(),
		ResultOmitted: row.ResultOmitted == 1,
	}
	if row.ResultMeta != nil {
		if res, err := DecodeMeta(*row.ResultMeta); err == nil {
			if row.ResultBody != nil {
				res.Body = append([]byte(nil), row.ResultBody...)
			}
			res.Omitted = rec.ResultOmitted
			rec.Result = &res
		}
	}
	return rec
}
