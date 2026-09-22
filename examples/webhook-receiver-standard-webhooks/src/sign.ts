/**
 * Signs a payload the way a Standard Webhooks sender does, for trying the receiver with curl:
 * the signature is v1, followed by base64 HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<body>" keyed by
 * the decoded secret.
 *
 *   bun run sign <webhook-id> '<body>' > headers.txt   (reads WEBHOOK_SECRET)
 */

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function signatureHeaders(
  secret: string,
  id: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const raw = atob(secret.replace(/^whsec_/, ''));
  const keyBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const hmac = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${id}.${timestampSeconds}.${body}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, signed));
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': `v1,${base64(mac)}`,
  };
}

if (import.meta.main) {
  const [id, body] = process.argv.slice(2);
  const secret = process.env.WEBHOOK_SECRET;
  if (id === undefined || body === undefined || secret === undefined) {
    console.error("usage: WEBHOOK_SECRET=whsec_... bun run sign <webhook-id> '<body>'");
    process.exit(1);
  }
  // One curl header per line, for curl -H @file.
  for (const [name, value] of Object.entries(await signatureHeaders(secret, id, body))) {
    console.log(`${name}: ${value}`);
  }
}
