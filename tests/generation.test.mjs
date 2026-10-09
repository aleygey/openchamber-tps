import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrackedMeter, SessionStatistics, StatisticsStore } from '../service/statistics.js';
const make = () => { const stats = new SessionStatistics(); return { stats, m: new TrackedMeter('s', stats) }; };
const emit = (m, type, data, at) => m.event({ type, data: { sessionID: 's', ...data } }, at);
const delta = (m, at, id = 'm1', chars = 100, type = 'session.text.delta', extra = {}) => emit(m, type, { assistantMessageID: id, ordinal: 0, delta: 'x'.repeat(chars), ...extra }, at);
function burst(m, start, id = 'm1', chars = 100, count = 4) {
  delta(m, start, id, chars);
  for (let i = 1; i <= count; i++) delta(m, start + i * 250, id, chars);
  return start + count * 250;
}

test('regression: 0ms to 5-minute bash waits cannot lower resumed TPS, mean or peak', () => {
  for (const wait of [0, 100, 3000, 60000, 300000]) {
    const { m, stats } = make();
    emit(m, 'session.execution.started', {}, 1000);
    const end = burst(m, 2000);
    assert.equal(m.rate(end).tokensPerSecond, 100);
    emit(m, 'session.tool.called', { id: 'bash', name: 'bash' }, end + 1);
    const before = stats.serialize();
    for (let i = 0; i < 20; i++) {
      const at = end + 1 + wait * i / 20;
      emit(m, 'session.tool.progress', { id: 'bash', metadata: { output: 'build log'.repeat(1000) } }, at);
      assert.equal(m.rate(at).tokensPerSecond, null);
      assert.equal(m.rate(at).phase, 'tool');
    }
    assert.deepEqual(stats.serialize(), before, `wait=${wait}: idle samples must not change statistics`);
    emit(m, 'session.tool.success', { id: 'bash', content: 'shell result'.repeat(1000) }, end + wait + 2);
    const end2 = burst(m, end + wait + 100, 'm2');
    assert.equal(m.rate(end2).tokensPerSecond, 100);
    assert.equal(stats.summary().averageTps, 100);
    assert.equal(stats.summary().peakTps, 100);
    assert.equal(stats.summary().activeMs, 2000);
    assert.equal(stats.summary().generatedTokens, 200);
    assert.equal(stats.history().filter(p => p.breakBefore).length, 2);
  }
});
test('different generation durations are weighted by their tokens/time, not by turn count', () => {
  const { m, stats } = make();
  burst(m, 1000, 'm1', 50, 4); // 50 tok/s for 1s
  emit(m, 'session.tool.called', { id: 'bash' }, 2100);
  emit(m, 'session.tool.success', { id: 'bash' }, 30000);
  burst(m, 31000, 'm2', 100, 8); // 100 tok/s for 2s
  assert.equal(stats.summary().generatedTokens, 250);
  assert.equal(stats.summary().activeMs, 3000);
  assert.equal(stats.summary().averageTps, 250 / 3);
});
test('TTFT and request/streamed notifications do not count as generation', () => {
  const { m, stats } = make();
  emit(m, 'session.step.started', { assistantMessageID: 'm1' }, 1000);
  emit(m, 'session.step.streamed', { assistantMessageID: 'm1' }, 2000);
  assert.equal(m.rate(5000).phase, 'waiting-model');
  burst(m, 20000);
  assert.equal(stats.summary().activeMs, 1000);
  assert.equal(stats.summary().averageTps, 100);
});
test('tool parameter JSON is LLM output, tool execution and return payloads are not', () => {
  const { m, stats } = make();
  emit(m, 'session.tool.input.started', { assistantMessageID: 'm1', id: 'bash' }, 1000);
  delta(m, 1100, 'm1', 100, 'session.tool.input.delta', { id: 'bash' });
  delta(m, 1600, 'm1', 100, 'session.tool.input.delta', { id: 'bash' });
  assert.equal(m.rate(1600).tokensPerSecond, 50);
  emit(m, 'session.tool.input.ended', { assistantMessageID: 'm1', id: 'bash', text: 'x'.repeat(200) }, 1700);
  emit(m, 'session.tool.called', { id: 'bash' }, 1701);
  emit(m, 'session.tool.success', { id: 'bash', content: 'x'.repeat(1000000) }, 120000);
  assert.equal(stats.summary().generatedTokens, 25);
  assert.equal(stats.summary().activeMs, 500);
  assert.equal(m.messageChars.get('m1'), 200);
});
test('stream pauses without explicit boundaries are not arbitrarily erased at one second', () => {
  const { m, stats } = make();
  delta(m, 1000); delta(m, 4000); // May be a slow LLM or buffered delivery; count conservatively.
  assert.equal(stats.summary().activeMs, 3000);
  assert.equal(stats.summary().averageTps, 25 / 3);
  assert.equal(m.rate(4000).tokensPerSecond, 25 / 3);
});
test('generation endings and retries break even short inter-fragment intervals', () => {
  const { m, stats } = make();
  burst(m, 1000);
  emit(m, 'session.text.ended', { assistantMessageID: 'm1', ordinal: 0, text: 'x'.repeat(500) }, 2001);
  delta(m, 2050); assert.equal(stats.summary().activeMs, 1000);
  emit(m, 'session.retry.scheduled', { assistantMessageID: 'm1' }, 2051);
  delta(m, 2100); delta(m, 2350);
  assert.equal(stats.summary().activeMs, 1250);
  assert.equal(stats.summary().averageTps, 100);
});
test('reasoning counts, while permission/form waits and status heartbeats do not add timing', () => {
  const { m, stats } = make();
  delta(m, 1000, 'm1', 100, 'session.reasoning.delta');
  emit(m, 'session.status', { status: { type: 'busy' } }, 1100);
  delta(m, 1500, 'm1', 100, 'session.reasoning.delta');
  emit(m, 'form.created', { form: { id: 'f', sessionID: 's' } }, 1501);
  delta(m, 1510, 'm1', 100, 'session.reasoning.delta');
  assert.equal(m.rate(1510).phase, 'question');
  emit(m, 'form.replied', { id: 'f' }, 1590);
  delta(m, 1600, 'm1', 100, 'session.reasoning.delta');
  assert.equal(stats.summary().activeMs, 500);
  assert.equal(stats.summary().generatedTokens, 25);
});
test('a shell can keep running in the background while genuinely received LLM deltas are measured', () => {
  const { m, stats } = make();
  emit(m, 'session.tool.called', { id: 'background' }, 1000);
  delta(m, 2000, 'm2');
  emit(m, 'session.tool.progress', { id: 'background' }, 2100);
  delta(m, 2500, 'm2');
  emit(m, 'session.tool.success', { id: 'background' }, 2600);
  delta(m, 3000, 'm2');
  assert.equal(stats.summary().activeMs, 1000);
  assert.equal(stats.summary().averageTps, 50);
});
test('polling, stale readout and disconnect do not advance history or include reconnect downtime', () => {
  const { m, stats } = make(); burst(m, 1000);
  const before = stats.serialize();
  assert.equal(m.rate(50000).tokensPerSecond, null);
  for (let i = 0; i < 100; i++) m.rate(51000 + i);
  assert.deepEqual(stats.serialize(), before);
  m.pause(); delta(m, 60000); delta(m, 60250);
  assert.equal(stats.summary().activeMs, 1250);
  assert.equal(stats.summary().averageTps, 100);
});
test('measured window uses short actual durations, grows to five seconds, then clips correctly', () => {
  const { m, stats } = make();
  delta(m, 1000); delta(m, 1250);
  assert.equal(m.rate(1250).measuredWindowMs, 250);
  assert.equal(m.rate(1250).tokensPerSecond, 100);
  for (let at = 1500; at <= 10000; at += 250) delta(m, at);
  assert.equal(m.rate(10000).measuredWindowMs, 5000);
  assert.equal(m.rate(10000).tokensPerSecond, 100);
  assert.equal(stats.summary().averageTps, 100);
});
test('single chunks, sub-250ms windows and complete snapshots never invent a high peak', () => {
  const { m, stats } = make();
  delta(m, 1000, 'm1', 10000);
  assert.equal(m.rate(1000).phase, 'sampling');
  delta(m, 1001, 'm1', 10);
  assert.equal(m.rate(1001).tokensPerSecond, null);
  assert.equal(stats.summary().peakTps, null);
  emit(m, 'session.text.ended', { assistantMessageID: 'm1', text: 'x'.repeat(10010) }, 1100);
  emit(m, 'session.text.ended', { assistantMessageID: 'old', text: 'x'.repeat(1000000) }, 1200);
  assert.equal(stats.summary().peakTps, null);
});
test('reset breaks the current interval without losing another session or credentials', () => {
  const { m, stats } = make(); burst(m, 1000); m.resetStatistics();
  assert.equal(stats.summary().averageTps, null);
  delta(m, 2200); assert.equal(stats.summary().activeMs, 0);
  delta(m, 2450); assert.equal(stats.summary().averageTps, 100);
});
test('new metric schema and default directory do not reinterpret or overwrite version 1 history', t => {
  assert.equal(path.basename(new StatisticsStore().directory), 'metrics-v2');
  assert.throws(() => new SessionStatistics({ schema: 1, activeMs: 1000, area: 123, points: [] }), /Invalid/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'metrics-v1'));
  const legacy = path.join(root, 'metrics-v1', 'saved.json');
  fs.writeFileSync(legacy, '{"schema":1,"area":123}');
  const store = new StatisticsStore({ directory: path.join(root, 'metrics-v2') });
  const m = new TrackedMeter('s', store.get('http://test:3000', 's')); burst(m, 1000); store.flush();
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"schema":1,"area":123}');
  assert.equal(fs.readdirSync(path.join(root, 'metrics-v2')).length, 1);
});
