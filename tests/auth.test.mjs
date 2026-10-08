import test from 'node:test';
import assert from 'node:assert/strict';
import { UiSessionAuth, normalizeOrigin, readSessionCookie } from '../service/auth.js';
import { fixture, delay } from './helpers.mjs';

test('origin validation rejects credentials, paths, non-http schemes and query strings', () => {
  assert.equal(normalizeOrigin('http://LOCALHOST:3000/'), 'http://localhost:3000');
  for (const bad of ['file:///tmp/a', 'https://a/a', 'http://u:p@host', 'https://host?x=1', 'https://host#x', 'not-url']) {
    assert.throws(() => normalizeOrigin(bad));
  }
});
test('login uses official endpoint and keeps port-scoped cookie in memory', async t => {
  const remote = await fixture(t);
  const auth = new UiSessionAuth(); auth.setOrigin(remote.origin);
  await auth.login(remote.origin, remote.password);
  assert.equal(auth.authenticated, true);
  assert.match(auth.headersFor(remote.origin).Cookie, /^oc_ui_session_\d+=session-fixture-secret$/);
  assert.deepEqual(remote.logins[0].data, { password: remote.password, trustDevice: false });
  assert.deepEqual(auth.headersFor('https://other.invalid'), {});
  assert.equal(JSON.stringify(auth).includes(remote.secret), false);
  auth.clear(); assert.equal(auth.authenticated, false); assert.deepEqual(auth.headersFor(remote.origin), {});
});
test('wrong password is not retried automatically', async t => {
  const remote = await fixture(t); const auth = new UiSessionAuth(); auth.setOrigin(remote.origin);
  await assert.rejects(auth.login(remote.origin, 'wrong'), e => e.code === 'INVALID_PASSWORD');
  await delay(80); assert.equal(remote.logins.length, 1); assert.equal(auth.authenticated, false);
});
test('origin switching cancels pending login and drops all credentials', async t => {
  const remote = await fixture(t, { loginDelay: 150 });
  const other = await fixture(t);
  const auth = new UiSessionAuth(); auth.setOrigin(remote.origin);
  const login = auth.login(remote.origin, remote.password);
  await delay(30); auth.setOrigin(other.origin);
  await assert.rejects(login, e => e.code === 'ORIGIN_CHANGED');
  assert.deepEqual(auth.headersFor(other.origin), {}); assert.equal(auth.authenticated, false);
});
test('a login redirect never receives credentials at its destination', async t => {
  const other = await fixture(t);
  const remote = await fixture(t, { loginRedirect: other.origin + '/auth/session' });
  const auth = new UiSessionAuth(); auth.setOrigin(remote.origin);
  await assert.rejects(auth.login(remote.origin, remote.password), e => e.code === 'AUTH_REDIRECT');
  assert.equal(other.logins.length, 0);
});
test('429 prevents a second outbound login while Retry-After is active', async t => {
  const remote = await fixture(t, { rateLimit: true });
  const auth = new UiSessionAuth(); auth.setOrigin(remote.origin);
  await assert.rejects(auth.login(remote.origin, remote.password), e => e.code === 'LOGIN_RATE_LIMITED');
  await assert.rejects(auth.login(remote.origin, remote.password), e => e.code === 'LOGIN_RATE_LIMITED');
  assert.equal(remote.logins.length, 1);
});
test('session-cookie parsing accepts canonical names only and respects Secure/expiry', () => {
  const headers = new Headers({ 'set-cookie': 'oc_ui_session_3000=abc; HttpOnly; Max-Age=10; Path=/' });
  const cookie = readSessionCookie(headers, 'http://localhost:3000', 1000);
  assert.equal(cookie.value, 'oc_ui_session_3000=abc'); assert.equal(cookie.expiresAt, 11000);
  assert.throws(() => readSessionCookie(headers, 'http://localhost:4000'));
  assert.throws(() => readSessionCookie(new Headers({ 'set-cookie': 'oc_ui_session=abc; Secure' }), 'http://localhost'));
  assert.throws(() => readSessionCookie(new Headers({ 'set-cookie': 'oc_ui_session=abc; Max-Age=0' }), 'https://localhost'));
  assert.throws(() => readSessionCookie(new Headers({ 'set-cookie': 'other_secret=abc' }), 'https://localhost'));
});
