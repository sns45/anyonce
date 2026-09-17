import { describe, expect, test } from 'bun:test';
import { newKey, redactKey } from '../src/keygen';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newKey', () => {
  test('REQ-CORE-5: returns a lowercase UUID version 4', () => {
    expect(newKey()).toMatch(UUID_V4);
  });

  test('REQ-CORE-5: 10000 keys are unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newKey());
    expect(seen.size).toBe(10_000);
  });
});

describe('redactKey', () => {
  test('NFR-2: keeps the first 8 characters and appends an ellipsis', () => {
    expect(redactKey('8e03978e-40d5-43e8-bc93-6894a57f9324')).toBe('8e03978e…');
    expect(redactKey('short')).toBe('short…');
  });
});
