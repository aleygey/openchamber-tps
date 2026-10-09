import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, service, waitFor, delay, event } from './helpers.mjs';

test('protected server: 401 -> manual login -> authenticated SSE -> TPS; no credential leaks', async t => {
  const remote = await fixture(t); const s = await service(t);
  assert.equal((await s.call('GET', '/rate', undefined, false)).status, 401);
  assert.equal((await s.call('GET', '/health', undefined, false)).status, 401);
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'ses-test' });
  await waitFor(async () => (await s.rate()).authRequired);
  const count = remote.requests;
  await delay(1150); assert.equal(remote.requests, count, '401 must stop automatic reconnect');
  const noConsent = await s.call('POST', '/auth/login', { origin: remote.origin, password: remote.password });
  assert.equal(noConsent.data.code, 'HTTP_CONFIRMATION_REQUIRED'); assert.equal(remote.logins.length, 0);
  const login = await s.call('POST', '/auth/login', { origin: remote.origin, password: remote.password, allowHttp: true });
  assert.equal(login.status, 200);
  await waitFor(async () => (await s.rate()).connection === 'live');
  remote.send(event('session.execution.started', { sessionID: 'ses-test' }));
  remote.send(event('session.text.delta', { sessionID: 'ses-test', assistantMessageID: 'msg-a', ordinal: 0, delta: 'A'.repeat(100) }));
  remote.send(event('session.text.delta', { sessionID: 'ses-other', assistantMessageID: 'msg-x', delta: 'X'.repeat(999) }));
  await waitFor(async () => (await s.rate()).eventsSeen >= 2);
  assert.equal((await s.rate()).tokensPerSecond, null, 'first chunk is not a timed sample');
  await delay(350);
  remote.send(event('session.text.delta', { sessionID: 'ses-test', assistantMessageID: 'msg-a', ordinal: 0, delta: 'A'.repeat(100) }));
  await waitFor(async () => (await s.rate()).tokensPerSecond > 0);
  const rate = await s.rate();
  assert.ok(rate.tokensPerSecond > 0 && rate.tokensPerSecond < 150); assert.equal(rate.authenticated, true);
  assert.equal(JSON.stringify(rate).includes(remote.password), false); assert.equal(JSON.stringify(rate).includes(remote.secret), false);
  assert.equal(s.output().includes(remote.password), false); assert.equal(s.output().includes(remote.secret), false);
  // A new session on the same server reuses the session cookie, but clears counts.
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'ses-next' });
  await waitFor(async () => (await s.rate()).connection === 'live');
  assert.equal((await s.rate()).chars, 0); assert.equal(remote.logins.length, 1);
  // Expiry/revocation on reconnect returns to sign-in, not an infinite retry loop.
  remote.revoked = true; remote.closeStreams();
  await waitFor(async () => (await s.rate()).authRequired, 5000);
  assert.equal((await s.rate()).authenticated, false);
});
test('unprotected servers still stream without any login request', async t => {
  const remote = await fixture(t, { unprotected: true }); const s = await service(t);
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'ses-a' });
  await waitFor(async () => (await s.rate()).connection === 'live');
  assert.equal(remote.logins.length, 0);
  assert.equal((await s.rate()).authRequired, false);
});
test('changing server clears cookie; cross-origin login is refused', async t => {
  const a = await fixture(t); const b = await fixture(t); const s = await service(t);
  await s.call('POST', '/watch', { origin: a.origin, sessionId: 'ses-a' });
  await waitFor(async () => (await s.rate()).authRequired);
  await s.call('POST', '/auth/login', { origin: a.origin, password: a.password, allowHttp: true });
  await waitFor(async () => (await s.rate()).connection === 'live');
  await s.call('POST', '/watch', { origin: b.origin, sessionId: 'ses-b' });
  await waitFor(async () => (await s.rate()).authRequired);
  assert.equal(b.cookies[0], null);
  const bad = await s.call('POST', '/auth/login', { origin: a.origin, password: a.password, allowHttp: true });
  assert.equal(bad.data.code, 'ORIGIN_CHANGED'); assert.equal(b.logins.length, 0);
});
test('stream redirects are not followed and no cookie reaches destination', async t => {
  const dest = await fixture(t, { unprotected: true });
  const remote = await fixture(t, { streamRedirect: dest.origin + '/api/global/event' });
  const s = await service(t);
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'ses-a' });
  await waitFor(async () => (await s.rate()).errorCode === 'STREAM_REDIRECT');
  assert.equal(dest.requests, 0);
});
test('clear login forgets the session; auth requests require service bearer', async t => {
  const remote = await fixture(t); const s = await service(t);
  await s.call('POST', '/watch', { origin: remote.origin, sessionId: 'ses-a' });
  await waitFor(async () => (await s.rate()).authRequired);
  assert.equal((await s.call('POST', '/auth/login', {}, false)).status, 401);
  await s.call('POST', '/auth/login', { origin: remote.origin, password: remote.password, allowHttp: true });
  await waitFor(async () => (await s.rate()).authenticated);
  await s.call('POST', '/auth/clear', {});
  assert.equal((await s.rate()).authenticated, false); assert.equal((await s.rate()).authRequired, true);
});
