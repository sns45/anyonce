package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
)

type observed struct {
	status int
	header http.Header
	body   []byte
}

type evalContext struct {
	prior       map[string][]byte
	invocations *int
}

func jsonText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

func checkHeader(name string, exp HeaderExpectation, h http.Header) string {
	actual, present := h[http.CanonicalHeaderKey(name)]
	value := ""
	if present {
		value = actual[0]
	}
	switch {
	case exp.Exact != nil:
		if !present {
			return fmt.Sprintf("header %s: expected %q, got absent", name, *exp.Exact)
		}
		if value != *exp.Exact {
			return fmt.Sprintf("header %s: expected %q, got %q", name, *exp.Exact, value)
		}
	case exp.Present:
		if !present {
			return fmt.Sprintf("header %s: expected present, got absent", name)
		}
	case exp.Absent:
		if present {
			return fmt.Sprintf("header %s: expected absent, got %q", name, value)
		}
	case exp.Regex != "":
		re, err := regexp.Compile(exp.Regex)
		if err != nil {
			return fmt.Sprintf("header %s: invalid regex /%s/", name, exp.Regex)
		}
		if !present {
			return fmt.Sprintf("header %s: expected /%s/, got absent", name, exp.Regex)
		}
		if !re.MatchString(value) {
			return fmt.Sprintf("header %s: expected /%s/, got %q", name, exp.Regex, value)
		}
	}
	return ""
}

// evaluate mirrors packages/conformance/src/expect.ts message for message.
func evaluate(exp StepExpect, obs observed, ctx evalContext) []string {
	failures := []string{}
	if obs.status != exp.Status {
		failures = append(failures, fmt.Sprintf("status: expected %d, got %d", exp.Status, obs.status))
	}
	names := make([]string, 0, len(exp.Headers))
	for name := range exp.Headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if f := checkHeader(name, exp.Headers[name], obs.header); f != "" {
			failures = append(failures, f)
		}
	}
	if exp.BodyEquals != nil {
		switch {
		case exp.BodyEquals.Exact != nil:
			if string(obs.body) != *exp.BodyEquals.Exact {
				failures = append(failures, fmt.Sprintf("body: expected %q, got %q", *exp.BodyEquals.Exact, string(obs.body)))
			}
		default:
			prior, ok := ctx.prior[exp.BodyEquals.SameAs]
			if !ok {
				failures = append(failures, fmt.Sprintf("body: sameAs references unknown step %s", exp.BodyEquals.SameAs))
			} else if !bytes.Equal(prior, obs.body) {
				failures = append(failures, fmt.Sprintf("body: expected same bytes as step %s (%d bytes), got %d bytes that differ", exp.BodyEquals.SameAs, len(prior), len(obs.body)))
			}
		}
	}
	if exp.BodyJSON != nil {
		var parsed any
		if err := json.Unmarshal(obs.body, &parsed); err != nil {
			failures = append(failures, "body: expected JSON object, got unparseable body")
		} else if object, ok := parsed.(map[string]any); !ok {
			failures = append(failures, "body: expected JSON object, got non-object")
		} else {
			keys := make([]string, 0, len(exp.BodyJSON))
			for k := range exp.BodyJSON {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				got := "undefined"
				if value, present := object[k]; present {
					got = jsonText(value)
				}
				if got != jsonText(exp.BodyJSON[k]) {
					failures = append(failures, fmt.Sprintf("body.%s: expected %s, got %s", k, jsonText(exp.BodyJSON[k]), got))
				}
			}
		}
	}
	if exp.BodyBytes != nil && len(obs.body) != *exp.BodyBytes {
		failures = append(failures, fmt.Sprintf("body: expected %d bytes, got %d", *exp.BodyBytes, len(obs.body)))
	}
	if exp.HandlerInvocations != nil {
		switch {
		case ctx.invocations == nil:
			failures = append(failures, "handlerInvocations: counter unavailable")
		case *ctx.invocations != *exp.HandlerInvocations:
			failures = append(failures, fmt.Sprintf("handlerInvocations: expected %d, got %d", *exp.HandlerInvocations, *ctx.invocations))
		}
	}
	return failures
}
