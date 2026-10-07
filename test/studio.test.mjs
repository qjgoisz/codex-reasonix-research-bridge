import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioClient, validateOrigin } from '../src/studio-client.mjs';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { McpServer } from '../src/mcp-server.mjs';
import { startFakeStudio } from './fake-studio.mjs';

async function fixture(t, scenario = 'normal') {
  const fake = await startFakeStudio();
  const streams = new Map(), live = new Map();
  let seq = 0, nextRuntime = 0;
  const emit = (id, frame) => {
    const out = streams.get(id);
    if (out) out.write(`id: ${++seq}\ndata: ${JSON.stringify({ ...frame, seq })}\n\n`);
  };
  fake.addRoute('GET', '/runtimes', () => [...live.values()]);
  fake.addRoute('POST', '/runtimes', (req, res, ctx) => {
    const id = `r${++nextRuntime}`;
    const rt = { id, base: `/rt/${id}`, root: ctx.json.root,
      sessionPath: ctx.json.sessionPath ?? `/fake/session-${id}`, model: ctx.json.model ?? 'llm/deepseek-flash', effort: 'high' };
    live.set(id, rt); return rt;
  });
  fake.addRoute('POST', '/runtimes/:id/close', (req, res, ctx) => { streams.get(ctx.params.id)?.end(); streams.delete(ctx.params.id); live.delete(ctx.params.id); });
  fake.addRoute('POST', '/rt/:id/new', () => undefined);
  fake.addRoute('GET', '/rt/:id/models', (req, res, ctx) => ({ current: live.get(ctx.params.id).model,
    models: [{ ref: 'llm/deepseek-flash', efforts: ['auto', 'high'], effort: 'high' }, { ref: 'llm/other' }] }));
  fake.addRoute('GET', '/rt/:id/status', (req, res, ctx) => ({ sessionPath: live.get(ctx.params.id).sessionPath,
    modelRef: live.get(ctx.params.id).model, effort: live.get(ctx.params.id).effort }));
  fake.addRoute('POST', '/rt/:id/model', (req, res, ctx) => { live.get(ctx.params.id).model = ctx.json.ref; });
  fake.addRoute('GET', '/rt/:id/events', async (req, res, ctx) => {
    res.setHeader('content-type', 'text/event-stream'); res.write(': connected\n\n'); streams.set(ctx.params.id, res);
    await new Promise(resolve => res.once('close', resolve));
  });
  const finish = id => {
    emit(id, { kind: 'text', text: 'delta not counted' });
    emit(id, { kind: 'message', text: 'Studio result' });
    emit(id, { kind: 'turn_done' });
  };
  fake.addRoute('POST', '/rt/:id/submit', (req, res, ctx) => {
    res.statusCode = 202; res.end(); const id = ctx.params.id;
    setImmediate(() => {
      emit(id, { kind: 'turn_started', text: ctx.json.input });
      if (scenario === 'approval') emit(id, { kind: 'approval_request', approval: { id: 'native-approval', tool: 'write', subject: 'result.txt' } });
      else if (scenario === 'ask') emit(id, { kind: 'ask_request', ask: { id: 'native-ask', questions: [{ id: 'units', prompt: 'What units?' }] } });
      else if (scenario === 'drop') { streams.get(id).end(); }
      else if (scenario === 'gap') { seq++; emit(id, { kind: 'turn_done' }); }
      else if (scenario === 'paused') emit(id, { kind: 'turn_done', outcome: 'no_progress' });
      else finish(id);
    });
  });
  fake.addRoute('POST', '/rt/:id/approve', (req, res, ctx) => { setImmediate(() => finish(ctx.params.id)); });
  fake.addRoute('POST', '/rt/:id/cancel', (req, res, ctx) => { setImmediate(() => emit(ctx.params.id, { kind: 'turn_done', cancelled: true })); });
  const client = new StudioClient({ connection: { origin: fake.origin, token: fake.token }, promptTimeoutMs: 2000, requestTimeoutMs: 1000 });
  t.after(async () => { await client.shutdown(); await fake.close(); });
  await client.initialize();
  return { fake, client, emit };
}

test('Studio rejects non-loopback origins and credential-bearing URLs', () => {
  for (const url of ['https://127.0.0.1:1234', 'http://example.com', 'http://localhost:1234', 'http://user:pass@127.0.0.1:12', 'http://127.0.0.1:12/path']) assert.throws(() => validateOrigin(url));
  assert.equal(validateOrigin('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});
test('Studio lifecycle and route choices use actual HTTP contract', async t => {
  const { fake, client } = await fixture(t);
  const created = await client.newSession({ cwd: '/tmp/studio-fixture' });
  assert.equal(created.configOptions[1].id, 'effort');
  await client.setConfigOption({ sessionId: created.sessionId, configId: 'model', value: 'llm/other' });
  assert.deepEqual(fake.requests.find(r => r.url.endsWith('/model')).json, { ref: 'llm/other', default: false });
  await client.closeSession(created.sessionId);
  const resumed = await client.resumeSession({ cwd: '/tmp/studio-fixture', sessionId: created.sessionId });
  assert.equal(resumed.sessionId, created.sessionId);
  assert.equal(JSON.stringify(fake.requests).includes(fake.token), false);
  const denied = await fetch(fake.origin + '/runtimes'); assert.equal(denied.status, 401);
});
test('Studio effort is verified without writing global settings', async t => {
  const { fake, client } = await fixture(t);
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  await client.setConfigOption({ sessionId, configId: 'effort', value: 'high' });
  await assert.rejects(client.setConfigOption({ sessionId, configId: 'effort', value: 'auto' }), /全局配置/);
  assert.equal(fake.requests.some(r => r.url.endsWith('/effort')), false);
});
test('Studio authoritative full messages avoid duplicate streaming deltas', async t => {
  const { client } = await fixture(t);
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  const updates = []; client.onUpdate(u => updates.push(u));
  const call = client.prompt({ sessionId, text: 'task' });
  assert.equal((await call).stopReason, 'end_turn');
  assert.equal(client.wasSubmitted(call.requestId), true);
  assert.deepEqual(updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').map(u => u.update.content.text), ['Studio result\n']);
});
test('Studio approvals map native identity and never grant session/persistent access', async t => {
  const { fake, client } = await fixture(t, 'approval');
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  client.setPermissionPolicy(params => ({ outcome: 'selected', optionId: params.options[0].optionId }));
  assert.equal((await client.prompt({ sessionId, text: 'write' })).stopReason, 'end_turn');
  assert.deepEqual(fake.requests.find(r => r.url.endsWith('/approve')).json,
    { id: 'native-approval', allow: true, session: false, persist: false });
});
test('Studio native questions surface through the bridge clarification marker', async t => {
  const { client } = await fixture(t, 'ask');
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  const text = []; client.onUpdate(u => { if (u.update.content?.text) text.push(u.update.content.text); });
  assert.equal((await client.prompt({ sessionId, text: 'ask' })).stopReason, 'end_turn');
  assert.ok(text.join('').includes('<<BRIDGE_CLARIFY>>'));
  assert.ok(text.join('').includes('What units?'));
});
for (const scenario of ['drop', 'gap']) test(`Studio ${scenario} cannot be reported as successful completion`, async t => {
  const { client } = await fixture(t, scenario);
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  await assert.rejects(client.prompt({ sessionId, text: 'task' }), error => error.code === 'connection_lost' && error.submitted === true);
});
test('Studio paused outcome is not end_turn completion', async t => {
  const { client } = await fixture(t, 'paused');
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  assert.equal((await client.prompt({ sessionId, text: 'task' })).stopReason, 'max_turn_requests');
});
test('MCP → bridge → Studio HTTP result persists and native questions change task state', async t => {
  const { client } = await fixture(t, 'ask');
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-studio-test-'));
  const store = new Store(join(workspace, 'state')).init().lock();
  const bridge = new Bridge({ store, createClient: () => client, worker: { command: 'fake' } });
  t.after(async () => { await bridge.shutdown(); store.unlock(); });
  const server = new McpServer({ bridge });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'reasonix_delegate', arguments: { id: 'studio-question', workspace, phase: 'maintenance', objective: 'ask',
      plan: { summary: 'ask', steps: ['ask'] }, acceptance: ['question surfaced'], waitMs: 1000 } } });
  assert.equal(response.result.isError, undefined);
  assert.equal(bridge.status('studio-question').status, 'needs_clarification');
  assert.ok(bridge.result('studio-question').text.includes('What units?'));
});

test('default compatibility mode restores the same persisted session before the next explicit prompt', async t => {
  const { client, fake } = await fixture(t);
  const { sessionId } = await client.newSession({ cwd: '/tmp/studio-fixture' });
  await client.prompt({ sessionId, text: 'first' });
  await client.prompt({ sessionId, text: 'second' });
  const opens = fake.requests.filter(r => r.method === 'POST' && r.url === '/runtimes');
  assert.equal(opens.length, 2);
  assert.equal(opens[1].json.sessionPath, sessionId);
  assert.equal(opens[1].json.model, 'llm/deepseek-flash');
  assert.equal(fake.requests.filter(r => r.url.endsWith('/submit')).length, 2);
});
