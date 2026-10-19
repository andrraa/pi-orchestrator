import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../extensions/orchestrator.ts', import.meta.url), 'utf8');
function setup(child = false) {
  let config = { enabled: true, roles: {}, thinking: {} };
  const handlers = {}, commands = {}, tools = {}, listeners = new Map(), requests = [];
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (name, spec) => { commands[name] = spec; },
    registerTool: spec => { tools[spec.name] = spec; },
    events: {
      on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
      emit: (_, req) => {
        requests.push(req);
        queueMicrotask(() => listeners.get('subagents:rpc:v1:reply:' + req.requestId)?.({
          requestId: req.requestId, success: true,
          data: req.method === 'spawn' ? { details: { asyncId: 'owned-run' } } : {},
        }));
      },
    },
  };
  const code = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, '').replace('export default function', 'function install').replace(/export /g, ''));
  let id = 0;
  const sandbox = {
    process: { env: { PI_SUBAGENT_CHILD: child ? '1' : '' } },
    fs: { readFileSync: () => JSON.stringify(config), writeFileSync: (_, text) => { config = JSON.parse(text); }, renameSync() {} },
    os: { homedir: () => '/fake' }, path: { join: (...p) => p.join('/') }, randomUUID: () => String(++id),
    Type: { Object: x => x, String: x => x }, AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(code + '\ninstall(pi);', { ...sandbox, pi });
  const ctx = { cwd: '/fake', ui: { notify() {} } };
  return { handlers, commands, tools, requests, ctx, setEnabled: enabled => { config.enabled = enabled; } };
}
test('children register nothing and cannot mutate global toggle', () => {
  const app = setup(true);
  assert.deepEqual(Object.keys(app.handlers), []);
  assert.deepEqual(Object.keys(app.tools), []);
});
test('OFF rejects new workflows and gate reads external config changes', async () => {
  const app = setup();
  app.setEnabled(false);
  const result = await app.tools.orchestrate.execute('', { task: 'test' }, undefined, undefined, app.ctx);
  assert.equal(result.isError, true);
  assert.equal(app.requests.length, 0);
  assert.equal(app.handlers.tool_call({ toolName: 'write', input: {} }), undefined);
  app.setEnabled(true);
  assert.equal(app.handlers.tool_call({ toolName: 'write', input: {} }).block, true);
});
for (const reason of ['abort', 'off', 'shutdown']) test(`${reason} stops the owned workflow`, async () => {
  const app = setup();
  const controller = new AbortController();
  const result = app.tools.orchestrate.execute('', { task: 'test' }, controller.signal, undefined, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  if (reason === 'abort') controller.abort();
  if (reason === 'off') await app.commands.orchestrator.handler('off', app.ctx);
  if (reason === 'shutdown') app.handlers.session_shutdown();
  const receipt = await result;
  assert.equal(receipt.details.ok, false);
  const stops = app.requests.filter(r => r.method === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].params.id, 'owned-run');
});
