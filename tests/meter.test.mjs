import test from 'node:test';
import assert from 'node:assert/strict';
import { Meter } from '../service/meter.js';
import { SseParser } from '../service/sse.js';
const ev = (type, data) => ({ type, data: { sessionID: 'ses-a', ...data } });

test('rolling estimate, reasoning, session filter, no tool-input inflation, and no ended double count', () => {
  const m = new Meter(); m.reset('ses-a');
  m.event(ev('session.execution.started', {}), 1000);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1100);
  m.event(ev('session.text.ended', { assistantMessageID: 'm1', text: 'x'.repeat(100) }), 1150);
  m.event(ev('session.reasoning.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(20) }), 1200);
  m.event(ev('session.tool.input.delta', { delta: 'x'.repeat(1000) }), 1250);
  m.event(ev('session.text.delta', { sessionID: 'ses-other', assistantMessageID: 'm2', delta: 'x'.repeat(1000) }), 1250);
  assert.equal(m.rate(1300).chars, 120); assert.equal(m.rate(1300).tokensPerSecond, 6);
  assert.equal(m.rate(7000).chars, 0);
});
test('real settled tokens, duplicate settlement, calibration, and finished-turn average', () => {
  const m = new Meter(); m.reset('ses-a');
  m.event(ev('session.execution.started', {}), 1000);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1100);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'x'.repeat(100) }), 1300);
  const ended = ev('session.step.ended', { assistantMessageID: 'm1', tokens: { output: 60, reasoning: 20 } });
  m.event(ended, 1400); const ratio = m.ratio; m.event(ended, 1401); assert.equal(m.ratio, ratio);
  m.event(ev('session.usage.updated', { tokens: { input: 100, output: 60, reasoning: 20, cache: { read: 10, write: 5 } }, cost: .01 }), 1402);
  m.event(ev('session.execution.succeeded', {}), 1500);
  assert.equal(m.rate(1600).lastTurn.tokens, 80); assert.equal(m.rate(1600).lastTurn.activeMs, 300);
  assert.equal(m.rate(1600).sessionUsage.generated, 80); assert.equal(m.rate(1600).lastTurn.source, 'tokens');
});
test('waits and long tool gaps are excluded; session changes reset state', () => {
  const m = new Meter(); m.reset('ses-a');
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 1000);
  m.event(ev('permission.asked', { id: 'p' }), 1100);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 1200);
  assert.equal(m.rate(1250).waiting, 'permission');
  m.event(ev('permission.replied', { requestID: 'p' }), 1300);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 5000);
  m.event(ev('session.text.delta', { assistantMessageID: 'm1', delta: 'abc' }), 5100);
  m.event(ev('session.execution.succeeded', {}), 5200);
  assert.equal(m.rate(5200).lastTurn.activeMs, 100);
  m.reset('ses-b'); assert.equal(m.rate(5300).lastTurn, null); assert.equal(m.rate(5300).chars, 0);
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
