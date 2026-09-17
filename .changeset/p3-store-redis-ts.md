---
"@anyonce/stores": minor
---

Redis store for @anyonce/stores (`@anyonce/stores/redis`): `RedisStore`, `RedisStoreOptions`, `RedisAdapter`, the `fromIoredis`, `fromNodeRedis` and `fromUpstash` client adapters, and the `BEGIN_LUA`, `COMPLETE_LUA` and `ABANDON_LUA` scripts. Every transition is a single Lua script run with EVALSHA and an EVAL fallback on NOSCRIPT, with the sha cached per store. Bodies are stored base64 so the Upstash REST client stays binary safe, which adds `bytesToBase64` and `base64ToBytes` to the package root.
