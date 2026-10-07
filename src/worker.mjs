// Discover executable entry points without running the graphical application.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
export const DEFAULT_REASONIX_HOME = process.platform === 'win32'
  ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'reasonix') : join(homedir(), '.reasonix');
export const DEFAULT_WORKER_COMMAND = 'reasonix';
export const WORKER_PROFILE = null;
export class WorkerError extends Error {
  constructor(code, message, hint) { super(message ?? code); this.name = 'WorkerError'; this.code = code; if (hint) this.hint = hint; }
}
function executable(path, platform = process.platform) {
  try { return statSync(path).isFile() && (accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK), true); }
  catch { return false; }
}
export function locateReasonix({ installationRoot, command, backend = 'studio', pathEnv = process.env.PATH ?? '', platform = process.platform } = {}) {
  const name = backend === 'studio' ? 'reasonix-studio-host' : 'reasonix';
  const binary = name + (platform === 'win32' ? '.exe' : '');
  const roots = installationRoot ? [resolve(installationRoot)] : platform === 'darwin'
    ? ['/Applications/Reasonix Studio.app'] : platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'Reasonix Studio')]
      : ['/opt/Reasonix Studio', '/opt/reasonix-studio'];
  const candidates = command ? [command] : [
    ...roots.flatMap(root => [join(root, 'resources', 'bin', binary), join(root, 'Contents', 'Resources', 'bin', binary), join(root, 'bin', binary), join(root, binary)]),
    ...pathEnv.split(delimiter).filter(Boolean).map(dir => join(dir, binary)),
  ];
  const valid = candidates.filter(p => executable(p, platform));
  if (installationRoot && new Set(valid).size > 1) throw new WorkerError('ambiguous_installation', '安装目录中有多个后端入口，请指定更精确的 resources 目录。');
  const entry = valid[0];
  return entry ? { name, entry, backend, root: installationRoot ?? null } : null;
}
export function createWorkerSpec(options = {}) {
  const { workspace, reasonixHome = process.env.REASONIX_HOME ?? DEFAULT_REASONIX_HOME, command, args,
    transport = 'direct', env = process.env, nodeBin = process.execPath, entry, installationRoot } = options;
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0'))
    throw new WorkerError('invalid_workspace', 'worker 工作区必须是绝对路径。');
  // Explicit arbitrary workers (including fake ACP fixtures) retain their argv.
  const backend = options.backend ?? (command || entry ? 'acp' : 'studio');
  const detected = !command && !entry ? locateReasonix({ installationRoot, backend }) : null;
  const resolvedCommand = command ?? (entry ? nodeBin : detected?.entry ?? (backend === 'studio' ? 'reasonix-studio-host' : 'reasonix'));
  const resolvedArgs = args ?? (entry ? [entry] : backend === 'acp' ? ['acp'] : []);
  if (!Array.isArray(resolvedArgs) || resolvedArgs.some(a => typeof a !== 'string' || a.includes('\0')))
    throw new WorkerError('invalid_worker_args');
  if (backend === 'studio' && transport !== 'direct') throw new WorkerError('studio_requires_direct');
  return { ...options, backend, command: resolvedCommand, args: [...resolvedArgs], transport, cwd: workspace,
    env: { ...env, REASONIX_HOME: reasonixHome }, reasonixHome };
}
export function preflightWorker(options = {}) {
  const spec = createWorkerSpec({ workspace: options.workspace ?? process.cwd(), ...options });
  const installation = locateReasonix({ ...options, backend: spec.backend, command: options.command });
  const problems = [];
  if (!installation && !options.entry) problems.push('未找到后端入口，请指定 reasonixRoot 或 workerCommand。');
  if (spec.transport === 'posix-pipes' && process.platform !== 'linux') problems.push('posix-pipes 仅适用于 Linux。');
  return { ok: problems.length === 0, backend: spec.backend, problems,
    hints: ['预检不调用模型；运行 probe 才会验证协议。Studio 连接使用桥自有后端实例与独立任务会话。'],
    installation, reasonixHome: spec.reasonixHome, homePresent: existsSync(spec.reasonixHome),
    platform: process.platform, arch: process.arch, protocol: 'unverified',
    launch: { command: spec.command, args: spec.args } };
}
