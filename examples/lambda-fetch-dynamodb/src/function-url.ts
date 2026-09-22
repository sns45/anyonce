/**
 * Lambda function URL payload format 2.0, converted to and from the Fetch API. Only the fields this example
 * reads are typed; a real event carries more (requestContext.accountId, apiId, stage and so on).
 *
 * Bodies travel base64 encoded in both directions, so a binary body survives the trip byte for byte.
 */

export interface FunctionUrlEvent {
  version: '2.0';
  rawPath: string;
  rawQueryString: string;
  /** Lambda moves the Cookie header here, one entry per cookie. */
  cookies?: string[];
  /** Lower cased names; repeated headers arrive comma joined. */
  headers: Record<string, string>;
  requestContext: {
    domainName: string;
    requestId: string;
    timeEpoch: number;
    http: { method: string; path: string; protocol: string; sourceIp: string; userAgent: string };
  };
  body?: string;
  isBase64Encoded: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  /** Set-Cookie values, one per cookie; a function URL cannot carry them in headers. */
  cookies: string[];
  body: string;
  isBase64Encoded: boolean;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a large body does not exceed the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const NO_BODY_METHODS = new Set(['GET', 'HEAD']);
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** The function URL event as a Request: what the handler below sees. */
export function toRequest(event: FunctionUrlEvent): Request {
  const query = event.rawQueryString === '' ? '' : `?${event.rawQueryString}`;
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const headers = new Headers(event.headers);
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }
  const method = event.requestContext.http.method;
  const init: RequestInit = { method, headers };
  if (event.body !== undefined && !NO_BODY_METHODS.has(method)) {
    init.body = event.isBase64Encoded ? (fromBase64(event.body) as BufferSource) : event.body;
  }
  return new Request(url, init);
}

/** The Response as a function URL result. Reads the whole body, so the idempotency record has settled. */
export async function toResult(response: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers,
    cookies: response.headers.getSetCookie(),
    body: toBase64(body),
    isBase64Encoded: true,
  };
}

/** The other direction, for a local harness: an HTTP request as the event Lambda would deliver. */
export async function toEvent(req: Request): Promise<FunctionUrlEvent> {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, name) => {
    if (name !== 'cookie') headers[name] = value;
  });
  const cookie = req.headers.get('cookie');
  const event: FunctionUrlEvent = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    requestContext: {
      domainName: url.host,
      requestId: crypto.randomUUID(),
      timeEpoch: Date.now(),
      http: {
        method: req.method,
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: req.headers.get('user-agent') ?? '',
      },
    },
    isBase64Encoded: false,
  };
  if (cookie !== null) event.cookies = cookie.split(/;\s*/).filter((c) => c !== '');
  if (req.body !== null) {
    event.body = toBase64(new Uint8Array(await req.arrayBuffer()));
    event.isBase64Encoded = true;
  }
  return event;
}

/** The function URL result as the HTTP response a client would receive, for a local harness. */
export function fromResult(result: FunctionUrlResult): Response {
  const headers = new Headers(result.headers);
  for (const cookie of result.cookies) headers.append('set-cookie', cookie);
  const bytes = result.isBase64Encoded
    ? fromBase64(result.body)
    : new TextEncoder().encode(result.body);
  const body = bytes.byteLength === 0 || NULL_BODY_STATUS.has(result.statusCode) ? null : bytes;
  return new Response(body as BodyInit | null, { status: result.statusCode, headers });
}
