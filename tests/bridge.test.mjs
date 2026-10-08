import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const code = await readFile(new URL('../ui/host-bridge.js', import.meta.url), 'utf8');
function fixture() {
  const handlers = new Set(); const sent = [];
  const parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const win = { parent, addEventListener: (_, fn) => handlers.add(fn), removeEventListener: (_, fn) => handlers.delete(fn) };
  vm.runInNewContext(code, { window: win, setTimeout, clearTimeout, console });
  const host = win.TPSHost.connectHost(win, 200);
  const message = (data, source = parent) => { for (const h of handlers) h({ data, source }); };
  return { host, message, sent };
}
test('SDK hello/ready/session and real v1 resize envelope', async () => {
  const f = fixture(); let ready = null; let session = null;
  f.host.onReady(v => { ready = v; }); f.host.onSession(v => { session = v; });
  assert.equal(f.sent[0].data.type, 'hello');
  f.message({ channel: 'openchamber.sdk', v: 1, type: 'ready', payload: { session: { id: 'ses-a' } } });
  assert.equal(ready.session.id, 'ses-a'); assert.equal(session.id, 'ses-a');
  f.message({ channel: 'openchamber.sdk', v: 1, type: 'session', payload: { session: { id: 'ses-b' } } });
  assert.equal(session.id, 'ses-b');
  const call = f.host.setHeight(200);
  const req = f.sent.at(-1).data; assert.equal(req.type, 'resize'); assert.equal(req.payload.height, 200);
  f.message({ channel: 'openchamber.sdk', v: 1, type: 'result', id: req.id, ok: true });
  await call; f.host.dispose();
});
test('service requests accept matching parent responses only', async () => {
  const f = fixture();
  const promise = f.host.serviceRequest({ method: 'GET', path: '/rate' });
  const req = f.sent.at(-1).data; assert.equal(req.type, 'service-request');
  const reply = { channel: 'openchamber.sdk', v: 1, type: 'result', id: req.id, ok: true, payload: { status: 200, body: '{"ok":true}' } };
  f.message(reply, {}); // untrusted sender must be ignored
  f.message({ ...reply, v: 2 }); // version mismatch must be ignored
  f.message(reply);
  const result = await promise; assert.equal(result.status, 200); f.host.dispose();
});
