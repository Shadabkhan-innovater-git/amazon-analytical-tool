/* ==========================================================================
   I18N — translation lookup + locale-aware number/date/currency formatting.
   UI text never lives in components: everything goes through t().
   Locale dictionaries are registered by i18n-locales.js (one object per
   language, equivalent to en.json / hi.json / …).
   ========================================================================== */
const I18n = (() => {
  const dicts = {};
  let lang = 'en';
  let marketplace = 'US';
  let nfCache = new Map();

  function register(code, dict) { dicts[code] = dict; }
  function setLang(code) { lang = dicts[code] ? code : 'en'; nfCache = new Map(); document.documentElement.lang = lang; }
  function setMarketplace(mk) { marketplace = mk; nfCache = new Map(); }
  function getLang() { return lang; }

  function t(key, vars) {
    let s = (dicts[lang] && dicts[lang][key]) ?? dicts.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
    return s;
  }
  function has(key) { return dicts.en[key] != null; }

  /* locale = UI language + marketplace region (en-GB, en-IN, de-DE …) */
  function locale() {
    const region = lang === 'en' ? (Config.MARKETPLACES[marketplace]?.region || 'US') : Config.LANG_DEFAULT_REGION[lang];
    return `${lang}-${region}`;
  }
  function currency() { return Config.MARKETPLACES[marketplace]?.currency || 'USD'; }

  function nf(key, opts) {
    const k = key + '|' + locale() + '|' + currency();
    if (!nfCache.has(k)) {
      try { nfCache.set(k, new Intl.NumberFormat(locale(), opts)); }
      catch { nfCache.set(k, new Intl.NumberFormat('en-US', opts)); }
    }
    return nfCache.get(k);
  }

  const NA = () => t('common.na');

  function money(v, compact = true) {
    if (v == null || !isFinite(v)) return NA();
    const a = Math.abs(v);
    if (!compact || a < 1000) return nf('m0' + (a < 100 ? 2 : 0), { style: 'currency', currency: currency(), maximumFractionDigits: a < 100 ? 2 : 0 }).format(v);
    return nf('mc' + (a >= 1e6 ? 2 : 1), { style: 'currency', currency: currency(), notation: 'compact', maximumFractionDigits: a >= 1e6 ? 2 : 1 }).format(v);
  }
  function money2(v) {
    if (v == null || !isFinite(v)) return NA();
    return nf('m2', { style: 'currency', currency: currency() }).format(v);
  }
  function int(v, compact = true) {
    if (v == null || !isFinite(v)) return NA();
    const a = Math.abs(v);
    if (!compact || a < 10000) return nf('i0', { maximumFractionDigits: 0 }).format(v);
    return nf('ic' + (a >= 1e6 ? 2 : 1), { notation: 'compact', maximumFractionDigits: a >= 1e6 ? 2 : 1 }).format(v);
  }
  function pct(v, digits = 2) {
    if (v == null || !isFinite(v)) return NA();
    return nf('p' + digits, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v) + '%';
  }
  function num(v, digits = 2) {
    if (v == null || !isFinite(v)) return NA();
    return nf('n' + digits, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  }
  function metric(key, v, compact = true) {
    const m = Config.METRICS[key];
    if (!m) return num(v);
    switch (m.fmt) {
      case 'currency': return money(v, compact);
      case 'currency2': return money2(v);
      case 'int': return int(v, compact);
      case 'pct': return pct(v);
      case 'ratio': return num(v, 2);
      default: return num(v);
    }
  }
  function delta(v) { // magnitude only; arrow rendered separately
    if (v == null || !isFinite(v)) return '—';
    return nf('d1', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(v)) + '%';
  }

  /* dates are integer day numbers (UTC days since epoch) */
  function dateFmt(day, opts) {
    const k = 'd' + JSON.stringify(opts) + locale();
    if (!nfCache.has(k)) nfCache.set(k, new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', ...opts }));
    return nfCache.get(k).format(new Date(day * 86400000));
  }
  function date(day) { return dateFmt(day, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function dateShort(day) { return dateFmt(day, { month: 'short', day: 'numeric' }); }
  function monthLabel(day) { return dateFmt(day, { month: 'long', year: 'numeric' }); }
  function monthShort(day) { return dateFmt(day, { month: 'short', year: '2-digit' }); }
  function range(s, e) {
    if (s == null) return '—';
    if (s === e) return date(s);
    try {
      const k = 'r' + locale();
      if (!nfCache.has(k)) nfCache.set(k, new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }));
      return nfCache.get(k).formatRange(new Date(s * 86400000), new Date(e * 86400000));
    } catch { return date(s) + ' – ' + date(e); }
  }
  function weekdayNames() {
    const f = new Intl.DateTimeFormat(locale(), { weekday: 'narrow', timeZone: 'UTC' });
    return [0, 1, 2, 3, 4, 5, 6].map(i => f.format(new Date(Date.UTC(2023, 0, 1 + i)))); // Jan 1 2023 = Sunday
  }

  function dim(dimKey) { return t('dim.' + dimKey); }
  function metricLabel(key) { return t('m.' + key); }

  return { register, setLang, setMarketplace, getLang, t, has, locale, currency, money, money2, int, pct, num, metric, delta,
    date, dateShort, monthLabel, monthShort, range, weekdayNames, dim, metricLabel, NA, dicts };
})();
const t = I18n.t;
