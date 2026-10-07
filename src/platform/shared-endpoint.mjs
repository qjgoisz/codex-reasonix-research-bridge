// IPC stays local: Windows named pipes; POSIX filesystem sockets.
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const PIPE_PREFIX = '\\\\.\\pipe\\codex-reasonix-';
export function isWindowsPipe(path) {
  return typeof path === 'string' && path.startsWith(PIPE_PREFIX) && /^[a-f0-9]{64}$/.test(path.slice(PIPE_PREFIX.length));
}
export function createSharedEndpoint({ platform = process.platform, temporaryRoot = tmpdir() } = {}) {
  if (platform === 'win32') return { transport: 'pipe', socket: PIPE_PREFIX + randomBytes(32).toString('hex'), directory: null };
  // macOS's sun_path limit is shorter than Linux's. Its usual TMPDIR may be long.
  const suffixBytes = Buffer.byteLength('/reasonix-ipc-XXXXXX/mcp.sock');
  const base = Buffer.byteLength(temporaryRoot) + suffixBytes >= 100 ? '/tmp' : temporaryRoot;
  const directory = mkdtempSync(join(base, 'reasonix-ipc-')); chmodSync(directory, 0o700);
  return { transport: 'unix', socket: join(directory, 'mcp.sock'), directory };
}
export function validateSharedEndpoint(doc, platform = process.platform) {
  if (platform === 'win32') return doc.transport === 'pipe' && isWindowsPipe(doc.socket);
  if (doc.transport !== 'unix') return false;
  try {
    const sock = lstatSync(doc.socket), parent = lstatSync(doc.socket.substring(0, doc.socket.lastIndexOf('/')));
    return sock.isSocket() && !(sock.mode & 0o077) && parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o077)
      && (!process.getuid || (sock.uid === process.getuid() && parent.uid === process.getuid()));
  } catch { return false; }
}
export function prepareSharedEndpoint(endpoint) {
  if (endpoint.transport === 'unix') chmodSync(endpoint.socket, 0o600);
}
export function removeSharedEndpoint(endpoint) {
  if (endpoint.directory) rmSync(endpoint.directory, { recursive: true, force: true });
}
