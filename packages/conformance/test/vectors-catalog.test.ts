import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_IDS, PROFILE_IDS } from './catalog';

const vectorsDir = join(import.meta.dir, '../../../conformance/vectors');

type Loaded = { id: string; tier: string; draftRef?: string; requires?: string[] };

function loadTier(tier: string): Loaded[] {
  return readdirSync(join(vectorsDir, tier))
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(vectorsDir, tier, n), 'utf8')) as Loaded)
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('vector catalog', () => {
  test('REQ-CONF-3: core tier contains the minimum vector set', () => {
    expect(loadTier('core').map((v) => v.id)).toEqual(CORE_IDS);
  });

  test('REQ-CONF-3: every core vector cites a draft section', () => {
    for (const v of loadTier('core')) {
      expect(v.tier).toBe('core');
      expect(v.draftRef).toMatch(/^section-\d/);
    }
  });

  test('REQ-CONF-3: only the expiry vector requires a capability', () => {
    const requiring = loadTier('core')
      .filter((v) => (v.requires ?? []).length > 0)
      .map((v) => v.id);
    expect(requiring).toEqual(['core/expiry-executes-again']);
  });

  test('REQ-CONF-4: profile tier contains the anyonce extension vectors', () => {
    expect(loadTier('profile').map((v) => v.id)).toEqual(PROFILE_IDS);
  });

  test('REQ-CONF-4: profile vectors never require a capability', () => {
    expect(loadTier('profile').filter((v) => (v.requires ?? []).length > 0)).toEqual([]);
  });
});
