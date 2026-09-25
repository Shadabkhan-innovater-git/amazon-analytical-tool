/* ==========================================================================
   IMPORT + VALIDATION ENGINE
   read file → detect type → read headers → auto-map → preview → validate →
   commit into the columnar store. Nothing is dropped silently: every
   excluded row is counted, listed and downloadable.
   ========================================================================== */
const Libs = (() => {
  const loaded = {};
  function load(url) {
    if (!loaded[url]) loaded[url] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = url; s.async = true;
      s.onload = res; s.onerror = () => { delete loaded[url]; rej(new Error('Could not load ' + url)); };
      document.head.appendChild(s);
    });
    return loaded[url];
  }
  return {
    xlsx: () => load('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').then(() => window.XLSX),
    fflate: () => load('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js').then(() => window.fflate),
    pptx: () => load('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js').then(() => window.PptxGenJS),
    pdf: () => load('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js').then(() => load('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js')).then(() => window.jspdf.jsPDF),
  };
})();

const ImportService = (() => {
  /* Size limits in the browser. Text reports (CSV/TSV/TXT, also zipped as .zip/.gz) are STREAMED:
     read in chunks, never held whole in memory, so multi-GB files work. Excel files must be
     loaded whole by the spreadsheet library, so they keep a lower cap. */
  const MAX_TEXT_MB = 4096, MAX_EXCEL_MB = 200;
  const ALLOWED = /\.(csv|tsv|txt|xlsx|xls|zip|gz)$/i;
  const HEAD_ROWS = 1000;

  /* ---------- 1. read */
  async function readFile(file) {
    if (!ALLOWED.test(file.name)) throw new Error(t('imp.err.type'));
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      if (file.size > MAX_EXCEL_MB * 1048576) throw new Error(t('imp.err.excelSize', { mb: MAX_EXCEL_MB }));
      const XLSX = await Libs.xlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) })).filter(s => s.rows.length);
      if (!sheets.length) throw new Error(t('imp.err.empty'));
      return { kind: 'xlsx', sheets };
    }
    if (file.size > MAX_TEXT_MB * 1048576) throw new Error(t('imp.err.size', { mb: I18n.int(MAX_TEXT_MB, false) }));
    // streamed text report: read only the first rows now; validation streams the whole file later
    const head = [], rowNos = [];
    let chars = 0;
    for await (const [no, row] of streamRows(file)) {
      head.push(row); rowNos.push(no); chars += row.join(',').length + 1;
      if (head.length >= HEAD_ROWS) break;
    }
    if (!head.length) throw new Error(t('imp.err.empty'));
    const compressed = /\.(zip|gz)$/i.test(file.name);
    const approxRows = head.length < HEAD_ROWS ? head.length : compressed ? null : Math.round(file.size / (chars / head.length));
    return { kind: 'csv', streaming: true, file, approxRows, sheets: [{ name: innerName(file), rows: head, rowNos }] };
  }
  const innerName = f => f.name.replace(/\.(gz|zip)$/i, '');

  /* bytes of the report, decompressed on the fly for .gz (native) and .zip (fflate, streaming) */
  function byteStream(file, onBytes) {
    let read = 0;
    const counted = file.stream().pipeThrough(new TransformStream({ transform(chunk, c) { read += chunk.length; onBytes && onBytes(read); c.enqueue(chunk); } }));
    if (/\.gz$/i.test(file.name)) {
      if (typeof DecompressionStream === 'undefined') throw new Error(t('imp.err.noGzip'));
      return Promise.resolve(counted.pipeThrough(new DecompressionStream('gzip')));
    }
    if (/\.zip$/i.test(file.name)) return zipStream(counted);
    return Promise.resolve(counted);
  }
  async function zipStream(src) {
    const fflate = await Libs.fflate();
    const reader = src.getReader();
    const out = [];
    let picked = false, done = false, finished = false, error = null;
    const uz = new fflate.Unzip();
    uz.register(fflate.UnzipInflate);
    uz.onfile = f => {
      const base = f.name.split('/').pop();
      if (picked || !/\.(csv|tsv|txt)$/i.test(base) || base.startsWith('._')) return;
      picked = true;
      f.ondata = (err, chunk, final) => { if (err) error = err; else { if (chunk.length) out.push(chunk); if (final) finished = true; } };
      f.start();
    };
    return new ReadableStream({
      async pull(ctrl) {
        while (!out.length && !finished && !error && !done) {
          const r = await reader.read();
          if (r.done) { done = true; uz.push(new Uint8Array(0), true); }
          else uz.push(r.value, false);
        }
        if (error) return ctrl.error(error);
        if (out.length) return ctrl.enqueue(out.shift());
        if (!picked) return ctrl.error(new Error(t('imp.err.zipEmpty')));
        ctrl.close();
      },
      cancel() { reader.cancel(); },
    });
  }
  async function detectEncoding(file) {
    if (/\.(zip|gz)$/i.test(file.name)) return 'utf-8';
    const b = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff) ? 'utf-16' : 'utf-8';
  }

  /* incremental CSV parser: quotes, escaped quotes and line breaks may span chunk boundaries */
  function csvParser() {
    let delim = null, row = [], field = '', q = false, pendingQuote = false, pendingCR = false, first = true;
    const out = [];
    function endRow() { row.push(field); field = ''; out.push(row); row = []; }
    return {
      feed(text, final) {
        if (first) { text = text.replace(/^﻿/, ''); first = false; }
        if (delim === null) {
          text = this._held + text; this._held = '';
          const line = text.split(/\r?\n/)[0] || '';
          if (!final && line.length === text.length && text.length < 65536) { this._held = text; return []; }
          delim = [',', ';', '\t', '|'].map(d => [d, line.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
        }
        for (let i = 0; i < text.length; i++) {
          const c = text[i];
          if (pendingCR) { pendingCR = false; if (c === '\n') continue; }
          if (pendingQuote) { pendingQuote = false; if (c === '"') { field += '"'; continue; } q = false; }
          if (q) {
            if (c === '"') { if (i + 1 < text.length) { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else pendingQuote = true; }
            else field += c;
          } else if (c === '"') q = true;
          else if (c === delim) { row.push(field); field = ''; }
          else if (c === '\n') endRow();
          else if (c === '\r') { endRow(); pendingCR = true; }
          else field += c;
        }
        if (final && (field !== '' || row.length)) endRow();
        return out.splice(0);
      },
      _held: '',
    };
  }

  /* async iterator of [fileRowNumber, row] over every non-blank row */
  async function* streamRows(file, onBytes) {
    const enc = await detectEncoding(file);
    const stream = (await byteStream(file, onBytes)).pipeThrough(new TextDecoderStream(enc));
    const reader = stream.getReader(), parser = csvParser();
    let no = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        const rows = done ? parser.feed('', true) : parser.feed(value, false);
        for (const r of rows) { no++; if (r.length > 1 || r[0] !== '') yield [no, r]; }
        if (done) break;
      }
    } finally { reader.cancel().catch(() => { }); }
  }
  async function* dataRows(file, headerRowNo, onBytes) {
    for await (const [no, row] of streamRows(file, onBytes)) if (no > headerRowNo) yield [no, row];
  }

  function parseCSV(text) {
    const p = csvParser();
    return p.feed(text, true).filter(r => r.length > 1 || r[0] !== '');
  }

  /* ---------- 2–4. headers + mapping */
  const norm = h => String(h ?? '').toLowerCase()
    .replace(/\b(1|7|14|30)[\s-]*days?\b/g, '').replace(/\(#\)|\(\$\)|\(%\)/g, '')
    .replace(/[^a-z0-9]/g, '');
  function synonyms() {
    const extra = State.get().synonyms || {};
    return Object.fromEntries(Object.entries(Config.FIELD_SYNONYMS).map(([f, list]) => [f, [...list, ...(extra[f] || []).map(norm).filter(Boolean)]]));
  }
  function detectHeaderRow(rows) {
    const syn = new Set(Object.values(synonyms()).flat());
    let best = 0, bestScore = -1;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const score = rows[i].filter(c => syn.has(norm(c))).length;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }
  function autoMap(headers) {
    const syn = synonyms(), mapping = {}, confidence = {}, used = new Set();
    const nh = headers.map(norm);
    // pass 1: exact synonym, pass 2: contains
    for (const pass of [1, 2]) {
      for (const [field, list] of Object.entries(syn)) {
        if (mapping[field] != null) continue;
        for (let i = 0; i < nh.length; i++) {
          if (used.has(i) || !nh[i]) continue;
          const hit = pass === 1 ? list.includes(nh[i]) : list.some(s => s.length > 4 && (nh[i].includes(s) || (nh[i].length > 5 && s.includes(nh[i]))));
          if (hit && !Config.RECALCULATED.includes(nh[i])) { mapping[field] = i; confidence[field] = pass === 1 ? 'high' : 'medium'; used.add(i); break; }
        }
      }
    }
    // "Targeting" is a keyword column in targeting reports but targeting type elsewhere
    if (mapping.keyword == null && mapping.targeting != null && !/type/.test(nh[mapping.targeting])) { mapping.keyword = mapping.targeting; delete mapping.targeting; }
    const unmapped = headers.map((h, i) => ({ header: h, i, status: used.has(i) ? 'mapped' : Config.RECALCULATED.includes(nh[i]) ? 'recalculated' : 'ignored' })).filter(x => x.status !== 'mapped');
    return { mapping, confidence, unmapped };
  }
  const ASIN_RE = /^(B0[A-Z0-9]{8}|\d{9}[\dX])$/;
  /* content-based fixes: an 'Advertised product SKU' column full of ASINs is the ASIN */
  function refineMapping(m, rows) {
    const mapping = m.mapping;
    if (mapping.asin == null && mapping.sku != null) {
      const vals = rows.slice(0, 500).map(r => String(r[mapping.sku] ?? '').trim().toUpperCase()).filter(Boolean);
      if (vals.length && vals.filter(v => ASIN_RE.test(v)).length / vals.length >= 0.8) {
        mapping.asin = mapping.sku; delete mapping.sku;
        m.confidence.asin = m.confidence.sku || 'medium'; delete m.confidence.sku;
      }
    }
    return m;
  }
  function detectSource(mapping, sheetName = '', fileName = '') {
    const has = f => mapping[f] != null;
    const txt = (sheetName + ' ' + fileName).toLowerCase();
    let adType = /sponsored[ _-]?brands?|\bsb\b|_sb_|headline/.test(txt) ? 'SB' : /sponsored[ _-]?display|\bsd\b|_sd_/.test(txt) ? 'SD' : /sponsored[ _-]?products?|\bsp\b|_sp_/.test(txt) ? 'SP' : null;
    const bulk = has('entity');
    const levels = ['keyword', 'asin', 'placement', 'searchTerm'].filter(has);
    let source = levels.length >= 2 && levels.join() !== 'keyword,searchTerm' ? Config.MULTI
      : has('searchTerm') ? 'searchTerm' : has('asin') ? 'asin' : has('placement') ? 'placement' : has('keyword') ? 'keyword' : 'campaign';
    return { source, adType, bulk };
  }

  /* ---------- value normalisers */
  function parseNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    let s = String(v).trim();
    if (!s || /^(-|—|n\/?a|null)$/i.test(s)) return null;
    const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
    s = s.replace(/[()\s%]/g, '').replace(/^-/, '').replace(/[^\d.,-]/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    if (!/^\d*\.?\d+$/.test(s)) return NaN;
    const n = parseFloat(s);
    return neg ? -n : n;
  }
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function dateOrder(values) {
    let dmy = 0, mdy = 0; // vote only on unambiguous, plausible values
    for (const v of values) {
      const m = String(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); if (!m) continue;
      const a = +m[1], b = +m[2];
      if (a > 12 && a <= 31 && b <= 12) dmy++; else if (b > 12 && b <= 31 && a <= 12) mdy++;
    }
    return dmy > mdy ? 'dmy' : 'mdy';
  }
  function parseDate(v, order) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? NaN : Dates.dayOf(v.getFullYear(), v.getMonth(), v.getDate());
    if (typeof v === 'number') { if (v > 20000 && v < 80000) return Math.round(v) - 25569; if (v > 19000000 && v < 21000000) v = String(v); else return NaN; }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/))) return valid(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
      let y = +m[3]; if (y < 100) y += 2000;
      return order === 'dmy' ? valid(y, +m[2] - 1, +m[1]) : valid(y, +m[1] - 1, +m[2]);
    }
    if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) return MONTHS[m[1].toLowerCase()] != null ? valid(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) : NaN;
    if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{4})/))) return MONTHS[m[2].toLowerCase()] != null ? valid(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) : NaN;
    return NaN;
  }
  function valid(y, mo, d) {
    if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) return NaN;
    const day = Dates.dayOf(y, mo, d);
    return Dates.ymd(day)[2] === d ? day : NaN;
  }
  function normAdType(v) {
    const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return null;
    if (/^(sp|sponsoredproducts?|products)$/.test(s) || s.includes('sponsoredproduct')) return 'SP';
    if (/^(sb|sponsoredbrands?|headlinesearch|hsa|brands)$/.test(s) || s.includes('sponsoredbrand')) return 'SB';
    if (/^(sd|sponsoreddisplay|display)$/.test(s) || s.includes('sponsoreddisplay')) return 'SD';
    return undefined;
  }
  function normMatch(v, kw) {
    const s = String(v || '').toLowerCase(), k = String(kw || '').toLowerCase();
    if (s === 'targeting_expression_predefined' || ['close-match', 'loose-match', 'substitutes', 'complements'].includes(k)) return 'Auto';
    if (s === 'theme') return 'Theme';
    if (s === 'unallocated' || k === 'unallocated') return 'Unallocated';
    if (s.includes('exact')) return 'Exact';
    if (s.includes('phrase')) return 'Phrase';
    if (s.includes('broad')) return 'Broad';
    if (/auto|close|loose|substitut|complement/.test(s) || /^(close-match|loose-match|substitutes|complements)$/.test(String(kw || '').toLowerCase())) return 'Auto';
    if (/audience|views|purchases|remarketing/.test(s) || /^(views|purchases|audience)/i.test(kw || '')) return 'Audience';
    if (/asin|category|product|targeting_expression/.test(s) || /^(asin|category)=/i.test(kw || '')) return 'Product';
    return v ? String(v).trim() : (kw ? 'Unknown' : null);
  }
  function normPlacement(v) {
    const s = String(v || '').toLowerCase();
    if (!s) return null;
    if (s.includes('top')) return 'Top of Search';
    if (s.includes('rest') || s.includes('other on') || s === 'other') return 'Rest of Search';
    if (s.includes('detail') || s.includes('product page')) return 'Product Pages';
    if (s.includes('off')) return 'Off-Amazon';
    if (s.includes('business')) return 'Amazon Business';
    return String(v).trim();
  }
  function normMarketplace(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    const up = s.toUpperCase().replace(/^AMAZON\./, '');
    if (Config.MARKETPLACES[up]) return up;
    if (up === 'GB') return 'UK';
    for (const [code, mk] of Object.entries(Config.MARKETPLACES)) if (mk.name.toUpperCase() === up || mk.domain.toUpperCase() === s.toUpperCase() || mk.domain.toUpperCase().endsWith(up.toLowerCase().toUpperCase())) return code;
    return undefined;
  }
  function marketFromCurrency(c) {
    const s = String(c || '').toUpperCase();
    const hits = Object.entries(Config.MARKETPLACES).filter(([, m]) => m.currency === s);
    return hits.length === 1 ? hits[0][0] : null;
  }
  function keywordType(kw, match) {
    if (!kw) return null;
    const k = kw.toLowerCase(), st = State.get();
    if (match === 'Auto') return 'Auto';
    if (match === 'Audience') return 'Audience';
    if (match === 'Theme' || match === 'Unallocated') return match;
    const list = s => s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (list(st.competitorTerms).some(b => k.includes(b))) return 'Competitor';
    if (list(st.brandTerms).some(b => k.includes(b))) return 'Branded';
    if (/^category=/.test(k)) return 'Contextual';
    if (/^asin(-expanded)?=/.test(k)) return 'Product';
    return 'Generic';
  }

  /* ---------- 6. validate (+ normalise). Chunked so the UI stays responsive. */
  const MAX_EXCLUDED = 50000;
  function hash53(str) { // cyrb53 — compact duplicate detection for millions of rows
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  /* ctx.rows: array of rows (Excel)  |  ctx.stream: () => async iterator of [rowNo,row] (large text files)
     Valid rows are staged into a compact column table as they are read, so nothing is held twice. */
  async function validate(ctx, onProgress) {
    const { mapping, settings } = ctx;
    const rows = ctx.rows || [];
    const issues = new Map();
    const add = (rule, severity, rowNo, field) => {
      const k = rule + '|' + (field || '');
      if (!issues.has(k)) issues.set(k, { rule, severity, field, count: 0, rows: [] });
      const it = issues.get(k); it.count++; if (it.rows.length < 12 && rowNo != null) it.rows.push(rowNo);
    };
    const get = (r, f) => mapping[f] != null ? r[mapping[f]] : undefined;
    // file-level checks
    const missingReq = Config.REQUIRED_FIELDS.filter(f => mapping[f] == null && !(f === 'date' && settings.dateOverride));
    missingReq.forEach(f => add('missingColumn', 'error', null, f));
    const unitsAsOrders = mapping.orders == null && mapping.units != null && !!settings.unitsAsOrders;
    Config.RECOMMENDED_FIELDS.filter(f => mapping[f] == null).forEach(f => f === 'orders' && unitsAsOrders ? add('unitsAsOrders', 'warning', null, 'orders') : add('optionalMissing', 'warning', null, f));
    if (mapping.marketplace == null && mapping.currency == null && !settings.marketplace) add('missingMarketplace', 'error', null, 'marketplace');
    const counts = { total: 0, ok: 0, warn: 0, err: 0, dup: 0, excludedEntity: 0 };
    if (missingReq.length) return { issues: [...issues.values()], counts, ready: 0, excluded: [], blocked: true };

    const sample = ctx.sample || rows;
    const order = mapping.date != null ? dateOrder(sample.slice(0, 500).map(r => r[mapping.date])) : 'mdy';
    const staging = new ColumnTable(ctx.source, 4096);
    const excluded = [];
    const exclude = (rowNo, reason, r) => { if (excluded.length < MAX_EXCLUDED) excluded.push([rowNo, reason, r]); };
    let minDay = Infinity, maxDay = -Infinity; const mks = new Set(), grains = new Set();
    const seen = new Set();
    const metricFields = Config.BASE_METRICS.map(m => m.key).filter(k => mapping[k] != null);
    const today = Dates.toDay(new Date());
    const iter = ctx.stream ? ctx.stream() : (function* () { for (let i = 0; i < rows.length; i++) yield [ctx.headerRow + i + 2, rows[i]]; })();
    let n = 0;
    for await (const [rowNo, r] of iter) {
      if (++n % 5000 === 0) { if (!ctx.stream) onProgress && onProgress(n / rows.length); await new Promise(res => setTimeout(res)); }
      if (settings.entity && mapping.entity != null && String(get(r, 'entity')).toLowerCase() !== settings.entity.toLowerCase()) { counts.excludedEntity++; continue; }
      counts.total++;
      let err = false, warn = false;
      // date
      let day = settings.dateOverride ? Dates.fromISO(settings.dateOverride) : parseDate(get(r, 'date'), order);
      if (day == null || isNaN(day)) { add('invalidDate', 'error', rowNo, 'date'); err = true; }
      else if (day > today + 1) { add('futureDate', 'warning', rowNo, 'date'); warn = true; }
      // campaign
      const campaign = String(get(r, 'campaign') ?? '').trim();
      if (!campaign) { add('missingCampaign', 'error', rowNo, 'campaign'); err = true; }
      // marketplace
      let mk = mapping.marketplace != null ? normMarketplace(get(r, 'marketplace')) : null;
      if (mk === undefined) { add('unknownMarketplace', 'error', rowNo, 'marketplace'); err = true; }
      if (!mk && mapping.currency != null) mk = marketFromCurrency(get(r, 'currency'));
      if (!mk) mk = settings.marketplace || null;
      if (!mk && !err) { add('missingMarketplace', 'error', rowNo, 'marketplace'); err = true; }
      // ad type
      let adType = mapping.adType != null ? normAdType(get(r, 'adType')) : null;
      if (adType === undefined) { add('unknownAdType', 'warning', rowNo, 'adType'); warn = true; adType = null; }
      adType = adType || adTypeFromName(campaign) || settings.adType || 'SP';
      // metrics
      const m = {};
      for (const f of metricFields) {
        const v = parseNumber(get(r, f));
        if (v != null && isNaN(v)) { add('invalidNumber', 'error', rowNo, f); err = true; continue; }
        m[f] = v;
      }
      if (unitsAsOrders) m.orders = m.units ?? null;
      if (m.adSpend < 0) { add('negativeSpend', 'error', rowNo, 'adSpend'); err = true; }
      if (m.adSales < 0) { add('negativeSales', 'error', rowNo, 'adSales'); err = true; }
      // ad-type availability: never store 0 for metrics this ad type does not report
      Config.BASE_METRICS.forEach(b => { if (b.adTypes && !b.adTypes.includes(adType) && m[b.key] === 0) m[b.key] = null; });
      // asin
      let asin = get(r, 'asin'); asin = asin ? String(asin).trim().toUpperCase() : null;
      if (asin && !/^(B0[A-Z0-9]{8}|\d{9}[\dX])$/.test(asin)) { add('skuNotAsin', 'warning', rowNo, 'asin'); warn = true; }
      if (ctx.source === 'asin' && !asin) { add('missingAsin', 'error', rowNo, 'asin'); err = true; }
      // dimensions
      const keyword = get(r, 'keyword') != null ? String(get(r, 'keyword')).trim() : null;
      const matchType = normMatch(get(r, 'matchType'), keyword);
      let targeting = get(r, 'targeting');
      targeting = targeting ? (/auto/i.test(targeting) ? 'Auto' : 'Manual') : (matchType === 'Auto' || /\bauto\b/i.test(campaign) ? 'Auto' : 'Manual');
      const dims = {
        marketplace: mk, account: String(get(r, 'account') || settings.account || t('imp.importedAccount')).trim(),
        adType, targeting, campaign,
        campaignType: String(get(r, 'campaignType') || (adType === 'SP' ? 'SP ' + targeting : adType)).trim(),
        portfolio: String(get(r, 'portfolio') || t('imp.noPortfolio')).trim(),
        placement: normPlacement(get(r, 'placement')), keyword, matchType,
        keywordType: keywordType(keyword, matchType),
        searchTerm: get(r, 'searchTerm') != null ? String(get(r, 'searchTerm')).trim().toLowerCase() : null,
        asin, title: get(r, 'title') ? String(get(r, 'title')).trim() : (asin || null),
        brand: String(get(r, 'brand') || t('imp.unknown')).trim(), category: String(get(r, 'category') || t('imp.unknown')).trim(),
        asinStatus: get(r, 'asinStatus') ? normStatus(get(r, 'asinStatus')) : 'Active',
      };
      if (err) { counts.err++; exclude(rowNo, 'error', r); continue; }
      // duplicates (identical dimension key + date + metrics)
      const key = hash53(r.join('\u0001'));   // a duplicate is an identical line in the file
      if (seen.has(key)) { add('duplicate', 'warning', rowNo, null); counts.dup++; exclude(rowNo, 'duplicate', r); continue; }
      seen.add(key);
      counts[warn ? 'warn' : 'ok']++;
      dims.fileId = STAGING_ID;
      staging.push(day, dims, m);
      if (day < minDay) minDay = day; if (day > maxDay) maxDay = day; mks.add(mk);
      if (ctx.source === Config.MULTI) for (const g in Config.GRAIN_FILTER) if (dims[Config.GRAIN_FILTER[g]]) grains.add(g);
    }
    onProgress && onProgress(1);
    const ready = staging.length;
    return { issues: [...issues.values()], counts, ready, staging, excluded, blocked: ready === 0, order,
      minDay, maxDay, marketplaces: [...mks],
      grains: ctx.source === Config.MULTI ? ['campaign', ...['keyword', 'asin', 'placement', 'searchTerm'].filter(g => grains.has(g))] : [ctx.source] };
  }
  /* agency naming conventions carry the ad type: 'SP | WW | …', 'A/B1 SB | …', 'SBV | …', 'SD | …' */
  const AD_IN_NAME = /(?:^|[\s|/_(\[-])(SP|SBV|SB|SD)(?:$|[\s|/_)\]-])/;
  const adNameCache = new Map();
  function adTypeFromName(name) {
    if (adNameCache.has(name)) return adNameCache.get(name);
    const m = AD_IN_NAME.exec(name || ''), v = m ? (m[1] === 'SBV' ? 'SB' : m[1]) : null;
    if (adNameCache.size < 50000) adNameCache.set(name, v);
    return v;
  }
  function normStatus(v) {
    const s = String(v).toLowerCase();
    if (/out.?of.?stock|oos/.test(s)) return 'Out of Stock';
    if (/suppress/.test(s)) return 'Suppressed';
    if (/inactive|paused|archived|ineligible/.test(s)) return 'Inactive';
    return 'Active';
  }

  /* ---------- 8–9. commit */
  const STAGING_ID = '__staging__';
  function overlaps(ctx, res) {
    if (!res.ready) return [];
    return DataStore.files.filter(f => !f.demo && f.source === ctx.source && f.maxDay >= res.minDay && f.minDay <= res.maxDay && (f.marketplaces || []).some(m => res.marketplaces.includes(m)));
  }
  function commit(ctx, res, opts) {
    if (opts.replaceDemo) DataStore.clearDemo();
    (opts.replaceIds || []).forEach(id => DataStore.removeFile(id));
    const id = 'f' + Date.now().toString(36);
    const st = res.staging;
    // give the staged rows their real data-source id (one dictionary entry, no per-row work)
    const fd = st.dicts.fileId, code = fd.index.get(STAGING_ID);
    fd.values[code] = id; fd.index.delete(STAGING_ID); fd.index.set(id, code);
    if (ctx.source === Config.MULTI) res.grains.forEach(g => DataStore.table(g).appendFrom(explode(st, g)));
    else DataStore.table(ctx.source).appendFrom(st);
    DataStore.registerFile({ id, name: ctx.fileName + (ctx.sheetName && ctx.kind === 'xlsx' ? ` · ${ctx.sheetName}` : ''), source: ctx.source, grains: res.grains, rows: res.ready, minDay: res.minDay, maxDay: res.maxDay, importedAt: Date.now(), marketplaces: res.marketplaces, demo: false });
    DataStore.touch();
    return { id, min: res.minDay, max: res.maxDay, marketplaces: res.marketplaces };
  }

  /* roll a staged multi-level table up to one grain (sums; impression-weighted for share metrics) */
  function explode(st, g) {
    const n = st.length, T = new ColumnTable(g, 1024);
    const idDims = ['marketplace', 'campaign', ...Config.GRAIN_ID[g]];
    const cols = idDims.map(d => st.dimCols[d]), radix = idDims.map(d => Math.max(1, st.dicts[d].values.length));
    const minDay = st.minDay, span = st.maxDay - st.minDay + 1;
    const numeric = radix.reduce((a, b) => a * b, span) < 2 ** 52;
    const fdim = Config.GRAIN_FILTER[g], fcol = fdim ? st.dimCols[fdim] : null, empty = fdim ? st.dicts[fdim].index.get('') : undefined;
    const ks = st.activeMetrics(), W = ks.map(k => !!Config.BASE_METRICS[k].weight), IMPR = 2;
    const groups = new Map(), rep = [], sums = ks.map(() => []), cnts = ks.map(() => []), wts = ks.map(() => []);
    for (let i = 0; i < n; i++) {
      if (fcol && fcol[i] === empty) continue;
      let key;
      if (numeric) { key = st.day[i] - minDay; for (let c = 0; c < cols.length; c++) key = key * radix[c] + cols[c][i]; }
      else key = st.day[i] + '|' + cols.map(c => c[i]).join('|');
      let gi = groups.get(key);
      if (gi === undefined) { gi = rep.length; groups.set(key, gi); rep.push(i); ks.forEach((_, j) => { sums[j].push(0); cnts[j].push(0); wts[j].push(0); }); }
      const impr = st.metrics[IMPR][i];
      for (let j = 0; j < ks.length; j++) {
        const v = st.metrics[ks[j]][i];
        if (v !== v) continue;
        if (W[j]) { const w = impr === impr ? impr : 0; sums[j][gi] += v * w; wts[j][gi] += w; } else sums[j][gi] += v;
        cnts[j][gi]++;
      }
    }
    const dims = {}, m = {};
    for (let gi = 0; gi < rep.length; gi++) {
      const i = rep[gi];
      for (const d of T.dims) dims[d] = st.dicts[d].values[st.dimCols[d][i]];
      Config.BASE_METRICS.forEach(b => { m[b.key] = null; });
      ks.forEach((k, j) => { m[Config.BASE_METRICS[k].key] = !cnts[j][gi] ? null : W[j] ? (wts[j][gi] ? sums[j][gi] / wts[j][gi] : null) : sums[j][gi]; });
      T.push(st.day[i], dims, m);
    }
    return T;
  }

  function template() {
    const h = ['Date', 'Marketplace', 'Ad Type', 'Portfolio name', 'Campaign Name', 'Targeting', 'Match Type', 'Customer Search Term', 'Impressions', 'Clicks', 'Spend', '7 Day Total Sales', '7 Day Total Orders (#)', '7 Day Total Units (#)'];
    const r = [['2026-09-01', 'US', 'Sponsored Products', 'Core Scrubs', 'Core Pants – Exact', 'scrub pants women', 'EXACT', 'scrub pants women', '12840', '104', '96.20', '412.50', '13', '14']];
    return [h, ...r];
  }

  return { readFile, parseCSV, streamRows, dataRows, detectHeaderRow, autoMap, refineMapping, detectSource, validate, overlaps, commit, template, parseNumber, parseDate, norm };
})();
