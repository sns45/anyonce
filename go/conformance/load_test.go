package conformance

import "testing"

func TestLoad(t *testing.T) {
	t.Run("REQ-CONF-6: loads every core and profile vector sorted by id with requires and concurrency parsed", func(t *testing.T) {
		vectors, err := LoadVectors(DefaultVectorsDir())
		if err != nil {
			t.Fatal(err)
		}
		if len(vectors) != 20 {
			t.Fatalf("got %d vectors", len(vectors))
		}
		for i := 1; i < len(vectors); i++ {
			if vectors[i-1].ID >= vectors[i].ID {
				t.Fatalf("not sorted at %d: %s %s", i, vectors[i-1].ID, vectors[i].ID)
			}
		}
		byID := map[string]Vector{}
		for _, v := range vectors {
			byID[v.ID] = v
		}
		if exp := byID["core/expiry-executes-again"]; len(exp.Requires) != 1 || exp.Requires[0] != "short-ttl" || exp.Steps[1].DelayMs != 2500 {
			t.Fatalf("%+v", exp)
		}
		if c := byID["core/concurrent-409"]; len(c.Steps[1].ConcurrentWith) != 1 || c.Steps[1].ConcurrentWith[0] != "original" || *c.Steps[1].Expect.HandlerInvocations != 1 {
			t.Fatalf("%+v", c)
		}
		retry := byID["core/retry-replays"].Steps[1].Expect
		if retry.BodyEquals == nil || retry.BodyEquals.SameAs != "first" {
			t.Fatalf("%+v", retry)
		}
		ra := byID["profile/retry-after-on-409"].Steps[1].Expect.Headers["Retry-After"]
		if ra.Regex != "^[1-9][0-9]*$" || ra.Exact != nil {
			t.Fatalf("%+v", ra)
		}
		absent := byID["profile/5xx-not-stored"].Steps[1].Expect.Headers["Idempotency-Replayed"]
		if !absent.Absent {
			t.Fatalf("%+v", absent)
		}
		if got := byID["core/get-ignored"].Steps[0].Expect.BodyJSON["count"]; got != float64(0) {
			t.Fatalf("%v", got)
		}
	})
}
