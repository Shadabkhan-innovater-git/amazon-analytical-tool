/* ==========================================================================
   API CLIENT — talks to the Python backend (FastAPI). When the page is
   served by `python run.py`, uploads are parsed, validated and stored by
   Python (pandas + SQLite). Opened as a plain file, the dashboard falls back
   to in-browser processing.
   ========================================================================== */
const Api = (() => {
  let enabled = false;

  async function detect() {
    if (window.__STANDALONE__ || !/^https?:$/.test(location.protocol)) return false;
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      enabled = !!(j && j.ok === true);
      if (enabled) limits = { maxUploadMb: j.maxUploadMb };
    } catch { enabled = false; }
    return enabled;
  }
  async function req(path, opts = {}) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { }
      throw new Error(msg || `Request failed (${r.status})`);
    }
    return r.json();
  }
  const post = (path, body) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  let limits = { maxUploadMb: null };
  /* XHR (not fetch) so large uploads can report progress */
  function upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(), fd = new FormData();
      fd.append('file', file);
      x.open('POST', 'api/import/upload');
      x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.upload.onload = () => onProgress && onProgress(1);
      x.onload = () => {
        let j = null; try { j = JSON.parse(x.responseText); } catch { }
        if (x.status >= 200 && x.status < 300 && j) resolve(j);
        else reject(new Error((j && typeof j.detail === 'string' && j.detail) || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('The connection to the server was lost during upload.'));
      x.send(fd);
    });
  }
  const inspect = body => post('api/import/inspect', body);
  const validate = body => post('api/import/validate', body);
  const commit = body => post('api/import/commit', body);
  const remove = id => req('api/datasets/' + encodeURIComponent(id), { method: 'DELETE' });
  const issuesUrl = token => 'api/import/' + encodeURIComponent(token) + '/issues.csv';

  /* load every stored report into the browser query engine */
  async function loadData() {
    const header = await req('api/data', { cache: 'no-store' });
    let buf = new ArrayBuffer(0);
    if (header.bytes) {
      const r = await fetch('api/data.bin?v=' + header.version, { cache: 'no-store' });
      if (!r.ok) throw new Error(`Could not load data (${r.status})`);
      buf = await r.arrayBuffer();
    }
    DataStore.loadServer(header, buf);
    return header;
  }
  return { detect, upload, inspect, validate, commit, remove, issuesUrl, loadData, get enabled() { return enabled; }, get limits() { return limits; } };
})();
