package conformance

import (
	"encoding/json"
	"fmt"
)

// HeaderExpectation is a string, {present: true}, {absent: true} or {regex}.
type HeaderExpectation struct {
	Exact   *string
	Present bool
	Absent  bool
	Regex   string
}

// UnmarshalJSON parses a header expectation from a plain string or an object with present, absent or regex.
func (h *HeaderExpectation) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		h.Exact = &s
		return nil
	}
	var obj struct {
		Present bool   `json:"present"`
		Absent  bool   `json:"absent"`
		Regex   string `json:"regex"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return fmt.Errorf("header expectation: %w", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return fmt.Errorf("header expectation: %w", err)
	}
	_, hasPresent := raw["present"]
	_, hasAbsent := raw["absent"]
	_, hasRegex := raw["regex"]
	if !hasPresent && !hasAbsent && !hasRegex {
		return fmt.Errorf("header expectation: object must set present, absent or regex")
	}
	h.Present, h.Absent, h.Regex = obj.Present, obj.Absent, obj.Regex
	return nil
}

// BodyEquals is a string or {sameAs: stepId}.
type BodyEquals struct {
	Exact  *string
	SameAs string
}

// UnmarshalJSON parses a body equality expectation from a plain string or an object with sameAs.
func (e *BodyEquals) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		e.Exact = &s
		return nil
	}
	var obj struct {
		SameAs string `json:"sameAs"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return fmt.Errorf("bodyEquals: %w", err)
	}
	e.SameAs = obj.SameAs
	return nil
}

// StepRequest is the request a step sends.
type StepRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
}

// StepExpect is the response a step expects.
type StepExpect struct {
	Status             int                          `json:"status"`
	Headers            map[string]HeaderExpectation `json:"headers"`
	BodyEquals         *BodyEquals                  `json:"bodyEquals"`
	BodyJSON           map[string]any               `json:"bodyJson"`
	BodyBytes          *int                         `json:"bodyBytes"`
	HandlerInvocations *int                         `json:"handlerInvocations"`
}

// Step is one request/expectation pair in a Vector, with optional delay and concurrency.
type Step struct {
	ID             string      `json:"id"`
	DelayMs        int         `json:"delayMs"`
	ConcurrentWith []string    `json:"concurrentWith"`
	Request        StepRequest `json:"request"`
	Expect         StepExpect  `json:"expect"`
}

// Vector mirrors conformance/schema.json (REQ-CONF-1).
type Vector struct {
	ID          string   `json:"id"`
	Tier        string   `json:"tier"`
	Title       string   `json:"title"`
	DraftRef    string   `json:"draftRef"`
	Description string   `json:"description"`
	Requires    []string `json:"requires"`
	Fixture     string   `json:"fixture"`
	Steps       []Step   `json:"steps"`
}
