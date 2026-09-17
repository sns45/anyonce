import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { CORE_IDS, PROFILE_IDS } from '../../../conformance/test/catalog';
import { withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';

/** The subset of a Lambda function URL (payload 2.0) event and result that a fetch shim needs. */
interface FunctionUrlEvent {
  version: '2.0';
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  requestContext: { http: { method: string } };
  body?: string;
  isBase64Encoded: boolean;
}
interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A minimal Lambda fetch shim: event to Request, Response to result. Examples in P6 use the real adapters. */
function toLambdaHandler(fetchHandler: (req: Request) => Promise<Response>) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const url = `http://lambda.invalid${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
    const init: RequestInit = { method: event.requestContext.http.method, headers: event.headers };
    if (event.body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
      init.body = (event.isBase64Encoded ? fromBase64(event.body) : event.body) as BodyInit;
    }
    const res = await fetchHandler(new Request(url, init));
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      statusCode: res.status,
      headers,
      body: toBase64(new Uint8Array(await res.arrayBuffer())),
      isBase64Encoded: true,
    };
  };
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  const app = createFixtureApp();
  const lambda = toLambdaHandler(
    withIdempotency(app.fetch, {
      store: new MemoryStore(),
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    }),
  );
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const event: FunctionUrlEvent = {
        version: '2.0',
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers,
        requestContext: { http: { method: req.method } },
        isBase64Encoded: true,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        event.body = toBase64(new Uint8Array(await req.arrayBuffer()));
      }
      const result = await lambda(event);
      const body =
        result.body === ''
          ? null
          : ((result.isBase64Encoded ? fromBase64(result.body) : result.body) as BodyInit);
      return new Response(body, {
        status: result.statusCode,
        headers: result.headers,
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

describe('lambda function url harness', () => {
  test('REQ-HTTP-17: the URL-mode runner passes every vector against a Lambda-shaped handler behind withIdempotency', async () => {
    const { summary, report } = await runConformance({
      target: { baseUrl },
      capabilities: ['short-ttl'],
      report: 'markdown',
    });
    const notPassing = summary.results
      .filter((r) => r.status !== 'pass')
      .map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.passed).toBe(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
