/* ==========================================================================
   STATE — one global store. Every component reads from here; nothing keeps
   its own copy of filters, dates or comparison settings.
   ========================================================================== */
const State = (() => {
  const listeners = new Set();
  const s = {
    route: 'overview',
    lang: 'en',
    role: 'admin',
    assignedAccounts: [],
    marketplace: 'US',
    filters: Object.fromEntries(Config.FILTER_DIMS.map(d => [d, []])),
    date: { preset: 'mtd', start: null, end: null, compareMode: 'previous', cStart: null, cEnd: null },
    compareOn: true,
    filterPanelOpen: false,
    trendGrain: 'auto',
    breakdowns: [
      { metric: 'adSpend', dim: 'matchType' },
      { metric: 'adSales', dim: 'matchType' },
      { metric: 'adSpend', dim: 'adType' },
    ],
    periodCounts: { week: 13, month: 12, quarter: 8, year: 3 },
    synonyms: {},        // user additions to Config.FIELD_SYNONYMS
    brandTerms: 'veltra',
    competitorTerms: 'halden, carewell',
  };
  let scheduled = false;

  function get() { return s; }
  function set(patch, opts = {}) {
    for (const k of Object.keys(patch)) s[k] = patch[k];
    if (!opts.silent) schedule();
    savePrefs();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; listeners.forEach(fn => fn(s)); });
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ---- filters */
  function toggleFilter(dim, value) {
    const cur = s.filters[dim] || [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    set({ filters: { ...s.filters, [dim]: next } });
  }
  function setFilter(dim, values) { set({ filters: { ...s.filters, [dim]: values } }); }
  function clearFilters() { set({ filters: Object.fromEntries(Config.FILTER_DIMS.map(d => [d, []])) }); }
  function activeFilterCount() { return Object.values(s.filters).reduce((a, v) => a + (v.length ? 1 : 0), 0); }

  /* filters as the query engine sees them (role restrictions applied) */
  function effectiveFilters() {
    const f = { ...s.filters };
    if (!Config.ROLES[s.role].allAccounts) {
      const allowed = s.assignedAccounts;
      f.account = f.account.length ? f.account.filter(a => allowed.includes(a)) : [...allowed];
      if (!f.account.length) f.account = ['__none__'];
    }
    return f;
  }
  function can(perm) { return !!Config.ROLES[s.role][perm]; }

  /* ---- dates */
  function ranges() {
    const b = DataStore.bounds();
    if (!b) return { cur: null, cmp: null, ref: null, bounds: null };
    const d = s.date;
    let cur;
    if (d.preset === 'custom' && d.start != null) cur = [d.start, d.end];
    else cur = Dates.presetById(d.preset === 'custom' ? 'mtd' : d.preset).calc(b.max, b);
    const cmp = s.compareOn ? Dates.comparison(d.compareMode, cur[0], cur[1], d.preset, [d.cStart, d.cEnd]) : null;
    return { cur, cmp, ref: b.max, bounds: b };
  }

  /* ---- per-viewer preferences (localStorage, best-effort) */
  const PREF_KEYS = ['lang', 'role', 'assignedAccounts', 'marketplace', 'date', 'compareOn', 'breakdowns', 'periodCounts', 'synonyms', 'brandTerms', 'competitorTerms', 'trendGrain'];
  function savePrefs() {
    try { localStorage.setItem('ads-intel-prefs', JSON.stringify(Object.fromEntries(PREF_KEYS.map(k => [k, s[k]])))); } catch { }
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('ads-intel-prefs') || 'null');
      if (p) PREF_KEYS.forEach(k => { if (p[k] !== undefined) s[k] = p[k]; });
    } catch { }
  }

  return { get, set, subscribe, schedule, toggleFilter, setFilter, clearFilters, activeFilterCount, effectiveFilters, can, ranges, loadPrefs };
})();

/* ==========================================================================
   REPORTING SERVICE — the queries every view AND every export use.
   Views never talk to Query directly, so a table on screen and the same
   table in Excel/PPT are guaranteed to match.
   ========================================================================== */
const Reports = (() => {
  const base = () => { const st = State.get(); return { filters: State.effectiveFilters(), marketplace: st.marketplace }; };

  function totals(range) { return Query.run({ ...base(), range, groupBy: null }); }

  function kpis() {
    const { cur, cmp } = State.ranges();
    const c = totals(cur), p = cmp ? totals(cmp) : null;
    return { cur: c, prev: p, range: cur, cmpRange: cmp };
  }

  /* trend series for charts */
  function trend(grain) {
    const { cur } = State.ranges();
    if (!cur) return null;
    const g = grain === 'auto' || !grain ? Dates.autoGrain(cur[0], cur[1]) : grain;
    const res = Query.run({ ...base(), range: cur, groupBy: g });
    const keys = [];
    const G = Dates.GRAINS[g];
    for (let k = G.key(cur[0]); k <= cur[1]; k = G.end(k) + 1) keys.push(k);
    return { grain: g, keys, groups: res.groups, source: res.source, unapplied: res.unapplied || [] };
  }

  /* WoW / MoM / QoQ / YoY rows: last N periods ending at the selected range end */
  function periods(grain, n) {
    const { cur, bounds } = State.ranges();
    if (!cur) return { rows: [] };
    const keys = Dates.periodKeys(grain, cur[1], n + 1);
    const G = Dates.GRAINS[grain];
    const span = [G.start(keys[0]), G.end(keys[keys.length - 1])];
    const res = Query.run({ ...base(), range: [span[0], Math.min(span[1], cur[1])], groupBy: grain });
    const rows = [];
    for (let i = keys.length - 1; i >= 1; i--) {
      const k = keys[i], prevK = keys[i - 1];
      const d = res.groups.get(k), pd = res.groups.get(prevK);
      const sub = Dates.periodSub(grain, k, { min: bounds.min, max: Math.min(bounds.max, cur[1]) });
      let prev = pd || null;
      // a period cut short by the range end is compared like-for-like (same number of days)
      const endCut = Math.min(bounds.max, cur[1]);
      if (sub.partial && G.end(k) > endCut && G.start(k) <= endCut) {
        const len = endCut - G.start(k), ps = G.start(prevK);
        prev = Query.run({ ...base(), range: [ps, Math.min(ps + len, G.end(prevK))], groupBy: null }).total;
      }
      rows.push({ key: k, label: Dates.periodLabel(grain, k), sub: sub.range, partial: sub.partial, cur: d || null, prev });
    }
    return { rows, source: res.source, unapplied: res.unapplied || [] };
  }

  function lifetime() {
    const b = DataStore.bounds();
    const res = totals(null);
    return { total: res.total, bounds: b, source: res.source, unapplied: res.unapplied || [] };
  }

  /* dimension table: current + comparison, share of total, attributes */
  /* group = 'campaign' or composite 'keyword+matchType+campaign+portfolio' (1:1 attributes ride along in the key) */
  function byDim(group) {
    const dims = group.split('+');
    const { cur, cmp } = State.ranges();
    const c = Query.run({ ...base(), range: cur, groupBy: group });
    if (c.empty && !c.groups.size) return { rows: [], missing: c.missingDim ? dims[0] : null, total: c.total, source: c.source, unapplied: c.unapplied || [] };
    const p = cmp ? Query.run({ ...base(), range: cmp, groupBy: group }) : null;
    const tot = c.total?.v || {};
    const rows = [];
    for (const [label, g] of c.groups) {
      const parts = String(label).split('\u0001');
      if (!parts[0]) continue;
      const pg = p?.groups.get(label);
      rows.push({
        id: parts[0], key: label, ...Object.fromEntries(dims.map((d, j) => [d, parts[j]])),
        m: g.v, cov: g.cov, prev: pg ? pg.v : null,
        share: { adSpend: tot.adSpend ? g.v.adSpend / tot.adSpend * 100 : null, adSales: tot.adSales ? (g.v.adSales ?? 0) / tot.adSales * 100 : null },
      });
    }
    return { rows, total: c.total, prevTotal: p?.total || null, source: c.source, unapplied: c.unapplied || [] };
  }

  /* breakdown for donuts */
  function breakdown(dim, metric) {
    const { cur } = State.ranges();
    const res = Query.run({ ...base(), range: cur, groupBy: dim });
    const segs = [...res.groups].filter(([k]) => k).map(([label, g]) => ({ label, value: g.v[metric] || 0 })).sort((a, b) => b.value - a.value);
    return { segs, total: res.total?.v?.[metric] ?? null, source: res.source, unapplied: res.unapplied || [], missing: res.empty && !res.source };
  }

  return { kpis, trend, periods, lifetime, byDim, breakdown, totals };
})();
