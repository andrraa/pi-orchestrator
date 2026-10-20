import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../extensions/orchestrator.ts', import.meta.url), 'utf8');
function setup(child = false) {
  let config = { enabled: true, roles: {}, thinking: {} };
  const handlers = {}, commands = {}, tools = {}, listeners = new Map(), requests = [], messages = [], notices = [];
  const pi = {
    sendUserMessage: text => { messages.push(text); },
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (name, spec) => { commands[name] = spec; },
    registerTool: spec => { tools[spec.name] = spec; },
    events: {
      sendUserMessage: text => { messages.push(text); },
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
  const ctx = { modelRegistry: { getAvailable: () => [], refresh: async () => {} }, cwd: '/fake', isIdle: () => true, ui: { notify: text => notices.push(text) } };
  return { setConfig: value => { config = value; }, handlers, commands, tools, requests, ctx, messages, notices, complete: (text, success = true) => listeners.get('subagent:async-complete')?.({ runId: 'owned-run', text, success }) };
}
test('children register nothing and cannot mutate global toggle', () => {
  const app = setup(true);
  assert.deepEqual(Object.keys(app.handlers), []);
  assert.deepEqual(Object.keys(app.tools), []);
});
async function arm(app, prompt = 'Fix MixedCase bug') {
  await app.commands.orchestrator.handler(prompt, app.ctx);
  const event = { messageType: 'user', prompt, systemPromptOptions: { promptGuidelines: [] } };
  app.handlers.before_agent_start(event);
  return event;
}
test('legacy enabled config does not arm ordinary chat or tools', async () => {
  const app = setup();
  assert.equal(app.handlers.tool_call({ toolName: 'write', input: {} }), undefined);
  const result = await app.tools.orchestrate.execute('', { task: 'test' }, undefined, undefined, app.ctx);
  assert.equal(result.isError, true);
  assert.equal(app.requests.length, 0);
});
test('command preserves prompt and gates only the requested task', async () => {
  const app = setup();
  const event = await arm(app);
  assert.equal(app.messages[0], 'Fix MixedCase bug');
  assert.ok(event.systemPromptOptions.promptGuidelines.length);
  assert.equal(app.handlers.tool_call({ toolName: 'write', input: {} }).block, true);
  app.handlers.agent_settled();
  assert.equal(app.handlers.tool_call({ toolName: 'write', input: {} }), undefined);
});
test('empty command shows usage without arming and busy command is refused', async () => {
  const app = setup();
  await app.commands.orchestrator.handler(' ', app.ctx);
  assert.match(app.notices[0], /Usage:/);
  app.ctx.isIdle = () => false;
  await app.commands.orchestrator.handler('task', app.ctx);
  assert.equal(app.messages.length, 0);
});
test('ordinary next user prompt clears enforcement', async () => {
  const app = setup();
  await arm(app);
  app.handlers.before_agent_start({ messageType: 'user', prompt: 'normal', systemPromptOptions: { promptGuidelines: [] } });
  assert.equal(app.handlers.tool_call({ toolName: 'edit', input: {} }), undefined);
});
for (const reason of ['abort', 'settled', 'shutdown']) test(`${reason} stops the owned workflow`, async () => {
  const app = setup();
  await arm(app);
  const controller = new AbortController();
  const result = app.tools.orchestrate.execute('', { task: 'test' }, controller.signal, undefined, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  if (reason === 'abort') controller.abort();
  if (reason === 'settled') app.handlers.agent_settled();
  if (reason === 'shutdown') app.handlers.session_shutdown();
  const receipt = await result;
  assert.equal(receipt.details.ok, false);
  const stops = app.requests.filter(r => r.method === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].params.id, 'owned-run');
});

for (const verdict of ['clean', 'completed-with-skips', 'fixed-unverified', 'unverified', 'not-json']) test('completion gate: ' + verdict, async () => {
  const app = setup();
  await arm(app);
  const pending = app.tools.orchestrate.execute('', { task: 'test' }, undefined, undefined, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  app.complete(verdict === 'not-json' ? 'finished' : JSON.stringify({ verdict }));
  const result = await pending;
  const accepted = verdict === 'clean' || verdict === 'completed-with-skips';
  assert.equal(result.details.ok, accepted);
  assert.equal(app.handlers.tool_call({ toolName: 'write', input: {} })?.block, accepted ? undefined : true);
});

test('default model and thinking arguments are omitted and context uses scout', async () => {
  const app = setup();
  await arm(app);
  const controller = new AbortController();
  const pending = app.tools.orchestrate.execute('', { task: 'test' }, controller.signal, undefined, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  const args = app.requests.find(r => r.method === 'spawn').params.args;
  assert.equal(args.contextAgent, 'scout');
  assert.equal(args.qaAgent, 'oracle');
  assert.ok(!Object.values(args).includes(''));
  controller.abort();
  await pending;
});

test('refreshes dynamic models before passing their exact identifier to spawn', async () => {
  const app = setup();
  app.setConfig({ roles: { context: 'antigravity/gemini-3.8-flash-high' }, thinking: {} });
  let refreshed = false;
  app.ctx.modelRegistry = {
    getAvailable: () => refreshed ? [{ provider: 'antigravity', id: 'gemini-3.8-flash-high' }] : [],
    refresh: async options => { assert.equal(options.allowNetwork, true); refreshed = true; },
  };
  await arm(app);
  const controller = new AbortController();
  const pending = app.tools.orchestrate.execute('', { task: 'test' }, controller.signal, undefined, app.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed, true);
  assert.equal(app.requests.find(r => r.method === 'spawn').params.args.contextModel, 'antigravity/gemini-3.8-flash-high');
  controller.abort();
  await pending;
});
