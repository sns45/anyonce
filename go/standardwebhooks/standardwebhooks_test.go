package standardwebhooks_test

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/standardwebhooks"
)

type vector struct {
	Name      string
	Secrets   []string
	ID        string
	Payload   string
	Timestamp int64
	Signature string
}

const (
	secretA = "whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
	secretB = "whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
)

// Copied verbatim from docs/reference/anyhook-signing.md, which was read from the anyhook source at dfd5022.
var vectors = []vector{
	{
		Name:      "single_secret",
		Secrets:   []string{secretA},
		ID:        "msg_1",
		Payload:   `{"a":1}`,
		Timestamp: 1700000000,
		Signature: "v1,g9EIBBIwm31AQEkP7q60DV8jDWYbrjV7TTZJL+PIcMo=",
	},
	{
		Name:      "rotation_two_secrets",
		Secrets:   []string{secretA, secretB},
		ID:        "msg_2",
		Payload:   `{"nested":{"b":[1,2,3]},"unicode":"café"}`,
		Timestamp: 1700000001,
		Signature: "v1,Quo14+anAi2BEdvq/rAJ6acir9k1eo5oapk44aRYF6Y= v1,DA4ZWdZKEG9r6wHFCDZPQA+nmyvCvC6qn44us/GbmOw=",
	},
	{
		Name:      "empty_object_payload",
		Secrets:   []string{secretA},
		ID:        "msg_3",
		Payload:   `{}`,
		Timestamp: 0,
		Signature: "v1,rPUBbAcJfBgq5bbh2lc3N+SdRs/ySWgI2QxJlbKwSBU=",
	},
}

func headers(v vector, overrides map[string]string) http.Header {
	h := http.Header{}
	h.Set("webhook-id", v.ID)
	h.Set("webhook-timestamp", strconv.FormatInt(v.Timestamp, 10))
	h.Set("webhook-signature", v.Signature)
	for name, value := range overrides {
		h.Set(name, value)
	}
	return h
}

func verifierFor(t *testing.T, v vector, secret string) *standardwebhooks.Verifier {
	t.Helper()
	ver, err := standardwebhooks.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	return ver.WithClock(func() time.Time { return time.Unix(v.Timestamp, 0) })
}

func TestVerify(t *testing.T) {
	for _, v := range vectors {
		t.Run("REQ-WH-6: the "+v.Name+" anyhook golden vector verifies", func(t *testing.T) {
			ver := verifierFor(t, v, v.Secrets[0])
			if err := ver.Verify(headers(v, nil), []byte(v.Payload)); err != nil {
				t.Fatalf("verify: %v", err)
			}
		})
	}

	t.Run("REQ-WH-6: a rotation signature verifies against either secret", func(t *testing.T) {
		v := vectors[1]
		for _, secret := range v.Secrets {
			ver := verifierFor(t, v, secret)
			if err := ver.Verify(headers(v, nil), []byte(v.Payload)); err != nil {
				t.Fatalf("verify with %s: %v", secret, err)
			}
		}
	})

	t.Run("REQ-WH-6: a receiver holding two secrets verifies a payload signed with either", func(t *testing.T) {
		v := vectors[1]
		entries := strings.Split(v.Signature, " ")
		if len(entries) != 2 {
			t.Fatalf("the rotation vector carries %d entries, want 2", len(entries))
		}
		for _, entry := range entries {
			ver, err := standardwebhooks.New(secretA, secretB)
			if err != nil {
				t.Fatal(err)
			}
			ver = ver.WithClock(func() time.Time { return time.Unix(v.Timestamp, 0) })
			h := headers(v, map[string]string{"webhook-signature": entry})
			if err := ver.Verify(h, []byte(v.Payload)); err != nil {
				t.Fatalf("verify %q: %v", entry, err)
			}
		}
	})

	t.Run("REQ-WH-6: a secret without the whsec_ prefix is the same key", func(t *testing.T) {
		v := vectors[0]
		bare := strings.TrimPrefix(secretA, standardwebhooks.SecretPrefix)
		if bare == secretA {
			t.Fatalf("the fixture secret does not carry the %q prefix", standardwebhooks.SecretPrefix)
		}
		ver := verifierFor(t, v, bare)
		if err := ver.Verify(headers(v, nil), []byte(v.Payload)); err != nil {
			t.Fatalf("verify: %v", err)
		}
	})

	t.Run("REQ-WH-6: a changed body fails", func(t *testing.T) {
		v := vectors[0]
		ver := verifierFor(t, v, v.Secrets[0])
		err := ver.Verify(headers(v, nil), []byte(`{"a":2}`))
		if !errors.Is(err, standardwebhooks.ErrVerification) {
			t.Fatalf("err = %v, want ErrVerification", err)
		}
	})

	t.Run("REQ-WH-6: a changed id fails", func(t *testing.T) {
		v := vectors[0]
		ver := verifierFor(t, v, v.Secrets[0])
		h := headers(v, map[string]string{"webhook-id": "msg_9"})
		err := ver.Verify(h, []byte(v.Payload))
		if !errors.Is(err, standardwebhooks.ErrVerification) {
			t.Fatalf("err = %v, want ErrVerification", err)
		}
	})

	t.Run("REQ-WH-6: each of the three headers is required", func(t *testing.T) {
		v := vectors[0]
		for _, name := range []string{"webhook-id", "webhook-timestamp", "webhook-signature"} {
			h := headers(v, nil)
			h.Del(name)
			ver := verifierFor(t, v, v.Secrets[0])
			err := ver.Verify(h, []byte(v.Payload))
			if !errors.Is(err, standardwebhooks.ErrVerification) {
				t.Fatalf("without %s: err = %v, want ErrVerification", name, err)
			}
		}
	})

	t.Run("REQ-WH-6: the headers are matched case-insensitively", func(t *testing.T) {
		v := vectors[0]
		h := http.Header{}
		h.Set("WEBHOOK-ID", v.ID)
		h.Set("Webhook-TimeStamp", strconv.FormatInt(v.Timestamp, 10))
		h.Set("webhook-SIGNATURE", v.Signature)
		ver := verifierFor(t, v, v.Secrets[0])
		if err := ver.Verify(h, []byte(v.Payload)); err != nil {
			t.Fatalf("verify: %v", err)
		}
	})

	t.Run("REQ-WH-6: a timestamp that is not a finite number fails", func(t *testing.T) {
		v := vectors[0]
		for _, ts := range []string{"not-a-number", "NaN", "Inf", "-Inf", "1700000000abc"} {
			h := headers(v, map[string]string{"webhook-timestamp": ts})
			ver := verifierFor(t, v, v.Secrets[0])
			err := ver.Verify(h, []byte(v.Payload))
			if !errors.Is(err, standardwebhooks.ErrVerification) {
				t.Fatalf("timestamp %q: err = %v, want ErrVerification", ts, err)
			}
		}
	})

	t.Run("REQ-WH-6: a timestamp outside the 300 second tolerance fails on either side", func(t *testing.T) {
		v := vectors[0]
		for _, offset := range []int64{301, -301} {
			ver, err := standardwebhooks.New(v.Secrets[0])
			if err != nil {
				t.Fatal(err)
			}
			ver = ver.WithClock(func() time.Time { return time.Unix(v.Timestamp+offset, 0) })
			err = ver.Verify(headers(v, nil), []byte(v.Payload))
			if !errors.Is(err, standardwebhooks.ErrVerification) {
				t.Fatalf("offset %d: err = %v, want ErrVerification", offset, err)
			}
		}
	})

	t.Run("REQ-WH-6: a timestamp at the tolerance edge still verifies", func(t *testing.T) {
		v := vectors[0]
		for _, offset := range []int64{300, -300} {
			ver, err := standardwebhooks.New(v.Secrets[0])
			if err != nil {
				t.Fatal(err)
			}
			ver = ver.WithClock(func() time.Time { return time.Unix(v.Timestamp+offset, 0) })
			if err := ver.Verify(headers(v, nil), []byte(v.Payload)); err != nil {
				t.Fatalf("offset %d: %v", offset, err)
			}
		}
	})

	t.Run("REQ-WH-6: a fractional timestamp is accepted and truncated, matching anyhook", func(t *testing.T) {
		v := vectors[0]
		h := headers(v, map[string]string{"webhook-timestamp": strconv.FormatInt(v.Timestamp, 10) + ".9"})
		ver := verifierFor(t, v, v.Secrets[0])
		if err := ver.Verify(h, []byte(v.Payload)); err != nil {
			t.Fatalf("verify: %v", err)
		}
	})

	t.Run("REQ-WH-6: an entry with an unknown version prefix is ignored and the rest still decide", func(t *testing.T) {
		v := vectors[0]
		const v2 = "v2,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
		ver := verifierFor(t, v, v.Secrets[0])
		h := headers(v, map[string]string{"webhook-signature": v2 + " " + v.Signature})
		if err := ver.Verify(h, []byte(v.Payload)); err != nil {
			t.Fatalf("with a v2 entry alongside the v1 one: %v", err)
		}

		ver = verifierFor(t, v, v.Secrets[0])
		h = headers(v, map[string]string{"webhook-signature": v2})
		err := ver.Verify(h, []byte(v.Payload))
		if !errors.Is(err, standardwebhooks.ErrVerification) {
			t.Fatalf("with only a v2 entry: err = %v, want ErrVerification", err)
		}
	})

	t.Run("REQ-WH-6: a secret whose base64 does not decode is an error from New", func(t *testing.T) {
		if _, err := standardwebhooks.New("whsec_not base64!"); err == nil {
			t.Fatal("New accepted a secret that is not base64")
		}
		if _, err := standardwebhooks.ParseSecret("whsec_not base64!"); err == nil {
			t.Fatal("ParseSecret accepted a secret that is not base64")
		}
	})

	t.Run("REQ-WH-6: an empty secret is an error from New, as it is in the TypeScript twin", func(t *testing.T) {
		for _, secret := range []string{"", standardwebhooks.SecretPrefix} {
			if _, err := standardwebhooks.New(secret); err == nil {
				t.Fatalf("New accepted the empty secret %q", secret)
			}
		}
		if _, err := standardwebhooks.New(); err == nil {
			t.Fatal("New accepted an empty secret list")
		}
	})
}

func TestVerifyFunc(t *testing.T) {
	t.Run("REQ-WH-7: VerifyFunc reports false for a verification failure and true for a good delivery", func(t *testing.T) {
		v := vectors[0]
		ver := verifierFor(t, v, v.Secrets[0])
		fn := ver.VerifyFunc()

		r, err := http.NewRequest(http.MethodPost, "/hooks", strings.NewReader(v.Payload))
		if err != nil {
			t.Fatal(err)
		}
		r.Header = headers(v, nil)
		ok, err := fn(r, []byte(v.Payload))
		if err != nil || !ok {
			t.Fatalf("ok = %v, err = %v, want true and nil", ok, err)
		}

		ok, err = fn(r, []byte(`{"a":2}`))
		if err != nil || ok {
			t.Fatalf("ok = %v, err = %v, want false and nil", ok, err)
		}
	})
}
