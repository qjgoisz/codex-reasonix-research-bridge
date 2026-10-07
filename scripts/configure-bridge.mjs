#!/usr/bin/env node
import { readFileSync, lstatSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { BUILT_IN_CONFIG, validateConfig, defaultConfigPath } from '../src/config.mjs';
import { decodeModelSelector } from '../src/models.mjs';
import { readReasonixCatalogue, catalogueRoutes } from '../src/reasonix-catalogue.mjs';
import { desktopWorkerConfig } from '../src/platform/desktop.mjs';

const fields = Object.keys(BUILT_IN_CONFIG).filter(key => key !== 'schema');
const nullable = new Set(['provider', 'model', 'reasoningEffort', 'reasonixHome', 'reasonixRoot', 'workerCommand', 'workerArgs', 'workerEntry', 'nodeBin', 'profile']);
const hints = {
  studioRuntimeReuse: 'false 每轮恢复同一持久会话，兼容不支持 previous_response_id 的代理；true 保留 runtime',
  backend: 'studio（默认，安装包后端）/ acp（独立 CLI）',
  reasoningEffort: 'null 沿用当前档位；Studio 桥不改写全局 effort',
  exposeModelChoice: 'true / false', transport: 'direct / posix-pipes（ACP Linux）',
  approvalMode: 'ask / deny / allow-once；只批准当次请求',
  workerArgs: '完整 argv 的 JSON 字符串数组；null 使用后端默认参数',
  workerCommand: '后端可执行文件路径；null 自动发现', workerEntry: '自定义 JS 入口或 null',
  reasonixHome: 'Reasonix 配置目录；null 沿用平台默认',
  reasonixRoot: 'Reasonix Studio 安装根目录，例如 /opt/Reasonix Studio',
  provider: '真实模型目录的供应商；与 model 同时为 null 沿用 Studio 默认',
  model: '模型 id；与 provider 同时为 null 沿用 Studio 默认',
  nodeBin: 'JS 运行时路径或 null', profile: '保留兼容字段；Studio 不使用它',
};
const desktopPathHints = `Studio 路径说明：
  macOS: /Applications/Reasonix Studio.app 或 .app/Contents/Resources
  Linux: /opt/Reasonix Studio 或其 resources 目录
  Windows: 安装目录或 resources 目录
  应包含 resources/bin/reasonix-studio-host（Windows 为 .exe），资源目录下则为 bin/。
  不要填配置目录 ~/.reasonix。
`;
const authenticationHints = `桥沿用 Reasonix Studio 配置与登录；不复制凭据、不修改全局模型配置。
provider/model=null 保持 Studio 默认；可先用 models --refresh 读取实际路由。
`;
const help = `交互式桥配置（仅修改桥配置，不启动 REASONIX）
用法：node scripts/configure-bridge.mjs [选项]
  --config FILE       配置文件，默认启动目录的 bridge.config.json
  --set KEY VALUE     设置字段，可重复；有 --set 时跳过字段问答
  --yes               预览校验后直接保存；无 --set 时使用当前值/默认值
  --check             仅预览校验，不问答、不写文件
  --state-root DIR    配置读取失败时使用 DIR/models.json 缓存，默认 .bridge-state
  --reasonix-config FILE  只读指定 Reasonix config.toml；默认由 reasonixHome / REASONIX_HOME 确定
  --list-providers    显示本地配置中的提供商、地址、模型后退出，不写配置
  本地 TOML 读取使用 Python ≥3.11 标准库；缺少时退回缓存或手工输入
  --desktop           交互询问 Desktop 安装目录并配置其 CLI 启动器
  --desktop-root DIR  指定 Desktop 安装目录、macOS .app 或 Resources 目录
  --help              显示帮助
Enter 保留当前值；可空字段输入 null；保存前明确确认。
${desktopPathHints}${authenticationHints}`;

export function parseValue(key, text) {
  if (!fields.includes(key)) throw new Error(`未知或不可设置的字段：${key}`);
  if (text === 'null' && nullable.has(key)) return null;
  if (key === 'workerArgs') return JSON.parse(text);
  if (typeof BUILT_IN_CONFIG[key] === 'boolean') {
    if (!['true', 'false'].includes(text)) throw new Error(`${key} 必须是 true / false`);
    return text === 'true';
  }
  if (typeof BUILT_IN_CONFIG[key] === 'number') {
    if (!/^\d+$/.test(text)) throw new Error(`${key} 必须是正整数毫秒`);
    return Number(text);
  }
  return text;
}

export function readSnapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return { path, bytes: null, raw: {}, mode: 0o600 };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`配置必须是普通文件，不接受符号链接：${path}`);
  const bytes = readFileSync(path);
  const raw = JSON.parse(bytes.toString('utf8'));
  const result = validateConfig(raw);
  if (!result.config) throw new Error(result.problems.join('\n'));
  return { path, bytes, raw, mode: stat.mode & 0o777 };
}

function candidate(raw) {
  const result = validateConfig(raw);
  if (!result.config) throw new Error(result.problems.join('\n'));
  const comments = Object.fromEntries(Object.entries(raw).filter(([key]) => key.startsWith('_') || key.startsWith('$')));
  return { value: { ...comments, ...result.config }, warnings: result.warnings };
}

export function saveConfig(snapshot, value) {
  const bytes = Buffer.from(`${JSON.stringify(candidate(value).value, null, 2)}\n`);
  const check = () => {
    const current = readSnapshot(snapshot.path);
    if (current.bytes === null ? snapshot.bytes !== null : snapshot.bytes === null || !current.bytes.equals(snapshot.bytes)) {
      throw new Error('配置在问答期间被修改，请重新运行；未覆盖外部修改。');
    }
  };
  // Cooperating configurators serialize the compare-and-replace operation.
  const lock = `${snapshot.path}.configure.lock`;
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`配置锁已存在：${lock}；确认没有配置进程后可手工删除。`);
    throw error;
  }
  const temp = `${snapshot.path}.tmp.${randomUUID()}`;
  let backup = null;
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    check();
    if (snapshot.bytes?.equals(bytes)) return { changed: false, backup: null };
    const fd = openSync(temp, 'wx', snapshot.mode);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    check();
    if (snapshot.bytes !== null) {
      backup = `${snapshot.path}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
      writeFileSync(backup, snapshot.bytes, { flag: 'wx', mode: snapshot.mode });
    }
    check();
    renameSync(temp, snapshot.path);
    return { changed: true, backup };
  } finally {
    try {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } finally {
      try { closeSync(lockFd); } finally { unlinkSync(lock); }
    }
  }
}

function cachedModels(stateRoot) {
  try {
    const doc = JSON.parse(readFileSync(join(stateRoot, 'models.json'), 'utf8'));
    if (doc.schema !== 1) return [];
    return (doc.summary?.model?.choices ?? []).flatMap(choice => {
      const pair = decodeModelSelector(choice.value);
      return pair ? [pair] : [];
    });
  } catch { return []; }
}

export async function main(args = process.argv.slice(2), { input = process.stdin, output = process.stdout, cwd = process.cwd() } = {}) {
  let path = defaultConfigPath(cwd), stateRoot = join(cwd, '.bridge-state');
  let yes = false, checkOnly = false, desktop = false, desktopRoot, reasonixConfig, listProviders = false;
  const changes = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { output.write(help); return; }
    if (arg === '--yes') { yes = true; continue; }
    if (arg === '--list-providers') { listProviders = true; continue; }
    if (arg === '--check') { checkOnly = true; continue; }
    if (arg === '--desktop') { desktop = true; continue; }
    if (!['--config', '--state-root', '--desktop-root', '--reasonix-config', '--set'].includes(arg)) throw new Error(`未知选项：${arg}`);
    const count = arg === '--set' ? 2 : 1;
    if (i + count >= args.length) throw new Error(`${arg} 缺少参数`);
    if (arg === '--set') { changes.push([args[++i], args[++i]]); continue; }
    const value = args[++i];
    if (arg === '--config') path = resolve(cwd, value);
    else if (arg === '--reasonix-config') reasonixConfig = resolve(cwd, value);
    else if (arg === '--desktop-root') { desktop = true; desktopRoot = resolve(cwd, value); }
    else stateRoot = resolve(cwd, value);
  }
  if (desktop && !desktopRoot && (yes || checkOnly)) throw new Error('--desktop 搭配 --yes / --check 时必须指定 --desktop-root。');
  const snapshot = readSnapshot(path);
  let raw = { ...snapshot.raw };
  for (const [key, text] of changes) raw[key] = parseValue(key, text);
  let current = candidate(raw);
  const readCatalogue = () => readReasonixCatalogue({ home: current.value.reasonixHome, configPath: reasonixConfig });
  const showCatalogue = catalogue => {
    output.write(`Reasonix 配置目录：${catalogue.path}\n`);
    if (catalogue.error || !catalogue.providers.length) {
      output.write(`无法获取本地提供商目录（${catalogue.error ?? 'empty'}）；可使用缓存或手工输入。\n`);
      return;
    }
    output.write(`配置默认模型：${catalogue.defaultModel ?? '未指定'}\n`);
    for (const p of catalogue.providers) output.write(`  ${p.name}${p.displayName ? ` (${p.displayName})` : ''} — ${p.baseUrl ?? '地址未提供'}\n    模型：${p.models.join(', ')}；默认：${p.defaultModel ?? '未指定'}\n`);
    output.write('以上为本地配置声明；未启动后端、未验证服务或凭据可用性。\n');
  };
  if (listProviders) { showCatalogue(readCatalogue()); return; }
  let rl;
  try {
    let ask;
    if (!checkOnly && !yes) {
      rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
      const lines = rl[Symbol.asyncIterator]();
      ask = async prompt => {
        output.write(prompt);
        const line = await lines.next();
        if (line.done) throw new Error('输入结束，未保存配置。');
        return line.value.trim();
      };
    }
    if (desktop) {
      output.write(desktopPathHints + authenticationHints);
      if (!desktopRoot) {
        const answer = await ask('Desktop 安装目录、macOS .app 或 Resources 目录：');
        if (!answer) throw new Error('Desktop 目录为空，未保存配置。');
        desktopRoot = resolve(cwd, answer);
      }
      raw = { ...raw, ...desktopWorkerConfig(desktopRoot) };
      // Explicit field edits take precedence over the detected launch preset.
      for (const [key, text] of changes) raw[key] = parseValue(key, text);
      current = candidate(raw);
      output.write(`Studio 后端：${current.value.workerCommand}\n仅定位入口；未启动 Desktop，未验证协议。模型和 Reasonix home 保持当前值。\n`);
    }
    if (!changes.length && !checkOnly && !yes) {
      if (!desktop) output.write(authenticationHints);
      output.write('Enter 保留当前值；null 重置可空字段。配置不会启动 REASONIX 或调用模型。\n');
      raw = { ...current.value };
      const choose = async (key, values) => {
        output.write(`\n${key} ${menuSource}菜单（0 沿用 Studio 默认；m 手工输入）：\n${values.map((v, i) => `  ${i + 1}) ${v}`).join('\n')}\n`);
        while (true) {
          const answer = await ask(`${key} [${raw[key]}]：`);
          if (!answer) {
            if (key === 'model' && !values.includes(raw.model)) { output.write('请选择此提供商的模型，或输入 0 沿用 Studio 默认。\n'); continue; }
            return;
          }
          if (answer === '0' || answer === 'null') { raw.provider = null; raw.model = null; return; }
          if (answer === 'm') { await edit(key); return; }
          if (/^\d+$/.test(answer) && values[Number(answer) - 1]) { raw[key] = values[Number(answer) - 1]; return; }
          output.write('请输入菜单编号、0、m 或 Enter。\n');
        }
      };
      const edit = async key => {
        const hint = hints[key] ?? (key.endsWith('TimeoutMs') ? '正整数毫秒' : nullable.has(key) ? '路径或 null' : '非空字符串');
        while (true) {
          const answer = await ask(`${key} [${JSON.stringify(raw[key])}]（${hint}）：`);
          if (!answer) return;
          try {
            if (['provider', 'model'].includes(key)) { raw[key] = parseValue(key, answer); if (raw[key] === null) { raw.provider = null; raw.model = null; } return; }
            const next = candidate({ ...raw, [key]: parseValue(key, answer) });
            raw = next.value;
            return;
          } catch (error) { output.write(`${error.message}\n`); }
        }
      };
      // Ask for home first so menus match the worker's chosen configuration.
      await edit('reasonixHome');
      const catalogue = readReasonixCatalogue({ home: raw.reasonixHome, configPath: reasonixConfig });
      showCatalogue(catalogue);
      const local = catalogueRoutes(catalogue);
      const models = local.length ? local : cachedModels(stateRoot);
      const menuSource = local.length ? 'Reasonix 配置' : '缓存';
      if (models.length) {
        await choose('provider', [...new Set(models.map(m => m.provider))]);
        const options = [...new Set(models.filter(m => m.provider === raw.provider).map(m => m.model))];
        if (options.length) {
          if (!options.includes(raw.model)) {
            const preferred = catalogue.providers.find(p => p.name === raw.provider)?.defaultModel;
            raw.model = options.includes(preferred) ? preferred : null;
          }
          await choose('model', options);
        } else if (raw.provider !== null) await edit('model');
      } else {
        output.write('未发现可用模型目录缓存，请手工填写 provider/model。\n');
        await edit('provider'); await edit('model');
      }
      for (const key of fields.filter(key => !['provider', 'model', 'reasonixHome'].includes(key))) await edit(key);
      current = candidate(raw);
    }
    output.write(`\n配置预览：${path}\n${JSON.stringify(current.value, null, 2)}\n`);
    for (const warning of current.warnings) output.write(`提示：${warning}\n`);
    output.write('校验通过（结构校验；未验证 REASONIX 安装、凭据或模型可用性）。\n');
    if (checkOnly) { output.write('仅检查，未写入。\n'); return; }
    if (!yes && !['y', 'yes'].includes((await ask('保存配置？[y/N]：')).toLowerCase())) {
      output.write('未保存。\n'); return;
    }
    const saved = saveConfig(snapshot, current.value);
    output.write(saved.changed ? `已保存：${path}\n` : '配置没有变化，未写入或备份。\n');
    if (saved.backup) output.write(`原文件备份：${saved.backup}\n`);
  } finally { rl?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`配置失败：${error.message}\n`); process.exitCode = 1; });
}
