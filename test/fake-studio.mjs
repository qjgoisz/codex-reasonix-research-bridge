// test/fake-studio.mjs
//
// Standalone, dependency-free test fixture that emulates a Reasonix Studio
// launch HTTP server for the HTTP adapter under test.
//
// Contract (see the delegating task):
//   const studio = await startFakeStudio();
//   studio.origin  // e.g. "http://127.0.0.1:54321"
//   studio.token   // "test-launch-token"
//   studio.requests// recorded { method, url, body, ... } (NEVER Authorization)
//   studio.addRoute(method, path, handler) // register routes for the real protocol
//   await studio.close(); // closes all connections, never hangs
//
// Routing rules:
//   * Every request must carry `Cookie: reasonix_token=test-launch-token`,
//     otherwise the server replies 401 and records the request.
//   * GET /health -> { ok: true }
//   * GET /models -> { models: [{ provider, model, id }] }
//   * Anything else -> 404, request recorded with method/url/body.
//
// The Authorization header value is deliberately never copied into `requests`.

import http from 'node:http';

/** Default bearer token expected by the fixture, as specified by the task. */
export const LAUNCH_TOKEN = 'test-launch-token';

/** Hard cap on a recorded request body, so a stray huge payload cannot hang the test. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Time budget (ms) before `close()` forcibly destroys lingering sockets. */
const CLOSE_FORCE_MS = 1000;

/** Grace period (ms) before `close()` asks Node to drop all connections. */
const CLOSE_GRACE_MS = 250;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function normalizePathname(pathname) {
  if (!pathname) return '/';
  // Collapse a trailing slash so "/models/" and "/models" match the same route.
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function isAuthorized(headerValue, expectedToken) {
  if (typeof headerValue !== 'string') return false;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(headerValue.trim());
  if (!match) return false;
  return match[1] === expectedToken;
}

/**
 * Match a route pattern against a concrete pathname.
 * Supports exact segments and `:name` placeholders.
 * Returns a params object on match, or null when it does not match.
 */
function matchPath(pattern, pathname) {
  const patternParts = normalizePathname(pattern).split('/');
  const pathParts = normalizePathname(pathname).split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':') && expected.length > 1) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function parseBody(chunks, contentType) {
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return { body: '', json: undefined };
  // Only attempt JSON decoding for JSON-ish content types; keep the raw text regardless.
  if (!/\bjson\b/i.test(contentType || '')) return { body: raw, json: undefined };
  try {
    return { body: raw, json: JSON.parse(raw) };
  } catch {
    return { body: raw, json: undefined };
  }
}

/**
 * Run a route handler and normalize its return value into an HTTP response.
 *
 * Handler forms accepted:
 *   - write to `res` yourself (must end it), or
 *   - return a plain object -> 200 JSON, or
 *   - return a string/number -> 200 text, or
 *   - return undefined/null -> 204 empty.
 *
 * @param {(req, res, ctx) => unknown} handler
 * @param {object} ctx
 */
async function runHandler(handler, req, res, ctx) {
  const result = await handler(req, res, ctx);
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  if (result === undefined || result === null) {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (typeof result === 'object') {
    sendJson(res, 200, result);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(String(result));
}

/**
 * Start an in-process fake Reasonix Studio HTTP server.
 *
 * All options are optional:
 *   - token: bearer token to require (default "test-launch-token")
 *   - host: bind host (default "127.0.0.1")
 *   - port: bind port (default 0 = random free port)
 *   - silent: suppress nothing today; reserved for future logging
 *
 * @returns {Promise<{
 *   origin: string,
 *   token: string,
 *   requests: Array<object>,
 *   addRoute: (method: string, path: string, handler: Function) => { remove: () => void },
 *   setDefaultHandler: (handler: Function | null) => void,
 *   close: () => Promise<void>,
 *   server: import('node:http').Server,
 * }>}
 */
export async function startFakeStudio(options = {}) {
  const token = options.token ?? LAUNCH_TOKEN;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  /** @type {Array<{method: string, path: string, handler: Function}>} */
  const routes = [];
  /** @type {Array<{method: string, url: string, body: string, json?: unknown, status?: number}>} */
  const requests = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  let closed = false;
  /** @type {((req, res, ctx) => unknown) | null} */
  let defaultHandler = null;

  /**
   * Register a route on this fixture. Later registrations take precedence for
   * the same method+path, so callers can override the built-in /health and
   * /models routes to match the real Studio protocol.
   *
   * Handler signature: (req, res, ctx) => unknown. Returning a plain object
   * sends 200 JSON; returning undefined means the handler wrote the response
   * itself. `ctx` = { url, pathname, params, body, json, headers, token,
   * requests, addRoute, setDefaultHandler }.
   *
   * @param {string} method HTTP method, case-insensitive
   * @param {string} path Route pattern, supports `:name` segments
   * @param {Function} handler
   */
  function addRoute(method, path, handler) {
    if (typeof method !== 'string' || typeof path !== 'string' || typeof handler !== 'function') {
      throw new TypeError('addRoute(method, path, handler) requires two strings and a function');
    }
    const entry = { method: method.toUpperCase(), path, handler };
    routes.push(entry);
    return {
      method: entry.method,
      path: entry.path,
      remove() {
        const index = routes.indexOf(entry);
        if (index >= 0) routes.splice(index, 1);
      },
    };
  }

  /** Replace the fallback used when no route matches (default: 404 JSON). */
  function setDefaultHandler(handler) {
    if (handler !== null && typeof handler !== 'function') {
      throw new TypeError('setDefaultHandler(handler) requires a function or null');
    }
    defaultHandler = handler;
  }

  async function handleRequest(req, res) {
    // Record shape intentionally excludes Authorization and any other header.
    const record = {
      method: req.method ?? '',
      url: req.url ?? '',
      body: '',
      json: undefined,
    };
    requests.push(record);

    // --- read and record the body (bounded) ---
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          record.error = 'request body exceeded fixture limit';
          record.status = 413;
          sendJson(res, 413, { error: 'payload_too_large' });
          return;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      record.error = `failed to read request body: ${error?.message ?? error}`;
      record.status = 400;
      if (!res.headersSent) sendJson(res, 400, { error: 'bad_request' });
      else res.destroy();
      return;
    }

    const parsed = parseBody(chunks, req.headers['content-type']);
    record.body = parsed.body;
    if (parsed.json !== undefined) record.json = parsed.json;

    // --- authentication (checked for every request) ---
    if (req.headers.cookie !== `reasonix_token=${token}`) {
      record.status = 401;
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // --- routing ---
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    pathname = normalizePathname(pathname);

    const ctx = {
      url: req.url,
      pathname,
      params: {},
      body: record.body,
      json: record.json,
      headers: req.headers,
      token,
      requests,
      addRoute,
      setDefaultHandler,
    };

    // Last registered route wins, so callers can override built-ins.
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const entry = routes[i];
      if (entry.method !== (req.method ?? '').toUpperCase()) continue;
      const params = matchPath(entry.path, pathname);
      if (params === null) continue;
      ctx.params = params;
      try {
        await runHandler(entry.handler, req, res, ctx);
        if (!res.writableEnded) {
          record.status = res.statusCode;
          return;
        }
        record.status = res.statusCode;
        return;
      } catch (error) {
        record.error = String(error?.message ?? error);
        record.status = 500;
        if (!res.headersSent) sendJson(res, 500, { error: 'fixture_route_error', message: String(error?.message ?? error) });
        else res.destroy();
        return;
      }
    }

    if (defaultHandler) {
      try {
        await runHandler(defaultHandler, req, res, ctx);
        record.status = res.statusCode;
        return;
      } catch (error) {
        record.error = String(error?.message ?? error);
        record.status = 500;
        if (!res.headersSent) sendJson(res, 500, { error: 'fixture_default_error', message: String(error?.message ?? error) });
        else res.destroy();
        return;
      }
    }

    record.status = 404;
    sendJson(res, 404, { error: 'not_found', method: req.method, url: req.url });
  }

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handleRequest(req, res))
      .catch((error) => {
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'fixture_error', message: String(error?.message ?? error) });
          } else {
            res.destroy();
          }
        } catch {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        }
      });
  });

  // Explicitly keep the server from hanging on for keep-alive/idle sockets.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      /* a client reset must not crash the fixture */
    });
  });

  // --- built-in routes (registered first, so addRoute can override them) ---
  addRoute('GET', '/health', () => ({ ok: true }));
  addRoute('GET', '/models', () => ({
    models: [{ provider: 'deepseek', model: 'deepseek-flash', id: 'deepseek/deepseek-flash' }],
  }));

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const origin = `http://${host}:${boundPort}`;

  /**
   * Close the fixture. Idempotent. Guarantees resolution even if a client
   * keeps a keep-alive connection open, by escalating:
   *   1. server.close() + closeIdleConnections()
   *   2. closeAllConnections() after a short grace period
   *   3. destroy() every tracked socket after a hard deadline
   */
  async function close() {
    if (closed) return;
    closed = true;

    await new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(graceTimer);
        resolve();
      };

      const forceTimer = setTimeout(() => {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
        settle();
      }, CLOSE_FORCE_MS);

      const graceTimer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, CLOSE_GRACE_MS);

      try {
        server.close(() => settle());
      } catch {
        settle();
      }
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });

    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
  }

  return {
    origin,
    token,
    requests,
    addRoute,
    setDefaultHandler,
    close,
    server,
  };
}

export default startFakeStudio;
