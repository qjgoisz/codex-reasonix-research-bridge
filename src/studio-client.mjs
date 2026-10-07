// Translate Studio's authenticated HTTP/SSE surface into the client's internal
// session interface. This is NOT a claim that Studio speaks ACP.
import { createInterface } from 'node:readline';
import { AcpError } from './acp-client.mjs';
import { spawnWorker, terminateWorker } from './transport.mjs';

export function scrubStudioError(value) {
  return String(value ?? '').replace(/(?:Bearer\s+)[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1$2[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]').slice(0, 1000);
}
const failure = (code, message, submitted) => Object.assign(new AcpError(code, message), submitted === undefined ? {} : { submitted });
export function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw failure('invalid_studio_origin', 'Studio 必须提供纯 loopback HTTP origin。');
  return url.origin;
}
export function studioConfigOptions(catalogue, status) {
  const entries = Array.isArray(catalogue.models) ? catalogue.models : [];
  const current = status.modelRef ?? catalogue.current;
  const active = entries.find(m => m.ref === current || m.active);
  const options = [{ id: 'model', type: 'select', currentValue: current ?? null,
    options: entries.filter(m => typeof m.ref === 'string').map(m => ({ value: m.ref, name: m.displayName ?? m.ref })) }];
  if (active?.efforts?.length) options.push({ id: 'effort', type: 'select', currentValue: status.effort ?? active.effort,
    options: active.efforts.map(value => ({ value, name: value })) });
  return options;
}

export class StudioClient {
  #child; #origin; #token; #ready; #sessions = new Map(); #listeners = new Set();
  #permission = async () => ({ outcome: 'cancelled' }); #requests = new Map(); #next = 1;
  #closing = false; #started = false;
  constructor(spec) {
    this.spec = spec; this.failure = null; this.workerInfo = null; this.agentCapabilities = null;
    this.requestTimeoutMs = spec.requestTimeoutMs ?? 30_000;
    this.promptTimeoutMs = spec.promptTimeoutMs ?? 1_800_000;
    this.onDisconnect = spec.onDisconnect;
    // Test injection never goes into persisted bridge configuration.
    if (spec.connection) {
      this.#origin = validateOrigin(spec.connection.origin); this.#token = spec.connection.token;
      this.#ready = Promise.resolve(); return;
    }
    this.#child = spawnWorker(spec);
    this.exit = new Promise(resolve => this.#child.once('close', (code, signal) => {
      if (!this.#closing) this.#fail(failure('worker_exit', `Studio 后端退出：${code ?? signal}`));
      resolve({ code, signal });
    }));
    this.#child.on('error', () => this.#fail(failure('spawn_error', '无法启动 Reasonix Studio 后端，请检查入口。')));
    // Do not forward logs: the handshake contains the launch credential.
    this.#child.stderr.resume();
    this.#ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: this.#child.stdout });
      const timer = setTimeout(() => finish(failure('request_timeout', 'Studio 启动握手超时。')), this.requestTimeoutMs);
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      lines.on('line', line => {
        if (settled) return;
        try {
          if (Buffer.byteLength(line) > 16384) throw new Error();
          const h = JSON.parse(line);
          if (h.version !== 1 || typeof h.token !== 'string' || !h.token) throw new Error();
          this.#origin = validateOrigin(h.origin); this.#token = h.token; finish();
        } catch { finish(failure('invalid_handshake', '无法识别 Studio 后端握手。')); }
      });
      this.#child.once('error', () => finish(failure('spawn_error', 'Studio 后端无法启动。')));
      this.#child.once('close', () => finish(failure('worker_exit', 'Studio 握手前退出。')));
    });
  }
  get pid() { return this.#child?.pid ?? null; }
  get childForDiagnostics() { return this.#child; }
  get connectionInfo() { return { origin: this.#origin, owned: Boolean(this.#child) }; }
  onUpdate(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  setPermissionPolicy(policy) { this.#permission = policy; }
  wasSubmitted(id) { return this.#requests.get(id) ?? false; }
  #emit(id, update) { for (const fn of this.#listeners) fn({ sessionId: id, update }); }
  #fail(error) {
    this.failure ??= error;
    for (const s of this.#sessions.values()) s.active?.reject(error);
    this.onDisconnect?.({ code: error.code, pid: this.pid });
  }
  async #fetch(path, { method = 'GET', body, signal } = {}) {
    await this.#ready;
    const headers = { Cookie: `reasonix_token=${this.#token}`, Origin: this.#origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(this.#origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.requestTimeoutMs), redirect: 'error' });
  }
  async #json(path, options) {
    const response = await this.#fetch(path, options);
    if (!response.ok) {
      // Never copy response bodies into diagnostics; some upstream failures
      // include provider secrets. The status/path are sufficient for diagnosis.
      await response.body?.cancel();
      throw failure('studio_http_error', `Studio ${options?.method ?? 'GET'} ${path} 返回 HTTP ${response.status}。`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw failure('output_limit', 'Studio 响应超出限制。');
    return text ? JSON.parse(text) : null;
  }
  async initialize() {
    await this.#ready;
    await this.#json('/runtimes'); this.#started = true;
    // protocolVersion=null preserves the distinction from native ACP.
    this.workerInfo = { name: 'reasonix-studio-http', version: 'host-handshake-v1' };
    this.agentCapabilities = { sessionCapabilities: { close: {}, resume: {} }, _meta: { transport: 'studio-http' } };
    return { protocolVersion: null, agentInfo: this.workerInfo, agentCapabilities: this.agentCapabilities };
  }
  async #options(session) {
    const [catalogue, status] = await Promise.all([
      this.#json(session.base + '/models'), this.#json(session.base + '/status')]);
    return { options: studioConfigOptions(catalogue, status), status };
  }
  async #open({ cwd, sessionId, model }) {
    const rt = await this.#json('/runtimes', { method: 'POST', body: { root: cwd, ...(model ? { model } : {}), ...(sessionId ? { sessionPath: sessionId } : {}) } });
    if (typeof rt?.id !== 'string' || !/^r[0-9]+$/.test(rt.id) || rt.base !== `/rt/${rt.id}`)
      throw failure('invalid_frame', 'Studio runtime 响应格式不兼容。');
    const session = { runtime: rt.id, base: rt.base, cwd, active: null, sequence: null, attempts: 0 };
    try {
      if (!sessionId) await this.#json(session.base + '/new', { method: 'POST', body: {} });
      const { options, status } = await this.#options(session);
      const id = status.sessionPath;
      if (typeof id !== 'string' || !id || (sessionId && id !== sessionId)) throw failure('invalid_frame', 'Studio 未返回匹配的持久会话路径。');
      session.id = id; session.options = options;
      this.#sessions.set(id, session);
      return { sessionId: id, configOptions: options };
    } catch (error) {
      await this.#json(`/runtimes/${rt.id}/close`, { method: 'POST', body: {} }).catch(() => {}); throw error;
    }
  }
  newSession(params) { return this.#open(params); }
  resumeSession(params) { return this.#open(params); }
  async listSessions() { return { sessions: [...this.#sessions.values()].map(s => ({ sessionId: s.id, cwd: s.cwd })) }; }
  #get(id) { const s = this.#sessions.get(id); if (!s) throw failure('session_not_found', '找不到此桥拥有的会话。'); return s; }
  async setConfigOption({ sessionId, configId, value }) {
    const session = this.#get(sessionId);
    if (session.active) throw failure('session_busy', '运行中的会话不能改路由。');
    const before = await this.#options(session);
    const option = before.options.find(o => o.id === configId);
    if (!option || !option.options.some(o => o.value === value)) throw failure('invalid_config_option', '所选值不在 Studio 目录内。');
    if (option.currentValue !== value) {
      if (configId === 'effort') throw failure('studio_effort_requires_config_edit', 'Studio effort 接口会修改全局配置；请在 Studio 内选择档位，桥只沿用或核对当前值。');
      if (configId !== 'model') throw failure('invalid_config_option');
      await this.#json(session.base + '/model', { method: 'POST', body: { ref: value, default: false } });
    }
    const after = await this.#options(session);
    if (after.options.find(o => o.id === configId)?.currentValue !== value) throw failure('route_not_applied', 'Studio 未确认路由生效。');
    session.options = after.options;
    return { configOptions: after.options };
  }
  async #permissionEvent(s, event) {
    const turn = s.active;
    const a = event.approval;
    if (!a?.id || !a.tool) throw failure('invalid_frame', 'Studio 审批缺少身份。');
    const options = [{ optionId: `${a.id}:allow_once`, kind: 'allow_once', name: `${a.tool}: ${a.subject ?? ''}` },
      { optionId: `${a.id}:reject_once`, kind: 'reject_once', name: '拒绝' }];
    const params = { sessionId: s.id, toolCall: { toolCallId: a.id, title: a.tool, rawInput: a.input, description: a.reason }, options };
    const decision = typeof this.#permission === 'function' ? await this.#permission(params) : await this.#permission.decide(params);
    if (s.active !== turn) return;
    await this.#json(s.base + '/approve', { method: 'POST', body: { id: a.id,
      allow: decision?.outcome === 'selected' && decision.optionId === options[0].optionId, session: false, persist: false } });
  }
  #event(s, e) {
    if (!s.active) return;
    if (Number.isSafeInteger(e.seq) && e.seq > 0 && e.kind !== 'stream_watermark') {
      if (s.sequence !== null && e.seq !== s.sequence + 1) throw failure('connection_lost', 'Studio 事件序号不连续，结果不可确认。', true);
      s.sequence = e.seq;
    }
    if (e.kind === 'stream_watermark' && s.sequence !== null && e.seq > s.sequence)
      throw failure('connection_lost', 'Studio 事件水位显示有遗漏。', true);
    switch (e.kind) {
      case 'turn_started': s.active.started = true; this.#emit(s.id, { sessionUpdate: 'user_message_chunk', content: { text: e.text ?? '' } }); break;
      // Full messages are authoritative. Deltas can be shed by Studio itself.
      case 'message': this.#emit(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (e.text ?? '') + '\n' } }); break;
      case 'reasoning': this.#emit(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: e.text ?? '' } }); break;
      case 'tool_dispatch': this.#emit(s.id, { sessionUpdate: 'tool_call', toolCallId: e.tool?.id, title: e.tool?.name, status: 'in_progress' }); break;
      case 'tool_result': this.#emit(s.id, { sessionUpdate: 'tool_call_update', toolCallId: e.tool?.id, status: e.tool?.err ? 'failed' : 'completed' }); break;
      case 'approval_request': this.#permissionEvent(s, e).catch(error => s.active?.reject(error)); break;
      case 'ask_request': {
        // Stop the native wait, surface its exact questions as the bridge's
        // existing clarification flow, then resume via an ordinary new prompt.
        const question = e.nonPersistable ? 'Reasonix 请求不可持久化的登录或交互，请在 Studio 中完成后续跑。' : JSON.stringify(e.ask);
        this.#emit(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n<<BRIDGE_CLARIFY>>\n${question}\n` } });
        s.active.clarification = true;
        this.#json(s.base + '/cancel', { method: 'POST', body: {} }).catch(error => s.active?.reject(error)); break;
      }
      case 'turn_done':
        if (!s.active.started) break;
        if (e.err && !e.cancelled) s.active.reject(failure('studio_turn_error', `Studio 执行失败：${scrubStudioError(e.err)}`, true));
        else s.active.resolve({ stopReason: s.active.clarification ? 'end_turn' : e.cancelled ? 'cancelled' : e.outcome ? 'max_turn_requests' : 'end_turn',
          _meta: { studioOutcome: e.outcome ?? null, receipt: e.receipt ?? null } });
        break;
    }
  }
  async #stream(s, signal) {
    const response = await this.#fetch(s.base + '/events', { signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel(); throw failure('invalid_frame', 'Studio 未开启 SSE 事件流。', false);
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    s.active.streamReady();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw failure('connection_lost', 'Studio SSE 提前关闭。', s.active?.submitted);
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw failure('output_limit', 'Studio SSE 帧超出限制。', true);
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (data) this.#event(s, JSON.parse(data));
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  prompt({ sessionId, text }) {
    const requestId = this.#next++;
    this.#requests.set(requestId, false);
    const promise = this.#prompt(sessionId, text, requestId);
    promise.requestId = requestId; return promise;
  }
  async #prompt(id, text, requestId) {
    let s = this.#get(id);
    if (s.active) throw failure('session_busy', '此会话已有运行中的提示。', false);
    // Some Responses relays accept an initial request but reject chaining with
    // previous_response_id. Rebuild BEFORE a new explicit prompt; never replay
    // a failed/unknown prompt. Persisted transcript and session ID stay the same.
    if (s.attempts > 0 && this.spec.studioRuntimeReuse !== true) {
      const old = s, model = s.options?.find(o => o.id === 'model')?.currentValue;
      await this.closeSession(id);
      await this.#open({ cwd: old.cwd, sessionId: id, model });
      s = this.#get(id);
      for (const field of ['model', 'effort']) {
        const before = old.options?.find(o => o.id === field)?.currentValue;
        const after = s.options?.find(o => o.id === field)?.currentValue;
        if (before !== after) throw failure('route_changed_on_resume', '重建 runtime 后路由或档位发生变化，未提交新提示。', false);
      }
    }
    s.attempts++;
    const abort = new AbortController();
    let resolve, reject, ready;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Attach a handler before a fast stream/submit error can reject it.
    result.catch(() => {});
    const streamReady = new Promise(yes => { ready = yes; });
    s.sequence = null;
    s.active = { resolve, reject, streamReady: ready, started: false, submitted: false, abort };
    const timer = setTimeout(() => reject(failure('prompt_timeout', 'Studio 提示超时，结果未知。', s.active?.submitted)), this.promptTimeoutMs);
    const stream = this.#stream(s, abort.signal).catch(error => reject(error));
    try {
      await Promise.race([streamReady, result]);
      // From this point a dropped response can still mean the server admitted it.
      s.active.submitted = true; this.#requests.set(requestId, true);
      await this.#json(s.base + '/submit', { method: 'POST', body: { input: text } });
      return await result;
    } catch (error) { if (error.submitted === undefined) error.submitted = s.active?.submitted ?? false; throw error; }
    finally { clearTimeout(timer); abort.abort(); await stream; s.active = null; }
  }
  cancel(id) { const s = this.#get(id); this.#json(s.base + '/cancel', { method: 'POST', body: {} }).catch(error => s.active?.reject(error)); }
  async closeSession(id) {
    const s = this.#get(id);
    s.active?.reject(failure('client_shutdown', '会话已关闭。', s.active?.submitted));
    s.active?.abort.abort();
    await this.#json(`/runtimes/${s.runtime}/close`, { method: 'POST', body: {} });
    this.#sessions.delete(id);
  }
  async shutdown() {
    this.#closing = true;
    for (const id of this.#sessions.keys()) await this.closeSession(id).catch(() => {});
    this.#token = null;
    if (!this.#child) return { code: 0, signal: null, observed: true };
    this.#child.stdin.end();
    return terminateWorker(this.#child, { graceMs: 2000, killMs: 3000 });
  }
  async emergencyKill() { this.#closing = true; return this.#child ? terminateWorker(this.#child, { graceMs: 1, killMs: 2000 }) : { observed: true }; }
}
