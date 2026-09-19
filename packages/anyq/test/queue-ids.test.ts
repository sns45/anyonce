import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(import.meta.dir, '../../../docs/queue-ids.md'), 'utf8');
const rows = doc
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .map((line) => line.split('|').map((cell) => cell.trim()));

const CONSUMER_ADAPTERS = [
  'memory',
  'redis-streams',
  'rabbitmq',
  'sqs',
  'google-pubsub',
  'kafka',
  'nats',
  'azure-servicebus',
  'cloudflare-queues',
  'pgmq',
];

describe('docs/queue-ids.md', () => {
  test('REQ-DOC-9: one row per anyq consumer adapter', () => {
    expect(rows.map((row) => row[1]?.replaceAll('`', ''))).toEqual(CONSUMER_ADAPTERS);
  });

  test('REQ-DOC-9: the four adapters P4a tested are marked verified and the rest are marked unverified', () => {
    const verified = rows
      .filter((row) =>
        row.some((cell) => cell.includes('verified') && !cell.includes('unverified')),
      )
      .map((row) => row[1]?.replaceAll('`', ''));
    expect(verified.sort()).toEqual(['kafka', 'memory', 'redis-streams', 'sqs']);
    const unverified = rows.filter((row) => row.some((cell) => cell.includes('unverified')));
    expect(unverified.length).toBe(CONSUMER_ADAPTERS.length - 4);
  });

  test('REQ-DOC-9: the page recommends a producer supplied header where the id is not stable', () => {
    expect(doc).toContain('idempotency-key');
    expect(doc).toContain('producer retry');
    expect(doc).toContain('@anyq/sns');
  });
});
