/* ==========================================================================
   EXPORT ENGINE — CSV, Excel (multi-sheet), PowerPoint (10-slide deck), PDF.
   All exports read the same report package built from Reports/TableDefs,
   so exported numbers always equal what is on screen.
   ========================================================================== */
const Exporter = (() => {
  // downloads capability (Claude viewer) — resolves to null elsewhere
  const dlP = (async () => { try { return window.claude ? await window.claude.use('downloads') : null; } catch { return null; } })();

  async function save(filename, data, mime) {
    const downloads = await dlP;
    if (downloads) {
      try { await downloads.save({ filename, data }); App.toast(t('toast.saved', { file: filename })); }
      catch (e) { if (e && e.code !== 'declined') App.toast(t('toast.saveFailed', { reason: e.code || e.message || '' }), 'error'); }
      return;
    }
    // fallback for use outside the Claude viewer (e.g. self-hosted)
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    App.toast(t('toast.saved', { file: filename }));
  }
  const csvCell = v => { if (v == null) return ''; const s = String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function csv(filename, headers, rows) {
    const text = '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    return save(filename, new Blob([text], { type: 'text/csv;charset=utf-8' }), 'text/csv');
  }
  function stamp() { const d = new Date(); return d.toISOString().slice(0, 10); }
  function baseName() { const s = State.get(); return `amazon-ads-${s.marketplace.toLowerCase()}-${stamp()}`; }

  /* ---------- report package */
  function collect() {
    const st = State.get(), k = Reports.kpis();
    const tables = {};
    ['portfolio', 'campaign', 'placement', 'keyword', 'searchTerm', 'asin'].forEach(kind => {
      const res = TableDefs.dimRows(kind);
      const cols = TableDefs.defs[kind]();
      tables[kind] = { title: t('nav.' + (kind === 'searchTerm' ? 'searchTerms' : kind === 'asin' ? 'asins' : kind === 'portfolio' ? 'portfolio' : kind + 's')), cols, rows: res.rows.sort((a, b) => (b.m.adSales || 0) - (a.m.adSales || 0)) };
    });
    const periods = {};
    ['week', 'month', 'quarter', 'year'].forEach(g => { periods[g] = TableDefs.periodRows(g, st.periodCounts[g]); });
    const life = Reports.lifetime();
    return {
      meta: {
        marketplace: st.marketplace, currency: I18n.currency(), demo: DataStore.isDemo,
        range: k.range ? I18n.range(k.range[0], k.range[1]) : '', cmp: k.cmpRange ? I18n.range(k.cmpRange[0], k.cmpRange[1]) : t('cmp.none'),
        filters: App.filterSummary(), generated: new Date().toLocaleString(I18n.locale()),
      },
      kpis: k, periods, lifetime: { label: t('nav.lifetime'), m: life.total?.v || {} }, tables, insights: Insights.build(),
    };
  }
  const KPI_KEYS = ['adSpend', 'adSales', 'roas', 'acos', 'impressions', 'clicks', 'orders', 'ctr'];

  /* ---------- Excel */
  const XFMT = { currency: '#,##0.00', currency2: '#,##0.00', int: '#,##0', pct: '0.00"%"', ratio: '0.00' };
  async function xlsx() {
    App.busy(t('exp.building', { what: 'Excel' }));
    try {
      const XLSX = await Libs.xlsx(); const P = collect(); const wb = XLSX.utils.book_new();
      const addSheet = (name, aoa, fmts = {}, widths) => {
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        Object.entries(fmts).forEach(([col, z]) => { for (let r = 1; r < aoa.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: +col }); if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = z; } });
        ws['!cols'] = (widths || aoa[0].map((_, i) => i === 0 ? 34 : 14)).map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
      };
      // Summary
      const S = [[t('exp.report'), t('app.title')], [t('exp.dataset'), P.meta.demo ? t('demo.label') : t('exp.imported')], [t('hdr.marketplace'), P.meta.marketplace + ' (' + P.meta.currency + ')'],
        [t('exp.period'), P.meta.range], [t('exp.comparison'), P.meta.cmp], [t('exp.filters'), P.meta.filters || t('common.none')], [t('exp.generated'), P.meta.generated], [],
        [t('col.metric'), t('exp.current'), t('exp.previous'), t('exp.change')]];
      const V = P.kpis.cur.total?.v || {}, PV = P.kpis.prev?.total?.v;
      Object.keys(Config.METRICS).forEach(key => { const ch = PV ? Metrics.change(key, V[key], PV[key]) : null; S.push([I18n.metricLabel(key), TableDefs.rnd(key, V[key]) ?? 'N/A', PV ? (TableDefs.rnd(key, PV[key]) ?? 'N/A') : '', ch ? +(ch.pct / 100).toFixed(4) : '']); });
      const ws = XLSX.utils.aoa_to_sheet(S); ws['!cols'] = [{ wch: 30 }, { wch: 22 }, { wch: 22 }, { wch: 12 }];
      for (let r = 9; r < S.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: 3 }); if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '0.0%'; }
      XLSX.utils.book_append_sheet(wb, ws, t('exp.summary').slice(0, 31));
      // Period sheets (value + change columns)
      const periodSheet = (name, pr, withDelta = true) => {
        const cols = TableDefs.defs.period('delta');
        const head = [cols[0].label]; const fm = {};
        cols.slice(1).forEach(c => { fm[head.length] = XFMT[Config.METRICS[c.metric].fmt]; head.push(c.label); if (withDelta) { fm[head.length] = '0.0%'; head.push(c.label + ' Δ'); } });
        const aoa = [head, ...pr.rows.map(r => { const row = [r.label + (r.sub ? ` (${r.sub})` : '')]; cols.slice(1).forEach(c => { row.push(TableDefs.rnd(c.metric, r.m[c.metric]) ?? 'N/A'); if (withDelta) { const ch = r.prev ? Metrics.change(c.metric, r.m[c.metric], r.prev[c.metric]) : null; row.push(ch ? +(ch.pct / 100).toFixed(4) : ''); } }); return row; })];
        addSheet(name, aoa, fm);
      };
      periodSheet(t('nav.wow'), P.periods.week); periodSheet(t('nav.mom'), P.periods.month); periodSheet(t('nav.qoq'), P.periods.quarter); periodSheet(t('nav.yoy'), P.periods.year);
      const lcols = TableDefs.defs.lifetime();
      const lfm = {}; lcols.slice(1).forEach((c, i) => { lfm[i + 1] = XFMT[Config.METRICS[c.metric].fmt]; });
      addSheet(t('nav.lifetime'), [lcols.map(c => c.label), [t('nav.lifetime'), ...lcols.slice(1).map(c => TableDefs.rnd(c.metric, P.lifetime.m[c.metric]) ?? 'N/A')]], lfm);
      // dimension sheets
      Object.values(P.tables).forEach(tb => {
        const head = [], fm = {};
        tb.cols.forEach(c => {
          if (c.kind === 'metric' && Config.METRICS[c.metric]) fm[head.length] = XFMT[Config.METRICS[c.metric].fmt];
          else if (c.key.startsWith('g_')) fm[head.length] = '0.0"%"';
          head.push(c.label);
          if (c.sub === 'share') { fm[head.length] = '0.0"%"'; head.push(c.label + ' % ' + t('common.ofTotal')); }
        });
        const aoa = [head, ...tb.rows.map(r => { const row = []; tb.cols.forEach(c => { const v = TableDefs.exportValue(c, r); row.push(v == null ? (c.kind === 'metric' ? 'N/A' : '') : v); if (c.sub === 'share') row.push(TableDefs.rnd(null, r.share?.[c.metric]) ?? ''); }); return row; })];
        addSheet(tb.title, aoa, fm);
      });
      addSheet(t('nav.insights'), [[t('ins.kind'), t('ins.observation'), t('ins.recommendation')], ...P.insights.map(i => [t('kind.' + i.kind), i.obs, i.rec || ''])], {}, [16, 90, 90]);
      addSheet(t('exp.definitions'), [[t('col.metric'), t('exp.formula'), t('exp.direction')], ...Object.keys(Config.METRICS).map(k => [I18n.metricLabel(k), t('def.' + k), t('dir.' + Config.metricDirection[k])])], {}, [30, 70, 14]);
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      await save(baseName() + '.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) { App.toast(t('toast.exportFailed', { reason: e.message }), 'error'); console.error(e); }
    finally { App.busy(false); }
  }

  /* ---------- PowerPoint */
  const PX = { ink: '16233D', muted: '67758D', blue: '2469E8', purple: '6C46D9', line: 'DFE7F1', canvas: 'EEF3F9', green: '168456', red: 'D54955', soft: 'F7FAFF' };
  function deltaRun(key, cur, prev, size = 8) {
    const ch = prev ? Metrics.change(key, cur, prev) : null;
    if (!ch) return { text: '—', options: { color: PX.muted, fontSize: size } };
    return { text: (ch.flat ? '' : ch.up ? '↑ ' : '↓ ') + I18n.delta(ch.pct), options: { color: ch.tone === 'good' ? PX.green : ch.tone === 'bad' ? PX.red : PX.muted, fontSize: size } };
  }
  async function pptx() {
    App.busy(t('exp.building', { what: 'PowerPoint' }));
    try {
      const Pptx = await Libs.pptx(); const P = collect();
      const deck = new Pptx(); deck.layout = 'LAYOUT_WIDE'; deck.title = t('app.title');
      const font = 'Calibri';
      const frame = (title, kicker) => {
        const s = deck.addSlide(); s.background = { color: 'FFFFFF' };
        s.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.08, fill: { color: PX.blue } });
        s.addText(kicker.toUpperCase(), { x: 0.5, y: 0.3, w: 9, h: 0.3, fontFace: font, fontSize: 10, bold: true, color: PX.blue, charSpacing: 3 });
        s.addText(title, { x: 0.5, y: 0.58, w: 10, h: 0.55, fontFace: font, fontSize: 24, bold: true, color: PX.ink });
        s.addText(`${P.meta.marketplace} · ${P.meta.range}${P.meta.demo ? ' · ' + t('demo.label') : ''}`, { x: 7.8, y: 0.3, w: 5.03, h: 0.3, fontFace: font, fontSize: 9, color: P.meta.demo ? PX.red : PX.muted, align: 'right' });
        s.addText(t('exp.footer', { date: P.meta.generated }), { x: 0.5, y: 7.1, w: 12.3, h: 0.25, fontFace: font, fontSize: 8, color: PX.muted });
        return s;
      };
      const V = P.kpis.cur.total?.v || {}, PV = P.kpis.prev?.total?.v;
      // 1 Executive summary
      let s = frame(t('ppt.exec'), t('app.eyebrow'));
      s.addText([{ text: t('exp.period') + ': ', options: { bold: true } }, { text: P.meta.range + '   ' }, { text: t('exp.comparison') + ': ', options: { bold: true } }, { text: P.meta.cmp }], { x: 0.5, y: 1.25, w: 12.3, h: 0.3, fontFace: font, fontSize: 11, color: PX.muted });
      if (P.meta.filters) s.addText(t('exp.filters') + ': ' + P.meta.filters, { x: 0.5, y: 1.55, w: 12.3, h: 0.3, fontFace: font, fontSize: 10, color: PX.muted });
      ['adSales', 'adSpend', 'roas', 'acos'].forEach((k, i) => {
        const x = 0.5 + i * 3.1;
        s.addShape(deck.ShapeType.roundRect, { x, y: 2.0, w: 2.9, h: 1.35, fill: { color: PX.soft }, line: { color: PX.line }, rectRadius: 0.08 });
        s.addText(I18n.metricLabel(k).toUpperCase(), { x: x + 0.2, y: 2.1, w: 2.5, h: 0.3, fontFace: font, fontSize: 9, bold: true, color: PX.muted });
        s.addText([{ text: I18n.metric(k, V[k]), options: { fontSize: 26, bold: true, color: PX.ink, breakLine: true } }, deltaRun(k, V[k], PV?.[k], 11)], { x: x + 0.2, y: 2.4, w: 2.5, h: 0.85, fontFace: font, valign: 'top' });
      });
      s.addText(t('ppt.keyFindings'), { x: 0.5, y: 3.65, w: 12, h: 0.35, fontFace: font, fontSize: 14, bold: true, color: PX.ink });
      s.addText(P.insights.slice(0, 5).map(i => ({ text: i.obs, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 4.05, w: 12.3, h: 2.9, fontFace: font, fontSize: 12, color: '3B4B64', valign: 'top', paraSpaceAfter: 6 });
      // 2 KPI performance
      s = frame(t('ppt.kpi'), t('nav.overview'));
      KPI_KEYS.forEach((k, i) => {
        const x = 0.5 + (i % 4) * 3.1, y = 1.4 + Math.floor(i / 4) * 1.75;
        s.addShape(deck.ShapeType.roundRect, { x, y, w: 2.9, h: 1.55, fill: { color: 'FFFFFF' }, line: { color: PX.line }, rectRadius: 0.08 });
        s.addText(I18n.metricLabel(k).toUpperCase(), { x: x + 0.2, y: y + 0.12, w: 2.5, h: 0.3, fontFace: font, fontSize: 9, bold: true, color: PX.muted });
        s.addText([{ text: I18n.metric(k, V[k]), options: { fontSize: 28, bold: true, color: PX.ink, breakLine: true } }, deltaRun(k, V[k], PV?.[k], 11)], { x: x + 0.2, y: y + 0.45, w: 2.5, h: 0.95, fontFace: font, valign: 'top' });
      });
      s.addText(t('ppt.vs', { cmp: P.meta.cmp }), { x: 0.5, y: 5.1, w: 12, h: 0.3, fontFace: font, fontSize: 10, color: PX.muted });
      // 3-4 WoW / MoM
      const periodSlide = (title, kicker, pr) => {
        const s = frame(title, kicker);
        const rows = [...pr.rows].reverse();
        if (rows.length) s.addChart(deck.ChartType.bar, [
          { name: I18n.metricLabel('adSpend'), labels: rows.map(r => r.label), values: rows.map(r => r.m.adSpend || 0) },
          { name: I18n.metricLabel('adSales'), labels: rows.map(r => r.label), values: rows.map(r => r.m.adSales || 0) }],
          { x: 0.5, y: 1.3, w: 12.3, h: 2.6, barDir: 'col', barGapWidthPct: 60, chartColors: ['2F7BF5', '5B2BC0'], showLegend: true, legendPos: 't', legendFontSize: 9, catAxisLabelFontSize: 8, valAxisLabelFontSize: 8, valGridLine: { color: 'E5EBF3', size: 0.5 }, valAxisLabelFormatCode: '#,##0' });
        const keys = ['adSpend', 'adSales', 'roas', 'acos', 'orders', 'units', 'ctr', 'cvr'];
        const head = [t('col.period'), ...keys.map(k => I18n.metricLabel(k))].map(h => ({ text: h, options: { bold: true, color: PX.muted, fill: { color: 'FBFCFE' }, fontSize: 8 } }));
        const body = pr.rows.slice(0, 6).map(r => [{ text: r.label, options: { bold: true, color: PX.ink } }, ...keys.map(k => ({ text: [{ text: I18n.metric(k, r.m[k]), options: { breakLine: true, color: '40516C' } }, deltaRun(k, r.m[k], r.prev?.[k], 7)], options: { align: 'right' } }))]);
        s.addTable([head, ...body], { x: 0.5, y: 4.05, w: 12.3, fontFace: font, fontSize: 9, border: { type: 'solid', color: PX.line, pt: 0.5 }, colW: [1.9, ...keys.map(() => 1.3)], rowH: 0.42, valign: 'middle' });
        return s;
      };
      periodSlide(t('ppt.wow'), t('nav.wow'), P.periods.week);
      periodSlide(t('ppt.mom'), t('nav.mom'), P.periods.month);
      // 5-9 dimension slides
      const dimSlide = (tb, title, kicker, keys, chart = true, limit = 10) => {
        const s = frame(title, kicker);
        const rows = tb.rows.slice(0, limit);
        let y = 1.3;
        if (chart && rows.length) {
          const cr = rows.slice(0, 8);
          s.addChart(deck.ChartType.bar, [
            { name: I18n.metricLabel('adSpend'), labels: cr.map(r => r.id.slice(0, 28)), values: cr.map(r => r.m.adSpend || 0) },
            { name: I18n.metricLabel('adSales'), labels: cr.map(r => r.id.slice(0, 28)), values: cr.map(r => r.m.adSales || 0) }],
            { x: 0.5, y, w: 12.3, h: 2.4, barDir: 'bar', barGapWidthPct: 50, chartColors: ['2F7BF5', '5B2BC0'], showLegend: true, legendPos: 't', legendFontSize: 9, catAxisLabelFontSize: 8, valAxisLabelFontSize: 8, catAxisOrientation: 'maxMin', valAxisLabelFormatCode: '#,##0' });
          y = 3.85;
        }
        const first = tb.cols[0];
        const head = [first.label, ...keys.map(k => I18n.metricLabel(k))].map(h => ({ text: h, options: { bold: true, color: PX.muted, fill: { color: 'FBFCFE' }, fontSize: 8 } }));
        const body = rows.slice(0, chart ? 7 : 12).map(r => [{ text: String(r.id).slice(0, 42), options: { bold: true, color: PX.ink } }, ...keys.map(k => {
          const main = { text: I18n.metric(k, r.m[k]), options: { color: '40516C', breakLine: (k === 'adSpend' || k === 'adSales') } };
          return { text: (k === 'adSpend' || k === 'adSales') && r.share[k] != null ? [main, { text: I18n.pct(r.share[k], 1), options: { color: PX.muted, fontSize: 7 } }] : [main], options: { align: 'right' } };
        })]);
        s.addTable([head, ...body], { x: 0.5, y, w: 12.3, fontFace: font, fontSize: 9, border: { type: 'solid', color: PX.line, pt: 0.5 }, colW: [3.1, ...keys.map(() => 9.2 / keys.length)], rowH: chart ? 0.4 : 0.38, valign: 'middle' });
      };
      const K = ['adSpend', 'adSales', 'roas', 'acos', 'orders', 'cvr', 'cpc', 'ctr'];
      dimSlide(P.tables.portfolio, t('ppt.portfolio'), t('nav.portfolio'), K);
      dimSlide(P.tables.campaign, t('ppt.campaign'), t('nav.campaigns'), K, false);
      dimSlide(P.tables.placement, t('ppt.placement'), t('nav.placements'), K);
      dimSlide(P.tables.keyword, t('ppt.keyword'), t('nav.keywords'), K, false);
      dimSlide(P.tables.asin, t('ppt.asin'), t('nav.asins'), K, false);
      // 10 insights
      s = frame(t('ppt.insights'), t('nav.insights'));
      s.addText(t('ins.observations'), { x: 0.5, y: 1.3, w: 6, h: 0.35, fontFace: font, fontSize: 13, bold: true, color: PX.ink });
      s.addText(P.insights.slice(0, 7).map(i => ({ text: i.obs, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.7, w: 6.4, h: 5.2, fontFace: font, fontSize: 11, color: '3B4B64', valign: 'top', paraSpaceAfter: 6 });
      s.addShape(deck.ShapeType.roundRect, { x: 7.2, y: 1.3, w: 5.6, h: 5.6, fill: { color: 'F4F2FF' }, line: { color: 'DBE7FB' }, rectRadius: 0.1 });
      s.addText(t('ins.recommendations'), { x: 7.45, y: 1.45, w: 5.1, h: 0.35, fontFace: font, fontSize: 13, bold: true, color: PX.purple });
      const recs = [...new Set(P.insights.filter(i => i.rec).map(i => i.rec))].slice(0, 6);
      s.addText(recs.length ? recs.map(r => ({ text: r, options: { bullet: true, breakLine: true } })) : t('ins.noRecs'), { x: 7.45, y: 1.85, w: 5.1, h: 4.9, fontFace: font, fontSize: 11, color: '3B4B64', valign: 'top', paraSpaceAfter: 6 });
      const out = await deck.write({ outputType: 'arraybuffer' });
      await save(baseName() + '.pptx', new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
    } catch (e) { App.toast(t('toast.exportFailed', { reason: e.message }), 'error'); console.error(e); }
    finally { App.busy(false); }
  }

  /* ---------- PDF (latin fonts: Hindi / Japanese labels fall back to English) */
  async function pdf() {
    App.busy(t('exp.building', { what: 'PDF' }));
    const lang = I18n.getLang(), swap = ['hi', 'ja'].includes(lang);
    try {
      const jsPDF = await Libs.pdf();
      if (swap) I18n.setLang('en');
      const P = collect();
      const clean = s => String(s ?? '').replace(/₹/g, 'Rs ').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x00-\xFF€]/g, '');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      const header = (title, kicker) => {
        doc.setFillColor(36, 105, 232); doc.rect(0, 0, W, 5, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(36, 105, 232); doc.text(clean(kicker.toUpperCase()), 36, 30);
        doc.setFontSize(18); doc.setTextColor(22, 35, 61); doc.text(clean(title), 36, 52);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(103, 117, 141);
        doc.text(clean(`${P.meta.marketplace} · ${P.meta.range} · vs ${P.meta.cmp}${P.meta.demo ? ' · ' + t('demo.label') : ''}`), W - 36, 30, { align: 'right' });
      };
      const V = P.kpis.cur.total?.v || {}, PV = P.kpis.prev?.total?.v;
      header(t('ppt.exec'), t('app.eyebrow'));
      KPI_KEYS.forEach((k, i) => {
        const x = 36 + (i % 4) * ((W - 72) / 4), y = 72 + Math.floor(i / 4) * 70, w = (W - 72) / 4 - 10;
        doc.setDrawColor(223, 231, 241); doc.roundedRect(x, y, w, 60, 6, 6, 'S');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(117, 131, 154); doc.text(clean(I18n.metricLabel(k).toUpperCase()), x + 10, y + 15);
        doc.setFontSize(16); doc.setTextColor(25, 41, 70); doc.text(clean(I18n.metric(k, V[k])), x + 10, y + 36);
        const ch = PV ? Metrics.change(k, V[k], PV[k]) : null;
        if (ch) { const c = ch.tone === 'good' ? [22, 132, 86] : ch.tone === 'bad' ? [213, 73, 85] : [113, 128, 150]; doc.setFontSize(8); doc.setTextColor(...c); doc.text((ch.up ? '+' : '-') + I18n.delta(ch.pct), x + 10, y + 50); }
      });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(22, 35, 61); doc.text(clean(t('ppt.keyFindings')), 36, 228);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(59, 75, 100);
      let y = 246;
      P.insights.slice(0, 8).forEach(i => { const lines = doc.splitTextToSize('• ' + clean(i.obs), W - 72); doc.text(lines, 36, y); y += lines.length * 12 + 4; });
      const tableOpts = { theme: 'grid', styles: { font: 'helvetica', fontSize: 7, cellPadding: 4, lineColor: [223, 231, 241], textColor: [64, 81, 108] }, headStyles: { fillColor: [251, 252, 254], textColor: [108, 123, 146], fontStyle: 'bold' }, margin: { left: 36, right: 36, top: 70 } };
      const periodPage = (title, kicker, pr) => {
        doc.addPage(); header(title, kicker);
        const keys = ['adSpend', 'adSales', 'impressions', 'clicks', 'ctr', 'cpc', 'orders', 'units', 'cvr', 'acos', 'roas'];
        const deltas = [];
        const body = pr.rows.map((r, ri) => { deltas[ri] = keys.map(k => r.prev ? Metrics.change(k, r.m[k], r.prev[k]) : null); return [clean(r.label + (r.sub ? '\n' + r.sub : '')), ...keys.map(k => clean(I18n.metric(k, r.m[k])) + '\n ')]; });
        doc.autoTable({ ...tableOpts, startY: 70, head: [[t('col.period'), ...keys.map(k => clean(I18n.metricLabel(k)))]], body, columnStyles: Object.fromEntries(keys.map((_, i) => [i + 1, { halign: 'right' }])),
          didDrawCell: d => { if (d.section !== 'body' || d.column.index === 0) return; const ch = deltas[d.row.index]?.[d.column.index - 1]; if (!ch) return; const c = ch.tone === 'good' ? [22, 132, 86] : ch.tone === 'bad' ? [213, 73, 85] : [113, 128, 150]; doc.setFontSize(6.5); doc.setTextColor(...c); doc.text((ch.up ? '+' : '-') + I18n.delta(ch.pct), d.cell.x + d.cell.width - 4, d.cell.y + d.cell.height - 4, { align: 'right' }); } });
      };
      periodPage(t('ppt.wow'), t('nav.wow'), P.periods.week);
      periodPage(t('ppt.mom'), t('nav.mom'), P.periods.month);
      const dimPage = (tb, title, kicker) => {
        doc.addPage(); header(title, kicker);
        const cols = tb.cols.filter(c => !['campaignType', 'budget', 'budgetUtil', 'tosIs', 'searchIs', 'title', 'category', 'brand', 'keywordType'].includes(c.key)).slice(0, 16);
        doc.autoTable({ ...tableOpts, startY: 70, head: [cols.map(c => clean(c.label))],
          body: tb.rows.slice(0, 40).map(r => cols.map(c => { const v = TableDefs.exportValue(c, r); if (c.kind !== 'metric') return clean(v ?? ''); if (c.key.startsWith('g_')) return v == null ? '-' : (v >= 0 ? '+' : '') + I18n.delta(v); const main = clean(I18n.metric(c.metric, v)); return c.sub === 'share' && r.share?.[c.metric] != null ? main + '\n' + I18n.pct(r.share[c.metric], 1) : main; })),
          columnStyles: Object.fromEntries(cols.map((c, i) => [i, { halign: c.kind === 'metric' ? 'right' : 'left' }])) });
      };
      dimPage(P.tables.portfolio, t('ppt.portfolio'), t('nav.portfolio'));
      dimPage(P.tables.campaign, t('ppt.campaign'), t('nav.campaigns'));
      dimPage(P.tables.placement, t('ppt.placement'), t('nav.placements'));
      dimPage(P.tables.keyword, t('ppt.keyword'), t('nav.keywords'));
      dimPage(P.tables.asin, t('ppt.asin'), t('nav.asins'));
      doc.addPage(); header(t('ppt.insights'), t('nav.insights'));
      doc.autoTable({ ...tableOpts, startY: 70, head: [[t('ins.kind'), t('ins.observation'), t('ins.recommendation')]], body: P.insights.map(i => [clean(t('kind.' + i.kind)), clean(i.obs), clean(i.rec || '-')]), columnStyles: { 0: { cellWidth: 70 } }, styles: { ...tableOpts.styles, fontSize: 8 } });
      const pages = doc.getNumberOfPages();
      for (let p = 1; p <= pages; p++) { doc.setPage(p); doc.setFontSize(7); doc.setTextColor(150, 160, 175); doc.text(clean(t('exp.footer', { date: P.meta.generated })) + `  ·  ${p}/${pages}`, 36, doc.internal.pageSize.getHeight() - 18); }
      if (swap) I18n.setLang(lang);
      await save(baseName() + '.pdf', doc.output('blob'));
    } catch (e) { if (swap) I18n.setLang(lang); App.toast(t('toast.exportFailed', { reason: e.message }), 'error'); console.error(e); }
    finally { App.busy(false); }
  }

  /* CSV of the current page's primary report */
  function currentCSV() {
    const id = document.querySelector('.dt')?.id?.slice(3);
    if (id) return DataTable.exportCSV(id);
    const P = TableDefs.periodRows('week', State.get().periodCounts.week), cols = TableDefs.defs.period('delta');
    csv(baseName() + '-wow.csv', cols.map(c => c.label), P.rows.map(r => cols.map(c => TableDefs.exportValue(c, r) ?? '')));
  }
  return { save, csv, xlsx, pptx, pdf, currentCSV };
})();
