package rowcodec

import (
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestMeta(t *testing.T) {
	t.Run("REQ-STORE-4: meta round trips kind, status, headers, outcome and error without the body", func(t *testing.T) {
		in := anyonce.StoredResult{Kind: anyonce.KindMessage, Status: 201, Headers: [][2]string{{"content-type", "text/plain"}, {"set-cookie", "a=1"}}, Outcome: anyonce.OutcomeError, Error: &anyonce.MessageError{Name: "E", Message: "boom"}, Body: []byte{1}}
		text, err := EncodeMeta(in)
		if err != nil {
			t.Fatal(err)
		}
		if text != `{"kind":"message","status":201,"headers":[["content-type","text/plain"],["set-cookie","a=1"]],"outcome":"error","error":{"name":"E","message":"boom"}}` {
			t.Fatal(text)
		}
		out, err := DecodeMeta(text)
		if err != nil || out.Kind != in.Kind || out.Status != 201 || len(out.Headers) != 2 || out.Outcome != anyonce.OutcomeError || out.Error == nil || out.Error.Message != "boom" || out.Body != nil {
			t.Fatalf("%+v %v", out, err)
		}
	})
	t.Run("REQ-STORE-10: an omitted result encodes status and headers only and ToRecord sets ResultOmitted", func(t *testing.T) {
		text, _ := EncodeMeta(anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"x", "y"}}, Omitted: true})
		if text != `{"kind":"http","status":200,"headers":[["x","y"]]}` {
			t.Fatal(text)
		}
		rec := ToRecord(Row{Scope: "s", Key: "k", Fingerprint: "f", State: "completed", Fence: 1, LeaseUntil: 0, CreatedAt: 0, ExpiresAt: 9, ResultMeta: &text, ResultOmitted: 1})
		if !rec.ResultOmitted || rec.Result == nil || rec.Result.Body != nil || rec.Result.Status != 200 || !rec.ExpiresAt.Equal(time.UnixMilli(9)) {
			t.Fatalf("%+v", rec)
		}
	})
	t.Run("REQ-STORE-4: ToRecord decodes a completed row with a body and leaves Result nil for an in flight row", func(t *testing.T) {
		meta := `{"kind":"http","status":201}`
		rec := ToRecord(Row{Scope: "s", Key: "k", Fingerprint: "f", State: "completed", Fence: 2, ResultMeta: &meta, ResultBody: []byte{1, 2}})
		if rec.Result == nil || string(rec.Result.Body) != "\x01\x02" || rec.Fence != 2 || rec.State != anyonce.StateCompleted {
			t.Fatalf("%+v", rec)
		}
		if ToRecord(Row{State: "in_flight"}).Result != nil {
			t.Fatal("in flight row must not carry a result")
		}
	})
	t.Run("REQ-STORE-4: a malformed meta yields a record without a result rather than an error", func(t *testing.T) {
		broken := `{"kind":`
		rec := ToRecord(Row{Scope: "s", Key: "k", State: "completed", Fence: 3, ResultMeta: &broken})
		if rec.Result != nil || rec.Fence != 3 {
			t.Fatalf("%+v", rec)
		}
		if _, err := DecodeMeta(broken); err == nil {
			t.Fatal("DecodeMeta must report a parse failure")
		}
	})
}
