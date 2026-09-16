import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const root = join(import.meta.dir, '../../../conformance');
const schemaPath = join(root, 'schema.json');

function listVectorFiles(): string[] {
  const out: string[] = [];
  for (const tier of ['core', 'profile']) {
    const dir = join(root, 'vectors', tier);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.json')) out.push(join(dir, name));
    }
  }
  return out.sort();
}

describe('vector schema', () => {
  test('REQ-CONF-1: schema.json is a JSON Schema 2020-12 document', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  test('REQ-CONF-1: every vector validates against schema.json', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const files = listVectorFiles();
    expect(files.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const file of files) {
      const vector = JSON.parse(readFileSync(file, 'utf8'));
      if (!validate(vector)) {
        failures.push(`${file}: ${ajv.errorsText(validate.errors)}`);
      }
      const expectedId = file.replace(/^.*\/vectors\//, '').replace(/\.json$/, '');
      if (vector.id !== expectedId)
        failures.push(`${file}: id ${vector.id} must equal ${expectedId}`);
    }
    expect(failures).toEqual([]);
  });

  test('REQ-CONF-1: step ids are unique and every reference points at an earlier step', () => {
    const failures: string[] = [];
    for (const file of listVectorFiles()) {
      const vector = JSON.parse(readFileSync(file, 'utf8'));
      const seen = new Set<string>();
      for (const step of vector.steps) {
        if (seen.has(step.id)) failures.push(`${vector.id}: duplicate step id ${step.id}`);
        for (const ref of step.concurrentWith ?? []) {
          if (!seen.has(ref))
            failures.push(`${vector.id}: step ${step.id} concurrentWith unknown ${ref}`);
        }
        const same = step.expect.bodyEquals;
        if (typeof same === 'object' && same !== null && !seen.has(same.sameAs)) {
          failures.push(`${vector.id}: step ${step.id} sameAs unknown ${same.sameAs}`);
        }
        seen.add(step.id);
      }
    }
    expect(failures).toEqual([]);
  });
});
