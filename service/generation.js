// Throughput on observed LLM stream intervals, never on the agent busy clock.
// Text, reasoning and tool-input deltas are generated output; tool results are not.
export const WINDOW_MS = 5000;
export const MIN_SAMPLE_MS = 250;
const FRESH_MS = 2000;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export class Generation {
  constructor(onInterval = () => {}, onBreak = () => {}) {
    this.onInterval = onInterval; this.onBreak = onBreak;
    this.tools = new Set(); this.permissions = new Set(); this.questions = new Set();
    this.busy = false; this.phase = 'idle'; this.lastTurn = null;
    this.clearTurn(); this.break();
  }
  clearTurn() { this.turnMs = 0; this.turnTokens = 0; this.turnChars = 0; this.turnFirst = null; this.turnLast = null; }
  break(phase = this.phase) {
    this.anchor = null; this.pending = 0; this.intervals = [];
    this.windowMs = 0; this.windowTokens = 0; this.windowChars = 0;
    this.segmentMs = 0; this.phase = phase; this.onBreak();
  }
  waiting() { return this.permissions.size ? 'permission' : this.questions.size ? 'question' : null; }
  finish(at) {
    if (this.turnMs > 0) {
      const wallMs = Math.max(this.turnMs, (this.turnLast ?? at) - (this.turnFirst ?? at));
      this.lastTurn = { tokensPerSecond: this.turnMs >= MIN_SAMPLE_MS ? this.turnTokens * 1000 / this.turnMs : null,
        source: 'estimate', tokens: this.turnTokens, chars: this.turnChars, activeMs: this.turnMs,
        wallMs, pausedMs: Math.max(0, wallMs - this.turnMs), endedAt: at };
    } else this.lastTurn = null;
    this.clearTurn(); this.tools.clear(); this.permissions.clear(); this.questions.clear();
    this.busy = false; this.break('idle');
  }
  sample(at, chars, key, ratio) {
    if (!finite(at) || !finite(chars) || chars === 0 || !finite(ratio) || this.waiting()) return;
    // The first chunk anchors time. Its token count has no observed preceding
    // interval, so do not divide it by an invented 1ms or fixed five seconds.
    if (!this.anchor || this.anchor.key !== key || at < this.anchor.at) {
      this.break('generating'); this.anchor = { at, key }; return;
    }
    this.phase = 'generating';
    const elapsedMs = at - this.anchor.at;
    if (elapsedMs === 0) { this.pending += chars; return; }
    chars += this.pending; this.pending = 0;
    const tokens = chars * ratio;
    const from = this.anchor.at;
    const segmentStart = this.segmentMs === 0;
    this.segmentMs += elapsedMs;
    this.intervals.push({ ms: elapsedMs, tokens, chars });
    this.windowMs += elapsedMs; this.windowTokens += tokens; this.windowChars += chars;
    while (this.windowMs > WINDOW_MS && this.intervals.length) {
      const first = this.intervals[0];
      const removeMs = Math.min(first.ms, this.windowMs - WINDOW_MS);
      const fraction = removeMs / first.ms;
      this.windowMs -= removeMs; this.windowTokens -= first.tokens * fraction; this.windowChars -= first.chars * fraction;
      if (removeMs === first.ms) this.intervals.shift();
      else { first.ms -= removeMs; first.tokens *= 1 - fraction; first.chars *= 1 - fraction; }
    }
    // Bound the event-density case without shortening the measurement window.
    if (this.intervals.length > 20000) {
      const a = this.intervals.shift(), b = this.intervals[0];
      b.ms += a.ms; b.tokens += a.tokens; b.chars += a.chars;
    }
    const tps = this.windowMs >= MIN_SAMPLE_MS ? this.windowTokens * 1000 / this.windowMs : null;
    this.turnMs += elapsedMs; this.turnTokens += tokens; this.turnChars += chars;
    this.turnFirst ??= from; this.turnLast = at;
    this.anchor = { at, key };
    this.onInterval({ at, from, elapsedMs, tokens, tps, segmentStart });
  }
  event(type, p, at, ratio) {
    const id = typeof p.assistantMessageID === 'string' ? p.assistantMessageID : '';
    const isText = type.startsWith('session.text.');
    const isReasoning = type.startsWith('session.reasoning.');
    const isInput = type.startsWith('session.tool.input.');
    if (isText || isReasoning || isInput) {
      if (!id) return;
      const part = isInput ? `tool:${p.id ?? ''}` : `${isReasoning ? 'reasoning' : 'text'}:${p.ordinal ?? 0}`;
      const key = `${id}|${part}`;
      if (type.endsWith('.delta') && typeof p.delta === 'string') this.sample(at, p.delta.length, key, ratio);
      else if (type.endsWith('.ended') && this.anchor?.key === key) this.break(this.tools.size ? 'tool' : 'waiting-model');
      // A started/streamed notification is not a token and cannot start a timer.
      return;
    }
    if (type === 'session.execution.started') {
      this.clearTurn(); this.busy = true; this.break('waiting-model'); return;
    }
    if (['session.execution.succeeded', 'session.execution.failed', 'session.idle'].includes(type)) { this.finish(at); return; }
    if (type === 'session.execution.interrupted') {
      if (p.reason === 'shutdown') this.break('waiting-model'); else this.finish(at);
      return;
    }
    if (type === 'session.status') {
      if (p.status?.type === 'idle') this.finish(at);
      else { this.busy = true; if (p.status?.type === 'retry') this.break('waiting-model'); }
      return;
    }
    if (['session.step.started', 'session.step.ended', 'session.step.failed', 'session.retry.scheduled'].includes(type)) {
      this.busy = true; this.break(this.tools.size ? 'tool' : 'waiting-model'); return;
    }
    if (['session.tool.called', 'session.tool.started', 'session.shell.started'].includes(type)) {
      this.tools.add(String(p.id ?? p.shell?.id ?? 'unknown-tool'));
      this.break('tool'); return;
    }
    if (['session.tool.success', 'session.tool.failed', 'session.tool.ended', 'session.shell.ended'].includes(type)) {
      this.tools.delete(String(p.id ?? p.shell?.id ?? 'unknown-tool'));
      if (!this.tools.size && this.phase === 'tool') this.phase = 'waiting-model';
      return;
    }
    // A background tool's progress/success must not erase parallel LLM deltas.
    if (type === 'session.tool.progress') return;
    if (type === 'permission.asked' || type === 'permission.v2.asked') this.permissions.add(String(p.id ?? 'permission'));
    else if (type === 'permission.replied' || type === 'permission.v2.replied') this.permissions.delete(String(p.requestID ?? 'permission'));
    else if (type === 'form.created') this.questions.add(String(p.form?.id ?? 'question'));
    else if (type === 'question.asked' || type === 'question.v2.asked') this.questions.add(String(p.id ?? 'question'));
    else if (type === 'form.replied' || type === 'form.cancelled') this.questions.delete(String(p.id ?? 'question'));
    else if (['question.replied', 'question.rejected', 'question.v2.replied', 'question.v2.rejected'].includes(type)) this.questions.delete(String(p.requestID ?? 'question'));
    else return;
    this.break(this.waiting() || (this.tools.size ? 'tool' : 'waiting-model'));
  }
  rate(at) {
    const fresh = this.anchor !== null && at >= this.anchor.at && at - this.anchor.at < FRESH_MS;
    const active = fresh && this.phase === 'generating' && !this.waiting();
    const ready = this.windowMs >= MIN_SAMPLE_MS;
    const phase = this.waiting() || (active ? (ready ? 'generating' : 'sampling')
      : this.tools.size ? 'tool' : this.phase === 'generating' ? 'waiting-output' : this.phase);
    return { busy: this.busy, active, phase, waiting: this.waiting(),
      tokensPerSecond: active && ready ? this.windowTokens * 1000 / this.windowMs : null,
      charsPerSecond: active && ready ? this.windowChars * 1000 / this.windowMs : null,
      chars: this.windowChars, windowMs: WINDOW_MS, measuredWindowMs: this.windowMs,
      lastTurn: this.lastTurn, measurement: 'llm-generation-intervals-v2' };
  }
}
