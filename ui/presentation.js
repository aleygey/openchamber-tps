// Display-only transforms. Never fed back into generation timers or metrics-v2.
// UMD-style global works as a classic sandbox script and in Node's VM tests.
((root) => {
  'use strict';
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const STEP_MS = 250, SHORT_GAP_MS = 1200, HARD_GAP_MS = 2500;
  const mix = (old, next, ms, tau) => old + (next - old) * -Math.expm1(-Math.max(0, ms) / tau);
  // Equivalent to EMA alpha=.3 at each 250ms display bucket.
  const CHART_TAU = -STEP_MS / Math.log(.7);
  function trend(input) {
    const points = [];
    for (const p of Array.isArray(input) ? input.slice(-1800) : []) {
      if (!p || ![p.at, p.activeMs, p.tps].every(finite)) continue;
      if (points.length && p.activeMs < points.at(-1).activeMs) continue;
      points.push({ at: p.at, activeMs: p.activeMs, tps: p.tps, breakBefore: !!p.breakBefore });
    }
    if (!points.length) return [];
    // Sparse long histories stay bounded. The normal recent-60s view uses 250ms.
    const step = Math.max(STEP_MS, Math.ceil((points.at(-1).activeMs - points[0].activeMs) / 4096 / STEP_MS) * STEP_MS);
    const out = [];
    let previous = null, smoothed = null;
    for (const p of points) {
      const dt = previous ? p.activeMs - previous.activeMs : 0;
      const gap = previous ? Math.max(0, p.at - previous.at - dt) : 0;
      const backwards = previous && p.at < previous.at;
      const boundary = !previous || p.breakBefore || backwards;
      if (boundary) {
        const kind = !previous || backwards || gap > HARD_GAP_MS ? 'hard' : gap > SHORT_GAP_MS ? 'dashed' : 'soft';
        // Never interpolate time through an explicit pause. Soft joins only
        // connect the two observed endpoints on the compressed active axis.
        if (smoothed === null || kind !== 'soft') smoothed = p.tps;
        out.push({ ...p, value: smoothed, join: kind, gapMs: gap });
      } else if (dt > 0) {
        let lastX = previous.activeMs;
        const end = p.activeMs;
        const append = x => {
          const f = (x - previous.activeMs) / dt;
          const raw = previous.tps + (p.tps - previous.tps) * f;
          smoothed = mix(smoothed, raw, x - lastX, CHART_TAU);
          out.push({ at: previous.at + (p.at - previous.at) * f, activeMs: x, tps: raw, value: smoothed, join: 'line', gapMs: 0 });
          lastX = x;
        };
        for (let x = (Math.floor(previous.activeMs / step) + 1) * step; x < end; x += step) append(x);
        append(end);
      }
      previous = p;
    }
    return out;
  }
  class LiveValue {
    constructor() { this.reset(); }
    reset() { this.value = null; this.sampleKey = ''; this.activeMs = null; this.seenAt = 0; this.identity = null; this.stale = false; }
    read(rate, now) {
      const id = `${rate?.origin}|${rate?.sessionId}`;
      if (id !== this.identity) { this.reset(); this.identity = id; }
      if (!rate || rate.connection !== 'live' || rate.authRequired || !rate.active || rate.waiting ||
          !finite(rate.tokensPerSecond) || !['generating', 'sampling'].includes(rate.phase)) {
        this.reset(); this.identity = id; return null;
      }
      const active = rate.sessionStats?.activeMs;
      const at = rate.sessionStats?.updatedAt;
      if (!finite(active) || !finite(at)) { this.reset(); this.identity = id; return null; }
      const key = `${active}|${at}`;
      if (key !== this.sampleKey) {
        const dt = this.activeMs === null ? 0 : active - this.activeMs;
        if (this.value === null || dt <= 0 || this.stale) this.value = rate.tokensPerSecond;
        else this.value = mix(this.value, rate.tokensPerSecond, dt, 1500);
        this.activeMs = active; this.sampleKey = key; this.seenAt = now; this.stale = false;
      }
      // A repeated /rate response is not a new output sample. No wall-clock
      // extrapolation, no zero samples, no smoothing toward a stale value.
      if (now - this.seenAt > SHORT_GAP_MS) { this.stale = true; return null; }
      return this.value;
    }
  }
  root.TPSPresentation = { trend, LiveValue, STEP_MS, SHORT_GAP_MS, HARD_GAP_MS };
})(globalThis);
