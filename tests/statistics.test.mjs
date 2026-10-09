import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStatistics, TrackedMeter, StatisticsStore } from '../service/statistics.js';
import { fixture, service, waitFor, delay, event } from './helpers.mjs';
const emit = (m, type, data, at) => m.event({ type, data: { sessionID: 'a', ...data } }, at);
const delta = (m, at, count = 100) => emit(m, 'session.text.delta', { assistantMessageID: 'm', delta: 'x'.repeat(count) }, at);
function directory(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-metrics-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('active average is time-weighted, peak is retained, polling and idle add no observations', () => {
  const s = new SessionStatistics();
  s.observe(1000, 10, 'm'); s.observe(1500, 30, 'm'); s.observe(2000, 20, 'm');
  assert.equal(s.summary().averageTps, 22.5); assert.equal(s.summary().peakTps, 30);
  assert.equal(s.summary().activeMs, 1000);
  const before = s.serialize();
  for (let i = 0; i < 100; i++) { s.summary(); s.history(); }
  assert.deepEqual(s.serialize(), before);
  s.break(); s.observe(100000, 5, 'm');
  assert.equal(s.summary().activeMs, 1000); assert.equal(s.summary().averageTps, 22.5);
  assert.equal(s.history().at(-1).breakBefore, true);
});
test('single chunks, clock reversal, long gaps and different messages do not invent generation time', () => {
  const s = new SessionStatistics();
  s.observe(1000, 4, 'm'); assert.equal(s.summary().averageTps, null);
  s.observe(20000, 6, 'm'); s.observe(20020, 8, 'other'); s.observe(19000, 3, 'other');
  assert.equal(s.summary().activeMs, 0); assert.equal(s.summary().peakTps, 8);
  s.observe(19500, 5, 'other'); assert.equal(s.summary().averageTps, 4);
});
test('stream telemetry excludes snapshots, other sessions, tools and explicitly short waits', () => {
  const s = new SessionStatistics(); const m = new TrackedMeter('a', s);
  emit(m, 'session.text.ended', { assistantMessageID: 'old', text: 'full snapshot' }, 0);
  assert.equal(s.summary().observations, 0);
  delta(m, 10000); delta(m, 10200);
  assert.equal(s.summary().activeMs, 200); assert.equal(s.summary().peakTps, 10);
  emit(m, 'permission.asked', { id: 'p' }, 10300);
  emit(m, 'permission.replied', { requestID: 'p' }, 10400); delta(m, 10500);
  assert.equal(s.summary().activeMs, 200, 'even a 200ms permission wait must break the interval');
  emit(m, 'session.tool.started', {}, 10550); delta(m, 10600);
  assert.equal(s.summary().activeMs, 200);
  emit(m, 'session.text.delta', { sessionID: 'unvisited', assistantMessageID: 'x', delta: 'x'.repeat(1000) }, 10620);
  assert.equal(s.summary().observations, 4);
  emit(m, 'session.execution.succeeded', {}, 10700); delta(m, 10800);
  assert.equal(s.summary().activeMs, 200);
});
test('history is bounded and range filtering preserves cumulative active coordinates', () => {
  const s = new SessionStatistics(null, () => {}, 8);
  for (let i = 0; i < 30; i++) s.observe(1000 + i * 1000, i, 'm');
  assert.equal(s.history().length, 8); assert.equal(s.summary().droppedPoints, 22);
  assert.equal(s.summary().activeMs, 29000); assert.equal(s.summary().peakTps, 29);
  assert.equal(s.history()[0].breakBefore, true);
  assert.deepEqual(s.history(2000).map(p => p.activeMs), [27000, 28000, 29000]);
});
test('numeric statistics persist by hashed origin/session; restart excludes downtime and stores no raw ids', t => {
  const dir = directory(t); const store = new StatisticsStore({ directory: dir });
  const a = store.get('http://server:3000', 'secret-session-name');
  a.observe(1000, 10, 'secret-message-name'); a.observe(1500, 30, 'secret-message-name'); store.flush();
  const files = fs.readdirSync(dir); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.ok(!content.includes('secret')); assert.ok(!content.includes('http')); assert.ok(!content.includes('password'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
  const restored = new StatisticsStore({ directory: dir }).get('http://server:3000', 'secret-session-name');
  assert.deepEqual(restored.summary(), a.summary());
  restored.observe(99999, 15, 'secret-message-name'); assert.equal(restored.summary().activeMs, 500);
  assert.equal(store.get('http://other:3000', 'secret-session-name').summary().observations, 0);
  assert.equal(store.get('http://server:3000', 'other-session').summary().observations, 0);
});
test('corrupt storage and write errors degrade safely; retention touches only numeric telemetry files', t => {
  const dir = directory(t); const store = new StatisticsStore({ directory: dir, maxSessions: 3 });
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');
  for (let i = 0; i < 6; i++) { store.get('http://server:3000', String(i)).observe(1000 + i, i, 'm'); store.flush(); }
  assert.ok(fs.readdirSync(dir).filter(n => n.endsWith('.json')).length <= 3);
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'keep');
  const broken = new StatisticsStore({ directory: dir });
  fs.writeFileSync(path.join(dir, broken.key('http://a', 'bad') + '.json'), '{broken');
  assert.equal(broken.get('http://a', 'bad').summary().observations, 0); assert.equal(broken.warning, 'STATS_LOAD_FAILED');
  const badDir = new StatisticsStore({ directory: path.join(dir, 'unrelated.txt') });
  badDir.get('http://a', 'b').observe(1000, 10, 'm'); badDir.flush();
  assert.equal(badDir.warning, 'STATS_SAVE_FAILED');
  assert.throws(() => new SessionStatistics({ schema: 1, points: [] }), /Invalid/);
});
test('service keeps A/B histories separate, continues background observed sessions, and requires bearer for new endpoints', async t => {
  const remote = await fixture(t, { unprotected: true }); const s = await service(t);
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'a' });
  await waitFor(async () => (await s.rate()).connection === 'live');
  const send = id => remote.send(event('session.text.delta', { sessionID: id, assistantMessageID: 'msg-' + id, delta: 'x'.repeat(100) }));
  send('a'); await delay(100); send('a');
  await waitFor(async () => (await s.rate()).sessionStats.observations === 2);
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'b' });
  send('a'); send('b'); await delay(50);
  const a = (await s.call('GET', '/rate?sessionId=a')).data;
  const b = (await s.call('GET', '/rate?sessionId=b')).data;
  assert.equal(a.sessionStats.observations, 3); assert.equal(b.sessionStats.observations, 1);
  assert.equal(remote.requests, 1, 'switching sessions must not reconnect global SSE');
  assert.ok(a.sessionStats.averageTps > 0); assert.equal(b.sessionStats.averageTps, null);
  const history = await s.call('GET', '/history?sessionId=a&windowMs=60000');
  assert.equal(history.status, 200); assert.equal(history.data.sessionId, 'a'); assert.ok(history.data.points.length > 0);
  assert.equal((await s.call('GET', '/history', undefined, false)).status, 401);
  assert.equal((await s.call('POST', '/stats/reset', {}, false)).status, 401);
  assert.equal((await s.call('GET', '/history?windowMs=-2')).status, 400);
  assert.equal((await s.call('POST', '/stats/reset', { origin: 'http://other', sessionId: 'a' })).status, 409);
  await s.call('POST', '/stats/reset', { origin: remote.origin, sessionId: 'a' });
  assert.equal((await s.call('GET', '/rate?sessionId=a')).data.sessionStats.observations, 0);
  assert.equal((await s.call('GET', '/rate?sessionId=b')).data.sessionStats.observations, 1);
});
test('service restart restores average/peak/history without persisting UI credentials', async t => {
  const dir = directory(t); const remote = await fixture(t); const s = await service(t, { directory: dir });
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'a' });
  await waitFor(async () => (await s.rate()).authRequired);
  await s.call('POST', '/auth/login', { origin: remote.origin, password: remote.password, allowHttp: true });
  await waitFor(async () => (await s.rate()).connection === 'live');
  remote.send(event('session.text.delta', { sessionID: 'a', assistantMessageID: 'm', delta: 'x'.repeat(100) }));
  await delay(100);
  remote.send(event('session.text.delta', { sessionID: 'a', assistantMessageID: 'm', delta: 'x'.repeat(100) }));
  await waitFor(async () => (await s.rate()).sessionStats.observations === 2);
  const before = (await s.rate()).sessionStats; await s.stop();
  const content = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
  assert.ok(!content.includes(remote.password)); assert.ok(!content.includes(remote.secret));
  const next = await service(t, { directory: dir });
  await next.call('POST', '/watch', { origin: remote.origin, sessionId: 'a' });
  await waitFor(async () => (await next.rate()).authRequired);
  assert.deepEqual((await next.rate()).sessionStats, before);
  assert.equal((await next.rate()).authenticated, false);
});
