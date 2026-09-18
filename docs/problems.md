# Problem types

Every error anyonce returns over HTTP is an RFC 9457 problem details document with `Content-Type: application/problem+json`, the standard `type`, `title` and `status` members, an optional `detail`, and a stable `code` member (D10, D11). `type` is `problemBaseUri` followed by `code`; the base URI defaults to `https://in8.sh/anyonce/problems/` and is configurable per adapter. The `detail` member never contains the idempotency key.

| Code | Status | When | Extra headers |
|---|---|---|---|
| `missing-key` | 400 | The header is absent and the endpoint requires it (`required: true`) | `Link: <docsUrl>; rel="describedby"` |
| `invalid-key` | 400 | The header value is not a valid key: empty, longer than 255 bytes, outside printable ASCII, not an sf-string in strict mode, or the header field is repeated | none |
| `conflict` | 409 | A request with the same key and scope is still in flight | `Retry-After: <seconds until the lease expires, at least 1>` |
| `fingerprint-mismatch` | 422 | The key was already used in this scope with a different payload | none |
| `payload-too-large` | 413 | The request body exceeds `maxRequestBytes` (default 1 MiB) | none |
| `store-unavailable` | 503 | The store failed and the adapter runs fail-closed (D13) | `Retry-After: 1` |
| `missing-principal` | 500 | `requirePrincipal` is set and the principal function returned nothing for this request (Q18) | none |
| `configuration-error` | 500 | The webhook receiver could not establish that a delivery is genuine, for either of two causes: it was built with neither a `verify` callback nor a `verifiedMarker`, or its `verify` callback itself failed and so could not decide. The `detail` member says which, `no verify callback or verifiedMarker is configured` or `the verify callback failed`, and each cause logs once per receiver instance (REQ-WH-2, D16) | none |
| `signature-invalid` | 401 | The webhook signature did not verify, or the upstream verified marker was absent (D16) | none |

A receiver may override any title with `problemTitles` so it names the header its senders actually send; the status and the `code` member never change.

## Example bodies

`missing-key`

```json
{
  "type": "https://in8.sh/anyonce/problems/missing-key",
  "title": "The Idempotency-Key header is required for this request",
  "status": 400,
  "code": "missing-key"
}
```

`invalid-key`

```json
{
  "type": "https://in8.sh/anyonce/problems/invalid-key",
  "title": "The Idempotency-Key header value is not a valid key",
  "status": 400,
  "detail": "key exceeds 255 bytes",
  "code": "invalid-key"
}
```

`conflict`

```json
{
  "type": "https://in8.sh/anyonce/problems/conflict",
  "title": "A request with this Idempotency-Key is still in progress",
  "status": 409,
  "code": "conflict"
}
```

`fingerprint-mismatch`

```json
{
  "type": "https://in8.sh/anyonce/problems/fingerprint-mismatch",
  "title": "This Idempotency-Key was already used with a different request payload",
  "status": 422,
  "code": "fingerprint-mismatch"
}
```

`payload-too-large`

```json
{
  "type": "https://in8.sh/anyonce/problems/payload-too-large",
  "title": "The request body exceeds the size this idempotent endpoint accepts",
  "status": 413,
  "code": "payload-too-large"
}
```

`store-unavailable`

```json
{
  "type": "https://in8.sh/anyonce/problems/store-unavailable",
  "title": "The idempotency store is unavailable",
  "status": 503,
  "code": "store-unavailable"
}
```

`missing-principal`

```json
{
  "type": "https://in8.sh/anyonce/problems/missing-principal",
  "title": "The idempotency scope requires a principal and none was found",
  "status": 500,
  "code": "missing-principal"
}
```

`configuration-error`

```json
{
  "type": "https://in8.sh/anyonce/problems/configuration-error",
  "title": "This endpoint is not configured correctly and cannot accept the request",
  "status": 500,
  "code": "configuration-error"
}
```

`signature-invalid`

```json
{
  "type": "https://in8.sh/anyonce/problems/signature-invalid",
  "title": "The request signature could not be verified",
  "status": 401,
  "code": "signature-invalid"
}
```

The title is the catalogue default, which stays generic because `@anyonce/core/http` serves every door. The webhook receiver overrides it through `problemTitles` so a sender reads "The webhook signature could not be verified".

## Overriding

Both adapters accept `onError(problem, request)` returning a `Response` (TypeScript) or `OnError(w, r, problem)` (Go) to render problems differently, for example to translate titles. The status and code must not change; the conformance suite's profile tier checks the media type and the code member.
