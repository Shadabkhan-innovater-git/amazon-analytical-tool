/* ==========================================================================
   DATE ENGINE — day numbers, presets, comparison periods, period buckets.
   Weeks run Sunday–Saturday (Amazon Ads console convention); week 1 is the
   week containing January 1.
   ========================================================================== */
const Dates = (() => {
  const D = 86400000;
  const toDay = d => Math.floor(d.getTime() / D);
  const fromDay = n => new Date(n * D);
  const ymd = n => { const d = fromDay(n); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
  const dayOf = (y, m, d) => Math.floor(Date.UTC(y, m, d) / D);
  const iso = n => fromDay(n).toISOString().slice(0, 10);
  const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return dayOf(y, m - 1, d); };
  const weekday = n => (n + 4) % 7; // 1970-01-01 was Thursday → Sunday = 0
  const weekStart = n => n - weekday(n);
  const monthStart = n => { const [y, m] = ymd(n); return dayOf(y, m, 1); };
  const monthEnd = n => { const [y, m] = ymd(n); return dayOf(y, m + 1, 0); };
  const quarterStart = n => { const [y, m] = ymd(n); return dayOf(y, m - (m % 3), 1); };
  const quarterEnd = n => { const [y, m] = ymd(n); return dayOf(y, m - (m % 3) + 3, 0); };
  const yearStart = n => dayOf(ymd(n)[0], 0, 1);
  const yearEnd = n => dayOf(ymd(n)[0], 11, 31);
  function weekNumber(n) {
    const ws = weekStart(n), y = ymd(ws + 6)[0]; // the year that owns the week = year of its Saturday
    const w1 = weekStart(dayOf(y, 0, 1));
    return Math.floor((ws - w1) / 7) + 1;
  }
  function addMonths(n, k) { const [y, m, d] = ymd(n); const last = dayOf(y, m + k + 1, 0); return Math.min(dayOf(y, m + k, d), last); }
  function addYears(n, k) { return addMonths(n, 12 * k); }

  /* Presets: id → {group, calc(ref, bounds) → [start,end], unit} ; unit drives smart comparison */
  const PRESETS = [
    { id: 'today', group: 'days', calc: r => [r, r], unit: 'day' },
    { id: 'yesterday', group: 'days', calc: r => [r - 1, r - 1], unit: 'day' },
    { id: 'last7', group: 'days', calc: r => [r - 6, r] },
    { id: 'last14', group: 'days', calc: r => [r - 13, r] },
    { id: 'last30', group: 'days', calc: r => [r - 29, r] },
    { id: 'lastWeek', group: 'weeks', calc: r => { const s = weekStart(r) - 7; return [s, s + 6]; }, unit: 'week' },
    { id: 'last4Weeks', group: 'weeks', calc: r => { const e = weekStart(r) - 1; return [e - 27, e]; } },
    { id: 'last13Weeks', group: 'weeks', calc: r => { const e = weekStart(r) - 1; return [e - 90, e]; } },
    { id: 'mtd', group: 'months', calc: r => [monthStart(r), r], unit: 'month' },
    { id: 'lastMonth', group: 'months', calc: r => { const e = monthStart(r) - 1; return [monthStart(e), e]; }, unit: 'month' },
    { id: 'qtd', group: 'quarters', calc: r => [quarterStart(r), r], unit: 'quarter' },
    { id: 'lastQuarter', group: 'quarters', calc: r => { const e = quarterStart(r) - 1; return [quarterStart(e), e]; }, unit: 'quarter' },
    { id: 'ytd', group: 'years', calc: r => [yearStart(r), r], unit: 'year' },
    { id: 'lastYear', group: 'years', calc: r => { const e = yearStart(r) - 1; return [yearStart(e), e]; }, unit: 'year' },
    { id: 'lifetime', group: 'other', calc: (r, b) => [b.min, b.max] },
  ];
  const presetById = id => PRESETS.find(p => p.id === id);

  /* Comparison: 'previous' shifts by the preset's calendar unit when it has one
     (MTD Sep 1–22 → Aug 1–22), otherwise by equal length immediately before. */
  function comparison(mode, start, end, presetId, custom) {
    if (mode === 'none') return null;
    if (mode === 'custom') return custom && custom[0] != null ? custom : null;
    if (mode === 'yoy') return [addYears(start, -1), addYears(end, -1)];
    const p = presetById(presetId);
    const len = end - start;
    switch (p && p.unit) {
      case 'week': return [start - 7, end - 7];
      case 'month': { const s = addMonths(start, -1); return [s, Math.min(s + len, monthEnd(s))]; }
      case 'quarter': { const s = addMonths(start, -3); return [s, Math.min(s + len, quarterEnd(s))]; }
      case 'year': { const s = addYears(start, -1); return [s, Math.min(addYears(end, -1), yearEnd(s))]; }
      default: return [start - len - 1, start - 1];
    }
  }

  /* Period bucketing for WoW / MoM / QoQ / YoY / trend charts */
  const GRAINS = {
    day: { key: n => n, start: n => n, end: n => n, prev: k => k - 1 },
    week: { key: weekStart, start: k => k, end: k => k + 6, prev: k => k - 7 },
    month: { key: monthStart, start: k => k, end: monthEnd, prev: k => addMonths(k, -1) },
    quarter: { key: quarterStart, start: k => k, end: quarterEnd, prev: k => addMonths(k, -3) },
    year: { key: yearStart, start: k => k, end: yearEnd, prev: k => addYears(k, -1) },
  };
  function periodLabel(grain, k) {
    const [y, m] = ymd(k);
    switch (grain) {
      case 'day': return I18n.dateShort(k);
      case 'week': return t('period.week', { n: weekNumber(k) });
      case 'month': return I18n.monthLabel(k);
      case 'quarter': return `Q${Math.floor(m / 3) + 1} ${y}`;
      case 'year': return String(y);
    }
  }
  function periodSub(grain, k, bounds) {
    const g = GRAINS[grain];
    let s = g.start(k), e = g.end(k);
    const partial = bounds && (s < bounds.min || e > bounds.max);
    if (bounds) { s = Math.max(s, bounds.min); e = Math.min(e, bounds.max); }
    return { range: grain === 'day' ? '' : I18n.range(s, e), partial };
  }
  /* last N period keys ending at `endDay` */
  function periodKeys(grain, endDay, n) {
    const g = GRAINS[grain]; const out = [];
    let k = g.key(endDay);
    for (let i = 0; i < n; i++) { out.unshift(k); k = g.prev(k); }
    return out;
  }
  function autoGrain(start, end) {
    const len = end - start + 1;
    if (len <= 35) return 'day';
    if (len <= 200) return 'week';
    if (len <= 1100) return 'month';
    return 'quarter';
  }

  return { toDay, fromDay, ymd, dayOf, iso, fromISO, weekday, weekStart, monthStart, monthEnd, weekNumber, addMonths, addYears,
    PRESETS, presetById, comparison, GRAINS, periodLabel, periodSub, periodKeys, autoGrain };
})();
