// Small explicit live check: three model turns, plus no-model session recovery.
// Keep it separate from the full file/clarification/cancel smoke suite.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudioClient } from '../src/studio-client.mjs';
import { createWorkerSpec } from '../src/worker.mjs';
import { loadConfigFile } from '../src/config.mjs';
if (!process.argv.includes('--allow-model')) throw new Error('Requires --allow-model; performs three brief model turns.');
const value = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const configPath = value('--config');
if (!configPath) throw new Error('Requires --config.');
const { config } = loadConfigFile(resolve(configPath));
const existing = value('--session');
if (existing && !value('--workspace')) throw new Error('--session requires --workspace');
const workspace = existing ? resolve(value('--workspace')) : mkdtempSync(join(tmpdir(), 'reasonix-text-acceptance-'));
const spec = createWorkerSpec({ workspace, backend: 'studio', reasonixHome: config.reasonixHome ?? undefined,
  installationRoot: config.reasonixRoot ?? undefined, command: config.workerCommand ?? undefined, args: config.workerArgs ?? undefined });
const report = { at: new Date().toISOString(), workspace, checks: {}, turns: [], promptsSent: 0 };
const target = resolve(value('--report') ?? join(workspace, 'report.json'));
let client;
try {
  client = new StudioClient({ ...spec, promptTimeoutMs: 180000 });
  await client.initialize();
  const created = existing ? await client.resumeSession({ sessionId: existing, cwd: workspace }) : await client.newSession({ cwd: workspace }); report.sessionId = created.sessionId;
  client.setPermissionPolicy(() => ({ outcome: 'cancelled' }));
  let text = '';
  client.onUpdate(n => { if (n.update.sessionUpdate === 'agent_message_chunk') text += n.update.content.text; });
  const prompt = async content => {
    text = ''; report.promptsSent++;
    const outcome = await client.prompt({ sessionId: report.sessionId, text: content });
    report.turns.push({ text, ...outcome }); return text;
  };
  if (existing) {
    const reply = await prompt('恢复后的独立桥接文本测试，不调用任何工具。只回复 RESUME_OK，然后结束。');
    report.checks.restoredTextRoundtrip = reply.includes('RESUME_OK');
  } else {
  const first = await prompt('桥接协议文本测试，不调用任何工具、不读取文件、不开展研究。只回复 BRIDGE_OK，然后结束。');
  report.checks.textRoundtrip = first.includes('BRIDGE_OK');
  const second = await prompt('同一会话继续做文本测试，不调用任何工具。只回复 SESSION_REUSED，然后结束。');
  report.checks.activeSessionRoundtrip = second.includes('SESSION_REUSED');
  await client.closeSession(report.sessionId);
  await client.shutdown();
  client = new StudioClient({ ...spec, promptTimeoutMs: 180000 });
  await client.initialize();
  const resumed = await client.resumeSession({ cwd: workspace, sessionId: report.sessionId });
  report.checks.reconnectResume = resumed.sessionId === report.sessionId;
  client.setPermissionPolicy(() => ({ outcome: 'cancelled' }));
  client.onUpdate(n => { if (n.update.sessionUpdate === 'agent_message_chunk') text += n.update.content.text; });
  const third = await prompt('恢复后的桥接文本测试，不调用任何工具。只回复 RESUME_OK，然后结束。');
  report.checks.resumedPrompt = third.includes('RESUME_OK');
  }
  if (!Object.values(report.checks).every(Boolean)) throw new Error('Text acceptance failed; see report.');
} catch (error) { report.error = { code: error.code, message: error.message }; process.exitCode = 1; }
finally {
  report.shutdown = await client?.shutdown();
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: target, ...report }, null, 2));
}
