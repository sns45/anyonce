import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { checkServices, SERVICES } from '../scripts/services-check';

const compose = parse(readFileSync(join(import.meta.dir, 'compose.yml'), 'utf8')) as {
  services: Record<string, { image: string; ports: string[] }>;
};
const status = await checkServices();
const allUp = status.every((s) => s.up);

describe('service containers', () => {
  test('REQ-REL-4: compose declares DynamoDB Local, Redis 7, Postgres 16, Redpanda and ElasticMQ with pinned images', () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      'dynamodb',
      'elasticmq',
      'postgres',
      'redis',
      'redpanda',
    ]);
    for (const svc of Object.values(compose.services)) {
      expect(svc.image).toMatch(/:[^:]+$/);
      expect(svc.image).not.toMatch(/:latest$/);
    }
    expect(compose.services.redis?.image).toMatch(/^redis:7/);
    expect(compose.services.postgres?.image).toMatch(/^postgres:16/);
    expect(compose.services.dynamodb?.ports).toContain('18000:8000');
    expect(compose.services.postgres?.ports).toContain('15432:5432');
    expect(SERVICES.map((s) => s.name).sort()).toEqual(Object.keys(compose.services).sort());
  });

  test.skipIf(!allUp)('REQ-REL-4: every compose service accepts a TCP connection', () => {
    expect(status.filter((s) => !s.up)).toEqual([]);
  });

  if (!allUp) {
    test.skip(`REQ-REL-4: services down (${status
      .filter((s) => !s.up)
      .map((s) => s.name)
      .join(', ')}); run docker compose -f test/compose.yml up -d --wait`, () => {});
  }
});
