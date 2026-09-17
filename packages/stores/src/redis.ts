import type {
  BeginOptions,
  BeginOutcome,
  CompleteStatus,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  Store,
  StoredResult,
} from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import {
  base64ToBytes,
  bytesToBase64,
  encodeResultMeta,
  type RecordRow,
  rowToRecord,
} from './codec';

/** The four calls the store needs; three client shapes are wrapped below. */
export interface RedisAdapter {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}

interface IoredisLike {
  evalsha(sha: string, numkeys: number, ...args: string[]): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}
interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}
interface UpstashLike {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  del(key: string): Promise<unknown>;
}

export function fromIoredis(client: IoredisLike): RedisAdapter {
  return {
    evalsha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args),
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
    hgetall: (key) => client.hgetall(key),
    del: (key) => client.del(key),
  };
}

export function fromNodeRedis(client: NodeRedisLike): RedisAdapter {
  return {
    evalsha: (sha, keys, args) => client.evalSha(sha, { keys, arguments: args }),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
    hgetall: (key) => client.hGetAll(key),
    del: (key) => client.del(key),
  };
}

export function fromUpstash(client: UpstashLike): RedisAdapter {
  return {
    evalsha: (sha, keys, args) => client.evalsha(sha, keys, args),
    eval: (script, keys, args) => client.eval(script, keys, args),
    hgetall: async (key) => {
      const out = await client.hgetall(key);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(out ?? {})) flat[k] = String(v);
      return flat;
    },
    del: (key) => client.del(key),
  };
}

/** KEYS[1] hash; ARGV fingerprint, now, leaseMs, ttlMs, graceMs. Returns {'acquired', fence} | {'in_flight', leaseUntil} | {'completed', ...HGETALL} | {'mismatch', ...HGETALL}. */
export const BEGIN_LUA = `
local k = KEYS[1]
local fp = ARGV[1]
local now = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local grace = tonumber(ARGV[5])
local row = redis.call('HMGET', k, 'fingerprint', 'state', 'fence', 'lease_until', 'expires_at')
local fence = 1
if row[1] then
  if tonumber(row[5]) > now then
    if row[1] ~= fp then
      local all = redis.call('HGETALL', k)
      table.insert(all, 1, 'mismatch')
      return all
    end
    if row[2] == 'completed' then
      local all = redis.call('HGETALL', k)
      table.insert(all, 1, 'completed')
      return all
    end
    if tonumber(row[4]) > now then
      return {'in_flight', row[4]}
    end
  end
  fence = tonumber(row[3]) + 1
end
redis.call('HSET', k, 'fingerprint', fp, 'state', 'in_flight', 'fence', fence, 'lease_until', now + lease, 'created_at', now, 'expires_at', now + ttl, 'result_omitted', 0)
redis.call('HDEL', k, 'result_meta', 'result_body')
redis.call('PEXPIRE', k, ttl + grace)
return {'acquired', fence}
`;

/** ARGV fence, now, meta, body ('-' for none), omitted. Returns ok | stale_fence | not_found. */
export const COMPLETE_LUA = `
local k = KEYS[1]
local fence = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local row = redis.call('HMGET', k, 'fence', 'state', 'expires_at')
if not row[1] or tonumber(row[3]) <= now then return 'not_found' end
if tonumber(row[1]) ~= fence then return 'stale_fence' end
if row[2] == 'completed' then return 'ok' end
redis.call('HSET', k, 'state', 'completed', 'result_meta', ARGV[3], 'result_omitted', ARGV[5])
if ARGV[4] == '-' then redis.call('HDEL', k, 'result_body') else redis.call('HSET', k, 'result_body', ARGV[4]) end
return 'ok'
`;

/** ARGV fence. Returns ok | stale_fence | not_found. */
export const ABANDON_LUA = `
local k = KEYS[1]
local fence = tonumber(ARGV[1])
local row = redis.call('HMGET', k, 'fence', 'state')
if not row[1] or row[2] ~= 'in_flight' then return 'not_found' end
if tonumber(row[1]) ~= fence then return 'stale_fence' end
redis.call('DEL', k)
return 'ok'
`;

export interface RedisStoreOptions {
  adapter: RedisAdapter;
  /** Key prefix. Default anyonce: */
  prefix?: string;
  /** Added to PEXPIRE so a late complete from the previous fence holder still finds its hash. Default 60000. */
  nativeTtlGraceMs?: number;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)),
  );
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

function hashToRow(scope: string, key: string, fields: Record<string, string>): RecordRow {
  return {
    scope,
    key,
    fingerprint: fields.fingerprint ?? '',
    state: (fields.state as RecordRow['state']) ?? 'in_flight',
    fence: Number(fields.fence ?? 0),
    lease_until: Number(fields.lease_until ?? 0),
    created_at: Number(fields.created_at ?? 0),
    expires_at: Number(fields.expires_at ?? 0),
    result_meta: fields.result_meta ?? null,
    result_body: fields.result_body === undefined ? null : base64ToBytes(fields.result_body),
    result_omitted: Number(fields.result_omitted ?? 0),
  };
}

function pairsToFields(pairs: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) out[String(pairs[i])] = String(pairs[i + 1]);
  return out;
}

/** REQ-ST-REDIS-1: every state transition is one Lua script (EVALSHA, EVAL on NOSCRIPT), one hash per record. */
export class RedisStore implements Store {
  private readonly adapter: RedisAdapter;
  private readonly prefix: string;
  private readonly grace: number;
  private readonly shas = new Map<string, string>();

  constructor(options: RedisStoreOptions) {
    this.adapter = options.adapter;
    this.prefix = options.prefix ?? 'anyonce:';
    this.grace = options.nativeTtlGraceMs ?? 60_000;
  }

  keyFor(op: Pick<Operation, 'scope' | 'key'>): string {
    return `${this.prefix}${op.scope}\x1f${op.key}`;
  }

  private async run(script: string, keys: string[], args: string[]): Promise<unknown> {
    let sha = this.shas.get(script);
    if (sha === undefined) {
      sha = await sha1Hex(script);
      this.shas.set(script, sha);
    }
    try {
      return await this.adapter.evalsha(sha, keys, args);
    } catch (error) {
      if (!(error instanceof Error && /NOSCRIPT/i.test(error.message))) throw error;
      return this.adapter.eval(script, keys, args);
    }
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    const reply = (await this.run(
      BEGIN_LUA,
      [this.keyFor(op)],
      [
        op.fingerprint,
        String(opts.now),
        String(opts.leaseMs),
        String(opts.ttlMs),
        String(this.grace),
      ],
    )) as unknown[];
    const tag = String(reply[0]);
    if (tag === 'acquired') return { outcome: 'acquired', fence: Number(reply[1]) };
    if (tag === 'in_flight') return { outcome: 'in_flight', leaseUntil: Number(reply[1]) };
    const record = rowToRecord(hashToRow(op.scope, op.key, pairsToFields(reply.slice(1))));
    return tag === 'completed' ? { outcome: 'completed', record } : { outcome: 'mismatch', record };
  }

  async complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted || result.body === undefined ? '-' : bytesToBase64(result.body);
    const reply = await this.run(
      COMPLETE_LUA,
      [this.keyFor(op)],
      [String(fence), String(now), encodeResultMeta(result), body, omitted ? '1' : '0'],
    );
    return String(reply) as CompleteStatus;
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    return String(
      await this.run(ABANDON_LUA, [this.keyFor(op)], [String(fence)]),
    ) as CompleteStatus;
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const fields = await this.adapter.hgetall(this.keyFor(op));
    if (fields.fingerprint === undefined) return null;
    const row = hashToRow(op.scope, op.key, fields);
    return row.expires_at > now ? rowToRecord(row) : null;
  }

  /** PEXPIRE sweeps expired hashes; nothing to do here (Q21). */
  async purge(_now: number): Promise<number> {
    return 0;
  }

  /** Test-only: what the native expiry would do. */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.adapter.del(this.keyFor(op));
  }
}
