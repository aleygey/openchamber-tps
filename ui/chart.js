// Dependency-free SVG chart. X is cumulative observed active time; each pause
// starts a separate path. The hover readout includes the original wall time.
(() => {
  'use strict';
  const ns = 'http://www.w3.org/2000/svg';
  const duration = ms => ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
    : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function create(svg, tooltip) {
    let points = [], options = {}, plot = null;
    function node(tag, attrs, text) {
      const el = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      if (text !== undefined) el.textContent = text;
      svg.append(el); return el;
    }
    function paint() {
      const width = Math.max(180, svg.clientWidth || 300), height = svg.clientHeight || 110;
      const left = 34, top = 12, right = width - 6, bottom = height - 22;
      const first = points[0]?.activeMs ?? 0, last = points.at(-1)?.activeMs ?? 1000;
      const extent = Math.max(1000, last - first);
      const maximum = Math.max(1, options.averageTps || 0, ...points.map(p => p.tps));
      const step = 10 ** Math.floor(Math.log10(maximum));
      const ymax = Math.ceil(maximum * 1.05 / step) * step;
      const x = v => left + (v - first) / extent * (right - left);
      const y = v => bottom - v / ymax * (bottom - top);
      plot = { left, right, first, extent, x, y };
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.replaceChildren(); tooltip.hidden = true;
      for (const fraction of [0, .5, 1]) {
        const value = ymax * fraction;
        node('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'chart-grid' });
        node('text', { x: left - 5, y: y(value) + 3, 'text-anchor': 'end', class: 'chart-label' }, value.toFixed(value < 10 && value % 1 ? 1 : 0));
      }
      node('text', { x: left, y: height - 4, class: 'chart-label' }, duration(first));
      node('text', { x: right, y: height - 4, 'text-anchor': 'end', class: 'chart-label' }, duration(first + extent));
      if (!points.length) {
        node('text', { x: (left + right) / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-label' }, options.empty || 'Waiting for streamed output');
        return;
      }
      if (Number.isFinite(options.averageTps)) {
        node('line', { x1: left, x2: right, y1: y(options.averageTps), y2: y(options.averageTps), class: 'chart-average' });
      }
      let path = '';
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        path += `${i === 0 || p.breakBefore ? 'M' : 'L'}${x(p.activeMs).toFixed(2)},${y(p.tps).toFixed(2)} `;
        // Isolated bursts still have a visible point rather than an empty path.
        if ((i === 0 || p.breakBefore) && (i === points.length - 1 || points[i + 1].breakBefore)) {
          node('circle', { cx: x(p.activeMs), cy: y(p.tps), r: 2, class: 'chart-dot' });
        }
      }
      node('path', { d: path, class: 'chart-line' });
    }
    svg.addEventListener('pointermove', event => {
      if (!points.length || !plot) return;
      const rect = svg.getBoundingClientRect();
      const t = plot.first + Math.max(0, Math.min(1, (event.clientX - rect.left - plot.left) / (plot.right - plot.left))) * plot.extent;
      let best = points[0];
      for (const p of points) if (Math.abs(p.activeMs - t) <= Math.abs(best.activeMs - t)) best = p;
      const time = new Date(best.at).toLocaleTimeString(options.locale || undefined, { hour12: false });
      tooltip.textContent = `${time} · ${duration(best.activeMs)} · ≈ ${best.tps.toFixed(1)} tok/s`;
      tooltip.hidden = false;
    });
    svg.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(paint);
    observer?.observe(svg);
    return {
      render(next, nextOptions = {}) {
        points = Array.isArray(next) ? next.filter(p => p && Number.isFinite(p.tps) && Number.isFinite(p.activeMs) && Number.isFinite(p.at)).slice(-1800) : [];
        options = nextOptions; paint();
      },
      dispose() { observer?.disconnect(); },
    };
  }
  window.TPSChart = { create, duration };
})();
