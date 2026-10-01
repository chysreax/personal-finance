/**
 * Dependency-free, CSP-safe SVG charts.
 * Spec: bars ≤ 24px with 4px rounded data-end, 2px lines, ≥ 8px markers with a
 * surface ring, 10% area wash, hairline solid gridlines, legend for ≥ 2 series,
 * crosshair/per-mark tooltips, and a visually-hidden data table for screen readers.
 * Charts re-render at their real pixel width (ResizeObserver) so text never scales.
 */
import { h, s, clear } from './dom.js';

/* ---------- shared tooltip ---------- */

let tip;
function tooltip() {
  if (!tip) {
    tip = h('div', { class: 'chart-tip', role: 'tooltip', 'aria-hidden': 'true' });
    document.body.appendChild(tip);
  }
  return tip;
}

function showTip(evt, title, rows) {
  const t = tooltip();
  clear(t);
  t.appendChild(h('div', { class: 'tip-title' }, title));
  for (const r of rows) {
    t.appendChild(
      h('div', { class: 'tip-row' }, r.slot !== undefined && h('span', { class: `tip-key slot-bg-${r.slot}` }), h('span', { class: 'tip-name' }, r.name), h('span', { class: 'tip-val' }, r.value)),
    );
  }
  t.classList.add('show');
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const rect = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY - rect.height - pad;
  if (x + rect.width > W - 8) x = evt.clientX - rect.width - pad;
  if (y < 8) y = evt.clientY + pad;
  if (y + rect.height > H - 8) y = H - rect.height - 8;
  t.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
}

export function hideTip() {
  tip?.classList.remove('show');
}

/* ---------- scales ---------- */

export function niceTicks(min, max, count = 4) {
  if (min === max) {
    max = min + 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// One shared ResizeObserver for every chart; detached hosts are pruned.
const renderers = new Map();
let ro = null;
function observe(host, render) {
  if (typeof ResizeObserver === 'undefined') return;
  if (!ro) {
    ro = new ResizeObserver((entries) => {
      // Defer to the next frame so rendering never re-enters the observer loop.
      const fns = entries.map((e) => renderers.get(e.target)).filter(Boolean);
      requestAnimationFrame(() => fns.forEach((fn) => fn()));
    });
  }
  renderers.set(host, render);
  ro.observe(host);
}

/** Release observers of charts that are no longer in the document (called on navigation). */
export function pruneCharts() {
  for (const host of renderers.keys()) {
    if (!host.isConnected) {
      ro?.unobserve(host);
      renderers.delete(host);
    }
  }
}

function responsive(height, draw, cls = '') {
  const host = h('div', { class: `chart ${cls}`, style: { height: `${height}px` } });
  let lastW = 0;
  const render = () => {
    const w = Math.floor(host.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    const svg = draw(w, height);
    const old = host.querySelector('svg');
    if (old) old.replaceWith(svg);
    else host.prepend(svg);
  };
  observe(host, render);
  requestAnimationFrame(render);
  return host;
}

function srTable(caption, headers, rows) {
  return h(
    'table',
    { class: 'sr-only' },
    h('caption', {}, caption),
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', {}, c)))))),
  );
}

export function legend(items) {
  return h(
    'ul',
    { class: 'legend' },
    items.map((it) => h('li', {}, h('span', { class: `legend-key slot-bg-${it.slot}${it.line ? ' legend-line' : ''}` }), it.name)),
  );
}

function roundedTop(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  r = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function roundedBottom(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  r = Math.min(r, hgt, w / 2);
  return `M${x},${y}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w - r}Q${x + w},${y + hgt} ${x + w},${y + hgt - r}V${y}Z`;
}

function axisLabelStep(n, plotW, minPx = 44) {
  return Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / minPx))));
}

/* ---------- bar chart (grouped, supports negatives) ---------- */

/**
 * @param {{labels: string[], fullLabels?: string[], series: {name: string, values: number[], slot: number}[],
 *          height?: number, format: (v:number)=>string, formatAxis?: (v:number)=>string, caption?: string}} o
 */
export function barChart(o) {
  const height = o.height || 220;
  const fmtAxis = o.formatAxis || o.format;
  const wrap = h('div', { class: 'chart-wrap' });
  const chart = responsive(height, (W, H) => {
    const m = { t: 12, r: 8, b: 26, l: 8 };
    const all = o.series.flatMap((x) => x.values);
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 4);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    // measure the widest tick label roughly (7px per char at 11px)
    m.l = Math.max(...ticks.map((t) => fmtAxis(t).length)) * 6.6 + 10;
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const y = (v) => m.t + ((yMax - v) / (yMax - yMin)) * ph;
    const n = o.labels.length;
    const band = pw / n;
    const k = o.series.length;
    const gap = 2;
    const barW = Math.max(3, Math.min(24, (band * 0.72 - gap * (k - 1)) / k));
    const groupW = barW * k + gap * (k - 1);
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': o.caption || 'Bar chart' });
    const grid = s('g', { class: 'grid' });
    for (const t of ticks) {
      grid.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'gridline' }));
      grid.appendChild(s('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, fmtAxis(t)));
    }
    svg.appendChild(grid);
    const step = axisLabelStep(n, pw);
    const bars = s('g', {});
    o.labels.forEach((lab, i) => {
      const gx = m.l + band * i + (band - groupW) / 2;
      const g = s('g', { class: 'bar-group' });
      o.series.forEach((ser, j) => {
        const v = ser.values[i] || 0;
        const x = gx + j * (barW + gap);
        const y0 = y(0);
        const yv = y(v);
        const d = v >= 0 ? roundedTop(x, yv, barW, y0 - yv) : roundedBottom(x, y0, barW, yv - y0);
        if (d) g.appendChild(s('path', { d, class: `bar slot-fill-${ser.slot}` }));
      });
      const hit = s('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, class: 'hit' });
      hit.addEventListener('pointermove', (e) => {
        svg.classList.add('hovering');
        g.classList.add('active');
        showTip(e, o.fullLabels?.[i] || lab, o.series.map((ser) => ({ slot: ser.slot, name: ser.name, value: o.format(ser.values[i] || 0) })));
      });
      hit.addEventListener('pointerleave', () => {
        svg.classList.remove('hovering');
        g.classList.remove('active');
        hideTip();
      });
      g.appendChild(hit);
      bars.appendChild(g);
      if (i % step === 0 || i === n - 1) {
        bars.appendChild(s('text', { x: m.l + band * i + band / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis-text' }, lab));
      }
    });
    svg.appendChild(bars);
    return svg;
  });
  wrap.append(chart);
  if (o.series.length > 1) wrap.append(legend(o.series));
  wrap.append(srTable(o.caption || 'Chart data', ['Period', ...o.series.map((x) => x.name)], o.labels.map((l, i) => [o.fullLabels?.[i] || l, ...o.series.map((x) => o.format(x.values[i] || 0))])));
  return wrap;
}

/* ---------- line / area chart ---------- */

/**
 * @param {{labels: string[], fullLabels?: string[], series: {name: string, values: number[], slot: number, area?: boolean}[],
 *          height?: number, format: (v:number)=>string, formatAxis?: (v:number)=>string, caption?: string, zero?: boolean,
 *          endLabel?: boolean}} o
 */
export function lineChart(o) {
  const height = o.height || 220;
  const fmtAxis = o.formatAxis || o.format;
  const wrap = h('div', { class: 'chart-wrap' });
  const chart = responsive(height, (W, H) => {
    const m = { t: 14, r: 12, b: 26, l: 8 };
    const all = o.series.flatMap((x) => x.values);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (o.zero !== false) {
      lo = Math.min(0, lo);
      hi = Math.max(0, hi);
    }
    const ticks = niceTicks(lo, hi, 4);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    m.l = Math.max(...ticks.map((t) => fmtAxis(t).length)) * 6.6 + 10;
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const n = o.labels.length;
    const x = (i) => m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = (v) => m.t + ((yMax - v) / (yMax - yMin || 1)) * ph;
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': o.caption || 'Line chart' });
    for (const t of ticks) {
      svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 && yMin < 0 ? 'baseline' : 'gridline' }));
      svg.appendChild(s('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, fmtAxis(t)));
    }
    const step = axisLabelStep(n, pw, 52);
    o.labels.forEach((lab, i) => {
      if (i % step === 0 || i === n - 1) {
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        svg.appendChild(s('text', { x: x(i), y: H - 8, 'text-anchor': anchor, class: 'axis-text' }, lab));
      }
    });
    for (const ser of o.series) {
      const pts = ser.values.map((v, i) => [x(i), y(v)]);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (ser.area) {
        const base = y(Math.max(yMin, Math.min(0, yMax)));
        svg.appendChild(s('path', { d: `${d}L${pts[pts.length - 1][0]},${base}L${pts[0][0]},${base}Z`, class: `area slot-fill-${ser.slot}` }));
      }
      svg.appendChild(s('path', { d, class: `line slot-stroke-${ser.slot}` }));
      if (o.endLabel !== false && pts.length) {
        const last = pts[pts.length - 1];
        svg.appendChild(s('circle', { cx: last[0], cy: last[1], r: 4, class: `dot slot-fill-${ser.slot}` }));
      }
    }
    // crosshair layer
    const cross = s('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
    const dots = o.series.map((ser) => s('circle', { r: 4.5, class: `dot slot-fill-${ser.slot}`, visibility: 'hidden' }));
    svg.appendChild(cross);
    dots.forEach((d) => svg.appendChild(d));
    const hit = s('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'hit' });
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / pw) * (n - 1))));
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      o.series.forEach((ser, j) => {
        dots[j].setAttribute('cx', x(i));
        dots[j].setAttribute('cy', y(ser.values[i]));
        dots[j].setAttribute('visibility', 'visible');
      });
      showTip(e, o.fullLabels?.[i] || o.labels[i], o.series.map((ser) => ({ slot: ser.slot, name: ser.name, value: o.format(ser.values[i]) })));
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      hideTip();
    });
    svg.appendChild(hit);
    return svg;
  });
  wrap.append(chart);
  if (o.series.length > 1) wrap.append(legend(o.series.map((x) => ({ ...x, line: true }))));
  const every = Math.max(1, Math.ceil(o.labels.length / 24));
  wrap.append(
    srTable(o.caption || 'Chart data', ['Point', ...o.series.map((x) => x.name)], o.labels.map((l, i) => [o.fullLabels?.[i] || l, ...o.series.map((x) => o.format(x.values[i]))]).filter((_, i) => i % every === 0)),
  );
  return wrap;
}

/* ---------- donut ---------- */

/**
 * @param {{items: {id?: string, label: string, value: number, slot: number, icon?: string}[], format: (v:number)=>string,
 *          centerLabel?: string, size?: number, onSelect?: (item) => void}} o
 */
export function donutChart(o) {
  const size = o.size || 200;
  const total = o.items.reduce((acc, it) => acc + it.value, 0);
  const R = size / 2 - 6;
  const stroke = Math.max(14, size * 0.13);
  const r = R - stroke / 2;
  const C = 2 * Math.PI * r;
  const gapLen = o.items.length > 1 ? 2 : 0;
  const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img', 'aria-label': o.caption || 'Category breakdown' });
  svg.appendChild(s('circle', { cx: size / 2, cy: size / 2, r, class: 'donut-track', 'stroke-width': stroke, fill: 'none' }));
  const centerValue = s('text', { x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle', class: 'donut-value' }, o.format(total));
  const centerLabel = s('text', { x: size / 2, y: size / 2 + 22, 'text-anchor': 'middle', class: 'donut-label' }, o.centerLabel || 'Total');
  let offset = 0;
  const segs = [];
  const legendEl = h('ul', { class: 'donut-legend' });
  const setActive = (idx) => {
    segs.forEach((sg, i) => sg.classList.toggle('dim', idx !== null && i !== idx));
    [...legendEl.children].forEach((li, i) => li.classList.toggle('dim', idx !== null && i !== idx));
    if (idx === null) {
      centerValue.textContent = o.format(total);
      centerLabel.textContent = o.centerLabel || 'Total';
    } else {
      const it = o.items[idx];
      centerValue.textContent = o.format(it.value);
      centerLabel.textContent = `${it.label.length > 16 ? `${it.label.slice(0, 15)}…` : it.label} · ${Math.round((it.value / total) * 100)}%`;
    }
  };
  o.items.forEach((it, i) => {
    const len = total ? (it.value / total) * C : 0;
    const seg = s('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke,
      class: `donut-seg slot-stroke-${it.slot}`,
      'stroke-dasharray': `${Math.max(0, len - gapLen).toFixed(2)} ${C.toFixed(2)}`,
      'stroke-dashoffset': (-offset).toFixed(2),
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
      tabindex: '0',
      'aria-label': `${it.label}: ${o.format(it.value)}`,
    });
    seg.addEventListener('pointerenter', () => setActive(i));
    seg.addEventListener('focus', () => setActive(i));
    seg.addEventListener('pointerleave', () => setActive(null));
    seg.addEventListener('blur', () => setActive(null));
    if (o.onSelect) seg.addEventListener('click', () => o.onSelect(it));
    offset += len;
    segs.push(seg);
    svg.appendChild(seg);
    legendEl.appendChild(
      h(
        'li',
        { onpointerenter: () => setActive(i), onpointerleave: () => setActive(null), onclick: o.onSelect ? () => o.onSelect(it) : undefined, class: o.onSelect ? 'clickable' : '' },
        h('span', { class: `legend-key slot-bg-${it.slot}` }),
        h('span', { class: 'legend-name' }, it.icon ? `${it.icon} ${it.label}` : it.label),
        h('span', { class: 'legend-val' }, o.format(it.value)),
        h('span', { class: 'legend-pct' }, `${total ? Math.round((it.value / total) * 100) : 0}%`),
      ),
    );
  });
  svg.appendChild(centerValue);
  svg.appendChild(centerLabel);
  return h('div', { class: 'donut-wrap' }, h('div', { class: 'donut-figure' }, svg), legendEl);
}

/* ---------- sparkline ---------- */

export function sparkline(values, { slot = 0, height = 36 } = {}) {
  return responsive(
    height,
    (W, H) => {
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      const n = values.length;
      const x = (i) => 2 + (i / Math.max(1, n - 1)) * (W - 8);
      const y = (v) => 4 + (hi === lo ? (H - 8) / 2 : ((hi - v) / (hi - lo)) * (H - 8));
      const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      return s(
        'svg',
        { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'spark', 'aria-hidden': 'true' },
        s('path', { d: `${d}L${x(n - 1)},${H}L${x(0)},${H}Z`, class: `area slot-fill-${slot}` }),
        s('path', { d, class: `line slot-stroke-${slot}` }),
        s('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3.5, class: `dot slot-fill-${slot}` }),
      );
    },
    'chart-spark',
  );
}

/* ---------- gauge (semicircle meter) ---------- */

export function gauge(score, { size = 200, label = '' } = {}) {
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const W = size;
  const Hh = size * 0.62;
  const r = size / 2 - 14;
  const cx = W / 2;
  const cy = size / 2 + 2;
  const arc = (p) => {
    const a = Math.PI * (1 - p);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const [sx, sy] = arc(0);
  const [ex, ey] = arc(1);
  const [px, py] = arc(pct);
  const tone = score >= 80 ? 'good' : score >= 65 ? 'ok' : score >= 50 ? 'warn' : 'bad';
  return s(
    'svg',
    { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}`, class: `gauge gauge-${tone}`, role: 'img', 'aria-label': `Financial health score ${score} of 100 ${label}` },
    s('path', { d: `M${sx},${sy}A${r},${r} 0 0 1 ${ex},${ey}`, class: 'gauge-track' }),
    pct > 0 && s('path', { d: `M${sx},${sy}A${r},${r} 0 0 1 ${px.toFixed(2)},${py.toFixed(2)}`, class: 'gauge-fill' }),
    s('text', { x: cx, y: cy - 14, 'text-anchor': 'middle', class: 'gauge-value' }, String(score)),
    s('text', { x: cx, y: cy + 8, 'text-anchor': 'middle', class: 'gauge-label' }, label),
  );
}

/* ---------- horizontal bar list (HTML) ---------- */

export function hbarList(items, { format, slotOf = () => 0 }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h(
    'ul',
    { class: 'hbar-list' },
    items.map((it, i) =>
      h(
        'li',
        {},
        h('div', { class: 'hbar-top' }, h('span', { class: 'hbar-name' }, it.label), h('span', { class: 'hbar-val' }, format(it.value))),
        h('div', { class: 'hbar-track' }, h('div', { class: `hbar-fill slot-bg-${slotOf(it, i)}`, style: { '--w': `${((it.value / max) * 100).toFixed(1)}%` } })),
        it.sub && h('div', { class: 'hbar-sub muted small' }, it.sub),
      ),
    ),
  );
}

/* ---------- weekday heat strip ---------- */

export function heatStrip(values, labels, { format }) {
  const max = Math.max(1, ...values);
  return h(
    'div',
    { class: 'heat-strip', role: 'list' },
    values.map((v, i) =>
      h(
        'div',
        { class: 'heat-cell', role: 'listitem', 'aria-label': `${labels[i]}: ${format(v)}`, style: { '--a': (0.12 + 0.88 * (v / max)).toFixed(2) },
          onpointermove: (e) => showTip(e, labels[i], [{ name: 'Avg. spend', value: format(v) }]), onpointerleave: hideTip },
        h('span', { class: 'heat-label' }, labels[i].slice(0, 3)),
      ),
    ),
  );
}
