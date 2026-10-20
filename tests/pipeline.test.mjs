import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = readFileSync(new URL('../extensions/orchestrator.ts', import.meta.url), 'utf8');
const script = source.match(/export function buildPipelineScript\(\): string \{\s*return `([\s\S]*?)`\.trim\(\);/)[1];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export async function simulate(overrides = {}, stages) {
  const calls = [], tasks = {};
  const good = { ok: true, output: 'brief', structuredOutput: { verdict: 'clean', findings: [], evidence: 'Inspected diff; node --test exited 0' } };
  const run = async (key, spec) => { calls.push(key); tasks[key] = spec?.task; return { ...good, ...overrides[key] }; };
  const result = await new AsyncFunction('runs', 'args', script)({ run, all: specs => Promise.all(specs.map(s => run(s.key, s))) }, { task: 'test', stages });
  return { calls, result, tasks };
}
test('clean pipeline runs four stages', async () => {
  const { calls, result } = await simulate();
  assert.deepEqual(calls, ['research', 'implement', 'security', 'qa']);
  assert.equal(result.verdict, 'clean');
});
for (const failed of ['research', 'implement']) test(`stop after ${failed} failure`, async () => {
  const { calls, result } = await simulate({ [failed]: { ok: false, error: 'transport failed' } });
  assert.deepEqual(calls, failed === 'research' ? ['research'] : ['research', 'implement']);
  assert.equal(result.verdict, 'unverified');
  assert.match(JSON.stringify(result), /transport failed/);
});
test('successful fix is not independently verified', async () => {
  const { result } = await simulate({ security: { structuredOutput: { verdict: 'blocked', findings: ['unsafe input'], evidence: 'Unsafe interpolation at src/login.ts:12' } } });
  assert.equal(result.verdict, 'fixed-unverified');
});
test('gate requires explicit clean verdict, not just process completion', () => {
  assert.match(source, /completion.success && \(verdict === "clean" \|\| verdict === "completed-with-skips"\)/);
});
test('usage comes from runtime rows and missing values remain unknown', async () => {
  const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: 0.01, turns: 1 };
  const { result } = await simulate({ research: { results: [{ usage }, { usage }] } });
  assert.equal(result.metrics.research.usage.input, 20);
  assert.equal(result.metrics.research.usage.cost, 0.02);
  assert.equal(result.metrics.qa.usage.input, null);
  assert.equal(result.metrics.qa.durationMs, null);
});

for (let mask = 0; mask < 8; mask++) test(`stage toggles combination ${mask}`, async () => {
  const stages = { context: !!(mask & 1), security: !!(mask & 2), qa: !!(mask & 4) };
  const { calls, result } = await simulate({}, stages);
  assert.deepEqual(calls, [stages.context && 'research', 'implement', stages.security && 'security', stages.qa && 'qa'].filter(Boolean));
  assert.equal(result.verdict, stages.security && stages.qa ? 'clean' : 'completed-with-skips');
  assert.deepEqual(result.skipped, [!stages.context && 'research', !stages.security && 'security', !stages.qa && 'qa'].filter(Boolean));
});
test('disabled security does not shift QA result or trigger a missing-verdict fix', async () => {
  const { calls, result } = await simulate({ qa: { structuredOutput: { verdict: 'blocked', findings: ['broken test'], evidence: 'node --test exited 1' } } }, { security: false });
  assert.deepEqual(calls, ['research', 'implement', 'qa', 'fix']);
  assert.equal(result.verdict, 'fixed-unverified');
});

for (const failure of [
  { ok: false, error: 'provider unavailable' },
  { structuredOutput: undefined },
  { structuredOutput: { verdict: 'clean', findings: [] } },
  { structuredOutput: { verdict: 'clean', findings: [], evidence: ' ' } },
  { structuredOutput: { verdict: 'blocked', findings: [], evidence: 'Tests unavailable' } },
]) test('unverified review alone never launches speculative fixer: ' + JSON.stringify(failure), async () => {
  const { calls, result } = await simulate({ security: failure });
  assert.ok(!calls.includes('fix'));
  assert.equal(result.verdict, 'unverified');
});
test('fix receives context and concrete failure evidence', async () => {
  const { tasks, result } = await simulate({ qa: { structuredOutput: { verdict: 'blocked', findings: ['src/a.ts:1 fails'], evidence: 'node --test exited 1: assertion failed' } } });
  assert.match(tasks.fix, /RESEARCH:/);
  assert.match(tasks.fix, /IMPLEMENTATION:/);
  assert.match(tasks.fix, /node --test exited 1: assertion failed/);
  assert.equal(result.verdict, 'fixed-unverified');
});
