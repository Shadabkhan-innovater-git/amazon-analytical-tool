/* ==========================================================================
   TABLE DEFINITIONS — reusable column sets shared by on-screen tables and
   the Excel / PPT / PDF exports, so every surface shows the same report.
   ========================================================================== */
const TableDefs = (() => {
  const M = (metric, sub = null, extra = {}) => ({ key: metric, kind: 'metric', metric, sub, get label() { return I18n.metricLabel(metric); }, ...extra });
  const Dm = (key, extra = {}) => ({ key, kind: 'dim', get label() { return I18n.dim(key); }, ...extra });
  const PERIOD_METRICS = ['adSpend', 'adSales', 'impressions', 'clicks', 'ctr', 'cpc', 'orders', 'units', 'cvr', 'acos', 'roas', 'dpv', 'sameSkuSales', 'otherSkuSales', 'ntbOrders', 'ntbSales'];
  const STD = ['impressions', 'clicks', 'ctr', 'cpc', 'orders', 'units', 'cvr', 'acos', 'roas'];
  const adTypeBadge = r => `<span class="badge ad-${esc(r.adType)}">${esc(r.adType)}</span>`;
  const statusBadge = r => `<span class="status s-${esc((r.asinStatus || '').replace(/\s/g, ''))}">${esc(t('status.' + r.asinStatus))}</span>`;

  const defs = {
    period: sub => [
      { key: 'label', kind: 'dim', get label() { return t('col.period'); }, value: r => r.sortKey, render: r => `<span class="cell-main">${esc(r.label)}${r.partial ? ` <span class="pill-mini">${esc(t('common.partial'))}</span>` : ''}</span><span class="cell-sub">${esc(r.sub || '')}</span>`, exportValue: r => r.label },
      ...PERIOD_METRICS.map(k => M(k, sub)),
    ],
    lifetime: () => [{ key: 'label', kind: 'dim', get label() { return t('col.period'); } }, ...PERIOD_METRICS.map(k => M(k))],
    portfolio: () => [Dm('portfolio'), M('adSpend', 'share'), M('adSales', 'share'), M('roas'), M('acos'), M('impressions'), M('clicks'), M('ctr'), M('cpc'), M('orders'), M('units'), M('cvr')],
    campaign: () => [Dm('campaign'), Dm('adType', { get label() { return t('col.campaignType'); }, render: adTypeBadge }), Dm('targeting'), Dm('portfolio'), Dm('campaignType', { get label() { return t('col.format'); } }),
      M('adSpend', 'share'), M('adSales', 'share'), ...STD.map(k => M(k)), M('budget'), M('budgetUtil'), M('tosIs')],
    placement: () => [Dm('placement'), M('adSpend', 'share'), M('adSales', 'share'), ...STD.map(k => M(k))],
    keyword: () => [Dm('keyword'), Dm('matchType'), Dm('campaign'), Dm('portfolio'), Dm('keywordType'), M('adSpend', 'share'), M('adSales', 'share'), ...STD.map(k => M(k))],
    searchTerm: signal => [Dm('searchTerm'), Dm('keyword'), Dm('matchType'), Dm('campaign'),
      { key: 'signal', kind: 'dim', get label() { return t('col.signal'); }, value: r => (r.signals || []).join(', '), render: r => (r.signals || []).map(s => `<span class="sig sig-${s}">${esc(t('seg.' + s))}</span>`).join(' ') || '<span class="muted">—</span>', exportValue: r => (r.signals || []).map(s => t('seg.' + s)).join('; ') },
      M('adSpend', 'share'), M('adSales', 'share'), M('orders'), M('units'), M('clicks'), M('ctr'), M('cvr'), M('acos'), M('roas'), M('searchIs')],
    asin: () => [Dm('asin'), Dm('title', { get label() { return t('col.title'); } }), Dm('brand'), Dm('category'), Dm('portfolio'),
      Dm('asinStatus', { render: statusBadge, exportValue: r => t('status.' + r.asinStatus) }),
      M('adSpend', 'share'), M('adSales', 'share'), M('impressions'), M('clicks'), M('ctr'), M('cpc'), M('orders'), M('units'), M('cvr'), M('acos'), M('roas'),
      growthCol('adSales', 'col.salesGrowth'), growthCol('adSpend', 'col.spendGrowth'), growthCol('orders', 'col.ordersGrowth')],
    rollup: dim => [Dm(dim), M('adSpend', 'share'), M('adSales', 'share'), M('roas'), M('acos'), M('orders'), M('units'), M('cvr'), M('cpc'), M('ctr')],
  };
  function growthCol(metric, label) {
    const val = r => { const ch = r.prev ? Metrics.change(metric, r.m[metric], r.prev[metric]) : null; return ch ? ch.pct : null; };
    return { key: 'g_' + metric, kind: 'metric', get label() { return t(label); }, value: val,
      render: r => r.prev === undefined ? '<span class="muted">—</span>' : Fmt.deltaHTML(metric, r.m[metric], r.prev ? r.prev[metric] : null), exportValue: val };
  }
  /* composite groupings (1:1 attributes ride along so no joins are needed) */
  const GROUPS = {
    portfolio: 'portfolio', placement: 'placement',
    campaign: 'campaign+adType+targeting+portfolio+campaignType',
    keyword: 'keyword+matchType+campaign+portfolio+keywordType',
    searchTerm: 'searchTerm+keyword+matchType+campaign',
    asin: 'asin+title+brand+category+portfolio+asinStatus',
  };
  /* row builders shared by views and exports */
  function periodRows(grain, n) {
    const res = Reports.periods(grain, n);
    return { ...res, rows: res.rows.map(r => ({ label: r.label, sub: r.sub, partial: r.partial, sortKey: r.key, m: r.cur ? r.cur.v : {}, prev: r.prev ? r.prev.v : null })) };
  }
  function dimRows(kind) {
    const res = Reports.byDim(GROUPS[kind] || kind);
    if (kind === 'searchTerm') tagSearchTerms(res);
    return res;
  }
  /* Search-term signals — thresholds relative to the filtered account average */
  function tagSearchTerms(res) {
    const rows = res.rows; if (!rows.length) return;
    const avg = res.total.v, C = Config.INSIGHTS;
    const q = (arr, p) => { const s = arr.filter(v => v != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)] : 0; };
    const sp75 = q(rows.map(r => r.m.adSpend), 0.75), sp50 = q(rows.map(r => r.m.adSpend), 0.5), sa75 = q(rows.map(r => r.m.adSales), 0.75);
    rows.forEach(r => {
      const s = [], v = r.m, enough = (v.clicks || 0) >= 10;
      if (v.adSpend >= sp75 && (v.roas ?? 0) < avg.roas * C.lowRoasFactor) s.push('highSpendLowSales');
      if ((v.adSales || 0) >= sa75 && v.adSpend <= sp50) s.push('highSalesLowSpend');
      if (enough && v.roas != null && v.roas >= avg.roas * C.highRoasFactor) s.push('highRoas');
      if (enough && (v.roas ?? 0) < avg.roas * C.lowRoasFactor) s.push('lowRoas');
      if (enough && v.cvr != null && v.cvr >= avg.cvr * C.highRoasFactor) s.push('highCvr');
      if (enough && (v.cvr ?? 0) <= avg.cvr * C.lowRoasFactor) s.push('lowCvr');
      r.signals = s;
    });
  }
  /* exports carry clean numbers: money/counts to 2 dp, rates and ratios to 4 dp */
  function rnd(key, v) {
    if (typeof v !== 'number' || !isFinite(v)) return v;
    const f = Config.METRICS[key]?.fmt;
    return f === 'pct' || f === 'ratio' || !f ? Math.round(v * 1e4) / 1e4 : Math.round(v * 100) / 100;
  }
  function exportValue(col, row) {
    if (col.exportValue) return rnd(null, col.exportValue(row));
    if (col.value) return rnd(null, col.value(row));
    if (col.kind === 'metric') return row.m ? rnd(col.metric, row.m[col.metric]) : null;
    return row[col.key];
  }
  return { defs, GROUPS, PERIOD_METRICS, periodRows, dimRows, exportValue, rnd };
})();
