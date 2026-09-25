/* ==========================================================================
   APP SHELL — navigation, header controls, date picker, filter panel,
   routing, toasts. Presentation only: all numbers come from Reports.
   ========================================================================== */
const App = (() => {
  const NAV = [
    ['overview', 'dashboard'], null,
    ['wow', 'week'], ['mom', 'month'], ['qoq', 'quarter'], ['yoy', 'year'], ['lifetime', 'lifetime'], null,
    ['portfolio', 'briefcase'], ['campaigns', 'megaphone'], ['placements', 'mapPin'], ['keywords', 'search'], ['search-terms', 'terms'], ['asins', 'package'], ['products', 'products'], null,
    ['insights', 'sparkles'], ['reports', 'reports'], ['settings', 'settings'],
  ];
  const TABS = ['overview', 'portfolio', 'campaigns', 'keywords', 'asins', 'placements'];
  const navKey = r => 'nav.' + r.replace('-t', 'T');

  /* ---------------- rail + tabs */
  function renderRail() {
    const r = State.get().route;
    document.getElementById('rail').innerHTML = `<div class="rail-logo" aria-hidden="true">${icon('logo')}</div>` +
      NAV.map(n => n ? `<a class="rail-link ${r === n[0] ? 'active' : ''}" href="#${n[0]}" aria-current="${r === n[0] ? 'page' : 'false'}">${icon(n[1])}<span>${esc(t(navKey(n[0]) + 'Short'))}</span></a>` : '<span class="rail-sep"></span>').join('');
    document.getElementById('tab-strip').innerHTML = TABS.map(k => `<a class="tab-btn ${r === k ? 'active' : ''}" href="#${k}">${esc(t('tab.' + k))}</a>`).join('');
  }

  /* ---------------- header */
  function renderHeader() {
    const st = State.get(), rg = State.ranges();
    const mks = DataStore.distinct('marketplace');
    const accounts = DataStore.distinct('account', st.marketplace).filter(a => Config.ROLES[st.role].allAccounts || st.assignedAccounts.includes(a));
    const acct = st.filters.account.length === 1 ? st.filters.account[0] : t('hdr.allAccounts');
    const pageTitle = st.route === 'overview' ? t('app.title') : t(navKey(st.route));
    const fc = State.activeFilterCount();
    const cmpText = rg.cmp ? I18n.range(rg.cmp[0], rg.cmp[1]) : t('cmp.none');
    document.getElementById('hdr-main').innerHTML = `
      <div class="hdr-text">
        <nav class="breadcrumb" aria-label="Breadcrumb"><span>${esc(acct)}</span><span aria-hidden="true">›</span><span>${esc(st.marketplace)}</span><span aria-hidden="true">›</span><span aria-current="page">${esc(t(navKey(st.route)))}</span></nav>
        <div class="eyebrow">${esc(t('app.eyebrow'))}</div>
        <h1 class="page-title">${esc(pageTitle)} ${DataStore.isDemo ? `<span class="demo-badge" title="${esc(t('demo.hint'))}">${esc(t('demo.label'))}</span>` : ''}</h1>
        <p class="page-sub">${esc(accounts.length === 1 ? accounts[0] : t('hdr.accountsCount', { n: accounts.length }))} · ${rg.ref != null ? esc(t('hdr.dataThrough', { date: I18n.date(rg.ref) })) : esc(t('common.noData'))}</p>
      </div>
      <div class="header-actions">
        ${State.can('import') ? `<button class="action-btn export" type="button" data-act="import">${icon('upload')}${esc(t('hdr.import'))}</button>` : ''}
        <button class="action-btn" type="button" data-act="takeaways">${icon('sparkles')}${esc(t('hdr.takeaways'))}</button>
        ${State.can('export') ? `
        <button class="action-btn" type="button" data-act="ppt">${icon('ppt')}${esc(t('hdr.exportPpt'))}</button>
        <button class="action-btn" type="button" data-act="xlsx">${icon('xls')}${esc(t('hdr.exportXlsx'))}</button>
        <button class="action-btn download-btn" type="button" data-act="csv">${icon('csv')}${esc(t('hdr.csv'))}</button>` : `<span class="role-note">${icon('lock')}${esc(t('role.viewOnly'))}</span>`}
      </div>`;
    document.getElementById('hdr-controls').innerHTML = `
      <label class="ctl"><span>${esc(t('hdr.marketplace'))}</span><select id="sel-mk" class="period-select">${mks.map(m => `<option value="${m}" ${m === st.marketplace ? 'selected' : ''}>${m} · ${Config.MARKETPLACES[m]?.currency || ''}</option>`).join('')}</select></label>
      <label class="ctl"><span>${esc(t('hdr.account'))}</span><select id="sel-acct" class="period-select"><option value="">${esc(t('hdr.allAccounts'))}</option>${accounts.map(a => `<option ${st.filters.account.length === 1 && st.filters.account[0] === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label class="ctl"><span>${esc(t('hdr.adType'))}</span><select id="sel-adtype" class="period-select"><option value="">${esc(t('hdr.allAdTypes'))}</option>${Object.keys(Config.AD_TYPES).map(a => `<option value="${a}" ${st.filters.adType.length === 1 && st.filters.adType[0] === a ? 'selected' : ''}>${a} · ${esc(t('adType.' + a))}</option>`).join('')}</select></label>
      <div class="ctl date-range-wrap"><span>${esc(t('hdr.dateRange'))}</span>
        <button id="period-selector" class="action-btn date-range-trigger" type="button" aria-expanded="false" aria-haspopup="dialog">
          <span class="dr-main">${rg.cur ? esc(I18n.range(rg.cur[0], rg.cur[1])) : '—'}</span>
          <span class="dr-sub">${esc(t('preset.' + st.date.preset))}</span>${icon('chevronDown')}
        </button>
        <div id="date-popover" class="date-popover" role="dialog" aria-label="${esc(t('hdr.dateRange'))}" hidden></div>
      </div>
      <div class="ctl"><span>${esc(t('hdr.compare'))}</span>
        <button id="comparison-toggle" class="action-btn compare ${st.compareOn ? '' : 'off'}" type="button" aria-pressed="${st.compareOn}">${icon('compare')}<span class="dr-main">${st.compareOn ? esc(cmpText) : esc(t('cmp.off'))}</span></button>
      </div>
      <div class="ctl-actions">
        <button id="filter-toggle" class="action-btn ${st.filterPanelOpen ? 'active' : ''}" type="button" aria-expanded="${st.filterPanelOpen}">${icon('sliders')}${esc(t('hdr.filters'))}${fc ? `<b class="count">${fc}</b>` : ''}</button>
        <button class="action-btn" type="button" data-act="clear" ${fc ? '' : 'disabled'}>${icon('x')}${esc(t('hdr.clear'))}</button>
        <button class="action-btn" type="button" data-act="refresh" title="${esc(t('hdr.refreshHint'))}">${icon('refresh')}${esc(t('hdr.refresh'))}</button>
      </div>`;
    renderChips();
    renderFilterPanel();
  }

  function renderChips() {
    const st = State.get();
    const chips = [`<span class="filter-pill locked">${esc(t('hdr.marketplace'))}: ${esc(st.marketplace)}</span>`];
    for (const d of Config.FILTER_DIMS) for (const v of st.filters[d]) chips.push(`<span class="filter-pill">${esc(I18n.dim(d))}: ${esc(d === 'adType' ? t('adType.' + v) : v)}<button type="button" data-rm-dim="${esc(d)}" data-rm-val="${esc(v)}" aria-label="${esc(t('hdr.removeFilter'))}">${icon('x')}</button></span>`);
    if (!Config.ROLES[st.role].allAccounts) chips.push(`<span class="filter-pill locked">${icon('lock')}${esc(t('role.assignedOnly'))}</span>`);
    document.getElementById('chips').innerHTML = `<span class="chips-label">${esc(t('hdr.activeFilters'))}</span>${chips.join('')}`;
  }

  /* ---------------- filter panel (multi-selects) */
  let openMS = null;
  function renderFilterPanel() {
    const st = State.get(), el = document.getElementById('filter-panel');
    el.hidden = !st.filterPanelOpen;
    if (!st.filterPanelOpen) return;
    el.innerHTML = Config.FILTER_DIMS.filter(d => d !== 'account' && d !== 'adType').map(d => {
      const sel = st.filters[d];
      return `<div class="ms" data-ms="${d}"><span class="ms-label">${esc(I18n.dim(d))}</span>
        <button type="button" class="ms-btn ${sel.length ? 'has' : ''}" data-ms-open="${d}" aria-expanded="${openMS === d}">${esc(sel.length === 0 ? t('common.all') : sel.length === 1 ? sel[0] : t('common.nSelected', { n: sel.length }))}${icon('chevronDown')}</button>
        ${openMS === d ? msMenu(d) : ''}</div>`;
    }).join('') + `<p class="fp-note">${esc(t('filters.note'))}</p>`;
  }
  function msMenu(d, q = '') {
    const st = State.get(), vals = DataStore.distinct(d, st.marketplace), sel = new Set(st.filters[d]);
    const list = vals.filter(v => !q || v.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
    return `<div class="ms-menu" id="ms-menu-${d}"><input type="search" class="ms-search" id="ms-q-${d}" data-ms-q="${d}" value="${esc(q)}" placeholder="${esc(t('table.search'))}" aria-label="${esc(t('table.search'))}">
      <div class="ms-list">${list.length ? list.map(v => `<label class="chk"><input type="checkbox" data-ms-val="${d}" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}> <span>${esc(v)}</span></label>`).join('') : `<p class="muted pad">${esc(t('filters.noValues'))}</p>`}</div>
      ${vals.length > 300 ? `<p class="muted pad">${esc(t('filters.refine', { n: vals.length }))}</p>` : ''}
      <div class="ms-foot"><button type="button" class="link-btn" data-ms-clear="${d}">${esc(t('hdr.clear'))}</button><button type="button" class="action-btn sm export" data-ms-done="${d}">${esc(t('common.done'))}</button></div></div>`;
  }

  /* ---------------- date picker (draft state until Apply) */
  const DP = { draft: null, month: null, editing: 'cur', anchor: null };
  function openDate() {
    const st = State.get(), rg = State.ranges();
    DP.draft = { ...st.date, start: rg.cur?.[0], end: rg.cur?.[1], cStart: rg.cmp?.[0] ?? null, cEnd: rg.cmp?.[1] ?? null };
    DP.month = Dates.monthStart(Dates.addMonths(rg.cur ? rg.cur[1] : Dates.toDay(new Date()), -1));
    DP.editing = 'cur'; DP.anchor = null;
    const pop = document.getElementById('date-popover'); pop.hidden = false;
    document.getElementById('period-selector').setAttribute('aria-expanded', 'true');
    renderDate();
  }
  function closeDate() { const pop = document.getElementById('date-popover'); if (pop) pop.hidden = true; document.getElementById('period-selector')?.setAttribute('aria-expanded', 'false'); DP.draft = null; }
  function draftRanges() {
    const d = DP.draft, b = DataStore.bounds();
    const cur = d.preset === 'custom' ? [d.start, d.end] : Dates.presetById(d.preset).calc(b.max, b);
    const cmp = d.compareMode === 'none' ? null : d.compareMode === 'custom' ? (d.cStart != null ? [d.cStart, d.cEnd] : null) : Dates.comparison(d.compareMode, cur[0], cur[1], d.preset);
    return { cur, cmp, b };
  }
  function monthGrid(ms, cur, cmp, b) {
    const [y, m] = Dates.ymd(ms), me = Dates.monthEnd(ms), first = Dates.weekStart(ms);
    const wd = I18n.weekdayNames();
    let h = `<div><div class="month-title">${esc(I18n.monthLabel(ms))}</div><div class="calendar-grid"><span></span>${wd.map(w => `<span class="weekday">${esc(w)}</span>`).join('')}`;
    for (let ws = first; ws <= me; ws += 7) {
      h += `<span class="weekno">${Dates.weekNumber(ws)}</span>`;
      for (let d = ws; d < ws + 7; d++) {
        if (d < ms || d > me) { h += '<span></span>'; continue; }
        const inCur = cur && d >= cur[0] && d <= cur[1], inCmp = cmp && d >= cmp[0] && d <= cmp[1];
        const out = b && (d < b.min || d > b.max);
        const cls = [inCur ? 'range-day' : '', inCur && d === cur[0] ? 'range-start' : '', inCur && d === cur[1] ? 'range-end' : '', inCmp ? 'cmp-day' : '', out ? 'muted-day' : '', DP.anchor === d ? 'anchor' : ''].join(' ');
        h += `<button type="button" class="${cls}" data-day="${d}" aria-label="${esc(I18n.date(d))}">${Dates.ymd(d)[2]}</button>`;
      }
    }
    return h + '</div></div>';
  }
  function renderDate() {
    const pop = document.getElementById('date-popover'); if (!pop || pop.hidden || !DP.draft) return;
    const { cur, cmp, b } = draftRanges(), d = DP.draft;
    const groups = {}; Dates.PRESETS.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
    pop.innerHTML = `
      <div class="calendar-panel">
        <div class="calendar-head">
          <button type="button" class="cal-nav" data-cal="-1" aria-label="${esc(t('date.prevMonth'))}">${icon('chevronLeft')}</button>
          <div class="seg" role="group" aria-label="${esc(t('date.editing'))}">
            <button type="button" class="${DP.editing === 'cur' ? 'on' : ''}" data-edit="cur"><i class="sw cur"></i>${esc(t('date.current'))}</button>
            <button type="button" class="${DP.editing === 'cmp' ? 'on' : ''}" data-edit="cmp" ${d.compareMode === 'none' ? 'disabled' : ''}><i class="sw cmp"></i>${esc(t('date.comparison'))}</button>
          </div>
          <button type="button" class="cal-nav" data-cal="1" aria-label="${esc(t('date.nextMonth'))}">${icon('chevronRight')}</button>
        </div>
        <div class="calendar-months">${monthGrid(DP.month, cur, cmp, b)}${monthGrid(Dates.addMonths(DP.month, 1), cur, cmp, b)}</div>
        <div class="range-summary">
          <div><i class="sw cur"></i><span>${esc(t('date.current'))}</span><strong>${esc(I18n.range(cur[0], cur[1]))}</strong></div>
          <div><i class="sw cmp"></i><span>${esc(t('date.compareTo'))}</span><strong>${cmp ? esc(I18n.range(cmp[0], cmp[1])) : esc(t('cmp.none'))}</strong></div>
        </div>
        <p class="cal-hint">${esc(DP.anchor != null ? t('date.pickEnd') : t('date.pickStart'))}</p>
      </div>
      <div class="date-side">
        <div class="date-side-label">${esc(t('hdr.dateRange'))}</div>
        <div class="range-options">${Object.entries(groups).map(([g, ps]) => `<div class="range-group">${esc(t('dgroup.' + g))}</div>` + ps.map(p => `<button type="button" class="range-option ${d.preset === p.id ? 'selected' : ''}" data-preset="${p.id}">${esc(t('preset.' + p.id))}</button>`).join('')).join('')}
          <button type="button" class="range-option ${d.preset === 'custom' ? 'selected' : ''}" data-preset="custom">${esc(t('preset.custom'))}</button></div>
        <div class="date-side-label mt">${esc(t('date.compareTo'))}</div>
        <div class="date-select-wrap"><select id="cmp-mode" class="date-select">${['previous', 'yoy', 'custom', 'none'].map(m => `<option value="${m}" ${d.compareMode === m ? 'selected' : ''}>${esc(t('cmp.' + m))}</option>`).join('')}</select></div>
        <div class="date-actions">
          <button id="date-reset" class="date-reset" type="button">${esc(t('date.reset'))}</button>
          <button id="date-apply" class="date-apply" type="button">${esc(t('date.apply'))}</button>
        </div>
      </div>`;
  }
  function dateClick(e) {
    const d = DP.draft;
    const nav = e.target.closest('[data-cal]'); if (nav) { DP.month = Dates.addMonths(DP.month, +nav.dataset.cal); return renderDate(); }
    const ed = e.target.closest('[data-edit]'); if (ed) { DP.editing = ed.dataset.edit; DP.anchor = null; return renderDate(); }
    const pr = e.target.closest('[data-preset]');
    if (pr) {
      const id = pr.dataset.preset;
      if (id === 'custom') { const { cur } = draftRanges(); d.start = cur[0]; d.end = cur[1]; }
      d.preset = id; DP.editing = 'cur'; DP.anchor = null;
      const { cur } = draftRanges(); DP.month = Dates.monthStart(Dates.addMonths(cur[1], -1));
      return renderDate();
    }
    const day = e.target.closest('[data-day]');
    if (day) {
      const n = +day.dataset.day;
      if (DP.anchor == null) { DP.anchor = n; }
      else {
        const s = Math.min(DP.anchor, n), en = Math.max(DP.anchor, n);
        if (DP.editing === 'cur') { d.preset = 'custom'; d.start = s; d.end = en; }
        else { d.compareMode = 'custom'; d.cStart = s; d.cEnd = en; }
        DP.anchor = null;
      }
      return renderDate();
    }
    if (e.target.id === 'date-reset') { DP.draft = { preset: 'mtd', start: null, end: null, compareMode: 'previous', cStart: null, cEnd: null }; DP.anchor = null; return renderDate(); }
    if (e.target.id === 'date-apply') {
      const { cmp } = draftRanges();
      if (d.compareMode === 'custom' && !cmp) { toast(t('date.pickCompare'), 'error'); return; }
      State.set({ date: { preset: d.preset, start: d.start, end: d.end, compareMode: d.compareMode, cStart: d.cStart, cEnd: d.cEnd }, compareOn: d.compareMode !== 'none' ? true : State.get().compareOn });
      closeDate();
    }
  }

  /* ---------------- toasts / busy / modal */
  function toast(msg, kind = 'ok') {
    const host = document.getElementById('toast-host');
    const el = document.createElement('div'); el.className = 'toast ' + kind; el.setAttribute('role', 'status');
    el.innerHTML = `${icon(kind === 'error' ? 'error' : 'check')}<span>${esc(msg)}</span>`;
    host.appendChild(el); setTimeout(() => el.remove(), 4200);
  }
  function busy(msg) {
    const el = document.getElementById('busy');
    if (!msg) { el.hidden = true; return; }
    el.innerHTML = `<div class="busy-card"><span class="spinner"></span>${esc(msg)}</div>`; el.hidden = false;
  }
  function modal(html, cls = '') {
    const host = document.getElementById('modal-host');
    if (!html) { host.innerHTML = ''; host.hidden = true; document.body.classList.remove('modal-open'); return; }
    host.innerHTML = `<div class="modal-back" data-close-modal></div><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
    host.hidden = false; document.body.classList.add('modal-open');
  }
  function filterSummary() {
    const st = State.get();
    return Config.FILTER_DIMS.filter(d => st.filters[d].length).map(d => `${I18n.dim(d)}: ${st.filters[d].join(', ')}`).join(' · ');
  }

  /* ---------------- routing + render */
  function route() {
    const h = (location.hash || '#overview').slice(1);
    const valid = NAV.filter(Boolean).map(n => n[0]);
    State.set({ route: valid.includes(h) ? h : 'overview' });
  }
  let lastRoute = null;
  function render() {
    const st = State.get();
    I18n.setLang(st.lang); I18n.setMarketplace(st.marketplace);
    renderRail(); renderHeader();
    document.getElementById('demo-banner').innerHTML = DataStore.isDemo ? `<div class="demo-banner" role="note">${icon('info')}<span><strong>${esc(t('demo.label'))}</strong> — ${esc(t('demo.banner'))}</span>${State.can('import') ? `<button type="button" class="link-btn" data-act="import">${esc(t('demo.cta'))}</button>` : ''}</div>` : '';
    Charts.reset();
    const view = document.getElementById('view');
    const t0 = performance.now();
    view.innerHTML = Views.render(st.route);
    Charts.mountAll(view);
    view.dataset.ms = Math.round(performance.now() - t0);
    if (lastRoute !== st.route) { window.scrollTo({ top: 0 }); lastRoute = st.route; document.body.classList.remove('rail-open'); }
    document.title = `${t(navKey(st.route))} · ${t('app.titleShort')}`;
  }

  function init() {
    State.loadPrefs();
    const st = State.get();
    I18n.setLang(st.lang);
    Charts.initTooltip(); DataTable.init(); Views.init(); ImportWizard.init();
    State.subscribe(render);
    addEventListener('hashchange', route);

    document.addEventListener('click', e => {
      const a = e.target.closest('[data-act]');
      if (a) {
        const act = a.dataset.act;
        if (act === 'import') ImportWizard.open();
        if (act === 'takeaways') location.hash = '#insights';
        if (act === 'ppt') Exporter.pptx();
        if (act === 'xlsx') Exporter.xlsx();
        if (act === 'pdf') Exporter.pdf();
        if (act === 'csv') Exporter.currentCSV();
        if (act === 'clear') State.clearFilters();
        if (act === 'refresh') { DataStore.touch(); State.schedule(); toast(t('toast.refreshed')); }
        if (act === 'menu') document.body.classList.toggle('rail-open');
        return;
      }
      if (e.target.closest('#period-selector')) { const pop = document.getElementById('date-popover'); pop.hidden ? openDate() : closeDate(); return; }
      if (e.target.closest('#date-popover')) { dateClick(e); return; }
      if (DP.draft && !e.target.closest('.date-range-wrap')) closeDate();
      if (e.target.closest('#comparison-toggle')) { State.set({ compareOn: !State.get().compareOn }); return; }
      if (e.target.closest('#filter-toggle')) { State.set({ filterPanelOpen: !State.get().filterPanelOpen }); return; }
      const rm = e.target.closest('[data-rm-dim]'); if (rm) { State.toggleFilter(rm.dataset.rmDim, rm.dataset.rmVal); return; }
      const fs = e.target.closest('[data-filter-dim]');
      if (fs) { State.toggleFilter(fs.dataset.filterDim, fs.dataset.filterValue); toast(t('toast.filterApplied', { dim: I18n.dim(fs.dataset.filterDim), value: fs.dataset.filterValue })); return; }
      const mo = e.target.closest('[data-ms-open]'); if (mo) { openMS = openMS === mo.dataset.msOpen ? null : mo.dataset.msOpen; renderFilterPanel(); document.getElementById('ms-q-' + openMS)?.focus(); return; }
      const mc = e.target.closest('[data-ms-clear]'); if (mc) { State.setFilter(mc.dataset.msClear, []); return; }
      if (e.target.closest('[data-ms-done]')) { openMS = null; renderFilterPanel(); return; }
      if (openMS && !e.target.closest('.ms')) { openMS = null; renderFilterPanel(); }
      const menuBtn = e.target.closest('[data-menu]');
      document.querySelectorAll('.menu').forEach(m => { if (!menuBtn || m.id !== menuBtn.dataset.menu) { if (!m.contains(e.target)) m.hidden = true; } });
      if (menuBtn) { const m = document.getElementById(menuBtn.dataset.menu); m.hidden = !m.hidden; }
      if (e.target.closest('[data-close-modal]') && !ImportWizard.busy()) modal(null);
    });
    document.addEventListener('change', e => {
      const id = e.target.id;
      if (id === 'sel-mk') { State.set({ marketplace: e.target.value, filters: { ...State.get().filters, account: [] } }); }
      if (id === 'sel-acct') State.setFilter('account', e.target.value ? [e.target.value] : []);
      if (id === 'sel-adtype') State.setFilter('adType', e.target.value ? [e.target.value] : []);
      if (id === 'cmp-mode' && DP.draft) { DP.draft.compareMode = e.target.value; if (e.target.value === 'custom') { DP.editing = 'cmp'; const { cmp } = draftRanges(); } renderDate(); }
      if (e.target.dataset.msVal) State.toggleFilter(e.target.dataset.msVal, e.target.value);
    });
    let mq;
    document.addEventListener('input', e => {
      const d = e.target.dataset.msQ;
      if (d) { clearTimeout(mq); const v = e.target.value; mq = setTimeout(() => { const menu = document.getElementById('ms-menu-' + d); if (menu) { menu.outerHTML = msMenu(d, v); const q = document.getElementById('ms-q-' + d); q.focus(); q.setSelectionRange(v.length, v.length); } }, 120); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeDate(); if (openMS) { openMS = null; renderFilterPanel(); } if (!document.getElementById('modal-host').hidden && !ImportWizard.busy()) modal(null); }
      const f = e.target.closest && e.target.closest('[data-filter-dim][tabindex]');
      if (f && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); f.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    });
  }

  async function boot() {
    init();
    busy(t('boot.loading'));
    await new Promise(r => setTimeout(r, 30));
    if (await Api.detect()) {
      try { await Api.loadData(); } catch (e) { toast(t('api.loadFailed', { reason: e.message }), 'error'); }
      if (!DataStore.available().length) DemoData.generate();   // nothing uploaded yet → labelled demo
    } else {
      const restored = await DataStore.restore();
      if (!restored) DemoData.generate();
    }
    const st = State.get();
    const mks = DataStore.distinct('marketplace');
    if (!mks.includes(st.marketplace)) State.set({ marketplace: mks[0] || 'US' }, { silent: true });
    busy(false);
    route(); State.schedule();
  }
  return { boot, render, toast, busy, modal, filterSummary };
})();
