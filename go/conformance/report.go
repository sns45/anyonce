package conformance

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func details(r VectorResult) string {
	if r.Status == "not-applicable" || r.Status == "error" {
		return r.Error
	}
	var out []string
	for _, s := range r.Steps {
		for _, f := range s.Failures {
			out = append(out, s.StepID+": "+f)
		}
	}
	return strings.Join(out, "; ")
}

var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;")

// Format renders a summary as json, markdown or junit with the same shapes as the TypeScript runner (REQ-CONF-6).
func Format(s Summary, format, target string) ([]byte, error) {
	switch format {
	case "json":
		type report struct {
			Target      string `json:"target,omitempty"`
			GeneratedAt string `json:"generatedAt"`
			Summary
		}
		return json.MarshalIndent(report{Target: target, GeneratedAt: time.Now().UTC().Format(time.RFC3339), Summary: s}, "", "  ")
	case "markdown":
		var b strings.Builder
		b.WriteString("# anyonce conformance report\n\n")
		if target != "" {
			fmt.Fprintf(&b, "Target: %s\n\n", target)
		}
		fmt.Fprintf(&b, "%d passed, %d failed, %d not applicable, %d errored\n\n", s.Passed, s.Failed, s.NotApplicable, s.Errored)
		b.WriteString("| Vector | Tier | Status | Details |\n|---|---|---|---|\n")
		for _, r := range s.Results {
			fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", r.ID, r.Tier, r.Status, strings.ReplaceAll(details(r), "|", "\\|"))
		}
		return []byte(b.String()), nil
	case "junit":
		var b strings.Builder
		b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
		fmt.Fprintf(&b, "<testsuite name=\"anyonce-conformance\" tests=\"%d\" failures=\"%d\" errors=\"%d\" skipped=\"%d\">\n", len(s.Results), s.Failed, s.Errored, s.NotApplicable)
		for _, r := range s.Results {
			open := fmt.Sprintf("<testcase classname=\"%s\" name=\"%s\"", r.Tier, xmlEscaper.Replace(r.ID))
			message := xmlEscaper.Replace(details(r))
			switch r.Status {
			case "pass":
				fmt.Fprintf(&b, "  %s/>\n", open)
			case "fail":
				fmt.Fprintf(&b, "  %s><failure message=\"%s\"/></testcase>\n", open, message)
			case "not-applicable":
				fmt.Fprintf(&b, "  %s><skipped message=\"%s\"/></testcase>\n", open, message)
			default:
				fmt.Fprintf(&b, "  %s><error message=\"%s\"/></testcase>\n", open, message)
			}
		}
		b.WriteString("</testsuite>\n")
		return []byte(b.String()), nil
	default:
		return nil, fmt.Errorf("conformance: unknown report format %q", format)
	}
}
