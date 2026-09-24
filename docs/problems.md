# Problem types

Every error anyonce returns over HTTP is an RFC 9457 problem details document with `Content-Type: application/problem+json`, the standard `type`, `title` and `status` members, an optional `detail`, and a stable `code` member (D10, D11). `type` is `problemBaseUri` followed by `code`; the base URI defaults to `https://in8.sh/anyonce/problems/` and is configurable per adapter. The `detail` member never contains the idempotency key. Every problem response also carries `Cache-Control: no-store`.

The catalogue is `PROBLEM_STATUS` and `PROBLEM_TITLE` in [`packages/core/src/http/problems.ts`](../packages/core/src/http/problems.ts) and the same codes in [`go/internal/httpx/problems.go`](../go/internal/httpx/problems.go); both languages hold the same nine codes, statuses and default titles.

| Code | Status | When | Extra headers |
|---|---|---|---|
| `missing-key` | 400 | The header is absent and the endpoint requires it (`required: true`) | `Link: <docsUrl>; rel="describedby"` |
| `invalid-key` | 400 | The header value is not a valid key: empty, longer than 255 bytes, outside printable ASCII, not an sf-string in strict mode, or the header field is repeated | none |
| `conflict` | 409 | A request with the same key and scope is still in flight | `Retry-After: <seconds until the lease expires, at least 1>` |
| `fingerprint-mismatch` | 422 | The key was already used in this scope with a different payload | none |
| `payload-too-large` | 413 | The request body exceeds `maxRequestBytes` (default 1 MiB) | none |
| `store-unavailable` | 503 | The store failed and the adapter runs fail-closed (D13) | `Retry-After: 1` |
| `missing-principal` | 500 | `requirePrincipal` is set and the principal function returned nothing for this request (Q18) | none |
| `configuration-error` | 500 | The webhook receiver could not establish that a delivery is genuine (REQ-WH-2, D16) | none |
| `signature-invalid` | 401 | The webhook signature did not verify, or the upstream verified marker was absent (D16) | `WWW-Authenticate: Signature` |

A receiver may override any title with `problemTitles` (Go `ProblemTitles`) so it names the header its senders actually send (Q23); the status and the `code` member never change. The webhook receiver does this by default, so its titles name `webhook-id` rather than `Idempotency-Key`.

## Codes

### `missing-key`

Status: 400

When: the key header is absent and the endpoint requires one (`required: true`, REQ-HTTP-3). The HTTP door defaults to `required: false`, which passes a keyless request through untouched; the webhook door defaults to `required: true`, so a verified delivery with no id is refused (Q25).

Extra headers: `Link: <docsUrl>; rel="describedby"`, where `docsUrl` defaults to `problemBaseUri` plus `missing-key`.

```json
{
  "type": "https://in8.sh/anyonce/problems/missing-key",
  "title": "The Idempotency-Key header is required for this request",
  "status": 400,
  "code": "missing-key"
}
```

### `invalid-key`

Status: 400

When: the key is not a valid key under D7 (REQ-CORE-2, REQ-HTTP-2, REQ-HTTP-4): empty, longer than 255 bytes, a character outside printable ASCII, not an RFC 9651 sf-string in `strict` mode, or the header field repeated. The `detail` member names the rule that failed (`key is empty`, `key exceeds 255 bytes`, and so on) without quoting the key. A webhook id goes through the lenient rules only (Q25).

Extra headers: none.

```json
{
  "type": "https://in8.sh/anyonce/problems/invalid-key",
  "title": "The Idempotency-Key header value is not a valid key",
  "status": 400,
  "detail": "key exceeds 255 bytes",
  "code": "invalid-key"
}
```

### `conflict`

Status: 409

When: a request with the same scope, key and fingerprint is still in flight, which includes a first response whose body the client is still receiving (REQ-HTTP-10, Q19).

Extra headers: `Retry-After` in whole seconds until the lease expires, rounded up, at least 1.

```json
{
  "type": "https://in8.sh/anyonce/problems/conflict",
  "title": "A request with this Idempotency-Key is still in progress",
  "status": 409,
  "code": "conflict"
}
```

### `fingerprint-mismatch`

Status: 422

When: the key was already used in this scope with a different payload, whether that record is in flight or completed (REQ-HTTP-11, REQ-WH-5). The original record is untouched, so a retry with the original payload still replays it.

Extra headers: none.

```json
{
  "type": "https://in8.sh/anyonce/problems/fingerprint-mismatch",
  "title": "This Idempotency-Key was already used with a different request payload",
  "status": 422,
  "code": "fingerprint-mismatch"
}
```

### `payload-too-large`

Status: 413

When: the request body exceeds `maxRequestBytes` (default 1 MiB), judged by `Content-Length` when present and by the bytes read otherwise (REQ-HTTP-6). The store is never called.

Extra headers: none.

```json
{
  "type": "https://in8.sh/anyonce/problems/payload-too-large",
  "title": "The request body exceeds the size this idempotent endpoint accepts",
  "status": 413,
  "code": "payload-too-large"
}
```

### `store-unavailable`

Status: 503

When: the store failed at `begin` and the adapter runs fail-closed, the default (REQ-HTTP-12, D13). A store failure after the handler has run never produces this problem (Q15). Under fail-open the request is served instead, marked `Idempotency-Degraded: true`.

Extra headers: `Retry-After: 1`.

```json
{
  "type": "https://in8.sh/anyonce/problems/store-unavailable",
  "title": "The idempotency store is unavailable",
  "status": 503,
  "code": "store-unavailable"
}
```

### `missing-principal`

Status: 500

When: `requirePrincipal` is set and the principal function returned nothing (undefined or an empty string) for this request (REQ-HTTP-5, Q18). It is a 500 because it is a deployment fault: a route that requires a principal was reached without one. `requirePrincipal` without any principal function fails earlier, at construction.

Extra headers: none.

```json
{
  "type": "https://in8.sh/anyonce/problems/missing-principal",
  "title": "The idempotency scope requires a principal and none was found",
  "status": 500,
  "code": "missing-principal"
}
```

### `configuration-error`

Status: 500

When: the webhook receiver could not establish that a delivery is genuine, for either of two causes: it was built with neither a `verify` callback nor a `verifiedMarker`, or its `verify` callback itself failed and so could not decide (REQ-WH-2, D16). The `detail` member says which, `no verify callback or verifiedMarker is configured` or `the verify callback failed`, and each cause logs one fixed line once per receiver instance (Q26). Not reachable from the plain HTTP door.

Extra headers: none.

```json
{
  "type": "https://in8.sh/anyonce/problems/configuration-error",
  "title": "This endpoint is not configured correctly and cannot accept the request",
  "status": 500,
  "detail": "no verify callback or verifiedMarker is configured",
  "code": "configuration-error"
}
```

The title is the catalogue default. The webhook receiver overrides it to "The webhook endpoint could not establish that this delivery is genuine".

### `signature-invalid`

Status: 401

When: the webhook `verify` callback returned false, or the receiver relies on a `verifiedMarker` that the upstream verifier did not set (D16, Q23). The store is never called. Not reachable from the plain HTTP door.

Extra headers: `WWW-Authenticate: Signature`.

```json
{
  "type": "https://in8.sh/anyonce/problems/signature-invalid",
  "title": "The request signature could not be verified",
  "status": 401,
  "code": "signature-invalid"
}
```

The title is the catalogue default, which stays generic because `@anyonce/core/http` serves every door. The webhook receiver overrides it through `problemTitles` so a sender reads "The webhook signature could not be verified".

This is the only problem that is a 401, and RFC 9110 section 15.5.2 makes at least one challenge a MUST on a 401, so the response always carries `WWW-Authenticate: Signature` (Q29). The scheme token is `Signature` because the credential being challenged is a Standard Webhooks signature, and it carries no parameters: a realm would name nothing a sender could act on. The header is set whether or not the receiver renders problems through `onError`.

## Overriding

Both adapters accept `onError(problem, request)` returning a `Response` (TypeScript) or `OnError(w, r, problem)` (Go) to render problems differently, for example to translate titles. The status and code must not change; the conformance suite's profile tier checks the media type and the code member. Protocol headers (`Link`, `Retry-After`, `WWW-Authenticate`, `Cache-Control: no-store`) are applied to an overridden response too, unless the override set them itself.
