/* ==========================================================================
   DATA STORE — normalised reporting dataset held in columnar typed arrays.
   One ColumnTable per report grain (campaign, placement, keyword, asin,
   searchTerm). Dimensions are dictionary-encoded (Uint32 codes), metrics are
   Float32 with NaN = "not reported" (renders N/A, never 0).
   This layout keeps millions of rows scannable in milliseconds.
   ========================================================================== */
class Dict {
  constructor() { this.values = []; this.index = new Map(); }
  code(v) {
    v = v == null ? '' : String(v);
    let c = this.index.get(v);
    if (c === undefined) { c = this.values.length; this.values.push(v); this.index.set(v, c); }
    return c;
  }
}

class ColumnTable {
  constructor(name, capacity = 1024) {
    this.name = name;
    this.dims = Config.SOURCES[name].dims;
    this.nMetrics = Config.BASE_METRICS.length;
    this.length = 0;
    this.cap = capacity;
    this.dicts = Object.fromEntries(this.dims.map(d => [d, new Dict()]));
    this.dimCols = Object.fromEntries(this.dims.map(d => [d, new Uint32Array(capacity)]));
    this.day = new Uint16Array(capacity);
    this.metrics = Config.BASE_METRICS.map(() => new Float32Array(capacity));
    this.minDay = Infinity; this.maxDay = -Infinity;
  }
  grow() {
    const cap = this.cap * 2;
    const g = (arr, T) => { const n = new T(cap); n.set(arr); return n; };
    for (const d of this.dims) this.dimCols[d] = g(this.dimCols[d], Uint32Array);
    this.day = g(this.day, Uint16Array);
    this.metrics = this.metrics.map(a => { const n = new Float32Array(cap); n.fill(NaN); n.set(a); return n; });
    this.cap = cap;
  }
  /* row: { day, dims:{...}, m:{metricKey:value|null} } */
  push(day, dims, m) {
    if (this.length >= this.cap) this.grow();
    const i = this.length++;
    this.day[i] = day;
    if (day < this.minDay) this.minDay = day;
    if (day > this.maxDay) this.maxDay = day;
    for (const d of this.dims) this.dimCols[d][i] = this.dicts[d].code(dims[d]);
    const BM = Config.BASE_METRICS;
    for (let k = 0; k < BM.length; k++) {
      const v = m[BM[k].key];
      this.metrics[k][i] = v == null || v === '' || !isFinite(v) ? NaN : v;
    }
  }
  /* indices of metric columns with at least one reported value (cached until rows change) */
  activeMetrics() {
    if (this._active && this._activeLen === this.length) return this._active;
    const out = [];
    this.metrics.forEach((a, k) => { for (let i = 0; i < this.length; i++) if (a[i] === a[i]) { out.push(k); return; } });
    this._active = out; this._activeLen = this.length;
    return out;
  }
  /* append every row of another table of the same grain (re-maps dictionary codes) */
  appendFrom(o) {
    const n = o.length;
    while (this.length + n > this.cap) this.grow();
    const base = this.length;
    for (const d of this.dims) {
      const map = o.dicts[d].values.map(v => this.dicts[d].code(v));
      const src = o.dimCols[d], dst = this.dimCols[d];
      for (let i = 0; i < n; i++) dst[base + i] = map[src[i]];
    }
    this.day.set(o.day.subarray(0, n), base);
    this.metrics.forEach((a, k) => a.set(o.metrics[k].subarray(0, n), base));
    this.length += n;
    if (n) { this.minDay = Math.min(this.minDay, o.minDay); this.maxDay = Math.max(this.maxDay, o.maxDay); }
  }
  valuesOf(dim) { return this.dicts[dim] ? this.dicts[dim].values : []; }
  /* rebuild without rows matching predicate (used when a data source is removed) */
  filterRows(keepFn) {
    const nt = new ColumnTable(this.name, Math.max(1024, this.length));
    const dimsObj = {}, mObj = {};
    for (let i = 0; i < this.length; i++) {
      for (const d of this.dims) dimsObj[d] = this.dicts[d].values[this.dimCols[d][i]];
      if (!keepFn(dimsObj)) continue;
      Config.BASE_METRICS.forEach((b, k) => { const v = this.metrics[k][i]; mObj[b.key] = isNaN(v) ? null : v; });
      nt.push(this.day[i], dimsObj, mObj);
    }
    return nt;
  }
  serialize() {
    const n = this.length;
    return { name: this.name, length: n, day: this.day.slice(0, n),
      dimCols: Object.fromEntries(this.dims.map(d => [d, this.dimCols[d].slice(0, n)])),
      dicts: Object.fromEntries(this.dims.map(d => [d, this.dicts[d].values])),
      metrics: this.metrics.map(a => a.slice(0, n)), minDay: this.minDay, maxDay: this.maxDay };
  }
  /* wrap typed arrays received from the server without copying */
  static fromColumns(name, o) {
    const t = new ColumnTable(name, 1);
    t.length = t.cap = o.length;
    t.day = o.day;
    for (const d of t.dims) {
      const src = o.dims[d];
      t.dimCols[d] = src ? src.codes : new Uint32Array(o.length);
      (src ? src.values : ['']).forEach(v => t.dicts[d].code(v));
    }
    t.metrics = o.metrics; t.minDay = o.minDay; t.maxDay = o.maxDay;
    return t;
  }
  static deserialize(o) {
    const t = new ColumnTable(o.name, Math.max(1024, o.length));
    t.length = o.length; t.cap = Math.max(1024, o.length);
    t.day = new Uint16Array(t.cap); t.day.set(o.day);
    for (const d of t.dims) {
      t.dimCols[d] = new Uint32Array(t.cap);
      if (o.dimCols[d]) t.dimCols[d].set(o.dimCols[d]);
      const vals = o.dicts[d] || [''];
      vals.forEach(v => t.dicts[d].code(v));
    }
    t.metrics = Config.BASE_METRICS.map((_, k) => { const a = new Float32Array(t.cap); a.fill(NaN); if (o.metrics[k]) a.set(o.metrics[k]); return a; });
    t.minDay = o.minDay; t.maxDay = o.maxDay;
    return t;
  }
}

const DataStore = (() => {
  let tables = {};
  let files = [];      // data source registry: {id, name, source, rows, minDay, maxDay, importedAt, demo}
  let version = 0;     // bumps on every data change → invalidates query cache
  let isDemo = true;

  function reset() {
    tables = Object.fromEntries(Object.keys(Config.SOURCES).map(s => [s, new ColumnTable(s)]));
    files = [];
    version++;
  }
  reset();

  function table(name) { return tables[name]; }
  function available() { return Config.SOURCE_PREFERENCE.filter(s => tables[s].length > 0); }
  function bounds() {
    let min = Infinity, max = -Infinity;
    for (const s of Object.values(tables)) if (s.length) { min = Math.min(min, s.minDay); max = Math.max(max, s.maxDay); }
    return isFinite(min) ? { min, max } : null;
  }
  function distinct(dim, marketplace) {
    const out = new Set();
    for (const s of Object.values(tables)) {
      if (!s.length || !s.dicts[dim]) continue;
      if (!marketplace) { s.dicts[dim].values.forEach(v => v && out.add(v)); continue; }
      const mc = s.dicts.marketplace.index.get(marketplace);
      if (mc === undefined) continue;
      const col = s.dimCols[dim], mcol = s.dimCols.marketplace, seen = new Uint8Array(s.dicts[dim].values.length);
      for (let i = 0; i < s.length; i++) if (mcol[i] === mc && !seen[col[i]]) { seen[col[i]] = 1; }
      seen.forEach((f, c) => { if (f && s.dicts[dim].values[c]) out.add(s.dicts[dim].values[c]); });
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }
  function registerFile(f) { files.push(f); version++; }
  function removeFile(id) {
    for (const s of Object.keys(tables)) tables[s] = tables[s].filterRows(d => d.fileId !== id);
    files = files.filter(f => f.id !== id);
    if (!files.some(f => f.demo)) isDemo = false;
    version++;
  }
  function clearDemo() {
    const demoIds = files.filter(f => f.demo).map(f => f.id);
    if (!demoIds.length) return;
    for (const s of Object.keys(tables)) tables[s] = tables[s].filterRows(d => !demoIds.includes(d.fileId));
    files = files.filter(f => !f.demo);
    isDemo = false; version++;
  }
  function touch() { version++; }

  /* ---- per-viewer persistence (IndexedDB). Best-effort; never load-bearing. */
  const DB = 'ads-intel', STORE = 'datasets';
  function idb() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  /* server mode: replace everything with the reports stored by the Python backend */
  function loadServer(header, buf) {
    const T = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, f32: Float32Array };
    tables = Object.fromEntries(Object.keys(Config.SOURCES).map(s => {
      const o = header.tables[s];
      if (!o) return [s, new ColumnTable(s)];
      const n = o.length, view = c => new T[c.type](buf, c.offset, n);
      return [s, ColumnTable.fromColumns(s, {
        length: n, minDay: o.minDay, maxDay: o.maxDay, day: view(o.day),
        dims: Object.fromEntries(Object.entries(o.dims).map(([d, c]) => [d, { codes: c.type === 'u32' ? view(c) : Uint32Array.from(view(c)), values: c.values }])),
        metrics: o.metrics.map(c => c ? view(c) : new Float32Array(n).fill(NaN)),
      })];
    }));
    files = header.datasets.map(d => ({ ...d, importedAt: Date.parse(d.importedAt), demo: false }));
    isDemo = false; version++;
  }
  async function persist() {
    if (typeof Api !== 'undefined' && Api.enabled) return; // the server is the system of record
    try {
      const db = await idb();
      const payload = isDemo ? null : { files, tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.serialize()])) };
      await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(payload, 'current'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { console.warn('persist skipped', e); }
  }
  async function restore() {
    try {
      const db = await idb();
      const payload = await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const r = tx.objectStore(STORE).get('current'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (!payload || !payload.files?.length) return false;
      tables = Object.fromEntries(Object.keys(Config.SOURCES).map(s => [s, payload.tables[s] ? ColumnTable.deserialize(payload.tables[s]) : new ColumnTable(s)]));
      files = payload.files; isDemo = false; version++;
      return true;
    } catch (e) { return false; }
  }

  return {
    reset, table, available, bounds, distinct, registerFile, removeFile, clearDemo, touch, persist, restore, loadServer,
    get files() { return files; }, get version() { return version; },
    get isDemo() { return isDemo; }, set isDemo(v) { isDemo = v; },
    get tables() { return tables; },
  };
})();
