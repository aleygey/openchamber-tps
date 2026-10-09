// Local numeric-only session telemetry. No prompts, event payloads or credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Meter } from './meter.js';
import { MIN_SAMPLE_MS } from './generation.js';

export const HISTORY_LIMIT = 1800;
export const SESSION_LIMIT = 100;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const round = n => Math.round(n * 1000) / 1000;

/** Sum timed generated-token estimates / sum their matching durations.
 * Do not average wall-clock rolling rates, and do not infer time from polls.
 * The generation estimator alone supplies explicitly delimited intervals.
 */
export class SessionStatistics {
  constructor(saved = null, changed = () => {}, limit = HISTORY_LIMIT) {
    this.changed = changed; this.limit = limit; this.reset();
    if (saved) this.restore(saved);
  }
  reset() {
    this.activeMs = 0; this.generatedTokens = 0; this.peak = 0; this.peakSamples = 0;
    this.observations = 0; this.since = null; this.updatedAt = null;
    this.points = []; this.droppedPoints = 0; this.revision = 0; this.needsBreak = true;
    this.changed();
  }
  break() { this.needsBreak = true; }
  observe({ at, from, elapsedMs, tokens, tps, segmentStart = false }) {
    if (![at, from, elapsedMs, tokens].every(finite) || elapsedMs <= 0 || at < from) return;
    this.activeMs += elapsedMs; this.generatedTokens += tokens;
    this.observations++; this.since ??= from; this.updatedAt = at;
    if (segmentStart) this.needsBreak = true;
    if (finite(tps)) {
      this.peak = Math.max(this.peak, tps); this.peakSamples++;
      if (this.needsBreak) this.points.push({ at: from, activeMs: this.activeMs - elapsedMs, tps: round(tps), breakBefore: true });
      const point = { at, activeMs: this.activeMs, tps: round(tps), breakBefore: false };
      const last = this.points.at(-1);
      if (last && !last.breakBefore && Math.floor(last.activeMs / 1000) === Math.floor(point.activeMs / 1000)) this.points[this.points.length - 1] = point;
      else this.points.push(point);
      this.needsBreak = false;
    }
    if (this.points.length > this.limit) {
      const count = this.points.length - this.limit;
      this.points.splice(0, count); this.droppedPoints += count; this.points[0].breakBefore = true;
    }
    this.revision++; this.changed();
  }
  summary() {
    return { averageTps: this.activeMs >= MIN_SAMPLE_MS ? this.generatedTokens * 1000 / this.activeMs : null,
      peakTps: this.peakSamples ? this.peak : null, activeMs: this.activeMs, generatedTokens: this.generatedTokens,
      observations: this.observations, recordedSince: this.since, updatedAt: this.updatedAt,
      pointCount: this.points.length, droppedPoints: this.droppedPoints, revision: this.revision,
      method: 'llm-generation-intervals-v2' };
  }
  history(windowMs = 0) {
    const start = windowMs > 0 ? Math.max(0, this.activeMs - windowMs) : 0;
    return this.points.filter(p => p.activeMs >= start).map(p => ({ ...p }));
  }
  serialize() {
    return { schema: 2, activeMs: this.activeMs, generatedTokens: this.generatedTokens, peak: this.peak,
      peakSamples: this.peakSamples, observations: this.observations, since: this.since, updatedAt: this.updatedAt,
      droppedPoints: this.droppedPoints, revision: this.revision, points: this.points };
  }
  restore(data) {
    const names = ['activeMs', 'generatedTokens', 'peak', 'peakSamples', 'observations', 'droppedPoints', 'revision'];
    if (data.schema !== 2 || !names.every(k => finite(data[k])) ||
        ![data.since, data.updatedAt].every(v => v === null || finite(v)) ||
        !Array.isArray(data.points) || data.points.length > HISTORY_LIMIT) throw new Error('Invalid statistics');
    let previousX = -1;
    for (const p of data.points) {
      if (!p || !finite(p.at) || !finite(p.tps) || !finite(p.activeMs) || p.activeMs < previousX ||
          p.activeMs > data.activeMs || typeof p.breakBefore !== 'boolean') throw new Error('Invalid history');
      previousX = p.activeMs;
    }
    for (const name of names) this[name] = data[name];
    this.since = data.since; this.updatedAt = data.updatedAt;
    this.points = data.points.slice(-this.limit).map(p => ({ at: p.at, activeMs: p.activeMs, tps: p.tps, breakBefore: p.breakBefore }));
    this.needsBreak = true;
  }
}

export class TrackedMeter extends Meter {
  constructor(sessionId, statistics) {
    super(); this.reset(sessionId); this.statistics = statistics;
    this.generation.onInterval = interval => this.statistics.observe(interval);
    this.generation.onBreak = () => this.statistics.break();
  }
  resetStatistics() { this.pause(); this.statistics.reset(); }
}

/** One hashed filename per (server origin, session); bounded private files.
 * Sync writes happen only on the 5s flush timer / shutdown, never per chunk.
 * Failure to persist degrades to in-memory statistics, not broken chat/auth.
 */
export class StatisticsStore {
  constructor({ directory = path.join(os.homedir(), '.local', 'share', 'openchamber-tps', 'metrics-v2'), maxSessions = SESSION_LIMIT } = {}) {
    this.directory = directory; this.maxSessions = maxSessions;
    this.cache = new Map(); this.dirty = new Set(); this.warning = null;
  }
  key(origin, id) { return createHash('sha256').update(JSON.stringify([origin, id])).digest('hex'); }
  get(origin, id) {
    const key = this.key(origin, id);
    if (this.cache.has(key)) {
      const s = this.cache.get(key); this.cache.delete(key); this.cache.set(key, s); return s;
    }
    let saved = null;
    const filename = path.join(this.directory, key + '.json');
    try {
      const st = fs.lstatSync(filename);
      if (!st.isFile() || st.size > 512 * 1024) throw new Error('Invalid statistics file');
      saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (e) { if (e.code !== 'ENOENT') this.warning = 'STATS_LOAD_FAILED'; }
    let statistics;
    try { statistics = new SessionStatistics(saved, () => this.dirty.add(key)); }
    catch { this.warning = 'STATS_LOAD_FAILED'; statistics = new SessionStatistics(null, () => this.dirty.add(key)); }
    // Loading an existing record is not a modification.
    if (saved && this.warning !== 'STATS_LOAD_FAILED') this.dirty.delete(key);
    this.cache.set(key, statistics);
    if (this.cache.size > this.maxSessions) {
      const oldest = this.cache.keys().next().value;
      this.flush(); this.cache.delete(oldest); this.dirty.delete(oldest);
    }
    return statistics;
  }
  flush() {
    if (!this.dirty.size) return;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      for (const key of [...this.dirty]) {
        const statistics = this.cache.get(key);
        if (!statistics) { this.dirty.delete(key); continue; }
        const filename = path.join(this.directory, key + '.json');
        const temp = `${filename}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify(statistics.serialize()), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          fs.renameSync(temp, filename);
          this.dirty.delete(key);
        } finally { try { fs.unlinkSync(temp); } catch {} }
      }
      // Only prune files owned by this numeric-telemetry format.
      const files = fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(name => {
        const st = fs.lstatSync(path.join(this.directory, name)); return { name, mtime: st.mtimeMs, regular: st.isFile() };
      }).filter(f => f.regular).sort((a, b) => b.mtime - a.mtime);
      for (const f of files.slice(this.maxSessions)) fs.unlinkSync(path.join(this.directory, f.name));
      if (this.warning === 'STATS_SAVE_FAILED') this.warning = null;
    } catch { this.warning = 'STATS_SAVE_FAILED'; }
  }
}
