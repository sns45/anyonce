# anyhook signing routine (read from source, 2026-09-16)

Source of truth: `sns45/anyhook` at `dfd5022` (release 0.2.2). TypeScript in `packages/signing/src`, Go in `go/signing`. anyonce's `standardWebhooksVerify(secret)` (REQ-WH-6) and Go `standardwebhooks.Verify` (REQ-WH-7) must accept exactly what these produce. anyonce does not import anyhook; the interop test signs with anyhook and receives with anyonce.

## Wire format (Standard Webhooks, as anyhook implements it)

| Item | Value |
|---|---|
| Headers | `webhook-id`, `webhook-timestamp`, `webhook-signature` (matched case-insensitively) |
| Timestamp | Unix seconds as a decimal string. TS: `Math.floor(ms / 1000)`. Go: `time.Unix()` |
| Signed content | `${id}.${timestampSeconds}.${payload}` where `payload` is the exact raw body string |
| MAC | HMAC-SHA256 over the UTF-8 bytes of the signed content |
| Key | `parseSecret(secret)`: strip an optional `whsec_` prefix, base64 standard decode the remainder |
| Signature entry | `v1,` + standard base64 of the 32-byte MAC |
| Multiple secrets | one `v1,...` entry per secret, space joined, in secret order (key rotation) |
| Tolerance | 300 seconds, absolute difference between now and the header timestamp |
| Comparison | constant time on the decoded bytes (`timingSafeEqual` in TS, `hmac.Equal` in Go); any one matching entry passes |

Verification failure cases, in order: missing any of the three headers; timestamp not a finite number; timestamp outside tolerance; no matching `v1,` entry. TS throws `WebhookVerificationError`; Go returns `*WebhookVerificationError`.

Differences between the two anyhook implementations that anyonce must tolerate:

- TS `verify()` returns `JSON.parse(rawBody)`; Go `Verify` returns the raw bytes. anyonce verifies bytes and never parses.
- TS uses `Buffer` and `node:crypto`; anyonce's `@anyonce/webhooks` is Web APIs only, so it reimplements the routine with `crypto.subtle` and `atob`/`Uint8Array`. Byte compatibility is what the interop test proves.
- Go `Verify` parses the timestamp with `ParseFloat` then truncates; TS uses `Number`. A fractional timestamp is accepted by both and signed with the truncated integer. anyonce mirrors this.

## Signer API (what the interop test calls)

TypeScript (`@anyhook/signing` 0.2.2):

```ts
export function generateSecret(bytes = 24): string;                   // "whsec_" + base64(random)
export function parseSecret(secret: string): Uint8Array;
export function sign(secret: string, id: string, timestamp: Date, payload: string): string; // "v1,<b64>"
export class Signer {
  constructor(secrets: string | string[]);
  headers(id: string, payload: string, timestamp?: Date): Record<string, string>;
  // returns { 'webhook-id', 'webhook-timestamp', 'webhook-signature' }
}
export function verify(headers: Record<string, string>, rawBody: string, secret: string): unknown;
export class WebhookVerificationError extends Error {}
```

Go (`github.com/sns45/anyhook/go/signing`, tag `go/v0.2.1`, `go 1.24`):

```go
const SecretPrefix = "whsec_"
const ToleranceSeconds = 300
func GenerateSecret(numBytes int) (string, error)
func ParseSecret(secret string) ([]byte, error)
func Sign(secret, id string, timestamp time.Time, payload string) (string, error)
func NewSigner(secrets ...string) *Signer
func (s *Signer) Headers(id, payload string, timestamp time.Time) (map[string]string, error)
func Verify(headers map[string]string, rawBody, secret string) ([]byte, error)
type WebhookVerificationError struct{ /* unexported */ }
```

## Known-answer vectors (copied from `go/signing/testdata/*.golden`)

These are anyhook's committed golden outputs. anyonce's verify tests use them as fixed inputs with a frozen clock so the tolerance check passes.

| Case | Secrets | id | payload | timestamp | `webhook-signature` |
|---|---|---|---|---|---|
| single_secret | `whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB` | `msg_1` | `{"a":1}` | 1700000000 | `v1,g9EIBBIwm31AQEkP7q60DV8jDWYbrjV7TTZJL+PIcMo=` |
| rotation_two_secrets | `whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB`, `whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB` | `msg_2` | `{"nested":{"b":[1,2,3]},"unicode":"café"}` | 1700000001 | `v1,Quo14+anAi2BEdvq/rAJ6acir9k1eo5oapk44aRYF6Y= v1,DA4ZWdZKEG9r6wHFCDZPQA+nmyvCvC6qn44us/GbmOw=` |
| empty_object_payload | `whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB` | `msg_3` | `{}` | 0 | `v1,rPUBbAcJfBgq5bbh2lc3N+SdRs/ySWgI2QxJlbKwSBU=` |

anyhook's own interop test (`packages/signing/test/interop.test.ts`) round-trips against the official `standardwebhooks` 1.0.0 npm package in both directions, so matching anyhook is equivalent to matching the reference library.

## Interop test plan for P4

1. TS: `bun add -d @anyhook/signing@0.2.2` in `packages/webhooks`; sign with `new Signer(secret).headers(id, body)`; POST to a Hono app using `webhookReceiver({ verify: standardWebhooksVerify(secret) })`; expect 2xx, then replay and expect `Idempotency-Replayed: true`; tamper the body and expect 422 plus `onSuspicious`.
2. Go: `require github.com/sns45/anyhook/go v0.2.1` in a test-only module under `go/webhookmw/interop`, sign with `signing.NewSigner(secret).Headers(...)`, same expectations through `httptest`.
3. The three golden rows above are table tests for `standardWebhooksVerify` with the clock pinned to the row timestamp.
