import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { main, readSnapshot, saveConfig } from '../scripts/configure-bridge.mjs';
import { BUILT_IN_CONFIG } from '../src/config.mjs';
import { desktopWorkerConfig } from '../src/platform/desktop.mjs';

function desktopFixture(cwd, parts, name = 'reasonix-studio-host') {
  const bin = join(cwd, ...parts, 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, name);
  writeFileSync(launcher, 'fixture; never execute');
  chmodSync(launcher, 0o755);
  return launcher;
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge 配置 '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'bridge.config.json');
  const run = async (args, text = '') => {
    let outputText = '';
    await main([...args, '--reasonix-config', join(cwd, 'reasonix-config.toml')], {
      cwd, input: Readable.from([text]),
      output: new Writable({ write(chunk, encoding, done) { outputText += chunk.toString(); done(); } }),
    });
    return outputText;
  };
  return { cwd, path, run };
}

test('check validates a typed overlay without creating configuration or backup', async t => {
  const { cwd, path, run } = fixture(t);
  const output = await run(['--set', 'reasoningEffort', 'null', '--set', 'workerArgs', '["路径 含空格", "中文"]', '--check']);
  assert.match(output, /"reasoningEffort": null/);
  assert.match(output, /路径 含空格/);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(cwd), []);
});

test('explicit save backs up exact original bytes, preserves comments, and unchanged save is a no-op', async t => {
  const { cwd, path, run } = fixture(t);
  const original = '{"schema":1,"_note":"保留注释", "provider":"old","model":"old-model"}\n';
  writeFileSync(path, original);
  await run(['--set', 'provider', 'new', '--yes']);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.schema, 2);
  assert.equal(config._note, '保留注释');
  assert.equal(config.provider, 'new');
  const backups = readdirSync(cwd).filter(name => name.includes('.bak.'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(cwd, backups[0]), 'utf8'), original);
  const before = readdirSync(cwd);
  assert.match(await run(['--yes']), /配置没有变化/);
  assert.deepEqual(readdirSync(cwd), before);
});

test('conflicting external edit is retained, without backup or temporary files', t => {
  const { cwd, path } = fixture(t);
  writeFileSync(path, JSON.stringify(BUILT_IN_CONFIG));
  const snapshot = readSnapshot(path);
  const edited = JSON.stringify({ ...BUILT_IN_CONFIG, provider: 'external-provider', model: 'external' });
  writeFileSync(path, edited);
  assert.throws(() => saveConfig(snapshot, BUILT_IN_CONFIG), /被修改/);
  assert.equal(readFileSync(path, 'utf8'), edited);
  assert.deepEqual(readdirSync(cwd), ['bridge.config.json']);
});

test('interactive menu uses cached routes and requires final confirmation', async t => {
  const { cwd, path, run } = fixture(t);
  const state = join(cwd, 'cache');
  mkdirSync(state);
  writeFileSync(join(state, 'models.json'), JSON.stringify({ schema: 1, summary: { model: { choices: [
    { value: 'provider-a/model-a' },
    { value: 'provider-b/model-b' },
  ] } } }));
  const otherFields = Object.keys(BUILT_IN_CONFIG).length - 4;
  const output = await run(['--state-root', 'cache'], `\n2\n1\n${'\n'.repeat(otherFields)}y\n`);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.provider, 'provider-b');
  assert.equal(config.model, 'model-b');
  assert.match(output, /缓存菜单/);
  assert.match(output, /保存配置/);
});

test('rejected confirmation and premature EOF never write', async t => {
  const { path, run } = fixture(t);
  await run(['--set', 'provider', 'llm', '--set', 'model', 'chosen'], 'n\n');
  assert.equal(existsSync(path), false);
  await assert.rejects(run(['--set', 'provider', 'llm', '--set', 'model', 'chosen']), /输入结束/);
  assert.equal(existsSync(path), false);
});

test('invalid input is rejected before any write', async t => {
  const { cwd, run } = fixture(t);
  for (const args of [
    ['--set', 'workerArgs', '[42]', '--yes'],
    ['--set', 'requestTimeoutMs', '0', '--yes'],
    ['--set', 'exposeModelChoice', 'yes', '--yes'],
    ['--set', 'schema', '2', '--yes'],
    ['--mount-acp'], ['--config'],
  ]) await assert.rejects(run(args));
  assert.deepEqual(readdirSync(cwd), []);
});

test('existing writer lock prevents replacement and is retained', t => {
  const { cwd, path } = fixture(t);
  const snapshot = readSnapshot(path);
  writeFileSync(`${path}.configure.lock`, 'another writer');
  assert.throws(() => saveConfig(snapshot, BUILT_IN_CONFIG), /配置锁已存在/);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(cwd), ['bridge.config.json.configure.lock']);
});

test('refuses symlinks, including dangling symlinks', { skip: process.platform === 'win32' }, t => {
  const { path, cwd } = fixture(t);
  symlinkSync(join(cwd, 'absent.json'), path);
  assert.throws(() => readSnapshot(path), /不接受符号链接/);
});

test('Desktop preset preserves research route and clears stale npm/runtime overrides without launching anything', async t => {
  const { cwd, path, run } = fixture(t);
  const desktop = join(cwd, 'Desktop 安装');
  const launcher = desktopFixture(desktop, ['resources'], process.platform === 'win32' ? 'reasonix-studio-host.exe' : 'reasonix-studio-host');
  writeFileSync(path, JSON.stringify({ ...BUILT_IN_CONFIG, provider: 'llm', model: 'chosen', reasonixRoot: 'old-npm', workerEntry: 'old.js', nodeBin: 'old-node', workerArgs: ['old'] }));
  await run(['--desktop-root', desktop, '--check']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).workerEntry, 'old.js');
  await run(['--desktop-root', desktop, '--yes']);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.workerCommand, launcher);
  assert.equal(config.model, 'chosen');
  for (const key of ['workerEntry', 'nodeBin']) assert.equal(config[key], null);
  assert.equal(config.reasonixRoot, desktop);
  assert.deepEqual(config.workerArgs, []);
  assert.equal(config.transport, 'direct');
});

test('Desktop layouts inspect macOS app and Resources roots, plus Windows executable fixtures', t => {
  const { cwd } = fixture(t);
  const app = join(cwd, 'Harness.app');
  const mac = desktopFixture(app, ['Contents', 'Resources']);
  assert.equal(desktopWorkerConfig(app, { platform: 'darwin' }).workerCommand, mac);
  assert.equal(desktopWorkerConfig(join(app, 'Contents', 'Resources'), { platform: 'darwin' }).workerCommand, mac);
  const win = join(cwd, 'Windows 安装');
  const exe = desktopFixture(win, ['resources'], 'reasonix-studio-host.exe');
  assert.equal(desktopWorkerConfig(win, { platform: 'win32' }).workerCommand, exe);
});

test('Desktop missing or ambiguous launchers fail without changing configuration', async t => {
  const { cwd, path, run } = fixture(t);
  await assert.rejects(run(['--desktop', '--check']), /必须指定/);
  await assert.rejects(run(['--desktop-root', cwd, '--yes']), /未找到/);
  assert.equal(existsSync(path), false);
  desktopFixture(cwd, ['resources']);
  desktopFixture(cwd, ['Contents', 'Resources']);
  assert.throws(() => desktopWorkerConfig(cwd, { platform: 'linux' }), /多个/);
});

test('Desktop interactive selection still requires save confirmation', async t => {
  const { cwd, path, run } = fixture(t);
  const desktop = join(cwd, 'Desktop');
  desktopFixture(desktop, ['resources'], process.platform === 'win32' ? 'reasonix-studio-host.exe' : 'reasonix-studio-host');
  const output = await run(['--desktop', '--set', 'provider', 'llm', '--set', 'model', 'chosen'], `${desktop}\nn\n`);
  assert.match(output, /\.app\/Contents\/Resources/);
  assert.match(output, /Studio 配置与登录/);
  assert.ok(output.indexOf('Studio 路径说明') < output.indexOf('Desktop 安装目录、macOS'));
  assert.equal(existsSync(path), false);
  await run(['--desktop', '--set', 'provider', 'llm', '--set', 'model', 'chosen'], `${desktop}\ny\n`);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'chosen');
});

test('local Reasonix catalogue lists endpoint names without credentials or writes', async t => {
  const { cwd, path, run } = fixture(t);
  const config = join(cwd, 'reasonix-config.toml');
  const original = `default_model = 'llm/smart/reasoning'
[[providers]]
name = 'llm'
base_url = 'https://user:password@provider.example.org/v1?api_key=secret#token'
api_key = 'do-not-print-this'
api_key_env = 'SECRET_ENV_NAME'
models = [
 'deepseek-flash', # comment
 "smart/reasoning",
]
default = 'deepseek-flash'
[providers.model_overrides."smart/reasoning"]
name = 'not-a-provider'
[[providers]]
name = "other"
base_url = "https://example.org/v1"
models = ["other-model"]
`;
  writeFileSync(config, original);
  const output = await run(['--list-providers']);
  assert.match(output, /llm — https:\/\/provider\.example\.org\/v1/);
  assert.match(output, /smart\/reasoning/);
  for (const secret of ['password', 'secret', 'do-not-print-this', 'SECRET_ENV_NAME', 'not-a-provider']) assert.ok(!output.includes(secret));
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.equal(existsSync(path), false);
});

test('interactive configuration reads local providers before stale cache and saves chosen pair', async t => {
  const { cwd, path, run } = fixture(t);
  writeFileSync(join(cwd, 'reasonix-config.toml'), `[[providers]]
name = 'llm'
base_url = 'https://provider.example.org/v1'
models = ['deepseek-flash', 'smart/reasoning']
`);
  mkdirSync(join(cwd, '.bridge-state'));
  writeFileSync(join(cwd, '.bridge-state', 'models.json'), JSON.stringify({schema:1,summary:{model:{choices:[{value:'stale/old'}]}}}));
  const remaining = Object.keys(BUILT_IN_CONFIG).length - 4;
  const output = await run([], `\n1\n2\n${'\n'.repeat(remaining)}y\n`);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.provider, 'llm');
  assert.equal(config.model, 'smart/reasoning');
  assert.match(output, /Reasonix 配置菜单/);
  assert.ok(!output.includes('stale'));
});

test('home selection is applied before reading catalogue and zero keeps Studio defaults', async t => {
  const { cwd, path } = fixture(t);
  const home = join(cwd, 'custom-home'); mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), "[[providers]]\nname = 'custom'\nmodels = ['model']\n");
  let output = '';
  const remaining = Object.keys(BUILT_IN_CONFIG).length - 4;
  await main([], { cwd, input: Readable.from([`${home}\n0\n${'\n'.repeat(remaining)}y\n`]),
    output: new Writable({write(chunk, encoding, done){output+=chunk.toString();done();}}) });
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.reasonixHome, home);
  assert.equal(config.provider, null); assert.equal(config.model, null);
  assert.match(output, /custom/);
});

test('malformed TOML falls back safely without disclosing raw parse errors', async t => {
  const { cwd, path, run } = fixture(t);
  writeFileSync(join(cwd, 'reasonix-config.toml'), 'secret = "sensitive-invalid');
  const output = await run(['--list-providers']);
  assert.match(output, /unreadable_toml/);
  assert.ok(!output.includes('sensitive-invalid'));
  assert.equal(existsSync(path), false);
});
