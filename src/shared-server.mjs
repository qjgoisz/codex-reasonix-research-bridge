// One state owner; each Codex stdio process is only a socket client.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer } from './mcp-server.mjs';
import { Store } from './store.mjs';
import { installShutdownHandlers } from './shutdown.mjs';
import { DEFAULT_REASONIX_HOME } from './worker.mjs';
import { BRIDGE_VERSION } from './version.mjs';

const PROTOCOL = 1, MAX_FRAME = 4 * 1024 * 1024;
const descriptorPath = root => join(resolve(root), 'daemon.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });
export function sharedFingerprint(common) {
  return createHash('sha256').update(JSON.stringify({ protocol: PROTOCOL, version: BRIDGE_VERSION,
    installation: import.meta.dirname, config: common.config,
    home: common.config.reasonixHome ?? process.env.REASONIX_HOME ?? DEFAULT_REASONIX_HOME,
    workerCommand: common.workerCommand ?? null, workerArgs: common.workerArgs ?? null })).digest('hex');
}
function descriptor(root) {
  try {
    const path = descriptorPath(root), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077)) return null;
    if (process.getuid && stat.uid !== process.getuid()) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const lock = new Store(resolve(root)).lockStatus();
    if (doc.protocol !== PROTOCOL || lock.state !== 'held-live' || lock.pid !== doc.pid || typeof doc.socket !== 'string') return null;
    const sock = lstatSync(doc.socket), parent = lstatSync(resolve(doc.socket, '..'));
    if (!sock.isSocket() || (sock.mode & 0o077) || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) return null;
    if (process.getuid && (sock.uid !== process.getuid() || parent.uid !== process.getuid())) return null;
    return doc;
  } catch { return null; }
}
function parseLines(stream, receive, invalid) {
  let buffer = '';
  stream.setEncoding('utf8');
  const data = chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME) { invalid(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (line) receive(line);
    }
  };
  stream.on('data', data);
  return () => stream.off('data', data);
}
async function connect(doc, fingerprint) {
  if (doc.fingerprint !== fingerprint) throw fail('shared_config_mismatch', '同一状态目录的后台桥使用不同配置；关闭旧客户端，等待后台退出后再重新连接，或使用独立状态目录。');
  return new Promise((yes, no) => {
    const socket = net.createConnection(doc.socket);
    const timer = setTimeout(() => finish(fail('shared_timeout', '后台桥握手超时。')), 2000);
    let buffer = '', settled = false;
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer); socket.off('data', data); socket.off('error', errorHandler);
      if (error) { socket.destroy(); no(error); } else { socket.pause(); yes(socket); }
    }
    const errorHandler = () => finish(fail('shared_unreachable', '无法连接状态锁对应的后台桥；未清理或接管活动锁。'));
    const data = chunk => {
      buffer += chunk;
      if (buffer.length > 4096) return finish(fail('shared_handshake', '后台桥握手格式不兼容。'));
      if (!buffer.includes('\n')) return;
      try {
        const h = JSON.parse(buffer.trim());
        if (h.protocol !== PROTOCOL || h.pid !== doc.pid || h.fingerprint !== fingerprint || h.ok !== true) throw new Error();
        finish();
      } catch { finish(fail('shared_handshake', '后台桥握手格式不兼容。')); }
    };
    socket.setEncoding('utf8'); socket.on('data', data); socket.once('error', errorHandler);
    socket.once('connect', () => socket.write(JSON.stringify({ protocol: PROTOCOL, fingerprint }) + '\n'));
    socket.once('close', () => { if (!settled) errorHandler(); });
  });
}
async function getConnection(common, argv) {
  if (process.platform === 'win32') throw fail('shared_platform', '共享后台目前需要 POSIX 本机 socket；Windows 请显式使用 --private-stdio 和独立状态目录。');
  const root = resolve(common.stateRoot), fingerprint = sharedFingerprint(common);
  new Store(root).init();
  let launched = false, damagedSince = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const doc = descriptor(root);
    if (doc) {
      try { return await connect(doc, fingerprint); }
      catch (error) {
        if (error.code === 'shared_config_mismatch') throw error;
        // Retry attachment only: no MCP request has yet been forwarded.
        await delay(100); continue;
      }
    }
    const lock = new Store(root).lockStatus();
    if (lock.state === 'corrupt') {
      damagedSince ??= Date.now();
      if (Date.now() - damagedSince < 300) { await delay(100); continue; }
    } else damagedSince = null;
    if (lock.state === 'stale' || lock.state === 'corrupt') throw fail('shared_stale_lock', '状态锁残留或损坏；请核对后使用 unlock --stale。共享客户端不会自动删除锁。');
    if (lock.state === 'free' && !launched) {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'cli.mjs'), '_daemon', ...argv.slice(1)], {
        detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env,
      });
      child.on('error', () => {}); child.unref(); launched = true;
    }
    await delay(100);
  }
  if (new Store(root).lockStatus().state === 'free') throw fail('shared_start_failed', '后台桥未能启动；请用独立状态目录和 --private-stdio 检查配置及启动环境。');
  throw fail('shared_owner_unavailable', '状态目录的活动进程没有提供可连接的共享后台。旧版或 --private-stdio 服务需正常退出；不要删除活动锁。');
}
export async function serveSharedClient({ common, argv, input, output }) {
  // Do not consume stdin until the daemon is ready; stream buffers preserve init.
  const socket = await getConnection(common, argv);
  await new Promise((yes, no) => {
    let ending = false, settled = false;
    const cleanup = () => {
      input.unpipe(socket); socket.unpipe(output);
      input.off('end', end); input.off('error', error); input.pause();
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, end);
    };
    const finish = err => { if (settled) return; settled = true; cleanup(); err ? no(err) : yes(); };
    const end = () => { ending = true; socket.destroy(); finish(); };
    const error = () => { socket.destroy(); finish(fail('shared_connection_lost', '共享后台连接中断；未自动重发任何请求，请重新连接并核对任务状态。')); };
    socket.on('error', error);
    socket.once('close', () => finish(ending ? null : fail('shared_connection_lost', '共享后台连接关闭；未自动重发请求。')));
    input.once('end', end); input.once('error', error);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, end);
    socket.pipe(output, { end: false }); input.pipe(socket); socket.resume();
    if (input.readableEnded || input.destroyed) end();
  });
}
export async function runSharedDaemon({ common, openBridge, idleMs = 1000 }) {
  const { store, bridge } = openBridge(common); // exclusive election: losing candidates do nothing
  const fingerprint = sharedFingerprint(common), root = resolve(common.stateRoot);
  const directory = mkdtempSync(join(tmpdir(), 'reasonix-bridge-socket-')); chmodSync(directory, 0o700);
  const path = join(directory, 'mcp.sock'), sockets = new Set();
  let idleTimer, stopped = false, finish;
  const done = new Promise(yes => { finish = yes; });
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const cleanupTransport = () => {
    stopped = true; clearTimeout(idleTimer); server.close();
    for (const socket of sockets) socket.destroy();
    try {
      const doc = JSON.parse(readFileSync(descriptorPath(root), 'utf8'));
      if (doc.pid === process.pid) rmSync(descriptorPath(root));
    } catch { /* never remove another owner's descriptor */ }
    rmSync(directory, { recursive: true, force: true });
  };
  const lifecycle = installShutdownHandlers({ bridge: {
    shutdown: async () => { cleanupTransport(); return bridge.shutdown(); },
    emergencyKillWorkers: () => bridge.emergencyKillWorkers(),
  }, store });
  const scheduleIdle = (ms = idleMs) => {
    clearTimeout(idleTimer);
    if (stopped || sockets.size) return;
    idleTimer = setTimeout(async () => {
      if (sockets.size || stopped) return;
      // Work survives client EOF. Pending approvals remain available to reconnects.
      if (bridge.inflight.length) { scheduleIdle(); return; }
      stopped = true;
      await lifecycle.awaitCleanup('shared_idle'); lifecycle.dispose(); finish();
    }, ms);
  };
  const server = net.createServer(socket => {
    if (stopped) { socket.destroy(); return; }
    clearTimeout(idleTimer); sockets.add(socket);
    const mcp = new McpServer({ bridge }); // initialization belongs to this connection
    let ready = false, inflight = 0;
    const handshakeTimer = setTimeout(() => socket.destroy(), 2000);
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(handshakeTimer); sockets.delete(socket); scheduleIdle(); });
    const send = value => {
      if (value === null || socket.destroyed) return;
      const frame = JSON.stringify(value) + '\n';
      if (socket.writableLength + Buffer.byteLength(frame) > MAX_FRAME * 2) { socket.destroy(); return; }
      socket.write(frame);
    };
    parseLines(socket, line => {
      let message;
      try { message = JSON.parse(line); } catch { if (!ready) socket.destroy(); else send(rpcError(null, -32700, 'parse_error')); return; }
      if (!ready) {
        if (message.protocol !== PROTOCOL || message.fingerprint !== fingerprint) { socket.destroy(); return; }
        ready = true; clearTimeout(handshakeTimer);
        send({ ok: true, protocol: PROTOCOL, pid: process.pid, fingerprint }); return;
      }
      if (inflight >= 128) { send(rpcError(message?.id ?? null, -32603, 'too_many_requests')); return; }
      inflight++;
      mcp.handle(message).then(send, () => send(rpcError(message?.id ?? null, -32603, 'internal_error'))).finally(() => inflight--);
    }, () => socket.destroy());
  });
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen(path, yes); });
    chmodSync(path, 0o600);
    const temporary = descriptorPath(root) + `.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ protocol: PROTOCOL, pid: process.pid, socket: path, fingerprint }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, descriptorPath(root));
    scheduleIdle(10000); // leave time for the launching client's first connection
    await done;
  } catch (error) { await lifecycle.awaitCleanup('shared_start_failed'); throw error; }
  finally { lifecycle.dispose(); }
}
