/**
 * D16: the verified marker an upstream verifier sets. It lives in a WeakMap keyed by the Request object rather
 * than in a header, because a header can be forged by anything that reaches the receiver and the whole point of
 * the gate is that a forged delivery never claims to be verified. A fetch handler has no context object, so the
 * Request itself is the context.
 */
const markers = new WeakMap<Request, Set<string>>();

/** Records that this request has been verified under the named marker. Call it on the Request the receiver sees. */
export function markVerified(req: Request, marker: string): void {
  const set = markers.get(req);
  if (set === undefined) markers.set(req, new Set([marker]));
  else set.add(marker);
}

/** Reports whether markVerified was called for this request and marker. */
export function isVerified(req: Request, marker: string): boolean {
  return markers.get(req)?.has(marker) === true;
}
