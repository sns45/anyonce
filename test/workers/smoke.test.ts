import { describe, expect, test } from 'vitest';

describe('workerd', () => {
  test('REQ-REL-4: tests execute inside workerd with Web Crypto available', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('')),
    );
    expect(digest[0]).toBe(0xe3);
    expect(digest[31]).toBe(0x55);
  });
});
