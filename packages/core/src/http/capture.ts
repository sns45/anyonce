import type { IdempotencyRecord, StoredResult } from '../types';

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** REQ-HTTP-8: allowlisted names, lowercased by Headers iteration; Set-Cookie is dropped whatever the allowlist says. */
export function storedHeaders(headers: Headers, allow: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    if (allow.has(name)) out.push([name, value]);
  });
  return out;
}

export interface Capture {
  /** The response to hand to the client. Its stream (when streaming) closes only when close() is called. */
  response: Response;
  /**
   * Resolves when the handler's body has been consumed, which the client's reads drive (or the drain that a
   * client cancel starts); the body may exceed the cap by up to one chunk.
   */
  stored: Promise<StoredResult>;
  /** False for a bodiless response: nothing to stream, so the caller releases it after the record settles. */
  streaming: boolean;
  close(): void;
  fail(reason: unknown): void;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * REQ-HTTP-7: streams the handler's body to the client while buffering a copy. The pump is pull driven, one source
 * read per client pull at the default high water mark, so a slow client holds the handler's source back instead of
 * letting it run ahead into memory; a client cancel hands the rest to a free running drain so the copy is still
 * complete. Buffering stops once the copy is larger than maxResultBytes (the engine then stores the omitted form),
 * so the buffered copy is bounded by the cap plus one chunk. The client stream is closed by the caller, after the
 * record has settled.
 */
export function captureResponse(
  res: Response,
  allow: Set<string>,
  maxResultBytes: number,
  extraHeaders: [string, string][] = [],
): Capture {
  const headers = new Headers(res.headers);
  for (const [name, value] of extraHeaders) headers.set(name, value);
  const base: StoredResult = {
    kind: 'http',
    status: res.status,
    headers: storedHeaders(res.headers, allow),
  };

  if (res.body === null || NULL_BODY_STATUS.has(res.status)) {
    const stored: StoredResult = { ...base, body: new Uint8Array(0) };
    return {
      response: new Response(null, { status: res.status, statusText: res.statusText, headers }),
      stored: Promise.resolve(stored),
      streaming: false,
      close() {
        // bodiless: nothing to close
      },
      fail() {
        // bodiless: nothing to fail
      },
    };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overCap = false;
  let clientOpen = true;
  let settled = false;

  let resolveStored!: (result: StoredResult) => void;
  let rejectStored!: (reason: unknown) => void;
  const stored = new Promise<StoredResult>((resolve, reject) => {
    resolveStored = resolve;
    rejectStored = reject;
  });
  // A source error reaches the client read first, so the caller may attach its handler a turn later; a no-op
  // handler keeps a runtime from reporting an unhandled rejection in that window. The caller still sees it.
  void stored.catch(() => undefined);

  function record(value: Uint8Array): void {
    if (overCap) return;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxResultBytes) overCap = true;
  }

  /** The source is exhausted or errored: release it and settle the record, exactly once. */
  function finish(error?: { reason: unknown }): void {
    if (settled) return;
    settled = true;
    reader.releaseLock();
    if (error !== undefined) rejectStored(error.reason);
    else resolveStored({ ...base, body: concat(chunks, size) });
  }

  /** After a client cancel there is nobody left to pull, so the copy is drained free running. */
  async function drain(): Promise<void> {
    for (;;) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (error) {
        finish({ reason: error });
        return;
      }
      if (done === true) {
        finish();
        return;
      }
      if (value !== undefined) record(value);
    }
  }

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const clientBody = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    /** One source read per pull, so a slow client holds back the handler (REQ-HTTP-7). */
    async pull(c) {
      if (settled) return;
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (error) {
        if (clientOpen) {
          clientOpen = false;
          c.error(error);
        }
        finish({ reason: error });
        return;
      }
      if (done === true) {
        // The caller closes the client stream once the record has settled.
        finish();
        return;
      }
      if (value === undefined) return;
      if (clientOpen) {
        try {
          c.enqueue(value);
        } catch {
          // The client went away between our clientOpen check and this call (a cancel racing the pull on a
          // runtime whose cancel callback is not synchronous); never let that fail the stored copy.
          clientOpen = false;
        }
      }
      record(value);
    },
    cancel() {
      clientOpen = false;
      void drain();
    },
  });

  return {
    response: new Response(clientBody, { status: res.status, statusText: res.statusText, headers }),
    stored,
    streaming: true,
    close() {
      if (!clientOpen) return;
      clientOpen = false;
      controller.close();
    },
    fail(reason) {
      if (!clientOpen) return;
      clientOpen = false;
      controller.error(reason);
      // Nobody will pull again, so the source is cancelled and the record settles now.
      if (!settled) {
        reader.cancel(reason).catch(() => {});
        finish({ reason });
      }
    },
  };
}

/** REQ-HTTP-9 and D12. */
export function replayResponse(record: IdempotencyRecord): Response {
  const result = record.result;
  const status = result?.status ?? 200;
  const headers = new Headers(result?.headers ?? []);
  headers.set('Idempotency-Replayed', 'true');
  if (record.resultOmitted === true) headers.set('Idempotency-Replay', 'omitted');
  const body = result?.body;
  const useBody =
    record.resultOmitted !== true &&
    body !== undefined &&
    body.byteLength > 0 &&
    !NULL_BODY_STATUS.has(status);
  const responseBody: BodyInit | null = useBody ? (body as BodyInit) : null;
  return new Response(responseBody, { status, headers });
}
