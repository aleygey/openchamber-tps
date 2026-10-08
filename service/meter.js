// Adapted from herbkk/openchamber-tps feature/status-section (MIT).
// Original copyright (c) 2026 Howon Lee; see ../LICENSE.
// Adapted from herbkk/openchamber-tps feature/status-section, service/main.ts.
// Copyright (c) 2026 Howon Lee. MIT. The original rolling-5s measurement model
// is retained. The historical charsPerToken field is actually tokens/character.
const WINDOW_MS = 5000;
const MAX_STREAM_GAP_MS = 1000;
const SAMPLE_LIMIT = 20000;
const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const str = v => typeof v === 'string' ? v : '';
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;

export class Meter {
  constructor() { this.ratio = 0.25; this.reset(null); }
  reset(sessionId) {
    this.sessionId = sessionId;
    this.samples = [];
    this.partChars = new Map();
    this.deltaParts = new Set();
    this.messageChars = new Map();
    this.stepTokens = new Map();
    this.permissions = new Set();
    this.questions = new Set();
    this.lastEventAt = 0;
    this.lastCharAt = 0;
    this.eventsSeen = 0;
    this.lastEventType = null;
    this.busy = false;
    this.usage = null;
    this.lastTurn = null;
    this.clearTurn();
  }
  clearTurn() {
    this.turnFirst = null; this.turnLast = null; this.turnBusy = null;
    this.turnChars = 0; this.turnTokens = 0; this.turnActive = 0; this.sawTokens = false;
  }
  waiting() { return this.permissions.size ? 'permission' : this.questions.size ? 'question' : null; }
  watched(id) { return this.sessionId !== null && typeof id === 'string' && id === this.sessionId; }
  chars(messageID, partID, count, now) {
    if (count <= 0) return;
    this.samples.push({ at: now, chars: count });
    if (this.samples.length > SAMPLE_LIMIT) this.samples.splice(0, this.samples.length - SAMPLE_LIMIT);
    this.partChars.set(partID, (this.partChars.get(partID) ?? 0) + count);
    this.messageChars.set(messageID, (this.messageChars.get(messageID) ?? 0) + count);
    this.lastEventAt = now; this.lastCharAt = now;
    if (this.turnFirst === null) {
      this.turnFirst = now;
      if (this.turnBusy !== null && now - this.turnBusy <= MAX_STREAM_GAP_MS) this.turnActive += Math.max(0, now - this.turnBusy);
    } else if (this.turnLast !== null && !this.waiting()) {
      const gap = now - this.turnLast;
      if (gap >= 0 && gap <= MAX_STREAM_GAP_MS) this.turnActive += gap;
    }
    this.turnLast = now; this.turnChars += count;
  }
  tokens(id, output, reasoning) {
    const generated = output + reasoning;
    if (!id || generated <= 0) return;
    const chars = this.messageChars.get(id) ?? 0;
    const previous = this.stepTokens.get(id) ?? 0;
    // Replayed settlements must not keep recalibrating the same observation.
    if (chars >= 40 && generated !== previous) {
      const ratio = Math.min(1, Math.max(0.05, generated / chars));
      this.ratio += (ratio - this.ratio) * 0.3;
    }
    this.stepTokens.set(id, generated);
    if (this.turnFirst === null) return;
    this.turnTokens += generated - previous;
    if (generated > previous) this.sawTokens = true;
  }
  finish(now) {
    if (this.turnFirst === null || this.turnLast === null || this.turnChars === 0) { this.clearTurn(); return; }
    const wallMs = Math.max(1, this.turnLast - this.turnFirst);
    const activeMs = this.turnActive > 0 ? Math.max(1, Math.round(this.turnActive)) : Math.min(wallMs, MAX_STREAM_GAP_MS);
    const tokens = this.sawTokens ? this.turnTokens : this.turnChars * this.ratio;
    this.lastTurn = {
      tokensPerSecond: tokens / (activeMs / 1000),
      source: this.sawTokens ? 'tokens' : 'estimate', tokens, chars: this.turnChars,
      activeMs, wallMs, pausedMs: Math.max(0, wallMs - activeMs), endedAt: now,
    };
    this.clearTurn();
  }
  event(raw, now = Date.now()) {
    const e = record(raw?.payload) ?? record(raw);
    if (!e) return;
    const type = str(e.type);
    this.eventsSeen++; this.lastEventType = type || null;
    const p = record(e.data) ?? record(e.properties);
    if (!type || !p) return;
    if (type === 'form.created') {
      const f = record(p.form);
      if (f && this.watched(f.sessionID)) {
        if (str(f.id)) this.questions.add(f.id);
        this.lastEventAt = now;
      }
      return;
    }
    if (!this.watched(p.sessionID)) return;
    if (type === 'session.text.delta' || type === 'session.reasoning.delta' ||
        type === 'session.text.ended' || type === 'session.reasoning.ended') {
      const id = str(p.assistantMessageID);
      if (!id) return;
      const kind = type.includes('.reasoning.') ? 'reasoning' : 'text';
      const index = Number.isInteger(p.ordinal) && p.ordinal >= 0 ? p.ordinal : 0;
      const part = `${id}:${kind}:${index}`;
      if (type.endsWith('.delta')) {
        const delta = str(p.delta);
        if (!delta.length) return;
        this.deltaParts.add(part);
        this.chars(id, part, delta.length, now);
      } else if (!this.deltaParts.has(part)) {
        this.chars(id, part, str(p.text).length - (this.partChars.get(part) ?? 0), now);
      }
      return;
    }
    if (type === 'session.step.ended' || type === 'session.step.failed') {
      const t = record(p.tokens);
      if (t) this.tokens(str(p.assistantMessageID), num(t.output), num(t.reasoning));
      return;
    }
    if (type === 'session.usage.updated') {
      const t = record(p.tokens);
      if (!t) return;
      const cache = record(t.cache);
      this.usage = { cost: num(p.cost), input: num(t.input), output: num(t.output),
        reasoning: num(t.reasoning), cacheRead: num(cache?.read), cacheWrite: num(cache?.write),
        generated: num(t.output) + num(t.reasoning) };
      this.lastEventAt = now;
      return;
    }
    if (type === 'session.execution.started') {
      if (this.turnFirst === null) this.turnBusy = now;
      this.busy = true; this.lastEventAt = now; return;
    }
    if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.idle') {
      this.busy = false; this.lastEventAt = now;
      this.finish(now); this.permissions.clear(); this.questions.clear(); return;
    }
    if (type === 'session.execution.interrupted') {
      this.lastEventAt = now;
      if (p.reason === 'shutdown') return;
      this.busy = false; this.finish(now); this.permissions.clear(); this.questions.clear(); return;
    }
    if (type === 'session.status') {
      const next = p.status?.type === 'busy' || p.status?.type === 'retry';
      if (this.busy && !next) this.finish(now);
      if (next && this.turnFirst === null) this.turnBusy = now;
      this.busy = next; this.lastEventAt = now; return;
    }
    if (type === 'permission.asked' || type === 'permission.v2.asked') {
      if (str(p.id)) this.permissions.add(p.id);
    } else if (type === 'permission.replied' || type === 'permission.v2.replied') {
      this.permissions.delete(str(p.requestID));
    } else if (type === 'question.asked' || type === 'question.v2.asked') {
      if (str(p.id)) this.questions.add(p.id);
    } else if (type === 'form.replied' || type === 'form.cancelled') {
      this.questions.delete(str(p.id));
    } else if (['question.replied', 'question.rejected', 'question.v2.replied', 'question.v2.rejected'].includes(type)) {
      this.questions.delete(str(p.requestID));
    } else { return; }
    this.lastEventAt = now;
  }
  rate(now = Date.now()) {
    let expired = 0;
    while (expired < this.samples.length && now - this.samples[expired].at > WINDOW_MS) expired++;
    if (expired) this.samples.splice(0, expired);
    const chars = this.samples.reduce((sum, s) => sum + s.chars, 0);
    const charsPerSecond = chars / (WINDOW_MS / 1000);
    return {
      sessionId: this.sessionId, busy: this.busy, active: this.lastCharAt > 0 && now - this.lastCharAt < 2000,
      lastEventAt: this.lastEventAt || null, windowMs: WINDOW_MS, chars, charsPerSecond,
      tokensPerSecond: charsPerSecond * this.ratio, charsPerToken: this.ratio,
      sessionUsage: this.usage, lastTurn: this.lastTurn, eventsSeen: this.eventsSeen,
      lastEventType: this.lastEventType, waiting: this.waiting(),
    };
  }
}
