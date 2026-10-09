// Smoothed presentation of observed active-time history, not new measurements.
(() => {
  'use strict';
  const ns = 'http://www.w3.org/2000/svg';
  const duration = ms => ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
    : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function create(svg, tooltip) {
    let source = [], points = [], options = {}, plot = null, identity = '', ceiling = 0;
    function node(tag, attrs, text) {
      const el = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      if (text !== undefined) el.textContent = text;
      svg.append(el); return el;
    }
    function paint() {
      const compact = options.compact !== false;
      const width = Math.max(140, svg.clientWidth || 300), height = svg.clientHeight || 56;
      const left = compact ? 4 : 32, right = width - 5, top = 6, bottom = height - (compact ? 6 : 20);
      const first = points[0]?.activeMs ?? 0, last = points.at(-1)?.activeMs ?? 1000;
      const extent = Math.max(1000, last - first);
      let maximum = 1;
      for (const p of points) maximum = Math.max(maximum, p.value);
      if (!compact && Number.isFinite(options.averageTps)) maximum = Math.max(maximum, options.averageTps);
      const candidate = Math.ceil(maximum * 1.15 / 10) * 10;
      // Hysteresis prevents small window changes from making the whole line bob.
      if (!ceiling || candidate > ceiling || candidate < ceiling * .55) ceiling = candidate;
      const x = v => left + (v - first) / extent * (right - left);
      const y = v => bottom - v / ceiling * (bottom - top);
      plot = { left, right, first, extent, x, y };
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.replaceChildren(); tooltip.hidden = true;
      if (!compact) {
        for (const fraction of [0, .5, 1]) {
          node('line', { x1: left, x2: right, y1: y(ceiling * fraction), y2: y(ceiling * fraction), class: 'chart-grid' });
          node('text', { x: left - 5, y: y(ceiling * fraction) + 3, 'text-anchor': 'end', class: 'chart-label' }, String(ceiling * fraction));
        }
        node('text', { x: left, y: height - 3, class: 'chart-label' }, duration(first));
        node('text', { x: right, y: height - 3, 'text-anchor': 'end', class: 'chart-label' }, duration(first + extent));
      }
      if (!points.length) {
        node('line', { x1: left, x2: right, y1: (top + bottom) / 2, y2: (top + bottom) / 2, class: 'chart-empty' });
        return;
      }
      if (!compact && Number.isFinite(options.averageTps)) {
        node('line', { x1: left, x2: right, y1: y(options.averageTps), y2: y(options.averageTps), class: 'chart-average' });
      }
      let path = '', previous = null;
      const f = n => n.toFixed(2);
      for (let i = 0; i < points.length; i++) {
        const p = points[i], px = x(p.activeMs), py = y(p.value);
        if (!previous || p.join === 'hard' || p.join === 'dashed') {
          if (previous) {
            if (p.join === 'dashed') node('line', { x1: x(previous.activeMs), y1: y(previous.value), x2: px, y2: py, class: 'chart-bridge' });
            // A quiet tick marks omitted wall-clock time without adding zeros.
            node('line', { x1: px, x2: px, y1: bottom - 2, y2: bottom + 2, class: 'chart-pause' });
          }
          path += `M${f(px)},${f(py)} `;
        } else {
          const mid = (x(previous.activeMs) + px) / 2;
          // Horizontal tangents; Bezier values stay between their endpoints.
          path += `C${f(mid)},${f(y(previous.value))} ${f(mid)},${f(py)} ${f(px)},${f(py)} `;
        }
        if ((!previous || ['hard', 'dashed'].includes(p.join)) &&
            (i === points.length - 1 || ['hard', 'dashed'].includes(points[i + 1].join))) {
          node('circle', { cx: px, cy: py, r: 1.5, class: 'chart-dot' });
        }
        previous = p;
      }
      node('path', { d: path, class: 'chart-line' });
    }
    svg.addEventListener('pointermove', event => {
      if (!points.length || !plot) return;
      const rect = svg.getBoundingClientRect();
      const t = plot.first + Math.max(0, Math.min(1, (event.clientX - rect.left - plot.left) / (plot.right - plot.left))) * plot.extent;
      let best = points[0];
      for (const p of points) if (Math.abs(p.activeMs - t) <= Math.abs(best.activeMs - t)) best = p;
      const zh = options.locale?.startsWith('zh');
      const time = new Date(best.at).toLocaleTimeString(options.locale || undefined, { hour12: false });
      tooltip.textContent = `${time} · ${duration(best.activeMs)} · ≈ ${best.value.toFixed(1)} tok/s (${zh ? '平滑' : 'smoothed'})`;
      tooltip.hidden = false;
    });
    svg.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(paint);
    observer?.observe(svg);
    return {
      render(next, nextOptions = {}) {
        source = Array.isArray(next) ? next : [];
        if (identity !== nextOptions.identity || !source.length) ceiling = 0;
        identity = nextOptions.identity; options = nextOptions;
        points = window.TPSPresentation.trend(source); paint();
      },
      dispose() { observer?.disconnect(); },
    };
  }
  window.TPSChart = { create, duration };
})();
