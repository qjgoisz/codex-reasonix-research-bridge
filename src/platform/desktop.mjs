import { locateReasonix } from '../worker.mjs';
export function desktopWorkerConfig(root, { platform = process.platform } = {}) {
  const found = locateReasonix({ installationRoot: root, platform, backend: 'studio', pathEnv: '' });
  if (!found) throw new Error('未找到 Reasonix Studio 的 resources/bin/reasonix-studio-host；请手工指定 workerCommand。');
  return { backend: 'studio', workerCommand: found.entry, workerArgs: [], workerEntry: null,
    nodeBin: null, reasonixRoot: root, transport: 'direct' };
}
