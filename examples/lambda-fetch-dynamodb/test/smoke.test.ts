import { afterAll, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { DynamoDbStore, ensureTable } from '@anyonce/stores/dynamodb';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { fromResult, toEvent, toRequest, toResult } from '../src/function-url';
import { createApp, functionUrlHandler, handler, idempotencyOptions } from '../src/handler';
import { localClient, serveFunctionUrl } from '../src/local';

const DYNAMODB_PORT = 18000;

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

describe('lambda-fetch-dynamodb function URL conversion', () => {
  test('REQ-HTTP-17: function URL conversion round trips headers, cookies and a binary body', async () => {
    const bytes = new Uint8Array([0, 1, 2, 0xfe, 0xff, 0x80, 0x0a]);
    const req = new Request('https://abc.lambda-url.us-east-1.on.aws/payments?a=1&b=two', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': '"pay-1"',
        'X-Multi': 'one, two',
        Cookie: 'session=s1; theme=dark',
      },
      body: bytes,
    });
    const event = await toEvent(req);
    expect(event.version).toBe('2.0');
    expect(event.rawPath).toBe('/payments');
    expect(event.rawQueryString).toBe('a=1&b=two');
    expect(event.requestContext.http.method).toBe('POST');
    expect(event.cookies).toEqual(['session=s1', 'theme=dark']);
    expect(event.headers.cookie).toBeUndefined();
    expect(event.isBase64Encoded).toBe(true);

    const back = toRequest(event);
    expect(back.method).toBe('POST');
    expect(back.url).toBe('https://abc.lambda-url.us-east-1.on.aws/payments?a=1&b=two');
    expect(back.headers.get('idempotency-key')).toBe('"pay-1"');
    expect(back.headers.get('x-multi')).toBe('one, two');
    expect(back.headers.get('cookie')).toBe('session=s1; theme=dark');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);

    const headers = new Headers({ 'Content-Type': 'application/octet-stream', ETag: '"v1"' });
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; HttpOnly');
    const result = await toResult(new Response(bytes, { status: 201, headers }));
    expect(result.statusCode).toBe(201);
    expect(result.isBase64Encoded).toBe(true);
    expect(result.cookies).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers.etag).toBe('"v1"');

    const res = fromResult(result);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    const empty = await toResult(new Response(null, { status: 204 }));
    expect(empty.statusCode).toBe(204);
    expect(empty.body).toBe('');
    const plain = toRequest(await toEvent(new Request('https://x.test/counter')));
    expect(plain.method).toBe('GET');
    expect(plain.body).toBeNull();
  });

  test('REQ-HTTP-17: the example configures maxResultBytes at 300 KiB for the DynamoDB item limit', () => {
    expect(idempotencyOptions({ store: new MemoryStore() }).maxResultBytes).toBe(300 * 1024);
  });
});

const up = await tcpOpen(DYNAMODB_PORT);
if (!up) {
  test.skip(`lambda-fetch-dynamodb: service down on 127.0.0.1:${DYNAMODB_PORT}; run docker compose -f test/compose.yml up -d --wait dynamodb`, () => {});
} else {
  describe('lambda-fetch-dynamodb over DynamoDB Local', () => {
    const client = localClient(`http://127.0.0.1:${DYNAMODB_PORT}`);
    const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
    const tables: string[] = [];
    afterAll(async () => {
      for (const server of servers) server.stop(true);
      for (const TableName of tables) await client.send(new DeleteTableCommand({ TableName }));
      // An open client socket would keep bun from exiting.
      client.destroy();
    });

    async function freshTable(): Promise<string> {
      const tableName = `anyonce_example_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await ensureTable(client, tableName);
      tables.push(tableName);
      return tableName;
    }

    async function freshStore(): Promise<DynamoDbStore> {
      return new DynamoDbStore({ client, tableName: await freshTable() });
    }

    test('REQ-DOC-7: lambda-fetch-dynamodb replays a completed POST through the function URL harness', async () => {
      const handler = functionUrlHandler(createApp({ store: await freshStore() }));
      const server = serveFunctionUrl({ handler, port: 0 });
      servers.push(server);
      const pay = (body: string) =>
        fetch(new URL('/payments', server.url), {
          method: 'POST',
          headers: { 'Idempotency-Key': 'payment-readme-1', 'Content-Type': 'application/json' },
          body,
        });

      const first = await pay('{"amount":1200,"currency":"EUR"}');
      expect(first.status).toBe(201);
      expect(first.headers.get('Idempotency-Replayed')).toBeNull();
      const created = (await first.json()) as { id: string; amount: number };
      expect(created.amount).toBe(1200);

      const second = await pay('{"amount":1200,"currency":"EUR"}');
      expect(second.status).toBe(201);
      expect(second.headers.get('Idempotency-Replayed')).toBe('true');
      expect(await second.json()).toEqual(created);

      const changed = await pay('{"amount":9900,"currency":"EUR"}');
      expect(changed.status).toBe(422);
      expect(((await changed.json()) as { code: string }).code).toBe('fingerprint-mismatch');
    });

    test('REQ-DOC-7: the exported Lambda handler builds its own client from the environment and replays', async () => {
      const names = [
        'AWS_ENDPOINT_URL_DYNAMODB',
        'AWS_REGION',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'TABLE_NAME',
      ] as const;
      const saved = new Map(names.map((name) => [name, process.env[name]]));
      try {
        // What the Lambda runtime would provide, pointed at DynamoDB Local.
        process.env.AWS_ENDPOINT_URL_DYNAMODB = `http://127.0.0.1:${DYNAMODB_PORT}`;
        process.env.AWS_REGION = 'us-east-1';
        process.env.AWS_ACCESS_KEY_ID = 'local';
        process.env.AWS_SECRET_ACCESS_KEY = 'local';
        process.env.TABLE_NAME = await freshTable();
        const server = serveFunctionUrl({ handler, port: 0 });
        servers.push(server);
        const pay = (body: string) =>
          fetch(new URL('/payments', server.url), {
            method: 'POST',
            headers: { 'Idempotency-Key': 'payment-entry-1', 'Content-Type': 'application/json' },
            body,
          });

        const first = await pay('{"amount":500,"currency":"USD"}');
        expect(first.status).toBe(201);
        const created = await first.json();
        const second = await pay('{"amount":500,"currency":"USD"}');
        expect(second.status).toBe(201);
        expect(second.headers.get('Idempotency-Replayed')).toBe('true');
        expect(await second.json()).toEqual(created);

        const malformed = await fetch(new URL('/payments', server.url), {
          method: 'POST',
          headers: { 'Idempotency-Key': 'payment-entry-2', 'Content-Type': 'application/json' },
          body: '{"amount":',
        });
        expect(malformed.status).toBe(400);
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });

    test('REQ-HTTP-17: lambda-fetch-dynamodb passes the core and profile tiers over a local function URL harness', async () => {
      const fixture = createFixtureApp();
      // The fixture routes behind the example's own withIdempotency configuration, reached only through the
      // function URL event conversion. Only the TTL differs, so the short-ttl vector fits the time budget.
      const handler = functionUrlHandler(
        createApp({ store: await freshStore(), ttlMs: 2000, routes: fixture.fetch }),
      );
      // POST /reset is the runner's control path. It stays outside the function, the way the Hono fixture
      // mounts it ahead of the idempotency layer.
      const server = serveFunctionUrl({
        handler,
        port: 0,
        control: (req) => (new URL(req.url).pathname === '/reset' ? fixture.fetch(req) : undefined),
      });
      servers.push(server);
      const { summary, report } = await runConformance({
        target: { baseUrl: server.url.origin },
        capabilities: ['short-ttl'],
        report: 'markdown',
      });
      expect(
        summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`),
        report,
      ).toEqual([]);
      expect(summary.passed).toBe(20);
    }, 60_000);
  });
}
