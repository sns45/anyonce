import { evaluateExpect } from './expect';
import { type Sender, type Target, toSender } from './target';
import type {
  Capability,
  ObservedResponse,
  RunSummary,
  Step,
  StepOutcome,
  Tier,
  Vector,
  VectorResult,
} from './types';

export interface RunOptions {
  tiers?: Tier[];
  capabilities?: Capability[];
  only?: string[];
  resetPath?: string;
  counterPath?: string;
}

const decoder = new TextDecoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCounter(send: Sender, counterPath: string): Promise<number | undefined> {
  const res = await send({ method: 'GET', path: counterPath });
  if (res.status !== 200) return undefined;
  try {
    const parsed = JSON.parse(decoder.decode(res.body)) as { count?: unknown };
    return typeof parsed.count === 'number' ? parsed.count : undefined;
  } catch {
    return undefined;
  }
}

function deferredIds(steps: Step[]): Set<string> {
  const ids = new Set<string>();
  for (const step of steps) {
    for (const ref of step.concurrentWith ?? []) ids.add(ref);
  }
  return ids;
}

/** Runs one vector against a sender. Assumes requirements were already checked by the caller. */
export async function runVector(
  send: Sender,
  vector: Vector,
  options: RunOptions = {},
): Promise<VectorResult> {
  const resetPath = options.resetPath ?? '/reset';
  const counterPath = options.counterPath ?? '/counter';
  const outcomes: StepOutcome[] = [];
  const priorBodies = new Map<string, Uint8Array>();
  const pending = new Map<string, { step: Step; promise: Promise<ObservedResponse> }>();
  const deferred = deferredIds(vector.steps);

  const evaluateGroup = async (
    group: Array<{ step: Step; response: ObservedResponse }>,
  ): Promise<void> => {
    const needsCounter = group.some((g) => g.step.expect.handlerInvocations !== undefined);
    const handlerInvocations = needsCounter ? await readCounter(send, counterPath) : undefined;
    for (const { step, response } of group) {
      const ctx =
        handlerInvocations === undefined ? { priorBodies } : { priorBodies, handlerInvocations };
      outcomes.push({ stepId: step.id, failures: evaluateExpect(step.expect, response, ctx) });
      priorBodies.set(step.id, response.body);
    }
  };

  const settlePending = async (): Promise<void> => {
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    const responses = await Promise.all(entries.map((e) => e.promise));
    await evaluateGroup(
      entries.map((e, i) => ({ step: e.step, response: responses[i] as ObservedResponse })),
    );
  };

  try {
    const reset = await send({ method: 'POST', path: resetPath });
    if (reset.status < 200 || reset.status >= 300) {
      return {
        id: vector.id,
        tier: vector.tier,
        status: 'error',
        steps: [],
        error: `reset returned ${reset.status}`,
      };
    }

    for (const step of vector.steps) {
      const partners = step.concurrentWith ?? [];
      if (partners.length === 0) await settlePending();
      if (step.delayMs) await sleep(step.delayMs);
      const promise = send(step.request);
      if (deferred.has(step.id)) {
        pending.set(step.id, { step, promise });
        continue;
      }
      if (partners.length > 0) {
        const group = partners
          .map((id) => pending.get(id))
          .filter((e): e is { step: Step; promise: Promise<ObservedResponse> } => e !== undefined);
        for (const id of partners) pending.delete(id);
        const responses = await Promise.all([...group.map((g) => g.promise), promise]);
        const own = responses[responses.length - 1] as ObservedResponse;
        await evaluateGroup([
          ...group.map((g, i) => ({ step: g.step, response: responses[i] as ObservedResponse })),
          { step, response: own },
        ]);
        continue;
      }
      await evaluateGroup([{ step, response: await promise }]);
    }
    await settlePending();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: vector.id, tier: vector.tier, status: 'error', steps: outcomes, error: message };
  }

  const status = outcomes.every((o) => o.failures.length === 0) ? 'pass' : 'fail';
  return { id: vector.id, tier: vector.tier, status, steps: outcomes };
}

/** Runs the selected vectors sequentially and summarizes. */
export async function runVectors(
  target: Target,
  vectors: Vector[],
  options: RunOptions = {},
): Promise<RunSummary> {
  const send = toSender(target);
  const capabilities = new Set<Capability>(options.capabilities ?? []);
  const tiers = options.tiers ? new Set<Tier>(options.tiers) : undefined;
  const only = options.only ? new Set(options.only) : undefined;
  const results: VectorResult[] = [];

  for (const vector of vectors) {
    if (tiers && !tiers.has(vector.tier)) continue;
    if (only && !only.has(vector.id)) continue;
    const missing = (vector.requires ?? []).filter((c) => !capabilities.has(c));
    if (missing.length > 0) {
      results.push({
        id: vector.id,
        tier: vector.tier,
        status: 'not-applicable',
        steps: [],
        error: `requires ${missing.join(', ')}`,
      });
      continue;
    }
    results.push(await runVector(send, vector, options));
  }

  return {
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    notApplicable: results.filter((r) => r.status === 'not-applicable').length,
    errored: results.filter((r) => r.status === 'error').length,
  };
}
