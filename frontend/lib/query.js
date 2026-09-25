/* ==========================================================================
   METRIC ENGINE + FILTER ENGINE + AGGREGATION
   - Metrics.derive(acc): the only place derived metrics are computed.
   - Metrics.change(key, cur, prev): % change + direction-aware tone.
   - Query.run(spec): resolves the correct report grain, applies the global
     filter state in one pass over typed arrays, aggregates, memoises.
   ========================================================================== */
const Metrics = (() => {
  const BM = Config.BASE_METRICS;
  const NM = BM.length, S = 6; // per-metric slots: sum, count, cond orders, cond sales, cond spend, cond impressions
  const IDX = Object.fromEntries(BM.map((m, i) => [m.key, i]));
  const SLOT_OF = { orders: 2, adSales: 3, adSpend: 4, impressions: 5 };
  const WEIGHTED = BM.map(m => !!m.weight);

  function newAcc() { return new Float64Array(NM * S); }
  const ALL = BM.map((_, k) => k);
  function addRow(acc, M, i, ks = ALL) {
    const spend = M[0][i], sales = M[1][i], impr = M[2][i], ord = M[4][i];
    for (let j = 0, nk = ks.length; j < nk; j++) {
      const k = ks[j];
      const v = M[k][i];
      if (v !== v) continue;
      const b = k * S;
      acc[b] += WEIGHTED[k] ? v * (impr === impr ? impr : 0) : v;
      acc[b + 1]++;
      if (ord === ord) acc[b + 2] += ord;
      if (sales === sales) acc[b + 3] += sales;
      if (spend === spend) acc[b + 4] += spend;
      if (impr === impr) acc[b + 5] += impr;
    }
  }
  function merge(into, from) { for (let j = 0; j < into.length; j++) into[j] += from[j]; }

  function accessor(acc, source) {
    return {
      s(key) {
        const k = IDX[key], b = k * S;
        if (!acc[b + 1]) return null;
        const m = BM[k];
        if (m.sources && !m.sources.includes(source)) return null;
        return WEIGHTED[k] ? (acc[b + 5] ? acc[b] / acc[b + 5] : null) : acc[b];
      },
      c(key, of) { const b = IDX[key] * S; return acc[b + 1] ? acc[b + SLOT_OF[of]] : null; },
      cov(key) { // share of spend for which the metric is reported
        const b = IDX[key] * S, tot = acc[4];
        if (!acc[b + 1]) return 0;
        return tot ? acc[b + 4] / tot : 1;
      },
    };
  }

  /* acc → { values, cov } for every metric in the registry. Coverage (share of spend where a metric is
     reported) is only computed when asked — totals need it, 100k table rows don't. */
  const DERIVED = Object.values(Config.METRICS).filter(m => !m.base);
  const SRC_OK = BM.map(m => m.sources || null);
  function derive(acc, source, withCov = true) {
    const v = {};
    for (let k = 0; k < NM; k++) {
      const b = k * S, key = BM[k].key;
      if (!acc[b + 1] || (SRC_OK[k] && !SRC_OK[k].includes(source))) { v[key] = null; continue; }
      v[key] = WEIGHTED[k] ? (acc[b + 5] ? acc[b] / acc[b + 5] : null) : acc[b];
    }
    const a = { s: key => v[key], c: (key, of) => { const b = IDX[key] * S; return acc[b + 1] ? acc[b + SLOT_OF[of]] : null; } };
    for (const m of DERIVED) v[m.key] = m.f(a);
    if (!withCov) return { v, cov: null };
    const cov = {}, tot = acc[4];
    for (let k = 0; k < NM; k++) { const b = k * S; cov[BM[k].key] = v[BM[k].key] == null ? 0 : (tot ? acc[b + 4] / tot : 1); }
    for (const m of DERIVED) cov[m.key] = v[m.key] == null ? 0 : Math.min(...m.deps.map(d => cov[d] ?? 1));
    return { v, cov };
  }

  /* % change and tone, driven by Config.metricDirection */
  function change(key, cur, prev) {
    if (cur == null || prev == null || prev === 0) return null;
    const pct = (cur - prev) / Math.abs(prev) * 100;
    const dir = Config.metricDirection[key] || 'neutral';
    let tone = 'neutral';
    if (Math.abs(pct) >= 0.05) {
      if (dir === 'positive') tone = pct > 0 ? 'good' : 'bad';
      else if (dir === 'negative') tone = pct < 0 ? 'good' : 'bad';
    }
    return { pct, tone, up: pct > 0, flat: Math.abs(pct) < 0.05 };
  }
  return { newAcc, addRow, merge, derive, change, NM, IDX };
})();

const Query = (() => {
  let cache = new Map();
  let cacheVersion = -1;

  /* Pick the report grain that contains every dimension we need. */
  function resolve(required, groupDim) {
    const avail = DataStore.available();
    if (!avail.length) return null;
    const has = (s, d) => Config.SOURCES[s].dims.includes(d);
    const candidates = groupDim ? avail.filter(s => has(s, groupDim)) : avail;
    if (!candidates.length) return null;
    let best = null, bestScore = -1;
    for (const s of candidates) {
      const score = required.filter(d => has(s, d)).length;
      if (score > bestScore) { best = s; bestScore = score; }
      if (score === required.length) break;
    }
    return { source: best, unapplied: required.filter(d => !has(best, d)) };
  }

  /* spec: { filters, marketplace, range:[s,e]|null, groupBy: dim|'day'|'week'|'month'|'quarter'|'year'|null, source? } */
  function run(spec) {
    if (cacheVersion !== DataStore.version) { cache = new Map(); cacheVersion = DataStore.version; }
    const key = JSON.stringify(spec);
    if (cache.has(key)) return cache.get(key);
    const res = compute(spec);
    cache.set(key, res);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return res;
  }

  function compute({ filters, marketplace, range, groupBy, source: forced }) {
    const activeDims = Object.keys(filters).filter(d => filters[d] && filters[d].length);
    const isTime = groupBy && Dates.GRAINS[groupBy];
    const groupDims = groupBy && !isTime ? groupBy.split('+') : null;   // composite keys: 'keyword+matchType+campaign'
    const groupDim = groupDims ? groupDims[0] : null;
    const r = forced ? { source: forced, unapplied: activeDims.filter(d => !Config.SOURCES[forced].dims.includes(d)) } : resolve([...activeDims, ...(groupDims || []).slice(1)], groupDim);
    if (r && groupDims && groupDims.some(d => !Config.SOURCES[r.source].dims.includes(d))) return { empty: true, missingDim: groupDim, groups: new Map(), total: null };
    if (!r || !DataStore.table(r.source).length) return { empty: true, missingDim: groupDim, groups: new Map(), total: null };
    const T = DataStore.table(r.source);
    const n = T.length, day = T.day, M = T.metrics;

    // filter masks
    const checks = [];
    const mk = T.dicts.marketplace.index.get(marketplace);
    if (mk === undefined) return { empty: true, source: r.source, unapplied: r.unapplied, groups: new Map(), total: finalize(Metrics.newAcc(), r.source) };
    for (const d of activeDims) {
      if (r.unapplied.includes(d)) continue;
      const dict = T.dicts[d], mask = new Uint8Array(dict.values.length);
      filters[d].forEach(v => { const c = dict.index.get(v); if (c !== undefined) mask[c] = 1; });
      checks.push([T.dimCols[d], mask]);
    }
    const mcol = T.dimCols.marketplace;
    const s = range ? range[0] : -1, e = range ? range[1] : 1e9;
    const groups = new Map();
    const total = Metrics.newAcc();
    const gcols = groupDims ? groupDims.map(d => T.dimCols[d]) : null;
    const gcol = gcols && gcols.length === 1 ? gcols[0] : null;
    const gkey = isTime ? Dates.GRAINS[groupBy].key : null;
    const composite = gcols && gcols.length > 1;
    // composite keys as one number (mixed radix) when it fits — far faster than string keys on millions of rows
    const radix = composite ? groupDims.map(d => Math.max(1, T.dicts[d].values.length)) : null;
    const numericKey = composite && radix.reduce((a, b) => a * b, 1) < 2 ** 52;
    const ng = gcols ? gcols.length : 0;
    const nc = checks.length;
    const ks = T.activeMetrics();   // skip metric columns this report never fills
    outer: for (let i = 0; i < n; i++) {
      if (mcol[i] !== mk) continue;
      const d = day[i];
      if (d < s || d > e) continue;
      for (let c = 0; c < nc; c++) if (!checks[c][1][checks[c][0][i]]) continue outer;
      if (!groupBy) { Metrics.addRow(total, M, i, ks); continue; }
      {
        let k;
        if (numericKey) { k = 0; for (let g = 0; g < ng; g++) k = k * radix[g] + gcols[g][i]; }
        else k = composite ? gcols.map(c => c[i]).join('|') : gcol ? gcol[i] : gkey(d);
        let acc = groups.get(k);
        if (!acc) { acc = Metrics.newAcc(); groups.set(k, acc); }
        Metrics.addRow(acc, M, i, ks);
      }
    }
    if (groupBy) for (const acc of groups.values()) Metrics.merge(total, acc);   // total = sum of groups (cheaper than per row)
    const out = new Map();
    for (const [k, acc] of groups) {
      let codesOf = null;
      if (numericKey) { codesOf = new Array(ng); let r = k; for (let g = ng - 1; g >= 0; g--) { codesOf[g] = r % radix[g]; r = Math.floor(r / radix[g]); } }
      const label = composite ? (codesOf || String(k).split('|').map(Number)).map((c, j) => T.dicts[groupDims[j]].values[c]).join('\u0001')
        : gcol ? T.dicts[groupDim].values[k] : k;
      out.set(label, finalize(acc, r.source, false));
    }
    return { source: r.source, unapplied: r.unapplied, groups: out, total: finalize(total, r.source, true) };
  }
  function finalize(acc, source, withCov = true) { const d = Metrics.derive(acc, source, withCov); return { ...d, rows: acc[1] }; }

  /* attribute lookup: for each value of `dim`, first seen value of `attrDim` (e.g. campaign → portfolio) */
  const attrCache = new Map();
  function attributes(source, dim, attrDims) {
    const key = source + dim + attrDims.join() + DataStore.version;
    if (attrCache.has(key)) return attrCache.get(key);
    const T = DataStore.table(source), out = new Map();
    if (!T || !T.length) return out;
    const col = T.dimCols[dim];
    for (let i = 0; i < T.length; i++) {
      const v = T.dicts[dim].values[col[i]];
      if (out.has(v)) continue;
      const o = {};
      attrDims.forEach(a => { if (T.dimCols[a]) o[a] = T.dicts[a].values[T.dimCols[a][i]]; });
      out.set(v, o);
    }
    if (attrCache.size > 50) attrCache.clear();
    attrCache.set(key, out);
    return out;
  }
  return { run, resolve, attributes };
})();
