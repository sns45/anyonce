package anyonce_test

import (
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestFingerprints(t *testing.T) {
	t.Run("REQ-CORE-4: SHA256Hex known answers", func(t *testing.T) {
		if got := anyonce.SHA256Hex(nil); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
			t.Fatal(got)
		}
		if got := anyonce.SHA256Hex([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CORE-4: HTTPFingerprint hashes method, LF, path, LF, body", func(t *testing.T) {
		want := anyonce.SHA256Hex([]byte("POST\n/echo\nhello"))
		if got := anyonce.HTTPFingerprint("POST", "/echo", []byte("hello")); got != want {
			t.Fatal(got)
		}
		if anyonce.HTTPFingerprint("PATCH", "/echo", []byte("hello")) == want || anyonce.HTTPFingerprint("POST", "/echo", []byte("hellp")) == want {
			t.Fatal("fingerprint must change with method or body")
		}
		if got := anyonce.HTTPFingerprint("POST", "/x", nil); got != anyonce.SHA256Hex([]byte("POST\n/x\n")) {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CORE-4: JCSFingerprint is key order independent and hashes the canonical text", func(t *testing.T) {
		a, errA := anyonce.JCSFingerprint(map[string]any{"b": 1, "a": []any{2, 3}})
		b, errB := anyonce.JCSFingerprint(map[string]any{"a": []any{2, 3}, "b": 1})
		if errA != nil || errB != nil || a != b || a != anyonce.SHA256Hex([]byte(`{"a":[2,3],"b":1}`)) {
			t.Fatalf("%s %s %v %v", a, b, errA, errB)
		}
	})
}
