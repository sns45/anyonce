package conformance

import (
	"encoding/json"
	"testing"
)

func TestHeaderExpectationUnmarshalJSON(t *testing.T) {
	t.Run("REQ-CONF-1: a plain string is an exact match", func(t *testing.T) {
		var h HeaderExpectation
		if err := json.Unmarshal([]byte(`"text/plain"`), &h); err != nil {
			t.Fatal(err)
		}
		if h.Exact == nil || *h.Exact != "text/plain" {
			t.Fatalf("%+v", h)
		}
	})
	t.Run("REQ-CONF-1: an object setting present, absent or regex parses", func(t *testing.T) {
		var present HeaderExpectation
		if err := json.Unmarshal([]byte(`{"present":true}`), &present); err != nil || !present.Present {
			t.Fatalf("%+v %v", present, err)
		}
		var absent HeaderExpectation
		if err := json.Unmarshal([]byte(`{"absent":true}`), &absent); err != nil || !absent.Absent {
			t.Fatalf("%+v %v", absent, err)
		}
		var regex HeaderExpectation
		if err := json.Unmarshal([]byte(`{"regex":"^[1-9]"}`), &regex); err != nil || regex.Regex != "^[1-9]" {
			t.Fatalf("%+v %v", regex, err)
		}
	})
	t.Run("REQ-CONF-1: an object setting none of present, absent or regex is an error", func(t *testing.T) {
		var h HeaderExpectation
		if err := json.Unmarshal([]byte(`{}`), &h); err == nil {
			t.Fatal("expected an error")
		}
		if err := json.Unmarshal([]byte(`{"other":true}`), &h); err == nil {
			t.Fatal("expected an error")
		}
	})
}
