// Build only the npm allowlisted source package; no registry publishing.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BRIDGE_VERSION } from '../src/version.mjs';
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== BRIDGE_VERSION) throw new Error('package.json and BRIDGE_VERSION must match.');
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${pkg.version}`) throw new Error('Release tag must exactly match v<package.json version>.');
const dist = join(root, 'dist'); mkdirSync(dist, { recursive: true });
const npmCli = process.platform === 'win32' ? process.env.npm_execpath : null;
if (process.platform === 'win32' && !npmCli?.endsWith('.js')) throw new Error('On Windows run this through npm run package:release.');
const npm = npmCli ? process.execPath : 'npm';
function pack(extra) {
  const result = spawnSync(npm, [...(npmCli ? [npmCli] : []), 'pack', '--json', ...extra], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('npm pack failed; check npm and its cache directory permissions.');
  const doc = JSON.parse(result.stdout);
  const entries = Array.isArray(doc) ? doc : Object.values(doc);
  if (entries.length !== 1 || !Array.isArray(entries[0]?.files)) throw new Error('Unexpected npm pack manifest.');
  return entries[0];
}
function validate(manifest) {
  const allowed = new Set(['package.json', ...pkg.files]);
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    if (parts.includes('..') || !allowed.has(parts[0]) || parts.some(p => /^(?:\.env(?:\..*)?|\.aws|\.codex|\.agents|\.git|\.bridge-state|\.verification)$/.test(p))
      || /(?:\.bak\.|\.tmp\.|\.configure\.lock$|\.log$)/.test(file.path))
      throw new Error(`Private or unexpected package entry: ${file.path}`);
  }
  const files = new Set(manifest.files.map(f => f.path));
  for (const required of ['LICENSE', 'NOTICE.md', 'README.md', 'src/cli.mjs', 'src/shared-server.mjs', 'test/fake-acp-agent.mjs', 'examples/bridge.config.json'])
    if (!files.has(required)) throw new Error(`Missing package entry: ${required}`);
  if (files.has('bridge.config.json')) throw new Error('Local bridge configuration must not be packaged.');
}
validate(pack(['--dry-run']));
const built = pack(['--pack-destination', dist]); validate(built);
if (built.filename !== `${pkg.name}-${pkg.version}.tgz`) throw new Error('Unexpected package filename.');
const file = join(dist, built.filename);
const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(join(dist, 'SHA256SUMS'), `${hash}  ${built.filename}\n`);
console.log(`Verified ${built.files.length} entries: dist/${built.filename}\nSHA-256: ${hash}`);
