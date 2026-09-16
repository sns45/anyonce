/** Vector ids by tier. Kept in a plain module so test files never import each other. */
export const CORE_IDS = [
  'core/concurrent-409',
  'core/expiry-executes-again',
  'core/get-ignored',
  'core/header-name-case-insensitive',
  'core/key-missing-required',
  'core/mismatch-422',
  'core/mismatch-does-not-poison',
  'core/post-executes-once',
  'core/retry-replays',
  'core/sf-string-quoted-key',
  'core/two-keys-execute-twice',
];

export const PROFILE_IDS = [
  'profile/4xx-replayed',
  'profile/5xx-not-stored',
  'profile/key-too-long',
  'profile/omitted-body-replay',
  'profile/problem-code-member',
  'profile/replayed-header',
  'profile/retry-after-on-409',
];

/** Vectors that hold even without an idempotency layer: they only assert that handlers execute. */
export const BARE_PASS_IDS = [
  'core/expiry-executes-again',
  'core/get-ignored',
  'core/post-executes-once',
  'core/two-keys-execute-twice',
  'profile/5xx-not-stored',
];
