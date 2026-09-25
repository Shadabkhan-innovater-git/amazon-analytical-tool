/* ==========================================================================
   IMPORT WIZARD — the 10-step upload workflow UI on top of ImportService.
   ========================================================================== */
const ImportWizard = (() => {
  const STEPS = ['upload', 'detect', 'headers', 'map', 'preview', 'validate', 'review', 'import', 'build', 'refresh'];
  let W = null; // wizard state
  let working = false;

  function fresh() { return { step: 0, screen: 'upload', file: null, parsed: null, sheetIdx: 0, headerRow: 0, headers: [], rows: [], mapping: {}, confidence: {}, unmapped: [], settings: {}, source: 'campaign', result: null, error: null, progress: 0, replaceDemo: DataStore.isDemo, replaceIds: [] }; }
  function open() { if (!State.can('import')) return App.toast(t('role.noImport'), 'error'); W = fresh(); draw(); }
  function close() { if (working) return; W = null; App.modal(null); }

  function stepper() {
    return `<ol class="stepper">${STEPS.map((s, i) => `<li class="${i < W.step ? 'done' : i === W.step ? 'on' : ''}"><span>${i < W.step ? icon('check') : i + 1}</span>${esc(t('imp.step.' + s))}</li>`).join('')}</ol>`;
  }
  function frame(body, foot = '') {
    return `<div class="wiz-head"><div><div class="report-kicker">${esc(t('imp.kicker'))}</div><h2 class="report-title">${esc(t('imp.title'))}</h2></div><button type="button" class="icon-btn" data-wiz="close" aria-label="${esc(t('common.close'))}">${icon('x')}</button></div>
      ${stepper()}<div class="wiz-body">${W.error ? `<div class="notice error">${icon('error')}<span>${esc(W.error)}</span></div>` : ''}${body}</div>${foot ? `<div class="wiz-foot">${foot}</div>` : ''}`;
  }

  function draw() {
    if (!W) return;
    const s = W.screen;
    let html = '';
    if (s === 'upload') html = frame(`<label class="dropzone" id="dropzone" for="imp-file">${icon('upload', 'big')}<strong>${esc(t('imp.drop'))}</strong><span>${esc(Api.enabled ? t('api.dropSub', { mb: I18n.int(Api.limits.maxUploadMb || 2048, false) }) : t('imp.dropSub'))}</span><input type="file" id="imp-file" accept=".csv,.tsv,.txt,.xlsx,.xls,.zip,.gz" hidden></label>
      <div class="imp-help"><div><strong>${esc(t('imp.supported'))}</strong><p>${esc(t('imp.supportedList'))}</p></div><div><strong>${esc(t('imp.privacy'))}</strong><p>${esc(t('imp.privacyText'))}</p></div></div>
      <button type="button" class="link-btn" data-template>${esc(t('set.template'))}</button>`);
    if (s === 'reading') html = frame(`<div class="center-pad"><span class="spinner"></span><p id="up-msg">${esc(W.server ? t('api.uploading', { file: W.file.name, pct: 0 }) : t('imp.reading', { file: W.file.name }))}</p>${W.server ? '<div class="progress"><i id="up-bar" style="width:0%"></i></div>' : ''}</div>`);
    if (s === 'detect') html = frame(detectScreen(), `<button type="button" class="action-btn" data-wiz="back">${esc(t('common.back'))}</button><button type="button" class="action-btn export" data-wiz="to-map">${esc(t('imp.next.map'))}</button>`);
    if (s === 'map') html = frame(mapScreen(), `<button type="button" class="action-btn" data-wiz="to-detect">${esc(t('common.back'))}</button><button type="button" class="action-btn export" data-wiz="validate">${esc(t('imp.next.validate'))}</button>`);
    if (s === 'validating') html = frame(`<div class="center-pad"><span class="spinner"></span><p>${esc(t('imp.validating'))}</p>${W.server ? `<p class="fine">${esc(t('api.bigNote'))}</p>` : `<div class="progress"><i style="width:${Math.round(W.progress * 100)}%"></i></div><p class="fine"><span id="val-pct">${Math.round(W.progress * 100)}%</span>${W.parsed?.streaming ? ' · ' + esc(t('imp.streamNote')) : ''}</p>`}</div>`);
    if (s === 'review') html = frame(reviewScreen(), `<button type="button" class="action-btn" data-wiz="to-map">${esc(t('imp.back.map'))}</button><button type="button" class="action-btn export" data-wiz="commit" ${W.result.blocked ? 'disabled' : ''}>${esc(t('imp.next.import', { n: I18n.int(readyCount(), false) }))}</button>`);
    if (s === 'committing' || s === 'done') html = frame(doneScreen() + (s === 'committing' && W.server ? `<p class="fine">${esc(t('api.bigNote'))}</p>` : ''), s === 'done' ? `<button type="button" class="action-btn" data-wiz="another">${esc(t('imp.another'))}</button><button type="button" class="action-btn export" data-wiz="finish">${esc(t('imp.viewDash'))}</button>` : '');
    App.modal(html, 'wizard');
  }

  function detectScreen() {
    const P = W.parsed, sh = P.sheets[W.sheetIdx];
    const det = ImportService.detectSource(W.mapping, sh.name, W.file.name);
    const mkOpts = Object.keys(Config.MARKETPLACES);
    return `<div class="det-grid">
      <div class="det-card"><span class="lbl">${esc(t('imp.fileType'))}</span><strong>${esc(P.kind.toUpperCase())}</strong><span class="fine">${esc(W.file.name)} · ${W.file.size >= 1048576 ? I18n.num(W.file.size / 1048576, 1) + ' MB' : I18n.int(Math.round(W.file.size / 1024), false) + ' KB'}</span></div>
      <div class="det-card"><span class="lbl">${esc(t('imp.rowsFound'))}</span><strong>${W.totalRows == null ? esc(t('imp.rowsLater')) : (W.totalApprox ? '≈ ' : '') + I18n.int(W.totalRows, false)}</strong><span class="fine">${esc(t('imp.headerAt', { n: W.headerRow + 1 }))}</span></div>
      <div class="det-card"><span class="lbl">${esc(t('imp.detected'))}</span><strong>${esc(t('source.' + det.source))}</strong><span class="fine">${det.bulk ? esc(t('imp.bulkDetected')) : esc(t('imp.detectedHint'))}</span></div>
    </div>
    <div class="form-grid">
      ${P.sheets.length > 1 ? `<label>${esc(t('imp.sheet'))}<select id="w-sheet" class="period-select">${P.sheets.map((x, i) => `<option value="${i}" ${i === W.sheetIdx ? 'selected' : ''}>${esc(x.name)} (${x.rows.length ?? x.rows})</option>`).join('')}</select></label>` : ''}
      <label>${esc(t('imp.headerRow'))}<input type="number" id="w-header" class="text-in" min="1" max="20" value="${W.headerRow + 1}"></label>
      <label>${esc(t('imp.reportType'))}<select id="w-source" class="period-select">${Object.keys(Config.SOURCES).map(x => `<option value="${x}" ${W.source === x ? 'selected' : ''}>${esc(t('source.' + x))}</option>`).join('')}</select></label>
      <label>${esc(t('imp.defaultAdType'))}<select id="w-adtype" class="period-select">${Object.keys(Config.AD_TYPES).map(a => `<option value="${a}" ${W.settings.adType === a ? 'selected' : ''}>${a} · ${esc(t('adType.' + a))}</option>`).join('')}</select><span class="fine">${esc(W.mapping.adType != null ? t('imp.fromColumn') : t('imp.noColumn'))}</span></label>
      <label>${esc(t('imp.defaultMk'))}<select id="w-mk" class="period-select"><option value="">${esc(t('imp.chooseMk'))}</option>${mkOpts.map(m => `<option value="${m}" ${W.settings.marketplace === m ? 'selected' : ''}>${m} · ${esc(Config.MARKETPLACES[m].name)} (${Config.MARKETPLACES[m].currency})</option>`).join('')}</select><span class="fine">${esc(W.mapping.marketplace != null || W.mapping.currency != null ? t('imp.fromColumn') : t('imp.mkRequired'))}</span></label>
      <label>${esc(t('imp.defaultAccount'))}<input id="w-account" class="text-in" value="${esc(W.settings.account || '')}" placeholder="${esc(t('imp.defaultAccountPh'))}"></label>
      ${W.mapping.date == null ? `<label>${esc(t('imp.dateOverride'))}<input type="date" id="w-date" class="text-in" value="${esc(W.settings.dateOverride || '')}"><span class="fine">${esc(t('imp.dateOverrideHint'))}</span></label>` : ''}
      <label>${esc(t('imp.brandTerms'))}<input id="w-brand" class="text-in" value="${esc(State.get().brandTerms)}" placeholder="${esc(t('imp.brandTermsPh'))}"><span class="fine">${esc(t('imp.brandTermsHint'))}</span></label>
      ${W.mapping.orders == null && W.mapping.units != null ? `<label class="chk-block"><span><input type="checkbox" id="w-units-orders" ${W.settings.unitsAsOrders ? 'checked' : ''}> ${esc(t('imp.unitsAsOrders'))}</span><span class="fine">${esc(t('imp.unitsAsOrdersHint'))}</span></label>` : ''}
      ${det.bulk ? `<label>${esc(t('imp.entity'))}<select id="w-entity" class="period-select">${entityValues().map(v => `<option ${W.settings.entity === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><span class="fine">${esc(t('imp.entityHint'))}</span></label>` : ''}
    </div>
    <h4 class="sub-h">${esc(t('imp.headersRead', { n: W.headers.filter(Boolean).length }))}</h4>
    <div class="hdr-chips">${W.headers.map((h, i) => { const mapped = Object.entries(W.mapping).find(([, c]) => c === i); const un = W.unmapped.find(u => u.i === i); return `<span class="hchip ${mapped ? 'ok' : un?.status}">${esc(h || '(blank)')}${mapped ? ` → ${esc(t('field.' + mapped[0]))}` : un?.status === 'recalculated' ? ` · ${esc(t('imp.recalc'))}` : ''}</span>`; }).join('')}</div>`;
  }
  function entityValues() { if (W.server) return W.entities || []; const c = W.mapping.entity; return [...new Set(W.rows.slice(0, 5000).map(r => String(r[c] || '')).filter(Boolean))]; }

  function mapScreen() {
    const opt = sel => `<option value="">${esc(t('imp.notMapped'))}</option>` + W.headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `#${i + 1}`)}</option>`).join('');
    const sample = f => W.mapping[f] == null ? '' : W.rows.slice(0, 3).map(r => r[W.mapping[f]]).map(v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '')).filter(Boolean).join(' · ');
    const row = f => `<tr class="${Config.REQUIRED_FIELDS.includes(f) ? 'req' : ''}"><td class="txt"><strong>${esc(t('field.' + f))}</strong>${Config.REQUIRED_FIELDS.includes(f) ? ` <span class="req-tag">${esc(t('imp.required'))}</span>` : ''}</td>
      <td class="txt"><select class="mini-select" data-map="${f}" id="map-${f}">${opt(W.mapping[f])}</select></td>
      <td class="txt">${W.mapping[f] != null ? `<span class="conf c-${W.confidence[f] || 'manual'}">${esc(t('imp.conf.' + (W.confidence[f] || 'manual')))}</span>` : ''}</td>
      <td class="txt sample" title="${esc(sample(f))}">${esc(sample(f))}</td></tr>`;
    const dimF = Config.DIM_FIELDS, metF = Config.BASE_METRICS.map(m => m.key);
    const preview = W.rows.slice(0, 6);
    const pvFields = ['date', 'campaign', 'adType', 'keyword', 'placement', 'asin', 'adSpend', 'adSales', 'clicks', 'orders'].filter(f => W.mapping[f] != null);
    return `<p class="fine">${esc(t('imp.mapHelp'))}</p>
      <div class="map-cols"><div><h4 class="sub-h">${esc(t('imp.dimensions'))}</h4><div class="table-frame static tall"><table class="detail-table map"><thead><tr><th class="txt">${esc(t('set.field'))}</th><th class="txt">${esc(t('imp.column'))}</th><th class="txt">${esc(t('imp.match'))}</th><th class="txt">${esc(t('imp.sample'))}</th></tr></thead><tbody>${dimF.map(row).join('')}</tbody></table></div></div>
      <div><h4 class="sub-h">${esc(t('imp.metrics'))}</h4><div class="table-frame static tall"><table class="detail-table map"><thead><tr><th class="txt">${esc(t('set.field'))}</th><th class="txt">${esc(t('imp.column'))}</th><th class="txt">${esc(t('imp.match'))}</th><th class="txt">${esc(t('imp.sample'))}</th></tr></thead><tbody>${metF.map(row).join('')}</tbody></table></div></div></div>
      ${W.unmapped.length ? `<p class="fine">${esc(t('imp.unmappedList'))} ${W.unmapped.map(u => `${u.header} (${t('imp.st.' + u.status)})`).map(esc).join(', ')}</p>` : ''}
      <h4 class="sub-h">${esc(t('imp.previewTitle'))}</h4>
      <div class="table-frame static"><table class="detail-table"><thead><tr>${pvFields.map(f => `<th class="txt">${esc(t('field.' + f))}</th>`).join('')}</tr></thead><tbody>${preview.map(r => `<tr>${pvFields.map(f => { const v = r[W.mapping[f]]; return `<td class="txt">${esc(v instanceof Date ? v.toISOString().slice(0, 10) : v ?? '')}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function reviewScreen() {
    const R = W.result;
    let ok = 0, warn = 0, err = 0, dup = 0, total;
    if (R.counts) ({ ok, warn, err, dup, total } = R.counts);
    else total = W.rows.length;
    const errors = R.issues.filter(i => i.severity === 'error'), warnings = R.issues.filter(i => i.severity === 'warning');
    const issueRow = i => `<tr><td class="txt"><span class="sev ${i.severity}">${icon(i.severity === 'error' ? 'error' : 'alert')}${esc(t('imp.sev.' + i.severity))}</span></td><td class="txt"><strong>${esc(t('val.' + i.rule))}</strong><br><span class="fine">${esc(t('val.' + i.rule + '.hint'))}</span></td><td class="txt">${esc(i.field ? t('field.' + i.field) : '—')}</td><td class="num">${!i.rows.length && ['missingColumn', 'optionalMissing', 'missingMarketplace', 'unitsAsOrders'].includes(i.rule) ? esc(t('imp.allRows')) : I18n.int(i.count, false)}</td><td class="txt">${esc(i.rows.join(', '))}${i.count > i.rows.length && i.rows.length ? '…' : ''}</td></tr>`;
    const overlaps = R.overlaps || ImportService.overlaps(W, R);
    W.replaceIds = W.replaceIds.filter(id => overlaps.some(o => o.id === id));
    return `<div class="det-grid four">
      <div class="det-card"><span class="lbl">${esc(t('imp.total'))}</span><strong>${I18n.int(total, false)}</strong></div>
      <div class="det-card good"><span class="lbl">${esc(t('imp.valid'))}</span><strong>${I18n.int(ok + warn, false)}</strong><span class="fine">${esc(t('imp.withWarnings', { n: I18n.int(warn, false) }))}</span></div>
      <div class="det-card bad"><span class="lbl">${esc(t('imp.errors'))}</span><strong>${I18n.int(err, false)}</strong><span class="fine">${esc(t('imp.excluded'))}</span></div>
      <div class="det-card warn"><span class="lbl">${esc(t('imp.duplicates'))}</span><strong>${I18n.int(dup, false)}</strong><span class="fine">${esc(t('imp.excluded'))}</span></div>
    </div>
    ${W.source === Config.MULTI && R.grains ? `<div class="notice">${icon('layers')}<span>${esc(t('imp.grains', { list: R.grains.map(g => t('grain.' + g)).join(' · ') }))}</span></div>` : ''}
    ${R.blocked ? `<div class="notice error">${icon('error')}<span>${esc(t('imp.blocked'))}</span></div>` : ''}
    ${R.issues.length ? `<div class="table-frame static tall"><table class="detail-table"><thead><tr><th class="txt">${esc(t('imp.severity'))}</th><th class="txt">${esc(t('imp.issue'))}</th><th class="txt">${esc(t('set.field'))}</th><th class="num">${esc(t('imp.rowsAffected'))}</th><th class="txt">${esc(t('imp.sampleRows'))}</th></tr></thead><tbody>${[...errors, ...warnings].map(issueRow).join('')}</tbody></table></div>
      <button type="button" class="link-btn" data-wiz="issues-csv">${icon('download')} ${esc(t('imp.downloadIssues'))}</button>` : `<div class="notice ok">${icon('check')}<span>${esc(t('imp.clean'))}</span></div>`}
    <div class="opt-list">
      ${DataStore.isDemo && !W.server ? `<label class="chk"><input type="checkbox" id="w-replace-demo" ${W.replaceDemo ? 'checked' : ''}> ${esc(t('imp.replaceDemo'))}</label>` : ''}
      ${overlaps.map(o => `<label class="chk"><input type="checkbox" data-replace-id="${esc(o.id)}" ${W.replaceIds.includes(o.id) ? 'checked' : ''}> ${esc(t('imp.replaceOverlap', { file: o.name, range: I18n.range(o.minDay, o.maxDay) }))}</label>`).join('')}
    </div>`;
  }

  function readyCount() { return W.result.ready; }
  function doneScreen() {
    const d = W.done || {};
    const item = (k, ok) => `<li class="${ok ? 'done' : ''}">${ok ? icon('check') : '<span class="spinner sm"></span>'}${esc(t('imp.step.' + k))}</li>`;
    return `<ul class="progress-list">${item('import', d.imported)}${item('build', d.built)}${item('refresh', d.refreshed)}</ul>
      ${W.screen === 'done' ? `<div class="notice ok">${icon('check')}<span>${esc(t('imp.success', { n: I18n.int(d.rows, false), source: t('source.' + W.source), range: I18n.range(d.min, d.max), mk: d.marketplaces.join(', ') }))}</span></div>` : ''}`;
  }

  /* ---------- flow */
  /* server mode: Python parses the file and proposes the mapping */
  function applyInspect(res, keepSettings) {
    W.server = true; W.token = res.token;
    W.parsed = { kind: res.kind, sheets: res.sheets.map(x => ({ name: x.name, rows: x.rows })) };
    W.sheetIdx = res.sheetIdx; W.headerRow = res.headerRow; W.headers = res.headers;
    W.rows = res.sample; W.totalRows = res.totalRows; W.totalApprox = res.totalApprox; W.entities = res.entities; W.file = W.file || { name: res.fileName, size: res.size };
    W.mapping = res.mapping; W.confidence = res.confidence; W.unmapped = res.unmapped;
    const prev = W.settings || {};
    W.source = res.source;
    W.settings = { adType: res.adType || (keepSettings && prev.adType) || 'SP', marketplace: prev.marketplace || '', account: prev.account || '', dateOverride: prev.dateOverride || '', unitsAsOrders: prev.unitsAsOrders ?? true };
    if (res.bulk) { const ev = res.entities; W.settings.entity = ev.find(v => /keyword/i.test(v)) || ev[0]; sourceFromEntity(W.settings.entity); }
  }
  function sourceFromEntity(v) { if (/keyword|target/i.test(v)) W.source = 'keyword'; else if (/product ad/i.test(v)) W.source = 'asin'; else if (/campaign/i.test(v)) W.source = 'campaign'; }
  async function reinspect(keepHeader) {
    W.error = null;
    try { applyInspect(await Api.inspect({ token: W.token, sheetIdx: W.sheetIdx, headerRow: keepHeader ? W.headerRow : null, synonyms: State.get().synonyms }), true); }
    catch (e) { W.error = e.message; }
    draw();
  }
  function serverPayload() {
    const st = State.get();
    return { token: W.token, sheetIdx: W.sheetIdx, headerRow: W.headerRow, mapping: W.mapping, source: W.source, replaceIds: W.replaceIds,
      settings: { ...W.settings, brandTerms: st.brandTerms, competitorTerms: st.competitorTerms } };
  }

  async function handleFile(file) {
    W.file = file; W.error = null; W.screen = 'reading'; W.step = 1; W.server = Api.enabled; draw();
    try {
      if (W.server) {
        const maxMb = Api.limits.maxUploadMb;
        if (maxMb && file.size > maxMb * 1024 * 1024) throw new Error(t('api.tooLarge', { mb: I18n.int(maxMb, false) }));
        const res = await Api.upload(file, p => {
          const msg = document.getElementById('up-msg'), bar = document.getElementById('up-bar');
          if (bar) bar.style.width = Math.round(p * 100) + '%';
          if (msg) msg.textContent = p < 1 ? t('api.uploading', { file: file.name, pct: Math.round(p * 100) }) : t('api.processing', { file: file.name });
        });
        applyInspect(res); W.screen = 'detect'; W.step = 2; draw(); return;
      }
      W.parsed = await ImportService.readFile(file);
      W.sheetIdx = Math.max(0, W.parsed.sheets.findIndex(s => /sponsored|campaign|report|search|target|placement|advertised/i.test(s.name)));
      prepareSheet();
      W.screen = 'detect'; W.step = 2; draw();
    } catch (e) { W.error = e.message; W.screen = 'upload'; W.step = 0; draw(); }
  }
  function prepareSheet(keepHeader) {
    const sh = W.parsed.sheets[W.sheetIdx];
    if (!keepHeader) W.headerRow = ImportService.detectHeaderRow(sh.rows);
    W.headers = (sh.rows[W.headerRow] || []).map(h => String(h ?? '').trim());
    W.rows = sh.rows.slice(W.headerRow + 1).filter(r => r.some(v => v !== '' && v != null));
    // streamed text files: only the first rows are in memory; the rest are read during validation
    W.totalRows = W.parsed.streaming ? (W.parsed.approxRows != null ? Math.max(0, W.parsed.approxRows - W.headerRow - 1) : null) : W.rows.length;
    W.totalApprox = !!W.parsed.streaming && W.rows.length >= 900;
    const m = ImportService.refineMapping(ImportService.autoMap(W.headers), W.rows);
    W.mapping = m.mapping; W.confidence = m.confidence; W.unmapped = m.unmapped;
    const det = ImportService.detectSource(W.mapping, sh.name, W.file.name);
    W.source = det.source;
    W.settings = { adType: det.adType || 'SP', marketplace: W.settings.marketplace || '', account: W.settings.account || '', dateOverride: W.settings.dateOverride || '', unitsAsOrders: W.settings.unitsAsOrders ?? true };
    if (det.bulk) { const ev = entityValues(); W.settings.entity = ev.find(v => /keyword/i.test(v)) || ev[0]; if (/keyword|target/i.test(W.settings.entity)) W.source = 'keyword'; else if (/product ad/i.test(W.settings.entity)) W.source = 'asin'; else if (/campaign/i.test(W.settings.entity)) W.source = 'campaign'; }
  }
  function readDetectForm() {
    const v = id => document.getElementById(id)?.value;
    W.source = v('w-source') || W.source;
    W.settings.adType = v('w-adtype') || W.settings.adType;
    W.settings.marketplace = v('w-mk') ?? W.settings.marketplace;
    W.settings.account = (v('w-account') || '').trim().slice(0, 120);
    if (document.getElementById('w-date')) W.settings.dateOverride = v('w-date');
    if (document.getElementById('w-entity')) W.settings.entity = v('w-entity');
    const uo = document.getElementById('w-units-orders'); if (uo) W.settings.unitsAsOrders = uo.checked;
    const br = document.getElementById('w-brand'); if (br && br.value !== State.get().brandTerms) State.set({ brandTerms: br.value.slice(0, 500) }, { silent: true });
  }
  function setProgress(p) {
    W.progress = p;
    const bar = document.querySelector('.progress i'); if (bar) bar.style.width = Math.round(p * 100) + '%';
    const lbl = document.getElementById('val-pct'); if (lbl) lbl.textContent = Math.round(p * 100) + '%';
  }
  function localCtx() {
    const base = { mapping: W.mapping, settings: W.settings, headerRow: W.headerRow, source: W.source, sample: W.rows };
    if (!W.parsed.streaming) return { ...base, rows: W.rows };
    const sh = W.parsed.sheets[W.sheetIdx], headerNo = sh.rowNos[W.headerRow], size = W.file.size;
    return { ...base, stream: () => ImportService.dataRows(W.file, headerNo, bytes => setProgress(Math.min(0.99, bytes / size))) };
  }
  async function runValidate() {
    W.error = null; W.screen = 'validating'; W.step = 5; W.progress = 0; draw(); working = true;
    try {
      W.result = W.server ? await Api.validate(serverPayload()) : await ImportService.validate(localCtx(), setProgress);
      W.screen = 'review'; W.step = 6;
    } catch (e) { W.error = e.message; W.screen = 'map'; W.step = 3; }
    working = false; draw();
  }
  async function commit() {
    working = true; W.screen = 'committing'; W.step = 7; W.done = {}; draw();
    await new Promise(r => setTimeout(r, 30));
    let info;
    try {
      if (W.server) {
        const meta = await Api.commit(serverPayload());
        info = { id: meta.id, min: meta.minDay, max: meta.maxDay, marketplaces: meta.marketplaces };
        W.done = { imported: true, rows: meta.rows, ...info }; W.step = 8; draw();
        await Api.loadData();   // rebuild the reporting dataset from the database
      } else {
        info = ImportService.commit({ source: W.source, fileName: W.file.name.replace(/\.(gz|zip)$/i, ''), sheetName: W.parsed.sheets[W.sheetIdx].name, kind: W.parsed.kind }, W.result, { replaceDemo: W.replaceDemo && DataStore.isDemo, replaceIds: W.replaceIds });
        W.done = { imported: true, rows: W.result.ready, ...info }; W.step = 8; draw();
        await new Promise(r => setTimeout(r, 30));
      }
    } catch (e) { working = false; W.error = e.message; W.screen = 'review'; W.step = 6; draw(); return; }
    DataStore.touch(); await DataStore.persist();
    W.done.built = true; W.step = 9; draw();
    const st = State.get();
    const mk = info.marketplaces.includes(st.marketplace) ? st.marketplace : info.marketplaces[0];
    // keep the chosen date preset only if it still returns rows for the new data
    const noFilters = Object.fromEntries(Config.FILTER_DIMS.map(d => [d, []]));
    State.set({ marketplace: mk, filters: noFilters }, { silent: true });
    const rg = State.ranges();
    const rows = rg.cur ? Query.run({ filters: noFilters, marketplace: mk, range: rg.cur, groupBy: null }).total?.rows : 0;
    State.set({ date: rows ? st.date : { ...st.date, preset: 'lifetime' } });
    await new Promise(r => setTimeout(r, 60));
    W.done.refreshed = true; W.step = 10; W.screen = 'done'; working = false; draw();
  }
  function issuesCSV() {
    if (W.server) { const a = document.createElement('a'); a.href = Api.issuesUrl(W.token); a.download = 'import-issues.csv'; document.body.appendChild(a); a.click(); a.remove(); return; }
    const R = W.result;
    const rows = R.issues.map(i => [t('imp.sev.' + i.severity), t('val.' + i.rule), i.field ? t('field.' + i.field) : '', i.count, i.rows.join(' ')]);
    // row-level listing of every excluded row
    const ex = R.excluded.map(([no, reason, row]) => [no, reason === 'error' ? t('imp.sev.error') : t('val.duplicate'), ...row.map(v => v instanceof Date ? v.toISOString().slice(0, 10) : v)]);
    Exporter.csv('import-issues.csv', [t('imp.severity'), t('imp.issue'), t('set.field'), t('imp.rowsAffected'), t('imp.sampleRows')], [...rows, [], [t('imp.excludedRows')], ['Row', t('imp.issue'), ...W.headers], ...ex]);
  }

  function init() {
    document.addEventListener('click', e => {
      if (!W) return;
      const b = e.target.closest('[data-wiz]'); if (!b) return;
      const a = b.dataset.wiz;
      if (a === 'close') close();
      if (a === 'back') { W = fresh(); draw(); }
      if (a === 'to-detect') { W.screen = 'detect'; W.step = 2; draw(); }
      if (a === 'to-map') { if (W.screen === 'detect') { readDetectForm(); W.step = 3; } else W.step = 3; W.screen = 'map'; W.error = null; draw(); }
      if (a === 'validate') {
        const miss = Config.REQUIRED_FIELDS.filter(f => W.mapping[f] == null && !(f === 'date' && W.settings.dateOverride));
        if (miss.length) { W.error = t('imp.err.required', { fields: miss.map(f => t('field.' + f)).join(', ') }); draw(); return; }
        W.step = 4; runValidate();
      }
      if (a === 'commit') commit();
      if (a === 'issues-csv') issuesCSV();
      if (a === 'another') { W = fresh(); draw(); }
      if (a === 'finish') { W = null; App.modal(null); App.toast(t('imp.done')); }
    });
    document.addEventListener('change', e => {
      if (!W) return;
      const el = e.target;
      if (el.id === 'imp-file' && el.files[0]) handleFile(el.files[0]);
      if (el.id === 'w-sheet') { readDetectForm(); W.sheetIdx = +el.value; if (W.server) return reinspect(false); prepareSheet(); draw(); }
      if (el.id === 'w-header') { readDetectForm(); W.headerRow = Math.max(0, +el.value - 1); if (W.server) return reinspect(true); prepareSheet(true); draw(); }
      if (el.id === 'w-entity') { readDetectForm(); sourceFromEntity(el.value); draw(); }
      if (el.dataset.map) { const f = el.dataset.map; if (el.value === '') delete W.mapping[f]; else { W.mapping[f] = +el.value; W.confidence[f] = 'manual'; } draw(); }
      if (el.id === 'w-replace-demo') W.replaceDemo = el.checked;
      if (el.dataset.replaceId) { const id = el.dataset.replaceId; W.replaceIds = el.checked ? [...W.replaceIds, id] : W.replaceIds.filter(x => x !== id); }
    });
    ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { const dz = e.target.closest && e.target.closest('#dropzone'); if (dz) { e.preventDefault(); dz.classList.add('over'); } }));
    document.addEventListener('dragleave', e => { const dz = e.target.closest && e.target.closest('#dropzone'); if (dz) dz.classList.remove('over'); });
    document.addEventListener('drop', e => { const dz = e.target.closest && e.target.closest('#dropzone'); if (dz && W) { e.preventDefault(); dz.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); } });
  }
  return { open, init, busy: () => working };
})();
