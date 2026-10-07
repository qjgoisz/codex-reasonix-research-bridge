// Read only an allowlisted catalogue. Python's standard TOML parser avoids
// guessing at nested tables/escaped strings; optional for the configurator,
// never needed by the running bridge. No .env or credential fields are read out.
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { DEFAULT_REASONIX_HOME } from './worker.mjs';

const projection = String.raw`
import json, sys, pathlib
try:
 import tomllib
 p = pathlib.Path(sys.argv[1])
 if p.stat().st_size > 2 * 1024 * 1024:
  raise ValueError()
 c = tomllib.loads(p.read_text(encoding='utf-8-sig'))
 providers = []
 for v in c.get('providers', []):
  if not isinstance(v, dict): raise ValueError()
  row = {k: v.get(k) for k in ('name', 'display_name', 'base_url', 'default', 'kind') if isinstance(v.get(k), str)}
  row['models'] = [m for m in v.get('models', []) if isinstance(m, str)]
  providers.append(row)
 print(json.dumps({'providers': providers, 'defaultModel': c.get('default_model') if isinstance(c.get('default_model'), str) else None}))
except FileNotFoundError:
 print(json.dumps({'error': 'not_found'}))
except ImportError:
 print(json.dumps({'error': 'tomllib_unavailable'}))
except Exception:
 print(json.dumps({'error': 'unreadable_toml'}))
`;
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 512) : null;
function endpoint(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return clean(url.toString());
  } catch { return null; }
}
export function readReasonixCatalogue({ home, configPath, env = process.env } = {}) {
  const path = configPath ? resolve(configPath) : join(home ?? env.REASONIX_HOME ?? DEFAULT_REASONIX_HOME, 'config.toml');
  const launchers = process.platform === 'win32' ? [['python', []], ['py', ['-3']], ['python3', []]] : [['python3', []]];
  let run;
  for (const [command, prefix] of launchers) {
    run = spawnSync(command, [...prefix, '-I', '-c', projection, path], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env,
    });
    if (!run.error && run.status === 0 && !run.stdout.includes('tomllib_unavailable')) break;
  }
  if (run.error || run.status !== 0) return { path, providers: [], defaultModel: null, error: 'python_unavailable' };
  try {
    const doc = JSON.parse(run.stdout);
    if (doc.error) return { path, providers: [], defaultModel: null, error: doc.error };
    const providers = doc.providers.map(p => ({
      name: clean(p.name), displayName: clean(p.display_name), baseUrl: endpoint(p.base_url),
      kind: clean(p.kind), defaultModel: clean(p.default), models: [...new Set(p.models.map(clean).filter(Boolean))],
    })).filter(p => p.name && p.models.length);
    if (new Set(providers.map(p => p.name)).size !== providers.length) throw new Error();
    return { path, providers, defaultModel: clean(doc.defaultModel), error: null };
  } catch { return { path, providers: [], defaultModel: null, error: 'unreadable_toml' }; }
}
export function catalogueRoutes(catalogue) {
  return catalogue.providers.flatMap(p => p.models.map(model => ({ provider: p.name, model })));
}
