package webhookmw

import (
	"log"
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

// Code is a D11 problem code, aliased from internal/httpx so an Options.OnError hook can be written without
// naming an internal import path.
type Code = httpx.Code

// Problem is an RFC 9457 problem details document with the anyonce code member (D10).
type Problem = httpx.Problem

// The D11 problem codes. CodeConfigurationError and CodeSignatureInvalid are the two the webhook door adds.
const (
	CodeMissingKey          = httpx.CodeMissingKey
	CodeInvalidKey          = httpx.CodeInvalidKey
	CodeConflict            = httpx.CodeConflict
	CodeFingerprintMismatch = httpx.CodeFingerprintMismatch
	CodePayloadTooLarge     = httpx.CodePayloadTooLarge
	CodeStoreUnavailable    = httpx.CodeStoreUnavailable
	CodeMissingPrincipal    = httpx.CodeMissingPrincipal
	CodeConfigurationError  = httpx.CodeConfigurationError
	CodeSignatureInvalid    = httpx.CodeSignatureInvalid
)

// DefaultIDHeader is the Standard Webhooks delivery id header (REQ-WH-1).
const DefaultIDHeader = "webhook-id"

// DefaultMaxRequestBytes and DefaultProblemBaseURI are shared with the other doors and live in internal/httpx.
const (
	DefaultMaxRequestBytes = httpx.DefaultMaxRequestBytes
	DefaultProblemBaseURI  = httpx.DefaultProblemBaseURI
)

// DefaultMethods are the methods the receiver applies to. A webhook delivery is a POST.
var DefaultMethods = []string{http.MethodPost}

// DefaultStoreHeaders is the REQ-HTTP-8 allowlist. Set-Cookie is never stored whatever the allowlist says.
var DefaultStoreHeaders = []string{"Content-Type", "Content-Language", "Location", "ETag", "Link"}

// Options configures the webhook receiver. Store aside, every field has a working default.
type Options struct {
	// IDHeader is the header the delivery id arrives in. Default webhook-id.
	IDHeader string
	// Key derives the id from the body (a Stripe event.id, a GitHub delivery header). It wins over IDHeader.
	// The second result reports whether an id was found at all.
	Key func(r *http.Request, body []byte) (string, bool)
	// Verify runs before the store (D16). A false first result is 401 signature-invalid; a non nil error is a
	// 500 configuration-error, because a verifier that cannot decide must not be treated as a rejection.
	Verify func(r *http.Request, body []byte) (bool, error)
	// VerifiedMarker names a marker an upstream verifier put in the request context with MarkVerified.
	VerifiedMarker string
	// OnSuspicious fires when the same id arrives with a different body (REQ-WH-5).
	OnSuspicious func(r *http.Request, rec *anyonce.Record)
	// RoutePattern is the route half of the scope (D8). Default r.URL.EscapedPath(). Ignored when Scope is set.
	RoutePattern string
	// SourceID is the verified sender identity (Q24). An empty result leaves the scope as the route alone.
	// Ignored when Scope is set, and setting both panics from New rather than discarding this one silently.
	SourceID func(r *http.Request, body []byte) string
	// Scope is the whole store scope for one delivery (REQ-WH-1, ruling 18). It replaces RoutePattern and
	// SourceID entirely, so nothing is appended to what it returns, and it takes the body because the sender a
	// webhook door scopes by is usually only readable from the payload. It is also how a receiver behind a
	// router puts anything request-derived into its scope, which a plain RoutePattern string cannot express.
	// Setting it together with SourceID panics from New, because a scope that quietly dropped the sender
	// identity would put two senders in one dedupe namespace and let one suppress the other's delivery.
	Scope func(r *http.Request, body []byte) string
	// Fingerprint overrides the D9 default of SHA-256 over the body bytes alone.
	Fingerprint func(r *http.Request, body []byte) (string, error)
	// Methods the receiver applies to. Default POST.
	Methods []string
	// Required makes a delivery with no id a 400 missing-key. Default true (Q25).
	Required *bool
	// MaxRequestBytes bounds the body the receiver reads; larger bodies are 413 (REQ-HTTP-6). Default 1 MiB.
	MaxRequestBytes int64
	// StoreHeaders is the response header allowlist (REQ-HTTP-8).
	StoreHeaders []string
	// Policy is the engine policy. Zero values take anyonce.DefaultPolicy values.
	Policy anyonce.Policy
	// ProblemBaseURI is D11. DocsURL is the Link target on a 400 missing-key.
	ProblemBaseURI string
	DocsURL        string
	// ProblemTitles overrides the title of one or more problem codes (Q23), on top of the webhook defaults,
	// which name IDHeader. The status and the code member are fixed by D11 and are not overridable.
	ProblemTitles map[Code]string
	// OnError renders a problem differently. The status and the code must not change.
	OnError func(w http.ResponseWriter, r *http.Request, p Problem)
	// Logf receives the one configuration-error message (Q26). Default log.Printf.
	Logf func(format string, args ...any)
}

// resolved is Options with every default applied and the lookup sets precomputed. Go is case sensitive, so the
// resolved required bool sits beside the Options Required pointer it was read from.
type resolved struct {
	Options
	required     bool
	methods      map[string]bool
	storeHeaders map[string]bool
}

// webhookTitles is Q23: the D11 titles reworded for a webhook door, naming idHeader rather than
// Idempotency-Key, with the caller's overrides applied last. It mirrors the TypeScript receiver's titles.
func webhookTitles(idHeader string, overrides map[Code]string) map[Code]string {
	titles := map[Code]string{
		CodeMissingKey:          "The " + idHeader + " header is required for this request",
		CodeInvalidKey:          "The " + idHeader + " header value is not a valid key",
		CodeConflict:            "A delivery with this " + idHeader + " is still in progress",
		CodeFingerprintMismatch: "This " + idHeader + " was already delivered with a different payload",
		// One title for both causes of a 500, because it has to be honest whether the receiver runs no
		// verification at all or a working verifier merely failed. The detail member says which (ruling 13).
		CodeConfigurationError: "The webhook endpoint could not establish that this delivery is genuine",
		CodeSignatureInvalid:   "The webhook signature could not be verified",
	}
	for code, title := range overrides {
		titles[code] = title
	}
	return titles
}

// resolve applies the documented defaults and builds the methods and storeHeaders lookup sets.
func (o Options) resolve() resolved {
	r := resolved{Options: o, required: true, methods: httpx.MethodSet(o.Methods, DefaultMethods), storeHeaders: httpx.HeaderSet(o.StoreHeaders, DefaultStoreHeaders)}
	// Q25: a verified delivery with no id is a sender bug, so the default is true and Required is a pointer
	// purely so that false can be told from unset.
	if o.Required != nil {
		r.required = *o.Required
	}
	if r.IDHeader == "" {
		r.IDHeader = DefaultIDHeader
	}
	if r.MaxRequestBytes <= 0 {
		r.MaxRequestBytes = DefaultMaxRequestBytes
	}
	if r.ProblemBaseURI == "" {
		r.ProblemBaseURI = DefaultProblemBaseURI
	}
	if r.DocsURL == "" {
		r.DocsURL = r.ProblemBaseURI + string(CodeMissingKey)
	}
	if r.Logf == nil {
		r.Logf = log.Printf
	}
	r.ProblemTitles = webhookTitles(r.IDHeader, o.ProblemTitles)
	return r
}
