// Package conformance runs the anyonce conformance vectors (conformance/vectors) against an http.Handler or a base
// URL (REQ-CONF-6). It knows nothing about stores (D18). The vectors are embedded from go/conformance/vectors, a
// copy of the repository's conformance/vectors, so the runner works from the module cache.
package conformance
