import test from 'node:test';
import assert from 'node:assert/strict';
import { Meter } from '../service/meter.js';
import { SseParser } from '../service/sse.js';
const ev = (type, data) => ({ type, data: { sessionID: 'ses-a', ...data } });

test('generation rate needs a timed pair; other sessions, snapshots and tool results do not add samples', () => {
  const m = new Meter(); m.reset('ses-a');
  m.event(ev('session.execution.started', {}), 1000);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1100);
  assert.equal(m.rate(1200).tokensPerSecond, null);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1600);
  assert.equal(m.rate(1600).tokensPerSecond, 50);
  m.event(ev('session.tool.progress', { content: 'x'.repeat(10000) }), 1650);
  m.event(ev('session.text.delta', { sessionID: 'ses-other', assistantMessageID: 'm2', delta: 'x'.repeat(1000) }), 1700);
  assert.equal(m.rate(1700).tokensPerSecond, 50);
  m.event(ev('session.text.ended', { assistantMessageID: 'm1', text: 'x'.repeat(200) }), 1800);
  assert.equal(m.rate(1900).tokensPerSecond, null);
});
test('usage still uses provider counts; turn average uses only timed generated estimates, not unmatched whole-step tokens', () => {
  const m = new Meter(); m.reset('ses-a');
  m.event(ev('session.execution.started', {}), 1000);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1100);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1600);
  const ended = ev('session.step.ended', { assistantMessageID: 'm1', tokens: { output: 60, reasoning: 20 } });
  m.event(ended, 1700); const ratio = m.ratio; m.event(ended, 1701); assert.equal(m.ratio, ratio);
  m.event(ev('session.usage.updated', { tokens: { input: 100, output: 60, reasoning: 20, cache: { read: 10, write: 5 } }, cost: .01 }), 1800);
  m.event(ev('session.execution.succeeded', {}), 1900);
  assert.equal(m.rate(2000).lastTurn.tokens, 25); assert.equal(m.rate(2000).lastTurn.activeMs, 500);
  assert.equal(m.rate(2000).lastTurn.tokensPerSecond, 50);
  assert.equal(m.rate(2000).sessionUsage.generated, 80); assert.equal(m.rate(2000).lastTurn.source, 'estimate');
});
test('explicit waits break timing; session changes clear live measurement state', () => {
  const m = new Meter(); m.reset('ses-a');
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 1000);
  m.event(ev('permission.asked', { id: 'p' }), 1100);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 1200);
  assert.equal(m.rate(1250).waiting, 'permission');
  m.event(ev('permission.replied', { requestID: 'p' }), 1300);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 5000);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 5500);
  m.event(ev('session.execution.succeeded', {}), 5600);
  assert.equal(m.rate(5600).lastTurn.activeMs, 500);
  m.reset('ses-b'); assert.equal(m.rate(5700).lastTurn, null); assert.equal(m.rate(5700).chars, 0);
});
test('SSE accepts split CRLF, multiline data, Unicode chunks and wrapped events', () => {
  const values = []; const p = new SseParser(v => values.push(v));
  const text = ': heartbeat\r\n\r\ndata: {"payload":\r\ndata: {"type":"test","data":{"delta":"中文😀"}}}\r\n\r\n';
  for (const byte of new TextEncoder().encode(text)) p.feed(Uint8Array.of(byte));
  assert.equal(values.length, 1); assert.equal(values[0].payload.data.delta, '中文😀');
});
test('SSE ignores malformed JSON and bounds frame size', () => {
  const values = []; const p = new SseParser(v => values.push(v), 30);
  p.feed(Buffer.from('data: nope\n\n')); assert.equal(values.length, 0);
  assert.throws(() => p.feed(Buffer.from('x'.repeat(50))), /TOO_LARGE/);
});
