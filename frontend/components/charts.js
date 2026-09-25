/* ==========================================================================
   CHART ENGINE — data-driven SVG charts (no hard-coded values).
   Views register chart specs; the engine measures containers, draws, and
   redraws on resize. Segments/bars that carry data-filter-* attributes
   apply a global filter on click.
   ========================================================================== */
const Charts = (() => {
  const specs = new Map();
  let seq = 0;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = i => i < 0 ? 'var(--c-other)' : `var(--c${(i % 6) + 1})`;

  function register(kind, spec, cls = '') {
    const id = 'ch' + (++seq);
    specs.set(id, { kind, spec });
    return `<div class="chart ${cls}" id="${id}" data-chart="${id}"></div>`;
  }
  function mountAll(root = document) {
    root.querySelectorAll('[data-chart]').forEach(el => draw(el));
  }
  function draw(el) {
    const s = specs.get(el.dataset.chart);
    if (!s) return;
    const w = Math.max(260, el.clientWidth || 600);
    el.innerHTML = ({ bars, line, hbars, donut })[s.kind](s.spec, w);
  }
  function reset() { specs.clear(); }

  function niceScale(max, ticks = 4) {
    if (!(max > 0)) return { max: 1, step: 0.25 };
    const raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw);
    return { max: step * Math.ceil(max / step), step };
  }
  function tipAttr(title, lines) {
    return `data-tip="${esc(`<b>${esc(title)}</b>` + lines.map(([c, l, v]) => `<div class="tip-row">${c ? `<i style="background:${c}"></i>` : ''}<span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join(''))}"`;
  }
  function empty(msg, h = 240) { return `<div class="chart-empty" style="height:${h}px">${esc(msg || t('common.noData'))}</div>`; }

  /* grouped vertical bars on ONE axis. spec: {cats:[{label}], series:[{label, values, fmt}], fmt, height} */
  function bars(spec, W) {
    const H = spec.height || 300, L = 64, R = 12, T = 14, B = 34;
    const all = spec.series.flatMap(s => s.values.filter(v => v != null));
    if (!all.length) return empty(null, H);
    const { max, step } = niceScale(Math.max(...all));
    const ch = H - T - B, n = spec.cats.length, band = (W - L - R) / n;
    const sN = spec.series.length, gw = Math.min(band * 0.78, sN * 26), bw = Math.max(2, gw / sN - 2);
    let o = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.aria || '')}">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      const y = T + ch * (1 - v / max);
      o += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" class="axis">${esc(spec.fmt(v))}</text>`;
    }
    const every = Math.ceil(n / Math.max(1, Math.floor((W - L - R) / 64)));
    spec.cats.forEach((c, i) => {
      const x0 = L + i * band + (band - gw) / 2;
      const lines = spec.series.map((s, si) => [color(s.ci ?? si), s.label, spec.fmt(s.values[i])]);
      if (spec.extraTip) lines.push(...spec.extraTip(i));
      o += `<g class="hit" ${tipAttr(c.full || c.label, lines)}><rect x="${L + i * band}" y="${T}" width="${band}" height="${ch}" fill="transparent"/>`;
      spec.series.forEach((s, si) => {
        const v = s.values[i]; if (v == null) return;
        const h = Math.max(v > 0 ? 1 : 0, ch * v / max), x = x0 + si * (bw + 2), y = T + ch - h;
        o += `<path d="${roundTop(x, y, bw, h, Math.min(4, bw / 2))}" fill="${color(s.ci ?? si)}"/>`;
      });
      o += `</g>`;
      if (i % every === 0) o += `<text x="${L + i * band + band / 2}" y="${H - 12}" text-anchor="middle" class="axis">${esc(c.label)}</text>`;
    });
    o += `<line x1="${L}" x2="${W - R}" y1="${T + ch}" y2="${T + ch}" class="baseline"/>`;
    return o + '</svg>';
  }
  function roundTop(x, y, w, h, r) {
    if (h <= r) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /* line chart, one axis. spec: {cats, series:[{label, values}], fmt, height} */
  function line(spec, W) {
    const H = spec.height || 200, L = 56, R = 16, T = 14, B = 30;
    const all = spec.series.flatMap(s => s.values.filter(v => v != null));
    if (!all.length) return empty(null, H);
    const lo = Math.min(0, Math.min(...all));
    const { max, step } = niceScale(Math.max(...all) - lo);
    const ch = H - T - B, n = spec.cats.length, dx = n > 1 ? (W - L - R) / (n - 1) : 0;
    const X = i => L + (n > 1 ? i * dx : (W - L - R) / 2), Y = v => T + ch * (1 - (v - lo) / max);
    let o = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    for (let v = 0; v <= max + 1e-9; v += step) o += `<line x1="${L}" x2="${W - R}" y1="${Y(v + lo)}" y2="${Y(v + lo)}" class="grid"/><text x="${L - 8}" y="${Y(v + lo) + 4}" text-anchor="end" class="axis">${esc(spec.fmt(v + lo))}</text>`;
    spec.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => v == null ? null : [X(i), Y(v)]);
      const segs = []; let cur = [];
      pts.forEach(p => { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } });
      if (cur.length) segs.push(cur);
      const c = color(s.ci ?? si);
      segs.forEach(sg => {
        if (si === 0 && spec.area !== false) o += `<path d="M${sg[0][0]},${T + ch}L${sg.map(p => p.join(',')).join('L')}L${sg[sg.length - 1][0]},${T + ch}Z" fill="${c}" opacity=".08"/>`;
        o += `<path d="M${sg.map(p => p.join(',')).join('L')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      });
      const last = [...pts].reverse().find(p => p);
      if (last) o += `<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${c}" stroke="var(--card)" stroke-width="2"/>`;
    });
    const every = Math.ceil(n / Math.max(1, Math.floor((W - L - R) / 64)));
    spec.cats.forEach((c, i) => {
      const x0 = n > 1 ? X(i) - dx / 2 : L;
      o += `<rect class="hit" x="${x0}" y="${T}" width="${n > 1 ? dx : W - L - R}" height="${ch}" fill="transparent" ${tipAttr(c.full || c.label, spec.series.map((s, si) => [color(s.ci ?? si), s.label, spec.fmt(s.values[i])]))}/>`;
      if (i % every === 0) o += `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" class="axis">${esc(c.label)}</text>`;
    });
    return o + '</svg>';
  }

  /* horizontal grouped bars. spec: {rows:[{label, values:[], filter:{dim,value}}], series:[{label}], fmt} */
  function hbars(spec, W) {
    const rows = spec.rows;
    if (!rows.length) return empty();
    const sN = spec.series.length, barH = 11, gap = 3, rowH = sN * (barH + gap) + 14;
    const labelW = Math.min(230, Math.max(110, W * 0.3)), L = labelW + 12, R = 70, T = 6;
    const H = T + rows.length * rowH + 22;
    const all = rows.flatMap(r => r.values.filter(v => v != null));
    const { max, step } = niceScale(Math.max(...all, 0));
    const cw = W - L - R, X = v => L + cw * v / max;
    let o = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    for (let v = 0; v <= max + 1e-9; v += step) o += `<line x1="${X(v)}" x2="${X(v)}" y1="${T}" y2="${H - 22}" class="grid"/><text x="${X(v)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(spec.fmt(v))}</text>`;
    rows.forEach((r, i) => {
      const y0 = T + i * rowH + 7;
      const filt = r.filter ? `data-filter-dim="${esc(r.filter.dim)}" data-filter-value="${esc(r.filter.value)}" tabindex="0" role="button"` : '';
      o += `<g class="hit ${r.filter ? 'clickable' : ''}" ${filt} ${tipAttr(r.label, spec.series.map((s, si) => [color(s.ci ?? si), s.label, spec.fmt(r.values[si])]))}>`;
      o += `<rect x="0" y="${y0 - 5}" width="${W}" height="${rowH}" fill="transparent"/>`;
      const lbl = r.label.length > 34 ? r.label.slice(0, 33) + '…' : r.label;
      o += `<text x="${labelW}" y="${y0 + (sN * (barH + gap)) / 2 + 2}" text-anchor="end" class="axis label">${esc(lbl)}</text>`;
      r.values.forEach((v, si) => {
        if (v == null) return;
        const y = y0 + si * (barH + gap), w = Math.max(1, X(v) - L);
        o += `<path d="M${L},${y}H${L + w - 4}Q${L + w},${y} ${L + w},${y + 4}V${y + barH - 4}Q${L + w},${y + barH} ${L + w - 4},${y + barH}H${L}Z" fill="${color(spec.series[si].ci ?? si)}"/>`;
        if (si === 0 || sN <= 2) o += `<text x="${L + w + 6}" y="${y + barH - 2}" class="axis val">${esc(spec.fmt(v))}</text>`;
      });
      o += '</g>';
    });
    return o + '</svg>';
  }

  /* donut: spec {segs:[{label,value}], center, centerLabel, dim (for click filter), fmt, max:5} */
  function donut(spec, W) {
    const size = Math.min(170, W - 20), r = size / 2, ir = r * 0.64;
    let segs = spec.segs.filter(s => s.value > 0);
    const total = segs.reduce((a, s) => a + s.value, 0);
    if (!total) return empty(null, 220);
    const maxN = 5;
    let shown = segs.slice(0, maxN).map((s, i) => ({ ...s, ci: i }));
    if (segs.length > maxN) shown.push({ label: t('common.other'), value: segs.slice(maxN).reduce((a, s) => a + s.value, 0), ci: -1, other: true });
    let a0 = -Math.PI / 2, o = `<div class="donut-wrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">`;
    const gapA = shown.length > 1 ? 0.012 : 0;
    shown.forEach(s => {
      const frac = s.value / total, a1 = a0 + frac * Math.PI * 2;
      const pct = I18n.pct(frac * 100, 1);
      const filt = !s.other && spec.dim ? `data-filter-dim="${esc(spec.dim)}" data-filter-value="${esc(s.label)}" tabindex="0" role="button"` : '';
      const attrs = `class="hit ${filt ? 'clickable' : ''}" ${filt} ${tipAttr(s.label, [[color(s.ci), spec.metricLabel, spec.fmt(s.value)], [null, t('common.share'), pct]])}`;
      if (frac >= 0.9999) o += `<circle cx="${r}" cy="${r}" r="${(r + ir) / 2}" fill="none" stroke="${color(s.ci)}" stroke-width="${r - ir}" ${attrs}/>`;
      else o += `<path d="${arc(r, r, r, ir, a0 + gapA, a1 - gapA)}" fill="${color(s.ci)}" ${attrs}/>`;
      s.pct = pct; a0 = a1;
    });
    o += `<text x="${r}" y="${r - 4}" text-anchor="middle" class="donut-lbl">${esc(spec.centerLabel)}</text><text x="${r}" y="${r + 16}" text-anchor="middle" class="donut-val">${esc(spec.center)}</text></svg>`;
    o += `<div class="mini-legend">${shown.map(s => `<button type="button" class="legend-row ${s.other || !spec.dim ? 'static' : ''}" ${!s.other && spec.dim ? `data-filter-dim="${esc(spec.dim)}" data-filter-value="${esc(s.label)}"` : ''}><span><i class="legend-dot" style="background:${color(s.ci)}"></i>${esc(s.label)}</span><strong>${s.pct}</strong></button>`).join('')}</div></div>`;
    return o;
  }
  function arc(cx, cy, r, ir, a0, a1) {
    const p = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = p(r, a0), [x1, y1] = p(r, a1), [x2, y2] = p(ir, a1), [x3, y3] = p(ir, a0);
    return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${ir},${ir} 0 ${large} 0 ${x3},${y3}Z`;
  }

  /* global tooltip */
  function initTooltip() {
    const tip = document.getElementById('tip');
    document.addEventListener('mousemove', e => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) { tip.hidden = true; return; }
      tip.innerHTML = el.getAttribute('data-tip');
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + tw > innerWidth - 8) x = e.clientX - tw - 14;
      if (y + th > innerHeight - 8) y = e.clientY - th - 14;
      tip.style.transform = `translate(${x}px,${y}px)`;
    });
    document.addEventListener('scroll', () => { tip.hidden = true; }, true);
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => mountAll(), 150); });
  }
  return { register, mountAll, reset, initTooltip, esc };
})();
const esc = Charts.esc;
