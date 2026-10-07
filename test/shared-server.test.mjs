import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contract, FAKE_AGENT, until, wait } from './fixtures.mjs';
const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const supported = true;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function fixture(t, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reasonix-shared-test-'));
  const state = join(root, 'state'), workspace = join(root, 'work'); mkdirSync(workspace);
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.child.stdin.end();
    await until(() => {
      if (!existsSync(join(state, 'bridge.lock'))) return true;
      try { return !alive(JSON.parse(readFileSync(join(state, 'bridge.lock'))).pid); } catch { return false; }
    }, { timeoutMs: 10000 }).catch(() => {});
    // Only this fixture's processes may be force-cleaned after a failed assertion.
    const pids = clients.map(c => c.child.pid);
    for (const file of [join(state, 'daemon.json'), join(root, 'fake.json')]) {
      try { pids.push(JSON.parse(readFileSync(file)).pid); } catch {}
    }
    for (const pid of pids.filter(Number.isSafeInteger)) if (alive(pid)) {
      if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); } catch {} }
      else { try { process.kill(pid,'SIGKILL'); } catch {} }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const start = (extras = []) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--backend', 'acp', '--state-root', state,
      '--reasonix-home', join(root, 'home'), '--worker-command', process.execPath,
      '--worker-arg', FAKE_AGENT, '--provider', 'deepseek-official', '--model-id', 'deepseek-flash',
      '--prompt-timeout-ms', '7000', ...extras], {
      cwd: root, env: {...process.env, FAKE_STATE: join(root, 'fake.json'), ...env}, stdio:['pipe','pipe','pipe'],
    });
    let buffer = '', stderr = '', sequence = 0;
    const pending = new Map();
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at+1);
        if (!line.trim()) continue;
        const value = JSON.parse(line), p = pending.get(value.id);
        if (p) { pending.delete(value.id); clearTimeout(p.timer); p.yes(value); }
      }
    });
    const closed = new Promise(yes => child.once('close', code => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.no(new Error(stderr || 'client closed')); }
      pending.clear(); yes(code);
    }));
    const rpc = (method, params) => new Promise((yes, no) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); no(new Error('RPC timeout: '+stderr)); },15000);
      pending.set(id,{yes,no,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
    const call = async (name, args) => {
      const response = await rpc('tools/call',{name,arguments:args});
      assert.ok(!response.error,JSON.stringify(response.error));
      return JSON.parse(response.result.content[0].text);
    };
    const c={child,rpc,call,closed,stderr:()=>stderr};clients.push(c);return c;
  };
  return { root, state, workspace, start };
}
async function init(c) { const r=await c.rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(r.result.serverInfo.name,'codex-reasonix-bridge'); }
function lock(state) { return JSON.parse(readFileSync(join(state,'bridge.lock'))); }

test('concurrent Codex clients discover tools with one daemon owner and independent RPC IDs', {skip:!supported}, async t => {
  const f=fixture(t), clients=[f.start(),f.start(),f.start()];
  await Promise.all(clients.map(init));
  const result=await Promise.all(clients.map(c=>c.rpc('tools/list')));
  for(const r of result) assert.ok(r.result.tools.some(x=>x.name==='reasonix_delegate'));
  const owner=lock(f.state).pid;assert.ok(clients.every(c=>c.child.pid!==owner));
  assert.equal(JSON.parse(readFileSync(join(f.state,'daemon.json'))).pid,owner);
  const [a,b]=await Promise.all([clients[0].rpc('ping'),clients[1].call('reasonix_status',{})]);
  assert.deepEqual(a.result,{});assert.equal(b.count,0);
  clients[0].child.stdin.end();await clients[0].closed;
  assert.deepEqual((await clients[1].rpc('ping')).result,{});
  assert.equal(lock(f.state).pid,owner);
});

test('task survives all client EOFs and reconnect retrieves its result without replay', {skip:!supported}, async t => {
  const f=fixture(t,{FAKE_DELAY_MS:'2500'}), first=f.start();await init(first);
  await first.call('reasonix_delegate', {...contract({id:'survive',workspace:f.workspace}),waitMs:0});
  const owner=lock(f.state).pid;first.child.stdin.end();await first.closed;
  await wait(1300);assert.equal(lock(f.state).pid,owner);
  const second=f.start();await init(second);
  const result=await until(async()=>{const r=await second.call('reasonix_result',{id:'survive'});return r.status==='completed'?r:null;});
  assert.ok(result.text.includes('已完成任务'));
  const current=await second.call('reasonix_status',{id:'survive'});assert.equal(current.attempts,1);
  assert.equal(lock(f.state).pid,owner);
  const doc=JSON.parse(readFileSync(join(f.state,'daemon.json')));
  second.child.stdin.end();await second.closed;
  await until(()=>!existsSync(join(f.state,'bridge.lock')),{timeoutMs:10000});
  assert.equal(existsSync(join(f.state,'daemon.json')),false);assert.equal(existsSync(doc.socket),false);
});

test('another client observes and answers the owners actual approval request', {skip:!supported}, async t=>{
  const f=fixture(t,{FAKE_SCENARIO:'permission'}),a=f.start(),b=f.start();await Promise.all([init(a),init(b)]);
  await a.call('reasonix_delegate',{...contract({id:'approve-shared',workspace:f.workspace}),waitMs:0});
  const approvals=await until(async()=>{const r=await b.call('reasonix_approvals',{id:'approve-shared'});return r.pending?.length?r:null;});
  const request=approvals.pending[0],option=request.options.find(o=>o.kind==='allow_once');
  assert.ok(option);await b.call('reasonix_approve',{requestId:request.requestId,optionId:option.optionId,reason:'offline fake tool is authorized by this test'});
  await until(async()=> (await a.call('reasonix_result',{id:'approve-shared'})).status==='completed');
});

test('different configuration refuses attachment and preserves active daemon lock', {skip:!supported}, async t=>{
  const f=fixture(t),a=f.start();await init(a);const original=readFileSync(join(f.state,'bridge.lock'));
  const b=f.start(['--reasoning','different']);await assert.rejects(init(b),/不同配置/);assert.notEqual(await b.closed,0);
  assert.deepEqual(readFileSync(join(f.state,'bridge.lock')),original);assert.deepEqual((await a.rpc('ping')).result,{});
});

test('stale lock requires explicit operator recovery and is never silently deleted', {skip:!supported}, async t=>{
  const f=fixture(t);mkdirSync(f.state);const original='{"pid":2147483647,"schema":1}\n';writeFileSync(join(f.state,'bridge.lock'),original);
  const a=f.start();await assert.rejects(init(a),/残留或损坏/);assert.notEqual(await a.closed,0);
  assert.equal(readFileSync(join(f.state,'bridge.lock'),'utf8'),original);
  // Test cleanup may delete this fixture only after asserting non-recovery.
  rmSync(join(f.state,'bridge.lock'));
});

test('legacy exclusive service blocks shared startup without deleting its live lock', {skip:!supported}, async t=>{
  const f=fixture(t),a=f.start(['--private-stdio']);await init(a);
  const original=readFileSync(join(f.state,'bridge.lock'));assert.equal(lock(f.state).pid,a.child.pid);
  const b=f.start();await assert.rejects(init(b),/活动进程没有提供可连接的共享后台/);assert.notEqual(await b.closed,0);
  assert.deepEqual(readFileSync(join(f.state,'bridge.lock')),original);assert.deepEqual((await a.rpc('ping')).result,{});
});

test('daemon failure closes client connections and does not replay a submitted task', {skip:!supported}, async t=>{
  const f=fixture(t,{FAKE_DELAY_MS:'2000'}),a=f.start(),b=f.start();await Promise.all([init(a),init(b)]);
  await a.call('reasonix_delegate',{...contract({id:'interrupted',workspace:f.workspace}),waitMs:0});
  await until(()=>{try{return JSON.parse(readFileSync(join(f.root,'fake.json'))).prompts===1;}catch{return false;}});
  process.kill(lock(f.state).pid,'SIGTERM');
  assert.notEqual(await a.closed,0);assert.notEqual(await b.closed,0);
  if (process.platform !== 'win32') await until(()=>!existsSync(join(f.state,'bridge.lock')),{timeoutMs:10000});
  if (process.platform === 'win32') {
    // Windows terminates SIGTERM targets abruptly: no POSIX cleanup handler.
    assert.equal(JSON.parse(readFileSync(join(f.root,'fake.json'))).prompts,1);
    const c=f.start();await assert.rejects(init(c),/残留或损坏/);await c.closed;
    return;
  }
  const c=f.start();await init(c);
  const view=await c.call('reasonix_status',{id:'interrupted'});
  assert.ok(['cancelled','unknown'].includes(view.status));assert.equal(view.attempts,1);
  assert.equal(JSON.parse(readFileSync(join(f.root,'fake.json'))).prompts,1);
});

test('concurrent identical delegates from different clients execute only once', {skip:!supported}, async t=>{
  const f=fixture(t,{FAKE_DELAY_MS:'100'}),a=f.start(),b=f.start();await Promise.all([init(a),init(b)]);
  const task={...contract({id:'deduplicated',workspace:f.workspace}),waitMs:0};
  await Promise.all([a.call('reasonix_delegate',task),b.call('reasonix_delegate',task)]);
  await until(async()=> (await b.call('reasonix_result',{id:task.id})).status==='completed');
  assert.equal((await a.call('reasonix_status',{id:task.id})).attempts,1);
  assert.equal(JSON.parse(readFileSync(join(f.root,'fake.json'))).prompts,1);
});
