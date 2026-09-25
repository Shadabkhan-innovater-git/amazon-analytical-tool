"""FastAPI application: upload/validate/import Amazon Ads reports, store them in SQLite,
serve the dashboard and a small reporting API.

Large files: uploads stream to disk in 1 MB chunks, ZIP/GZ files are unpacked, and
validation + import read rows lazily in a single pass, so file size is limited by disk
space (and MAX_UPLOAD_MB), not memory.

Run:  python run.py        (then open http://localhost:8000)
"""
from __future__ import annotations

import csv
import io
import json
import os
import secrets
import shutil
import threading
import time
import uuid
from datetime import date

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import config as C
from . import db, files, importer, metrics

app = FastAPI(title="Amazon Ads Intelligence API", version="1.1.0")
app.add_middleware(GZipMiddleware, minimum_size=2000, compresslevel=1)   # /api/data compresses roughly 10x
FRONTEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend"))
UPLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(db.DB_PATH), "uploads"))
UPLOADS: dict[str, dict] = {}   # token -> upload on disk (kept 2 hours for re-validation / issue report)
UPLOAD_TTL = 2 * 3600
BOM = "﻿"


@app.on_event("startup")
def _startup():
    db.init()
    _warm_cache()
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)


def _warm_cache():
    """Rebuild the dashboard payload in the background so the next page load is instant."""
    threading.Thread(target=db.binary_payload, daemon=True).start()


def _json_cell(v):
    return v.isoformat() if isinstance(v, date) else v


def _cleanup(up: dict) -> None:
    if up.get("staged"):
        db.delete_dataset(up["staged"]["id"])
    shutil.rmtree(up["dir"], ignore_errors=True)


def _signature(req) -> str:
    return json.dumps([req.sheetIdx, req.headerRow, req.mapping, req.settings, req.source], sort_keys=True, default=str)


def _get_upload(token: str) -> dict:
    now = time.time()
    for k in [k for k, u in UPLOADS.items() if now - u["created"] > UPLOAD_TTL]:
        _cleanup(UPLOADS.pop(k))
    up = UPLOADS.get(token)
    if not up:
        raise HTTPException(404, "This upload has expired. Upload the file again.")
    return up


def _head(up: dict, sheet_idx: int) -> list:
    """First 1,000 non-blank rows (file_row_no, row) — enough to find headers and preview."""
    key = ("head", sheet_idx)
    if key not in up:
        up[key] = files.head(up["path"], up["name"], sheet_idx, 1000)
    return up[key]


def _inspect(up: dict, sheet_idx: int | None = None, header_row: int | None = None, synonyms: dict | None = None) -> dict:
    sheets = up["sheets"]
    if sheet_idx is None:
        sheet_idx = next((i for i, s in enumerate(sheets) if any(w in s["name"].lower() for w in
                          ("sponsored", "campaign", "report", "search", "target", "placement", "advertised"))), 0)
    sheet_idx = max(0, min(sheet_idx, len(sheets) - 1))
    head = _head(up, sheet_idx)
    if not head:
        raise HTTPException(400, "That sheet has no rows.")
    rows = [r for _, r in head]
    if header_row is None:
        header_row = importer.detect_header_row(rows, synonyms)
    header_row = max(0, min(header_row, len(rows) - 1))
    headers = [str(h if h is not None else "").strip() for h in rows[header_row]]
    data = rows[header_row + 1:]
    m = importer.auto_map(headers, synonyms)
    m["mapping"] = importer.refine_mapping(m["mapping"], headers, data[:500])
    if "asin" in m["mapping"]:
        m["confidence"]["asin"] = m["confidence"].pop("sku", "medium")
    det = importer.detect_source(m["mapping"], sheets[sheet_idx]["name"], up["name"])
    entities = []
    if det["bulk"]:
        ci = m["mapping"]["entity"]
        entities = sorted({str(r[ci]) for r in data if ci < len(r) and str(r[ci]).strip()})
    kind = files.kind_of(up["name"])
    return {
        "token": up["token"], "fileName": up["name"], "kind": kind, "size": up["size"],
        "sheets": sheets, "sheetIdx": sheet_idx, "headerRow": header_row, "headers": headers,
        "totalRows": max(0, sheets[sheet_idx]["rows"] - head[header_row][0]), "totalApprox": kind == "csv",
        "sample": [[_json_cell(c) for c in r] for r in data[:8]],
        "mapping": m["mapping"], "confidence": m["confidence"], "unmapped": m["unmapped"],
        "source": det["source"], "adType": det["adType"], "bulk": det["bulk"], "entities": entities,
    }


# --------------------------------------------------------------------------- health + data
@app.get("/api/health")
def health():
    return {"ok": True, "version": app.version, "storage": "sqlite", "datasets": len(db.list_datasets()),
            "maxUploadMb": C.MAX_UPLOAD_MB}


@app.get("/api/datasets")
def datasets():
    return db.list_datasets()


@app.delete("/api/datasets/{ds_id}")
def delete_dataset(ds_id: str):
    if not db.delete_dataset(ds_id):
        raise HTTPException(404, "Data source not found.")
    _warm_cache()
    return {"deleted": ds_id}


@app.get("/api/data")
def data():
    """Header: datasets + column layout. The columns themselves come from /api/data.bin."""
    header, _ = db.binary_payload()
    return header


@app.get("/api/data.bin")
def data_bin():
    _, blob = db.binary_payload()
    return Response(blob, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------- import workflow
@app.post("/api/import/upload")
async def upload(file: UploadFile = File(...)):
    name = os.path.basename(file.filename or "upload.csv")
    if not name.lower().endswith(C.ALLOWED_EXTENSIONS):
        raise HTTPException(400, "That file type is not supported. Use CSV, TSV, TXT, XLSX, XLS, ZIP or GZ.")
    token = secrets.token_urlsafe(12)
    work = os.path.join(UPLOAD_DIR, token)
    os.makedirs(work, exist_ok=True)
    path, size = os.path.join(work, "upload_" + name), 0
    try:
        with open(path, "wb") as out:          # stream to disk, 1 MB at a time
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > C.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"The file is larger than {C.MAX_UPLOAD_MB:,} MB. Zip it, split it by date range, "
                                             "or start the server with a higher MAX_UPLOAD_MB.")
                out.write(chunk)
        data_path, data_name = await run_in_threadpool(files.unpack, path, name, work)
        sheets = await run_in_threadpool(files.sheets, data_path, data_name)
    except HTTPException:
        shutil.rmtree(work, ignore_errors=True); raise
    except ValueError as e:
        shutil.rmtree(work, ignore_errors=True); raise HTTPException(400, str(e))
    except Exception as e:
        shutil.rmtree(work, ignore_errors=True); raise HTTPException(400, f"The file could not be read: {e}")
    UPLOADS[token] = {"token": token, "name": data_name, "size": size, "path": data_path, "dir": work,
                      "sheets": sheets, "created": time.time()}
    return await run_in_threadpool(_inspect, UPLOADS[token])


class InspectReq(BaseModel):
    token: str
    sheetIdx: int | None = None
    headerRow: int | None = None
    synonyms: dict = Field(default_factory=dict)


@app.post("/api/import/inspect")
def inspect(req: InspectReq):
    return _inspect(_get_upload(req.token), req.sheetIdx, req.headerRow, req.synonyms)


class ValidateReq(BaseModel):
    token: str
    sheetIdx: int
    headerRow: int
    mapping: dict
    settings: dict = Field(default_factory=dict)
    source: str
    replaceIds: list[str] = Field(default_factory=list)


def _process(req: ValidateReq, on_record=None) -> dict:
    if req.source not in C.SOURCES and req.source != C.MULTI:
        raise HTTPException(400, "Unknown report type.")
    up = _get_upload(req.token)
    head = _head(up, req.sheetIdx)
    if not 0 <= req.headerRow < len(head):
        raise HTTPException(400, "Header row is outside the file.")
    header_file_row = head[req.headerRow][0]
    rows_iter = files.data_rows(up["path"], up["name"], req.sheetIdx, header_file_row)
    sample = [r for _, r in head[req.headerRow + 1:req.headerRow + 501]]
    res = importer.process(rows_iter, req.mapping, req.settings, req.source, on_record=on_record, date_sample=sample)
    up["last_validation"] = {"res": res, "headers": [str(h) for h in head[req.headerRow][1]]}
    return res


@app.post("/api/import/validate")
def validate(req: ValidateReq):
    """One streaming pass: validate every row and stage the valid ones, so Import is instant."""
    up = _get_upload(req.token)
    if up.get("staged"):
        db.delete_dataset(up["staged"]["id"]); up["staged"] = None
    writer = db.DatasetWriter(db.STAGE + req.token, up["name"], req.source)
    try:
        res = _process(req, on_record=writer.add)
    except Exception:
        writer.abort(); raise
    if res["blocked"]:
        writer.abort()
    else:
        writer.close()
        up["staged"] = {"id": db.STAGE + req.token, "sig": _signature(req), "grains": res["grains"]}
    overlaps = db.overlapping(req.source, res["minDay"], res["maxDay"], res["marketplaces"]) if res["ready"] else []
    return {"issues": res["issues"], "counts": res["counts"], "blocked": res["blocked"], "ready": res["ready"], "overlaps": overlaps,
            "grains": res.get("grains", [])}


@app.post("/api/import/commit")
def commit(req: ValidateReq):
    up = _get_upload(req.token)
    sheet = up["sheets"][req.sheetIdx]["name"]
    name = up["name"] + (f" · {sheet}" if files.kind_of(up["name"]) != "csv" else "")
    new_id = "ds_" + uuid.uuid4().hex[:10]
    for ds in req.replaceIds:
        db.delete_dataset(ds)
    staged = up.get("staged")
    if staged and staged["sig"] == _signature(req):        # validated with these exact settings → promote
        up["staged"] = None
        meta = db.explode_multi(staged["id"], new_id, name, staged["grains"]) if req.source == C.MULTI else db.promote(staged["id"], new_id, name)
        _warm_cache()
        return meta
    writer = db.DatasetWriter(new_id, name, req.source)     # settings changed since validation → full pass
    try:
        res = _process(req, on_record=writer.add)
    except Exception:
        writer.abort(); raise
    if res["blocked"]:
        writer.abort()
        raise HTTPException(400, "Nothing to import — fix the errors first.")
    meta = writer.close()
    if req.source == C.MULTI:
        raw = "raw_" + new_id
        with db.connect() as con:   # re-key the raw rows, then split them into grains
            con.execute("UPDATE facts SET dataset_id = ? WHERE dataset_id = ?", (raw, new_id))
            con.execute("UPDATE datasets SET id = ? WHERE id = ?", (raw, new_id))
        meta = db.explode_multi(raw, new_id, name, res["grains"])
    _warm_cache()
    return meta


@app.get("/api/import/{token}/issues.csv")
def issues_csv(token: str):
    lv = _get_upload(token).get("last_validation")
    if not lv:
        raise HTTPException(404, "Validate the file first.")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Severity", "Issue", "Field", "Rows affected", "Example rows"])
    for i in lv["res"]["issues"]:
        w.writerow([i["severity"], i["rule"], i["field"] or "", i["count"], " ".join(map(str, i["rows"]))])
    w.writerow([]); w.writerow(["Excluded rows"]); w.writerow(["Row", "Reason"] + lv["headers"])
    for row_no, reason, row in lv["res"]["excluded"]:
        w.writerow([row_no, reason] + [_json_cell(c) for c in row])
    if len(lv["res"]["excluded"]) >= importer.MAX_EXCLUDED_LISTED:
        w.writerow([f"... list truncated at {importer.MAX_EXCLUDED_LISTED:,} rows"])
    return Response(BOM + buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="import-issues.csv"'})


@app.get("/api/template.csv")
def template():
    buf = io.StringIO()
    csv.writer(buf).writerows(importer.template_rows())
    return Response(BOM + buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="amazon-ads-import-template.csv"'})


# --------------------------------------------------------------------------- reporting API (pandas)
@app.get("/api/report/summary")
def report_summary(marketplace: str = "US", start: str | None = None, end: str | None = None,
                   source: str = "campaign", group_by: str | None = None):
    """KPIs (or a grouped table) for a date range. Dates as YYYY-MM-DD."""
    if source not in C.SOURCES:
        raise HTTPException(400, "Unknown report type.")
    if group_by and group_by not in C.SOURCES[source]:
        raise HTTPException(400, f"{group_by} is not available in the {source} report.")
    s = importer.parse_date(start) if start else None
    e = importer.parse_date(end) if end else None
    df = db.facts_frame(source, marketplace, s or None, e or None)
    return {"rows": len(df), "result": metrics.summarize(df, group_by)}


# --------------------------------------------------------------------------- dashboard (static front end)
@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND, "index.html"))


app.mount("/", StaticFiles(directory=FRONTEND), name="frontend")
