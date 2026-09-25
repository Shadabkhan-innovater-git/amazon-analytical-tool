/* ==========================================================================
   DATA TABLE — reusable: sorting, search, pagination, column visibility,
   column resizing, sticky header + first column, horizontal scroll,
   virtualised rendering for "All" rows, CSV export.
   Table UI state (sort/page/search/columns) survives page re-renders.
   ========================================================================== */
const Fmt = {
  deltaHTML(key, cur, prev) {
    const ch = Metrics.change(key, cur, prev);
    if (!ch) return `<span class="delta none">—</span>`;
    const arrow = ch.flat ? '' : ch.up ? '↑ ' : '↓ ';
    return `<span class="delta ${ch.tone}">${arrow}${I18n.delta(ch.pct)}</span>`;
  },
  value(key, v) {
    if (v == null) return `<span class="na" title="${esc(t('common.naHint'))}">${esc(t('common.na'))}</span>`;
    return esc(I18n.metric(key, v));
  },
};

const DataTable = (() => {
  const registry = new Map();   // id → spec (latest)
  const ui = new Map();         // id → {sort, q, page, size, hidden:Set, widths}
  const ROWH = 52;

  function stateOf(spec) {
    if (!ui.has(spec.id)) ui.set(spec.id, { sort: spec.defaultSort || null, q: '', page: 0, size: spec.pageSize || 25, hidden: new Set(spec.hidden || []), widths: {} });
    return ui.get(spec.id);
  }
  const visibleCols = (spec, st) => spec.columns.filter((c, i) => i === 0 || !st.hidden.has(c.key));
  function cellValue(col, row) {
    if (col.value) return col.value(row);
    if (col.kind === 'metric') return row.m ? row.m[col.metric || col.key] : null;
    return row[col.key];
  }

  function processed(spec) {
    const st = stateOf(spec);
    let rows = spec.rows;
    if (st.q) {
      const q = st.q.toLowerCase();
      const keys = spec.columns.filter(c => c.kind !== 'metric').map(c => c.key);
      rows = rows.filter(r => keys.some(k => String(r[k] ?? '').toLowerCase().includes(q)));
    }
    if (spec.rowFilter) rows = rows.filter(spec.rowFilter);
    if (st.sort) {
      const col = spec.columns.find(c => c.key === st.sort.key);
      if (col) {
        const dir = st.sort.dir;
        rows = [...rows].sort((a, b) => {
          const x = cellValue(col, a), y = cellValue(col, b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
        });
      }
    }
    return rows;
  }

  function cellHTML(col, row) {
    if (col.render) return col.render(row);
    const v = cellValue(col, row);
    if (col.kind !== 'metric') return `<span class="cell-main" title="${esc(v ?? '')}">${esc(v ?? '—')}</span>`;
    const key = col.metric || col.key;
    let sub = '';
    if (col.sub === 'share' && row.share && row.share[key] != null) sub = `<span class="cell-sub">${I18n.pct(row.share[key], 1)}</span>`;
    if (col.sub === 'delta' && State.get().compareOn && row.prev !== undefined) sub = `<span class="cell-sub">${row.prev ? Fmt.deltaHTML(key, v, row.prev[key]) : '<span class="delta none">—</span>'}</span>`;
    return `<span class="cell-main">${Fmt.value(key, v)}</span>${sub}`;
  }

  function rowsHTML(spec, cols, rows) {
    return rows.map(r => `<tr>${cols.map((c, i) => `<td class="${c.kind === 'metric' ? 'num' : 'txt'} ${i === 0 ? 'sticky-col' : ''}">${cellHTML(c, r)}</td>`).join('')}</tr>`).join('');
  }

  function bodyHTML(spec) {
    const st = stateOf(spec), cols = visibleCols(spec, st), rows = processed(spec);
    const total = rows.length;
    const virtual = st.size === 'all' && total > 150;
    let slice = rows, pages = 1;
    if (st.size !== 'all') {
      pages = Math.max(1, Math.ceil(total / st.size));
      st.page = Math.min(st.page, pages - 1);
      slice = rows.slice(st.page * st.size, (st.page + 1) * st.size);
    } else if (virtual) slice = rows.slice(0, 40);
    const head = `<thead><tr>${cols.map((c, i) => {
      const sorted = st.sort && st.sort.key === c.key;
      const w = st.widths[c.key];
      const style = w ? `style="width:${w}px;min-width:${w}px;max-width:${w}px"` : '';
      return `<th ${style} class="${c.kind === 'metric' ? 'num' : 'txt'} ${i === 0 ? 'sticky-col' : ''} sortable" data-sort="${esc(c.key)}" tabindex="0" aria-sort="${sorted ? (st.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}" title="${esc(c.hint || '')}">${esc(c.label)}${sorted ? (st.sort.dir > 0 ? ' ↑' : ' ↓') : ''}<span class="col-resize" data-resize="${esc(c.key)}" aria-hidden="true"></span></th>`;
    }).join('')}</tr></thead>`;
    const body = total ? rowsHTML(spec, cols, slice) : `<tr><td colspan="${cols.length}" class="empty-row">${esc(spec.emptyText || t('common.noRows'))}</td></tr>`;
    const vattrs = virtual ? `data-virtual="1" style="max-height:${ROWH * 12 + 44}px"` : '';
    const frame = `<div class="table-frame" ${vattrs} data-frame="${spec.id}"><table class="detail-table"><${'caption'} class="sr-only">${esc(spec.caption || '')}</caption>${head}<tbody>${virtual ? `<tr class="vpad" style="height:0"></tr>${body}<tr class="vpad" style="height:${(total - slice.length) * ROWH}px"></tr>` : body}</tbody></table></div>`;
    const from = total ? (st.size === 'all' ? 1 : st.page * st.size + 1) : 0;
    const to = st.size === 'all' ? total : Math.min(total, (st.page + 1) * st.size);
    const foot = `<div class="table-foot"><span>${esc(t('table.showing', { from: I18n.int(from, false), to: I18n.int(to, false), total: I18n.int(total, false) }))}</span>
      <span class="pager">
        <label>${esc(t('table.rows'))} <select data-size="${spec.id}" id="size-${spec.id}">${[25, 50, 100, 'all'].map(n => `<option value="${n}" ${String(st.size) === String(n) ? 'selected' : ''}>${n === 'all' ? t('table.all') : n}</option>`).join('')}</select></label>
        ${st.size !== 'all' ? `<button type="button" class="pg" data-page="${spec.id}" data-dir="-1" ${st.page === 0 ? 'disabled' : ''} aria-label="${esc(t('table.prev'))}">‹</button><span>${st.page + 1} / ${pages}</span><button type="button" class="pg" data-page="${spec.id}" data-dir="1" ${st.page >= pages - 1 ? 'disabled' : ''} aria-label="${esc(t('table.next'))}">›</button>` : ''}
      </span></div>`;
    return frame + foot;
  }

  function render(spec) {
    registry.set(spec.id, spec);
    const st = stateOf(spec);
    const colMenu = spec.columns.slice(1).map(c => `<label class="chk"><input type="checkbox" data-colvis="${spec.id}" value="${esc(c.key)}" ${st.hidden.has(c.key) ? '' : 'checked'}> ${esc(c.label)}</label>`).join('');
    return `<div class="dt" id="dt-${spec.id}">
      <div class="table-toolbar">
        ${spec.search !== false ? `<label class="search-box"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" id="q-${spec.id}" data-search="${spec.id}" value="${esc(st.q)}" placeholder="${esc(t('table.search'))}" aria-label="${esc(t('table.search'))}"></label>` : ''}
        ${spec.toolbarExtra || ''}
        <span class="spacer"></span>
        <div class="menu-wrap"><button type="button" class="action-btn sm" data-menu="cols-${spec.id}">${icon('columns')}${esc(t('table.columns'))}</button><div class="menu" id="cols-${spec.id}" hidden>${colMenu}</div></div>
        ${State.can('export') ? `<button type="button" class="action-btn sm" data-export-table="${spec.id}">${icon('download')}${esc(t('table.exportCsv'))}</button>` : ''}
      </div>
      <div class="dt-body" id="dtb-${spec.id}">${bodyHTML(spec)}</div>
    </div>`;
  }

  function refreshBody(id) {
    const spec = registry.get(id); const el = document.getElementById('dtb-' + id);
    if (spec && el) el.innerHTML = bodyHTML(spec);
  }

  function onScroll(frame) {
    const spec = registry.get(frame.dataset.frame); if (!spec) return;
    const st = stateOf(spec), cols = visibleCols(spec, st), rows = processed(spec);
    const start = Math.max(0, Math.floor(frame.scrollTop / ROWH) - 8), count = 40;
    const slice = rows.slice(start, start + count);
    const tb = frame.querySelector('tbody');
    tb.innerHTML = `<tr class="vpad" style="height:${start * ROWH}px"></tr>${rowsHTML(spec, cols, slice)}<tr class="vpad" style="height:${Math.max(0, rows.length - start - slice.length) * ROWH}px"></tr>`;
  }

  function exportCSV(id) {
    const spec = registry.get(id); if (!spec) return;
    const st = stateOf(spec), cols = visibleCols(spec, st), rows = processed(spec);
    const headers = []; cols.forEach(c => { headers.push(c.label); if (c.sub === 'share') headers.push(c.label + ' %'); if (c.sub === 'delta' && State.get().compareOn) headers.push(c.label + ' Δ%'); });
    const data = rows.map(r => {
      const out = [];
      cols.forEach(c => {
        const v = c.exportValue ? c.exportValue(r) : cellValue(c, r);
        out.push(v == null ? (c.kind === 'metric' ? 'N/A' : '') : (typeof v === 'number' ? +v.toFixed(4) : v));
        const key = c.metric || c.key;
        if (c.sub === 'share') out.push(r.share?.[key] != null ? +r.share[key].toFixed(2) : '');
        if (c.sub === 'delta' && State.get().compareOn) { const ch = r.prev ? Metrics.change(key, cellValue(c, r), r.prev[key]) : null; out.push(ch ? +ch.pct.toFixed(2) : ''); }
      });
      return out;
    });
    Exporter.csv((spec.exportName || id) + '.csv', headers, data);
  }

  /* delegated events */
  function init() {
    let qt;
    document.addEventListener('input', e => {
      const id = e.target.dataset.search;
      if (id) { clearTimeout(qt); qt = setTimeout(() => { const st = ui.get(id); st.q = e.target.value; st.page = 0; refreshBody(id); }, 160); }
    });
    document.addEventListener('change', e => {
      if (e.target.dataset.size) { const st = ui.get(e.target.dataset.size); st.size = e.target.value === 'all' ? 'all' : +e.target.value; st.page = 0; refreshBody(e.target.dataset.size); }
      if (e.target.dataset.colvis) { const st = ui.get(e.target.dataset.colvis); e.target.checked ? st.hidden.delete(e.target.value) : st.hidden.add(e.target.value); refreshBody(e.target.dataset.colvis); }
    });
    document.addEventListener('click', e => {
      if (e.target.closest('.col-resize')) return;
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const id = th.closest('.dt').id.slice(3), st = ui.get(id), key = th.dataset.sort;
        const col = registry.get(id).columns.find(c => c.key === key);
        st.sort = { key, dir: st.sort && st.sort.key === key ? -st.sort.dir : (col.kind === 'metric' ? -1 : 1) };
        refreshBody(id); return;
      }
      const pg = e.target.closest('[data-page]');
      if (pg) { const st = ui.get(pg.dataset.page); st.page += +pg.dataset.dir; refreshBody(pg.dataset.page); return; }
      const ex = e.target.closest('[data-export-table]');
      if (ex) exportCSV(ex.dataset.exportTable);
    });
    document.addEventListener('keydown', e => {
      const th = e.target.closest && e.target.closest('th[data-sort]');
      if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); th.click(); }
    });
    document.addEventListener('scroll', e => { if (e.target.dataset && e.target.dataset.virtual) onScroll(e.target); }, true);
    // column resizing
    document.addEventListener('mousedown', e => {
      const h = e.target.closest('.col-resize'); if (!h) return;
      e.preventDefault();
      const th = h.parentElement, id = th.closest('.dt').id.slice(3), key = h.dataset.resize, st = ui.get(id);
      const x0 = e.clientX, w0 = th.offsetWidth;
      const move = ev => { const w = Math.max(60, w0 + ev.clientX - x0); st.widths[key] = w; th.style.width = th.style.minWidth = th.style.maxWidth = w + 'px'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  }
  return { render, init, refreshBody, processed, registry, exportCSV };
})();
