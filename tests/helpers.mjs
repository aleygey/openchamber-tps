import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(fn, timeout = 4000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) { last = await fn(); if (last) return last; await delay(25); }
  throw new Error(`Timed out waiting for condition; last value: ${JSON.stringify(last)}`);
}
export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function fixture(t, options = {}) {
  const state = { events: new Set(), cookies: [], logins: [], requests: 0, password: 'test-password-only', secret: 'session-fixture-secret', revoked: false };
  let origin;
  let listenPort;
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    if (path === '/auth/session') {
      let body = '';
      for await (const c of req) body += c;
      const data = JSON.parse(body);
      state.logins.push({ data, origin: req.headers.origin, cookie: req.headers.cookie });
      if (options.loginDelay) await delay(options.loginDelay);
      if (res.destroyed) return;
      if (options.loginRedirect) { res.writeHead(307, { Location: options.loginRedirect }); res.end(); return; }
      if (options.rateLimit) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' }); res.end('{"retryAfter":2}'); return; }
      if (data.password !== state.password) { res.writeHead(401); res.end('{"error":"Invalid credentials"}'); return; }
      if (req.headers.origin !== origin) { res.writeHead(403); res.end('{}'); return; }
      const name = `oc_ui_session_${listenPort}`;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${name}=${state.secret}; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax` });
      res.end('{"authenticated":true}'); return;
    }
    if (path === '/api/global/event') {
      state.requests++; state.cookies.push(req.headers.cookie ?? null);
      if (options.streamRedirect) { res.writeHead(302, { Location: options.streamRedirect }); res.end(); return; }
      if (!options.unprotected && (state.revoked || req.headers.cookie !== `oc_ui_session_${listenPort}=${state.secret}`)) {
        res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"locked":true}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.flushHeaders(); state.events.add(res); req.on('close', () => state.events.delete(res));
      res.write(': connected\r\n\r\n'); return;
    }
    res.writeHead(404); res.end('{}');
  });
  origin = await listen(server);
  listenPort = Number(new URL(origin).port);
  state.origin = origin;
  state.send = event => { for (const res of state.events) res.write(`data: ${JSON.stringify(event)}\r\n\r\n`); };
  state.closeStreams = () => { for (const res of state.events) res.end(); state.events.clear(); };
  t.after(async () => { state.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return state;
}
export async function service(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(os.tmpdir(), 'tps-test-'));
  const reservation = http.createServer();
  const origin = await listen(reservation);
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const token = randomBytes(20).toString('hex');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../service/main.js', import.meta.url))], {
    env: { PATH: process.env.PATH, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, OPENCHAMBER_TPS_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  t.after(async () => { await stop(); if (!options.directory) await rm(directory, { recursive: true, force: true }); });
  const call = async (method, path, data, authenticated = true) => {
    const response = await fetch(origin + path, {
      method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  await waitFor(async () => { try { return (await call('GET', '/health')).status === 200; } catch { return false; } });
  return { origin, call, directory, stop, output: () => output, rate: async () => (await call('GET', '/rate')).data };
}
export const event = (type, data) => ({ id: randomBytes(6).toString('hex'), type, data });
