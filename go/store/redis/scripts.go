package redis

// The three Lua scripts below are copied byte for byte from packages/stores/src/redis.ts (BEGIN_LUA,
// COMPLETE_LUA, ABANDON_LUA) so both languages run the same logic; a parity test in Task 11 asserts it.

// beginLua is KEYS[1] the hash; ARGV fingerprint, now, leaseMs, ttlMs, graceMs. It returns
// {'acquired', fence} | {'in_flight', leaseUntil} | {'completed', ...HGETALL} | {'mismatch', ...HGETALL}.
const beginLua = `
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
`

// completeLua takes ARGV fence, now, meta, body ('-' for none), omitted. It returns ok | stale_fence |
// not_found.
const completeLua = `
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
`

// abandonLua takes ARGV fence. It returns ok | stale_fence | not_found.
const abandonLua = `
local k = KEYS[1]
local fence = tonumber(ARGV[1])
local row = redis.call('HMGET', k, 'fence', 'state')
if not row[1] or row[2] ~= 'in_flight' then return 'not_found' end
if tonumber(row[1]) ~= fence then return 'stale_fence' end
redis.call('DEL', k)
return 'ok'
`
