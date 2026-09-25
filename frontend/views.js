/* ==========================================================================
   VIEWS — one render function per sidebar page. Views compose reusable
   components (KPI cards, charts, tables); they never compute metrics.
   ========================================================================== */
const Views = (() => {
  const KPI_KEYS = ['adSpend', 'adSales', 'roas', 'acos', 'impressions', 'clicks', 'orders', 'ctr'];
  const SEGMENTS = ['highSpendLowSales', 'highSalesLowSpend', 'highRoas', 'lowRoas', 'highCvr', 'lowCvr'];
  const local = { segment: null, insightKind: 'all', effMetric: 'roas', aiText: null, aiState: 'idle', csvReport: 'campaign' };

  /* ---------- shared building blocks */
  function card({ kicker, title, sub, right = '', body, id = '' }) {
    return `<section class="report-section" ${id ? `id="${id}"` : ''}><article class="surface report-card">
      <div class="report-header"><div><div class="report-kicker">${esc(kicker)}</div><h2 class="report-title">${esc(title)}</h2>${sub ? `<p class="report-subtitle">${esc(sub)}</p>` : ''}</div>${right}</div>
      ${body}</article></section>`;
  }
  function notice(res) {
    const parts = [];
    if (res && res.unapplied && res.unapplied.length) parts.push(t('notice.unapplied', { dims: res.unapplied.map(d => I18n.dim(d)).join(', '), source: t('source.' + res.source) }));
    return parts.length ? `<div class="notice">${icon('info')}<span>${esc(parts.join(' '))}</span></div>` : '';
  }
  function missing(dimLabel, reportLabel) {
    return `<div class="empty-state">${icon('database')}<h3>${esc(t('empty.title', { dim: dimLabel }))}</h3><p>${esc(t('empty.body', { report: reportLabel }))}</p>${State.can('import') ? `<button type="button" class="action-btn export" data-act="import">${icon('upload')}${esc(t('hdr.import'))}</button>` : ''}</div>`;
  }
  function kpiCard(key, cur, prev, cov) {
    const st = State.get();
    const partial = cov != null && cov > 0 && cov < 0.995;
    let delta = '';
    if (st.compareOn) delta = prev ? Fmt.deltaHTML(key, cur, prev[key]) : `<span class="delta none">${esc(t('common.noComparison'))}</span>`;
    return `<article class="surface kpi-card"><p class="kpi-label">${esc(I18n.metricLabel(key))}${partial ? ` <span class="cov" title="${esc(t('kpi.partial', { pct: I18n.pct(cov * 100, 0) }))}">◐</span>` : ''}</p>
      <p class="kpi-value">${cur == null ? `<span class="na">${esc(t('common.na'))}</span>` : esc(I18n.metric(key, cur))}</p>${delta ? `<p class="kpi-delta">${delta}</p>` : ''}</article>`;
  }
  function kpiGrid(keys = KPI_KEYS) {
    const k = Reports.kpis();
    if (!k.cur || !k.cur.total) return '';
    const V = k.cur.total.v, P = k.prev?.total?.v || null;
    if (!k.cur.total.rows) return `<div class="notice">${icon('info')}<span>${esc(t('kpi.noRows', { range: I18n.range(k.range[0], k.range[1]) }))}</span></div>`;
    return `<section aria-label="${esc(t('kpi.aria'))}" class="kpi-grid">${keys.map(key => kpiCard(key, V[key], P, k.cur.total.cov[key])).join('')}</section>${notice(k.cur)}`;
  }
  const seg = (name, opts, cur) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" class="${String(cur) === String(v) ? 'on' : ''}" data-${name}="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
  const legend = items => `<div class="legend">${items.map((l, i) => `<span><i class="legend-dot" style="background:var(--c${i + 1})"></i>${esc(l)}</span>`).join('')}</div>`;
  const fmtFor = key => v => I18n.metric(key, v);

  /* ---------- trend (spend vs sales bars + efficiency line) */
  function trendCard() {
    const st = State.get(), tr = Reports.trend(st.trendGrain);
    if (!tr) return '';
    const cats = tr.keys.map(k => ({ label: tr.grain === 'month' ? I18n.monthShort(k) : tr.grain === 'week' ? t('period.wk', { n: Dates.weekNumber(k) }) : tr.grain === 'quarter' ? Dates.periodLabel('quarter', k) : I18n.dateShort(k), full: Dates.periodLabel(tr.grain, k) + (tr.grain === 'week' ? ' · ' + I18n.range(k, k + 6) : '') }));
    const val = key => tr.keys.map(k => tr.groups.get(k)?.v[key] ?? null);
    const bars = Charts.register('bars', { cats, series: [{ label: I18n.metricLabel('adSpend'), values: val('adSpend') }, { label: I18n.metricLabel('adSales'), values: val('adSales') }], fmt: v => I18n.money(v), height: 300,
      extraTip: i => [[null, I18n.metricLabel('roas'), I18n.metric('roas', val('roas')[i])], [null, I18n.metricLabel('orders'), I18n.metric('orders', val('orders')[i])]] });
    const em = local.effMetric;
    const line = Charts.register('line', { cats, series: [{ label: I18n.metricLabel(em), values: val(em) }], fmt: fmtFor(em), height: 190, ci: 0 });
    const right = seg('grain', [['auto', t('grain.auto')], ['day', t('grain.day')], ['week', t('grain.week')], ['month', t('grain.month')]], st.trendGrain);
    return card({ kicker: t('ov.trendKicker'), title: t('ov.trendTitle'), sub: t('ov.trendSub', { grain: t('grain.' + tr.grain) }), right,
      body: `<div class="chart-block">${bars}</div>${legend([I18n.metricLabel('adSpend'), I18n.metricLabel('adSales')])}
        <div class="chart-block split-top"><div class="mini-head"><strong>${esc(t('ov.efficiency'))}</strong>${seg('eff', ['roas', 'acos', 'cpc', 'cvr', 'ctr'].map(k => [k, I18n.metricLabel(k)]), em)}</div>${line}</div>` });
  }

  /* ---------- donut breakdowns (metric + dimension selectable) */
  function donutCard(i) {
    const b = State.get().breakdowns[i];
    const res = Reports.breakdown(b.dim, b.metric);
    const sel = (kind, opts, cur) => `<select class="mini-select" id="bd-${kind}-${i}" data-bd="${i}" data-bd-kind="${kind}" aria-label="${esc(t('ov.' + kind))}">${opts.map(o => `<option value="${o}" ${o === cur ? 'selected' : ''}>${esc(kind === 'metric' ? I18n.metricLabel(o) : I18n.dim(o))}</option>`).join('')}</select>`;
    const chart = res.missing || !res.source ? `<div class="chart-empty" style="height:220px">${esc(t('empty.short', { dim: I18n.dim(b.dim) }))}</div>` :
      Charts.register('donut', { segs: res.segs.map(s => ({ ...s, label: b.dim === 'adType' ? s.label : s.label })), dim: b.dim, center: I18n.metric(b.metric, res.total), centerLabel: t('common.total'), fmt: fmtFor(b.metric), metricLabel: I18n.metricLabel(b.metric) });
    return `<div class="donut-card"><div class="donut-controls">${sel('metric', Config.BREAKDOWN_METRICS, b.metric)}<span class="by">${esc(t('ov.by'))}</span>${sel('dim', Config.BREAKDOWN_DIMS, b.dim)}</div>${chart}${res.unapplied?.length ? `<p class="fine">${esc(t('notice.short', { dims: res.unapplied.map(I18n.dim).join(', ') }))}</p>` : ''}</div>`;
  }
  function breakdownSection(kicker, title, sub) {
    return card({ kicker, title, sub, body: `<div class="donut-grid">${[0, 1, 2].map(donutCard).join('')}</div><p class="print-note">${esc(t('ov.donutHint'))}</p>` });
  }

  /* ---------- insights block */
  function insightItems(list, limit) {
    return list.slice(0, limit).map((ins, i) => `<div class="insight-item tone-${ins.tone}">
      <span class="insight-index">${i + 1}</span>
      <div class="insight-body"><div class="insight-top"><span class="kind k-${ins.kind}">${esc(t('kind.' + ins.kind))}</span><strong>${esc(ins.title)}</strong></div>
        <p><span class="lbl">${esc(t('ins.observation'))}</span>${esc(ins.obs)}</p>
        ${ins.rec ? `<p class="rec"><span class="lbl">${esc(t('ins.recommendation'))}</span>${esc(ins.rec)}</p>` : ''}
        ${ins.link ? `<a class="link-btn" href="#${ins.link}">${esc(t('ins.open', { page: t('nav.' + ins.link.replace('-t', 'T')) }))} →</a>` : ''}</div></div>`).join('');
  }
  function insightsPreview() {
    const list = Insights.build();
    const top = list.find(i => i.rec);
    return card({ kicker: t('ins.kicker'), title: t('ins.title'), sub: t('ins.sub'), right: `<a class="view-all" href="#insights">${esc(t('common.viewAll'))} ↗</a>`,
      body: `<div class="insight-layout"><div class="insight-list">${list.length ? insightItems(list, 4) : `<p class="muted">${esc(t('ins.none'))}</p>`}</div>
      <aside class="takeaway-box"><h3>${esc(t('ins.nextMove'))}</h3><p>${esc(top ? top.rec : t('ins.noRecs'))}</p>${top ? `<p class="fine">${esc(t('ins.basedOn'))} ${esc(top.obs)}</p>` : ''}</aside></div>` });
  }

  /* ---------- pages */
  function overview() {
    const pf = TableDefs.dimRows('portfolio');
    const top = pf.rows.sort((a, b) => (b.m.adSales || 0) - (a.m.adSales || 0)).slice(0, 6);
    const pfChart = top.length ? Charts.register('hbars', { rows: top.map(r => ({ label: r.id, values: [r.m.adSpend, r.m.adSales], filter: { dim: 'portfolio', value: r.id } })), series: [{ label: I18n.metricLabel('adSpend') }, { label: I18n.metricLabel('adSales') }], fmt: v => I18n.money(v) }) : '';
    return kpiGrid() + trendCard() + insightsPreview() +
      breakdownSection(t('ov.mixKicker'), t('ov.mixTitle'), t('ov.mixSub')) +
      card({ kicker: t('pf.kicker'), title: t('ov.topPortfolios'), sub: t('ov.topPortfoliosSub'), right: `<a class="view-all" href="#portfolio">${esc(t('common.viewAll'))} ↗</a>`, body: `<div class="chart-block">${pfChart || `<div class="chart-empty">${esc(t('common.noData'))}</div>`}</div>${legend([I18n.metricLabel('adSpend'), I18n.metricLabel('adSales')])}` });
  }

  function periodPage(grain) {
    const st = State.get(), n = st.periodCounts[grain];
    const res = TableDefs.periodRows(grain, n);
    const rows = res.rows;
    const chrono = [...rows].reverse();
    const chart = Charts.register('bars', { cats: chrono.map(r => ({ label: grain === 'month' ? I18n.monthShort(r.sortKey) : grain === 'week' ? t('period.wk', { n: Dates.weekNumber(r.sortKey) }) : r.label, full: r.label + (r.sub ? ' · ' + r.sub : '') })),
      series: [{ label: I18n.metricLabel('adSpend'), values: chrono.map(r => r.m.adSpend ?? null) }, { label: I18n.metricLabel('adSales'), values: chrono.map(r => r.m.adSales ?? null) }], fmt: v => I18n.money(v), height: 280,
      extraTip: i => [[null, I18n.metricLabel('roas'), I18n.metric('roas', chrono[i].m.roas)]] });
    const counts = { week: [4, 8, 13, 26, 52], month: [3, 6, 12, 18, 24], quarter: [4, 6, 8], year: [2, 3, 5] }[grain];
    const right = `<label class="inline-ctl">${esc(t('period.show'))} <select id="pc-${grain}" data-pcount="${grain}">${counts.map(c => `<option value="${c}" ${c === n ? 'selected' : ''}>${c}</option>`).join('')}</select> ${esc(t('period.unit.' + grain))}</label>`;
    const table = DataTable.render({ id: 'period-' + grain, columns: TableDefs.defs.period('delta'), rows, pageSize: 25, exportName: `${grain}-over-${grain}`, search: false, caption: t('nav.' + { week: 'wow', month: 'mom', quarter: 'qoq', year: 'yoy' }[grain]) });
    const key = { week: 'wow', month: 'mom', quarter: 'qoq', year: 'yoy' }[grain];
    return kpiGrid() + card({ kicker: t(key + '.kicker'), title: t(key + '.title'), sub: t('period.sub', { unit: t('period.unit1.' + grain), end: I18n.date(State.ranges().cur[1]) }), right,
      body: `${notice(res)}<div class="chart-block">${chart}</div>${legend([I18n.metricLabel('adSpend'), I18n.metricLabel('adSales')])}${table}<p class="print-note">${esc(t('period.note', { unit: t('period.unit1.' + grain) }))}</p>` });
  }

  function lifetime() {
    const L = Reports.lifetime();
    if (!L.bounds) return missing(t('nav.lifetime'), t('source.campaign'));
    const res = Query.run({ filters: State.effectiveFilters(), marketplace: State.get().marketplace, range: null, groupBy: 'month' });
    const keys = [...res.groups.keys()].sort((a, b) => a - b);
    const chart = Charts.register('bars', { cats: keys.map(k => ({ label: I18n.monthShort(k), full: I18n.monthLabel(k) })), series: [{ label: I18n.metricLabel('adSpend'), values: keys.map(k => res.groups.get(k).v.adSpend) }, { label: I18n.metricLabel('adSales'), values: keys.map(k => res.groups.get(k).v.adSales) }], fmt: v => I18n.money(v), height: 280 });
    const row = { label: t('nav.lifetime'), m: L.total?.v || {} };
    const table = DataTable.render({ id: 'lifetime', columns: TableDefs.defs.lifetime(), rows: [row], search: false, exportName: 'lifetime' });
    return card({ kicker: t('lt.kicker'), title: t('lt.title'), sub: t('lt.sub', { range: I18n.range(L.bounds.min, L.bounds.max) }), body: `${notice(L)}${table}<div class="chart-block">${chart}</div>${legend([I18n.metricLabel('adSpend'), I18n.metricLabel('adSales')])}<p class="print-note">${esc(t('lt.note'))}</p>` });
  }

  function dimPage({ kind, kicker, title, sub, chartDim, chartLabel, filterDim, extraTop = '', rowFilter, toolbarExtra, id, reportLabel, hidden }) {
    const res = TableDefs.dimRows(kind);
    if (res.missing || (!res.rows.length && !res.source)) return card({ kicker, title, sub, body: missing(I18n.dim(filterDim), reportLabel) });
    const top = [...res.rows].sort((a, b) => (b.m.adSales || 0) - (a.m.adSales || 0)).slice(0, 10);
    // product-level data can cover less spend than campaign level (e.g. Sponsored Brands has no advertised SKU)
    let coverage = '';
    if (kind === 'asin' && res.total?.v?.adSpend != null) {
      const all = Reports.kpis().cur?.total?.v?.adSpend;
      if (all && res.total.v.adSpend < all * 0.995) coverage = `<div class="notice">${icon('info')}<span>${esc(t('as.coverage', { part: I18n.money(res.total.v.adSpend), all: I18n.money(all), pct: I18n.pct(res.total.v.adSpend / all * 100, 0) }))}</span></div>`;
    }
    const chart = Charts.register('hbars', { rows: top.map(r => ({ label: chartLabel ? chartLabel(r) : r.id, values: [r.m.adSpend, r.m.adSales], filter: { dim: filterDim, value: r.id } })), series: [{ label: I18n.metricLabel('adSpend') }, { label: I18n.metricLabel('adSales') }], fmt: v => I18n.money(v) });
    const table = DataTable.render({ id: id || kind, columns: TableDefs.defs[kind](), rows: res.rows, defaultSort: { key: 'adSales', dir: -1 }, exportName: kind, rowFilter, toolbarExtra, hidden, caption: title });
    return extraTop + card({ kicker, title, sub, right: `<button class="view-all" type="button" data-scroll="dt-${id || kind}">${esc(t('common.viewAll'))} ↗</button>`,
      body: `${notice(res)}${coverage}<div class="chart-block">${chart}</div>${legend([I18n.metricLabel('adSpend'), I18n.metricLabel('adSales')])}<p class="fine pad-x">${esc(t('common.clickToFilter'))}</p>${table}` });
  }

  function keywords() {
    const st = State.get();
    const tr = Reports.breakdown('matchType', 'adSpend'), sales = Reports.breakdown('matchType', 'adSales');
    const eff = Reports.byDim('matchType');
    const donut = (res, metric, title) => `<div class="donut-card"><h3>${esc(title)}</h3>${Charts.register('donut', { segs: res.segs, dim: 'matchType', center: I18n.metric(metric, res.total), centerLabel: t('common.total'), fmt: fmtFor(metric), metricLabel: I18n.metricLabel(metric) })}</div>`;
    const order = tr.segs.map(s => s.label);
    const effRows = order.map(l => eff.rows.find(r => r.id === l)).filter(Boolean);
    const roasBars = `<div class="donut-card"><h3>${esc(t('kw.roasByType'))}</h3>${Charts.register('hbars', { rows: effRows.map(r => ({ label: r.id, values: [r.m.roas], filter: { dim: 'matchType', value: r.id } })), series: [{ label: I18n.metricLabel('roas'), ci: 2 }], fmt: v => I18n.num(v, 2) })}<p class="fine">${esc(t('kw.blended', { roas: I18n.metric('roas', eff.total?.v.roas) }))}</p></div>`;
    const mix = tr.source ? card({ kicker: t('kw.mixKicker'), title: t('kw.mixTitle'), sub: t('kw.mixSub'), body: `${notice(tr)}<div class="donut-grid">${donut(tr, 'adSpend', t('kw.spendMix'))}${donut(sales, 'adSales', t('kw.salesMix'))}${roasBars}</div>` }) : '';
    return mix + dimPage({ kind: 'keyword', kicker: t('kw.kicker'), title: t('kw.title'), sub: t('kw.sub'), filterDim: 'keyword', chartLabel: r => `${r.id} · ${r.matchType}`, reportLabel: t('source.keyword'), hidden: ['keywordType'] });
  }

  function searchTerms() {
    const res = TableDefs.dimRows('searchTerm');
    const counts = Object.fromEntries(SEGMENTS.map(s => [s, res.rows.filter(r => r.signals?.includes(s)).length]));
    const segBar = `<div class="seg-chips" role="group" aria-label="${esc(t('st.segments'))}"><button type="button" class="chip ${!local.segment ? 'on' : ''}" data-segment="">${esc(t('common.all'))} <b>${I18n.int(res.rows.length, false)}</b></button>${SEGMENTS.map(s => `<button type="button" class="chip sig-${s} ${local.segment === s ? 'on' : ''}" data-segment="${s}" title="${esc(t('seg.' + s + '.hint'))}">${esc(t('seg.' + s))} <b>${counts[s]}</b></button>`).join('')}</div>`;
    return dimPage({ kind: 'searchTerm', kicker: t('st.kicker'), title: t('st.title'), sub: t('st.sub'), filterDim: 'searchTerm', reportLabel: t('source.searchTerm'),
      rowFilter: local.segment ? r => r.signals?.includes(local.segment) : null, toolbarExtra: '', id: 'searchTerm',
      extraTop: card({ kicker: t('st.segKicker'), title: t('st.segTitle'), sub: t('st.segSub'), body: `<div class="pad">${segBar}<p class="fine">${esc(t('st.thresholds'))}</p></div>` }), hidden: ['searchIs'] });
  }

  function products() {
    const rollup = (dim, i) => {
      const res = TableDefs.dimRows(dim);
      if (!res.rows.length) return '';
      return card({ kicker: t('pp.kicker'), title: t('pp.by', { dim: I18n.dim(dim) }), sub: t('pp.sub'),
        body: `<div class="split-2"><div class="donut-card flat">${Charts.register('donut', { segs: res.rows.map(r => ({ label: r.id, value: r.m.adSales || 0 })).sort((a, b) => b.value - a.value), dim, center: I18n.money(res.total.v.adSales), centerLabel: I18n.metricLabel('adSales'), fmt: v => I18n.money(v), metricLabel: I18n.metricLabel('adSales') })}</div>
        <div>${Charts.register('hbars', { rows: [...res.rows].sort((a, b) => (b.m.roas || 0) - (a.m.roas || 0)).map(r => ({ label: r.id, values: [r.m.roas], filter: { dim, value: r.id } })), series: [{ label: I18n.metricLabel('roas'), ci: 2 }], fmt: v => I18n.num(v, 2) })}<p class="fine pad-x">${esc(t('pp.roasNote'))}</p></div></div>
        ${DataTable.render({ id: 'roll-' + dim, columns: TableDefs.defs.rollup(dim), rows: res.rows, defaultSort: { key: 'adSales', dir: -1 }, exportName: 'by-' + dim, search: false })}` });
    };
    const out = rollup('brand') + rollup('category') + rollup('asinStatus');
    return out || card({ kicker: t('pp.kicker'), title: t('nav.products'), body: missing(I18n.dim('brand'), t('source.asin')) });
  }

  function insights() {
    const list = Insights.build();
    const kinds = ['all', ...new Set(list.map(i => i.kind))];
    const shown = local.insightKind === 'all' ? list : list.filter(i => i.kind === local.insightKind);
    const recs = [...new Set(list.filter(i => i.rec).map(i => i.rec))];
    const ai = local.aiState;
    const aiBlock = `<aside class="takeaway-box"><h3>${icon('sparkles')} ${esc(t('ai.title'))}</h3><p>${esc(t('ai.sub'))}</p>
      <div id="ai-out" class="ai-out" aria-live="polite">${local.aiText ? esc(local.aiText) : ai === 'thinking' ? esc(t('ai.thinking')) : ''}</div>
      <div class="row-gap"><button type="button" class="action-btn compare" data-ai="run" ${ai === 'thinking' || ai === 'unavailable' || !list.length ? 'disabled' : ''}>${icon('sparkles')}${esc(ai === 'done' ? t('ai.again') : t('ai.run'))}</button>${ai === 'thinking' ? `<button type="button" class="action-btn" data-ai="stop">${esc(t('ai.stop'))}</button>` : ''}</div>
      ${ai === 'unavailable' ? `<p class="fine">${esc(t('ai.unavailable'))}</p>` : `<p class="fine">${esc(t('ai.grounding'))}</p>`}</aside>`;
    return kpiGrid() + card({ kicker: t('ins.kicker'), title: t('ins.title'), sub: t('ins.subFull'),
      right: seg('ikind', kinds.map(k => [k, k === 'all' ? t('common.all') : t('kind.' + k)]), local.insightKind),
      body: `<div class="insight-layout"><div class="insight-list">${shown.length ? insightItems(shown, 50) : `<p class="muted">${esc(t('ins.none'))}</p>`}</div>
        <div class="stack">${aiBlock}<aside class="takeaway-box alt"><h3>${esc(t('ins.recommendations'))}</h3>${recs.length ? `<ol class="rec-list">${recs.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : `<p>${esc(t('ins.noRecs'))}</p>`}</aside></div></div>` });
  }

  function reports() {
    const canX = State.can('export');
    const csvOpts = ['campaign', 'portfolio', 'placement', 'keyword', 'searchTerm', 'asin'];
    const tile = (ic, title, desc, act, extra = '') => `<div class="export-tile">${icon(ic, 'big')}<h3>${esc(title)}</h3><p>${esc(desc)}</p>${extra}<button type="button" class="action-btn ${act === 'ppt' ? 'export' : ''}" data-act="${act}" ${canX ? '' : 'disabled'}>${icon('download')}${esc(t('exp.generate'))}</button></div>`;
    const csvTile = `<div class="export-tile">${icon('csv', 'big')}<h3>${esc(t('exp.csvTitle'))}</h3><p>${esc(t('exp.csvDesc'))}</p>
      <select id="csv-report" class="period-select">${csvOpts.map(o => `<option value="${o}" ${local.csvReport === o ? 'selected' : ''}>${esc(t('source.' + o))}</option>`).join('')}</select>
      <button type="button" class="action-btn" data-csv-export ${canX ? '' : 'disabled'}>${icon('download')}${esc(t('exp.generate'))}</button></div>`;
    return card({ kicker: t('exp.kicker'), title: t('exp.title'), sub: t('exp.sub', { range: App.filterSummary() || t('common.none') }),
      body: `${canX ? '' : `<div class="notice">${icon('lock')}<span>${esc(t('role.noExport'))}</span></div>`}<div class="export-grid">
        ${tile('ppt', t('exp.pptTitle'), t('exp.pptDesc'), 'ppt')}
        ${tile('xls', t('exp.xlsxTitle'), t('exp.xlsxDesc'), 'xlsx')}
        ${tile('pdf', t('exp.pdfTitle'), t('exp.pdfDesc'), 'pdf')}
        ${csvTile}</div><p class="print-note">${esc(t('exp.note'))}</p>` });
  }

  function settings() {
    const st = State.get(), canS = State.can('settings');
    const lang = `<div class="set-row"><label for="set-lang">${esc(t('set.language'))}</label><select id="set-lang" class="period-select">${Object.entries(Config.LANGS).map(([c, n]) => `<option value="${c}" ${st.lang === c ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><span class="fine">${esc(t('set.localeNote', { locale: I18n.locale(), currency: I18n.currency() }))}</span></div>`;
    const files = DataStore.files.map(f => `<tr><td class="txt">${esc(f.name)}${f.demo ? ` <span class="demo-badge sm">${esc(t('demo.label'))}</span>` : ''}</td><td class="txt">${esc(f.source === 'all' ? t('source.all') : t('source.' + f.source))}</td><td class="num">${I18n.int(f.rows, false)}</td><td class="txt">${isFinite(f.minDay) ? esc(I18n.range(f.minDay, f.maxDay)) : '—'}</td><td class="txt">${esc(new Date(f.importedAt).toLocaleString(I18n.locale()))}</td><td>${(canS || State.can('import')) && !(f.demo && Api.enabled) ? `<button type="button" class="icon-btn" data-rm-file="${esc(f.id)}" aria-label="${esc(t('set.remove'))}">${icon('trash')}</button>` : ''}</td></tr>`).join('');
    const data = `<div class="set-actions">${State.can('import') ? `<button type="button" class="action-btn export" data-act="import">${icon('upload')}${esc(t('hdr.import'))}</button>` : ''}<button type="button" class="action-btn" data-template>${icon('download')}${esc(t('set.template'))}</button>${!DataStore.isDemo && canS && !Api.enabled ? `<button type="button" class="action-btn" data-reset-demo>${icon('refresh')}${esc(t('set.resetDemo'))}</button>` : ''}</div>
      <p class="fine">${icon(Api.enabled ? 'database' : 'info')} ${esc(Api.enabled ? t('api.storageServer') : t('api.storageBrowser'))}</p>
      <div class="table-frame static"><table class="detail-table"><thead><tr><th class="txt">${esc(t('set.file'))}</th><th class="txt">${esc(t('set.report'))}</th><th class="num">${esc(t('set.rows'))}</th><th class="txt">${esc(t('set.dates'))}</th><th class="txt">${esc(t('set.imported'))}</th><th></th></tr></thead><tbody>${files || `<tr><td colspan="6" class="empty-row">${esc(t('common.noData'))}</td></tr>`}</tbody></table></div>`;
    const syn = Object.keys(Config.FIELD_SYNONYMS).filter(f => f !== 'entity');
    const mapping = `<p class="fine">${esc(t('set.mappingHelp'))}</p><div class="table-frame static tall"><table class="detail-table"><thead><tr><th class="txt">${esc(t('set.field'))}</th><th class="txt">${esc(t('set.builtin'))}</th><th class="txt">${esc(t('set.custom'))}</th></tr></thead><tbody>${syn.map(f => `<tr><td class="txt"><strong>${esc(t('field.' + f))}</strong><br><code>${f}</code></td><td class="txt wrap"><span class="fine">${esc(Config.FIELD_SYNONYMS[f].join(', '))}</span></td><td class="txt"><input class="text-in" id="syn-${f}" data-syn="${f}" value="${esc((st.synonyms[f] || []).join(', '))}" placeholder="${esc(t('set.synPlaceholder'))}" ${canS ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div>`;
    const kwc = `<div class="set-row"><label for="set-brand">${esc(t('set.brandTerms'))}</label><input id="set-brand" class="text-in" data-setting="brandTerms" value="${esc(st.brandTerms)}" ${canS ? '' : 'disabled'}></div>
      <div class="set-row"><label for="set-comp">${esc(t('set.compTerms'))}</label><input id="set-comp" class="text-in" data-setting="competitorTerms" value="${esc(st.competitorTerms)}" ${canS ? '' : 'disabled'}></div><p class="fine">${esc(t('set.kwHelp'))}</p>`;
    const allAccts = DataStore.distinct('account');
    const roles = `<div class="set-row"><label for="set-role">${esc(t('set.role'))}</label><select id="set-role" class="period-select">${Object.keys(Config.ROLES).map(r => `<option value="${r}" ${st.role === r ? 'selected' : ''}>${esc(t('role.' + r))}</option>`).join('')}</select></div>
      <div class="role-grid">${Object.entries(Config.ROLES).map(([r, p]) => `<div class="role-card ${st.role === r ? 'on' : ''}"><strong>${esc(t('role.' + r))}</strong><p>${esc(t('role.' + r + '.desc'))}</p><ul>${['import', 'export', 'settings', 'allAccounts'].map(k => `<li class="${p[k] ? 'yes' : 'no'}">${icon(p[k] ? 'check' : 'x')}${esc(t('perm.' + k))}</li>`).join('')}</ul></div>`).join('')}</div>
      ${st.role === 'manager' ? `<div class="set-row"><span class="lbl-inline">${esc(t('set.assigned'))}</span><div class="chk-row">${allAccts.map(a => `<label class="chk"><input type="checkbox" data-assign value="${esc(a)}" ${st.assignedAccounts.includes(a) ? 'checked' : ''}> ${esc(a)}</label>`).join('')}</div></div>` : ''}
      <p class="fine">${esc(t('set.roleNote'))}</p>`;
    const defs = `<div class="table-frame static tall"><table class="detail-table"><thead><tr><th class="txt">${esc(t('col.metric'))}</th><th class="txt">${esc(t('exp.formula'))}</th><th class="txt">${esc(t('exp.direction'))}</th><th class="txt">${esc(t('set.availability'))}</th></tr></thead><tbody>${Object.values(Config.METRICS).map(m => `<tr><td class="txt"><strong>${esc(I18n.metricLabel(m.key))}</strong></td><td class="txt wrap">${esc(t('def.' + m.key))}</td><td class="txt"><span class="dir d-${m.dir}">${esc(t('dir.' + m.dir))}</span></td><td class="txt">${esc(m.adTypes ? m.adTypes.join(', ') : t('set.allTypes'))}</td></tr>`).join('')}</tbody></table></div>`;
    const arch = `<div class="arch">${['presentation', 'state', 'processing', 'metrics', 'filters', 'charts', 'export', 'import', 'validation'].map(k => `<div class="arch-layer"><strong>${esc(t('arch.' + k))}</strong><p>${esc(t('arch.' + k + '.desc'))}</p></div>`).join('')}</div><p class="fine">${esc(t('arch.prod'))}</p>`;
    const sec = (title, body, id) => `<section class="set-sec" id="${id}"><h3>${esc(title)}</h3>${body}</section>`;
    return card({ kicker: t('set.kicker'), title: t('set.title'), sub: canS ? t('set.sub') : t('set.readOnly'),
      body: `<div class="settings">${sec(t('set.langTitle'), lang, 's-lang')}${sec(t('set.dataTitle'), data, 's-data')}${sec(t('set.rolesTitle'), roles, 's-roles')}${sec(t('set.kwTitle'), kwc, 's-kw')}${sec(t('set.mappingTitle'), mapping, 's-map')}${sec(t('set.defsTitle'), defs, 's-defs')}${sec(t('set.archTitle'), arch, 's-arch')}</div>` });
  }

  const ROUTES = {
    overview, lifetime, keywords, insights, reports, settings, products,
    wow: () => periodPage('week'), mom: () => periodPage('month'), qoq: () => periodPage('quarter'), yoy: () => periodPage('year'),
    portfolio: () => kpiGrid(['adSpend', 'adSales', 'roas', 'acos']) + dimPage({ kind: 'portfolio', kicker: t('pf.kicker'), title: t('pf.title'), sub: t('pf.sub'), filterDim: 'portfolio', reportLabel: t('source.campaign') }),
    campaigns: () => kpiGrid(['adSpend', 'adSales', 'roas', 'acos']) + dimPage({ kind: 'campaign', kicker: t('cp.kicker'), title: t('cp.title'), sub: t('cp.sub'), filterDim: 'campaign', reportLabel: t('source.campaign'), hidden: ['campaignType', 'budget', 'budgetUtil', 'tosIs'] }),
    placements: () => kpiGrid(['adSpend', 'adSales', 'roas', 'acos']) + dimPage({ kind: 'placement', kicker: t('pl.kicker'), title: t('pl.title'), sub: t('pl.sub'), filterDim: 'placement', reportLabel: t('source.placement') }),
    'search-terms': searchTerms,
    asins: () => dimPage({ kind: 'asin', kicker: t('as.kicker'), title: t('as.title'), sub: t('as.sub'), filterDim: 'asin', chartLabel: r => `${r.id} · ${(r.title || '').slice(0, 26)}`, reportLabel: t('source.asin'), hidden: ['brand', 'category'] }),
  };
  function render(route) {
    if (!DataStore.available().length) return card({ kicker: t('app.eyebrow'), title: t('empty.noDataTitle'), body: missing(t('common.data'), t('source.any')) });
    try { return (ROUTES[route] || overview)(); }
    catch (e) { console.error(e); return `<div class="notice error">${icon('error')}<span>${esc(t('common.renderError'))}: ${esc(e.message)}</span></div>`; }
  }

  /* ---------- optional Claude summary (sample capability, viewer's own account) */
  let aiCtl = null;
  async function runAI() {
    const sample = window.claude ? await window.claude.use('sample').catch(() => null) : null;
    if (!sample) { local.aiState = 'unavailable'; App.render(); return; }
    local.aiState = 'thinking'; local.aiText = null; App.render();
    aiCtl = new AbortController();
    const facts = Insights.factSheet(Insights.build());
    const prompt = `You are writing an executive summary of Amazon Ads performance for leadership.\nUse ONLY the facts in the JSON below. Do not invent numbers, causes, or entities. If something is not in the facts, do not mention it.\nWrite 4-6 short bullet points (start each with "• "), then one line starting "Next step:" that restates the single most important recommendation from the facts. Plain text, no markdown headers.\nWrite in this language: ${Config.LANGS[State.get().lang]}.\n\nFACTS:\n${JSON.stringify(facts)}`;
    try {
      const { text } = await sample(prompt, { signal: aiCtl.signal, cache: { gcTime: 10 * 60 * 1000 }, onText: ({ text }) => { local.aiText = text; const el = document.getElementById('ai-out'); if (el) el.textContent = text; } });
      local.aiText = text; local.aiState = 'done';
    } catch (e) {
      local.aiText = e.text || null;
      local.aiState = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code) ? 'unavailable' : 'idle';
      if (e.code && e.code !== 'cancelled' && local.aiState !== 'unavailable') App.toast(t('ai.failed'), 'error');
    }
    App.render();
  }

  function init() {
    document.addEventListener('click', e => {
      const g = e.target.closest('[data-grain]'); if (g) { State.set({ trendGrain: g.dataset.grain }); return; }
      const ef = e.target.closest('[data-eff]'); if (ef) { local.effMetric = ef.dataset.eff; App.render(); return; }
      const sg = e.target.closest('[data-segment]'); if (sg) { local.segment = sg.dataset.segment || null; App.render(); return; }
      const ik = e.target.closest('[data-ikind]'); if (ik) { local.insightKind = ik.dataset.ikind; App.render(); return; }
      const ai = e.target.closest('[data-ai]'); if (ai) { if (ai.dataset.ai === 'run') runAI(); else aiCtl?.abort(); return; }
      const sc = e.target.closest('[data-scroll]'); if (sc) { document.getElementById(sc.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (e.target.closest('[data-csv-export]')) { const kind = document.getElementById('csv-report').value; local.csvReport = kind; const res = TableDefs.dimRows(kind), cols = TableDefs.defs[kind](); Exporter.csv(`amazon-ads-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, cols.flatMap(c => c.sub === 'share' ? [c.label, c.label + ' %'] : [c.label]), res.rows.map(r => cols.flatMap(c => { const v = TableDefs.exportValue(c, r); const base = v == null ? (c.kind === 'metric' ? 'N/A' : '') : v; return c.sub === 'share' ? [base, r.share?.[c.metric] ?? ''] : [base]; }))); return; }
      if (e.target.closest('[data-template]')) { const rows = ImportService.template(); Exporter.csv('amazon-ads-import-template.csv', rows[0], rows.slice(1)); return; }
      const rf = e.target.closest('[data-rm-file]');
      if (rf) {
        const id = rf.dataset.rmFile;
        if (!rf.dataset.confirm) { rf.dataset.confirm = '1'; rf.classList.add('confirm'); rf.innerHTML = esc(t('set.confirmRemove')); return; }
        (async () => {
          try {
            if (Api.enabled && id !== 'demo') { await Api.remove(id); await Api.loadData(); }
            else DataStore.removeFile(id);
            if (!DataStore.available().length) DemoData.generate();
            DataStore.persist(); App.toast(t('set.removed')); State.schedule();
          } catch (err) { App.toast(err.message, 'error'); }
        })();
        return;
      }
      if (e.target.closest('[data-reset-demo]')) { DataStore.reset(); DemoData.generate(); DataStore.persist(); State.set({ marketplace: 'US', date: { ...State.get().date, preset: 'mtd' } }); App.toast(t('set.demoRestored')); return; }
    });
    document.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset.bd) { const i = +el.dataset.bd, b = [...State.get().breakdowns]; b[i] = { ...b[i], [el.dataset.bdKind]: el.value }; State.set({ breakdowns: b }); }
      if (el.dataset.pcount) State.set({ periodCounts: { ...State.get().periodCounts, [el.dataset.pcount]: +el.value } });
      if (el.id === 'set-lang') State.set({ lang: el.value });
      if (el.id === 'set-role') State.set({ role: el.value, assignedAccounts: el.value === 'manager' && !State.get().assignedAccounts.length ? DataStore.distinct('account').slice(0, 1) : State.get().assignedAccounts, filters: { ...State.get().filters, account: [] } });
      if (el.dataset.assign !== undefined) { const cur = new Set(State.get().assignedAccounts); el.checked ? cur.add(el.value) : cur.delete(el.value); State.set({ assignedAccounts: [...cur] }); }
      if (el.dataset.syn) { const syn = { ...State.get().synonyms, [el.dataset.syn]: el.value.split(',').map(s => s.trim()).filter(Boolean) }; State.set({ synonyms: syn }, { silent: true }); App.toast(t('set.saved')); }
      if (el.dataset.setting) { State.set({ [el.dataset.setting]: el.value }, { silent: true }); App.toast(t('set.savedKw')); }
      if (el.id === 'csv-report') local.csvReport = el.value;
    });
  }
  return { render, init };
})();
