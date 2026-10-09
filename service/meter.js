// Adapted from herbkk/openchamber-tps feature/status-section (MIT).
// Original copyright (c) 2026 Howon Lee; see ../LICENSE.
// Provider usage/calibration is separate from the observed generation clock.
import { Generation } from './generation.js';
const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const str = v => typeof v === 'string' ? v : '';
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;

export class Meter {
  constructor() { this.ratio = 0.25; this.reset(null); }
  reset(sessionId) {
    this.sessionId = sessionId; this.partChars = new Map(); this.deltaParts = new Set();
    this.messageChars = new Map(); this.stepTokens = new Map();
    this.lastEventAt = 0; this.eventsSeen = 0; this.lastEventType = null; this.usage = null;
    this.generation = new Generation();
  }
  watched(id) { return this.sessionId !== null && typeof id === 'string' && id === this.sessionId; }
  waiting() { return this.generation.waiting(); }
  pause() { this.generation.break('waiting-model'); }
  chars(id, part, count) {
    if (count <= 0) return;
    this.partChars.set(part, (this.partChars.get(part) ?? 0) + count);
    this.messageChars.set(id, (this.messageChars.get(id) ?? 0) + count);
  }
  tokens(id, output, reasoning) {
    const generated = output + reasoning;
    if (!id || generated <= 0) return;
    const chars = this.messageChars.get(id) ?? 0;
    const previous = this.stepTokens.get(id) ?? 0;
    // Same normalized output+reasoning usage as OpenChamber. This calibrates
    // future character estimates; it is NOT per-token timing or a backfill.
    if (chars >= 40 && generated !== previous) {
      const ratio = Math.min(1, Math.max(0.05, generated / chars));
      this.ratio += (ratio - this.ratio) * 0.3;
    }
    this.stepTokens.set(id, generated);
  }
  event(raw, now = Date.now()) {
    const e = record(raw?.payload) ?? record(raw);
    if (!e) return;
    const type = str(e.type), p = record(e.data) ?? record(e.properties);
    if (!type || !p || !this.watched(p.sessionID ?? p.form?.sessionID)) return;
    this.eventsSeen++; this.lastEventType = type; this.lastEventAt = now;
    this.generation.event(type, p, now, this.ratio);
    if (/^session\.(text|reasoning|tool\.input)\.(delta|ended)$/.test(type)) {
      const id = str(p.assistantMessageID); if (!id) return;
      const kind = type.includes('.tool.') ? 'tool' : type.includes('.reasoning.') ? 'reasoning' : 'text';
      const ordinal = Number.isInteger(p.ordinal) && p.ordinal >= 0 ? p.ordinal : 0;
      const part = `${id}:${kind}:${kind === 'tool' ? str(p.id) : ordinal}`;
      if (type.endsWith('.delta')) {
        const delta = str(p.delta); if (!delta.length) return;
        this.deltaParts.add(part); this.chars(id, part, delta.length);
      } else if (!this.deltaParts.has(part)) {
        // Snapshots can inform character calibration, but never create timed
        // samples: the generation happened before we observed it.
        this.chars(id, part, str(p.text).length - (this.partChars.get(part) ?? 0));
      }
      return;
    }
    if (type === 'session.step.ended' || type === 'session.step.failed') {
      const t = record(p.tokens); if (t) this.tokens(str(p.assistantMessageID), num(t.output), num(t.reasoning));
      return;
    }
    if (type === 'session.usage.updated') {
      const t = record(p.tokens); if (!t) return;
      const cache = record(t.cache);
      this.usage = { cost: num(p.cost), input: num(t.input), output: num(t.output), reasoning: num(t.reasoning),
        cacheRead: num(cache?.read), cacheWrite: num(cache?.write), generated: num(t.output) + num(t.reasoning) };
    }
  }
  rate(now = Date.now()) {
    return { sessionId: this.sessionId, ...this.generation.rate(now),
      lastEventAt: this.lastEventAt || null, charsPerToken: this.ratio,
      sessionUsage: this.usage, eventsSeen: this.eventsSeen, lastEventType: this.lastEventType };
  }
}
