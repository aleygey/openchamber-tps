// Authenticated TPS service. Runs only behind OpenChamber's granted loopback proxy.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AuthError, UiSessionAuth, normalizeOrigin } from './auth.js';
import { TrackedMeter, SessionStatistics, StatisticsStore, SESSION_LIMIT } from './statistics.js';
import { SseParser } from './sse.js';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}
const expectedToken = Buffer.from(`Bearer ${token}`);
const auth = new UiSessionAuth();
const store = new StatisticsStore({ directory: process.env.OPENCHAMBER_TPS_DATA_DIR });
const meters = new Map();
let meter = new TrackedMeter(null, new SessionStatistics());
const saveTimer = setInterval(() => store.flush(), 5000);
saveTimer.unref();
let watch = null;
let connection = 'idle';
let lastError = null;
let errorCode = null;
let authRequired = false;
let controller = null;
let retryTimer = null;
let retryDelay = 1000;
let closing = false;

function stopStream() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  controller?.abort(); controller = null;
  connection = 'idle';
  for (const m of meters.values()) m.statistics.break();
}
function reconnect(message, code) {
  connection = 'error'; lastError = message; errorCode = code;
  if (!watch || authRequired || retryTimer || closing) return;
  const delay = retryDelay;
  retryDelay = Math.min(15000, retryDelay * 2);
  retryTimer = setTimeout(() => { retryTimer = null; void startStream(); }, delay);
}
async function startStream() {
  if (!watch || closing || authRequired) return;
  stopStream();
  const local = new AbortController();
  controller = local;
  const current = { ...watch };
  const stillCurrent = () => !local.signal.aborted && controller === local && !closing;
  connection = 'connecting'; lastError = null; errorCode = null;
  let reader = null;
  const headerTimeout = setTimeout(() => {
    if (stillCurrent()) {
      local.abort(); controller = null;
      reconnect('The event stream timed out before responding.', 'STREAM_TIMEOUT');
    }
  }, 10000);
  try {
    const response = await fetch(new URL('/api/global/event', current.origin), {
      headers: { Accept: 'text/event-stream', ...auth.headersFor(current.origin) },
      redirect: 'manual', signal: local.signal,
    });
    clearTimeout(headerTimeout);
    if (!stillCurrent()) { await response.body?.cancel(); return; }
    if (response.status === 401) {
      await response.body?.cancel();
      if (!stillCurrent()) return;
      auth.clear(); authRequired = true;
      connection = 'auth-required'; lastError = 'Sign in to TPS with the OpenChamber UI password.';
      errorCode = 'AUTH_REQUIRED';
      return; // No repeated unauthenticated polling of the event endpoint.
    }
    if (response.status === 403) {
      await response.body?.cancel();
      if (!stillCurrent()) return;
      connection = 'error'; errorCode = 'STREAM_FORBIDDEN';
      lastError = 'The server denies event access for this scope. Password login may also be unavailable.';
      return;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (!stillCurrent()) return;
      connection = 'error'; errorCode = 'STREAM_REDIRECT';
      lastError = 'Event stream redirected. Credentials were not forwarded. Check the server address.';
      return;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (stillCurrent()) reconnect(`Event stream answered HTTP ${response.status}`, 'STREAM_HTTP');
      return;
    }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')) {
      await response.body.cancel();
      if (stillCurrent()) {
        connection = 'error'; errorCode = 'NOT_EVENT_STREAM';
        lastError = 'The server returned a page instead of an event stream. Check the server address.';
      }
      return;
    }
    connection = 'live'; authRequired = false; retryDelay = 1000;
    const parser = new SseParser(event => {
      if (!stillCurrent()) return;
      const e = event?.payload ?? event;
      const p = e?.data ?? e?.properties;
      const id = p?.sessionID ?? p?.form?.sessionID;
      // The same global stream continues measuring previously opened sessions.
      // Unvisited sessions are not silently collected.
      const target = meters.get(id);
      if (target) target.event(event);
    });
    reader = response.body.getReader();
    while (stillCurrent()) {
      const { value, done } = await reader.read();
      if (done) break;
      if (stillCurrent()) parser.feed(value);
    }
    if (stillCurrent()) reconnect('Event stream closed; reconnecting.', 'STREAM_CLOSED');
  } catch {
    if (stillCurrent()) reconnect('Event stream disconnected; reconnecting.', 'STREAM_ERROR');
  } finally {
    clearTimeout(headerTimeout);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
function applyWatch(origin, sessionId) {
  const changed = !watch || watch.origin !== origin || watch.sessionId !== sessionId;
  if (!changed) return false;
  const differentServer = !watch || watch.origin !== origin;
  if (differentServer) {
    stopStream(); store.flush(); meters.clear();
    auth.setOrigin(origin);
  }
  watch = { origin, sessionId };
  if (sessionId) {
    const statistics = store.get(origin, sessionId);
    meter = meters.get(sessionId);
    if (!meter || meter.statistics !== statistics) meter = new TrackedMeter(sessionId, statistics);
    meters.delete(sessionId); meters.set(sessionId, meter);
    if (meters.size > SESSION_LIMIT) {
      const oldest = meters.keys().next().value;
      meters.get(oldest).statistics.break(); meters.delete(oldest);
    }
  } else meter = new TrackedMeter(null, new SessionStatistics());
  // Switching chat on one server must not restart SSE or erase measurements.
  if (differentServer) {
    retryDelay = 1000; authRequired = false; lastError = null; errorCode = null;
    void startStream();
  }
  return true;
}
function selectedMeter(url) {
  const id = url.searchParams.get('sessionId');
  if (!id) return meter;
  const result = meters.get(id);
  if (!result) throw new AuthError(404, 'SESSION_NOT_WATCHED', 'Open this session before reading its statistics.');
  return result;
}
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new AuthError(413, 'BODY_TOO_LARGE', 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new AuthError(400, 'BAD_JSON', 'Expected a JSON object.'); }
}
function authorized(req) {
  const actual = Buffer.from(req.headers.authorization ?? '');
  return actual.length === expectedToken.length && timingSafeEqual(actual, expectedToken);
}
const server = http.createServer(async (req, res) => {
  if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === '/health' && req.method === 'GET') {
      json(res, 200, { ok: true, version: '1.2.0', pid: process.pid }); return;
    }
    if (pathname === '/watch' && req.method === 'POST') {
      const body = await readBody(req);
      const origin = normalizeOrigin(body.origin);
      const id = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId : null;
      if (id && id.length > 512) throw new AuthError(400, 'BAD_SESSION', 'Session id is too long.');
      const changed = applyWatch(origin, id);
      json(res, 200, { ok: true, changed, connection, sessionId: id }); return;
    }
    if (pathname === '/rate' && req.method === 'GET') {
      const target = selectedMeter(url);
      json(res, 200, { ...target.rate(), sessionStats: target.statistics.summary(),
        statisticsWarning: store.warning, connection, error: lastError, errorCode,
        origin: watch?.origin ?? null, authRequired, authenticated: auth.authenticated,
        authExpiresAt: auth.expiresAt, authRetryAfter: auth.retryAfter }); return;
    }
    if (pathname === '/history' && req.method === 'GET') {
      const target = selectedMeter(url);
      const windowMs = Number(url.searchParams.get('windowMs') ?? 0);
      if (!Number.isFinite(windowMs) || windowMs < 0 || windowMs > 86400000) throw new AuthError(400, 'BAD_WINDOW', 'Invalid history window.');
      json(res, 200, { origin: watch?.origin ?? null, sessionId: target.sessionId,
        revision: target.statistics.revision, points: target.statistics.history(windowMs) }); return;
    }
    if (pathname === '/stats/reset' && req.method === 'POST') {
      const body = await readBody(req);
      if (!watch || body.origin !== watch.origin || !meters.has(body.sessionId)) throw new AuthError(409, 'SESSION_CHANGED', 'The session or server changed.');
      const target = meters.get(body.sessionId);
      target.statistics.reset();
      store.flush(); json(res, 200, { ok: true }); return;
    }
    if (pathname === '/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!watch) throw new AuthError(409, 'NO_WATCH', 'Open a session before signing in.');
      const origin = normalizeOrigin(body.origin);
      if (origin !== watch.origin) throw new AuthError(409, 'ORIGIN_CHANGED', 'The active server changed.');
      // Password transport over plain LAN HTTP is not encrypted; require consent.
      if (origin.startsWith('http:') && body.allowHttp !== true) {
        throw new AuthError(400, 'HTTP_CONFIRMATION_REQUIRED', 'Confirm the unencrypted HTTP server address before signing in.');
      }
      const password = body.password;
      delete body.password;
      const result = await auth.login(origin, password);
      authRequired = false; lastError = null; errorCode = null;
      void startStream();
      json(res, 200, result); return;
    }
    if (pathname === '/auth/clear' && req.method === 'POST') {
      stopStream(); auth.clear();
      authRequired = true; connection = 'auth-required'; errorCode = 'AUTH_REQUIRED';
      lastError = 'The TPS login was forgotten. Sign in again to resume.';
      json(res, 200, { ok: true }); return;
    }
    if (pathname === '/retry' && req.method === 'POST') {
      // Retry is explicit, never an automatic password retry.
      authRequired = false; retryDelay = 1000;
      void startStream(); json(res, 200, { ok: true }); return;
    }
    json(res, 404, { error: 'not-found' });
  } catch (error) {
    if (error instanceof AuthError) json(res, error.status, { code: error.code, error: error.message, retryAfter: error.retryAfter });
    else json(res, 500, { code: 'SERVICE_ERROR', error: 'TPS could not complete this request.' });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1');
function shutdown() {
  if (closing) return;
  closing = true; stopStream(); auth.clear(); clearInterval(saveTimer); store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
