import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = readFileSync(new URL('../extensions/orchestrator.ts', import.meta.url), 'utf8');
const script = source.match(/export function buildPipelineScript\(\): string \{\s*return `([\s\S]*?)`\.trim\(\);/)[1];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export async function simulate(overrides = {}) {
  const calls = [];
  const good = { ok: true, output: 'brief', structuredOutput: { verdict: 'clean', findings: [] } };
  const run = async (key) => { calls.push(key); return { ...good, ...overrides[key] }; };
  const result = await new AsyncFunction('runs', 'args', script)({ run, all: specs => Promise.all(specs.map(s => run(s.key))) }, { task: 'test' });
  return { calls, result };
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
test('direct bypass requires explicit operator command and resets each user turn', () => {
  assert.match(source, /if \(arg === "direct"\)/);
  assert.match(source, /const direct = directNextTurn;\s*directNextTurn = false;/);
  assert.match(source, /pipelineState.direct = false;/);
  assert.match(source, /state.verified \|\| state.direct/);
});
