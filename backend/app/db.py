"""SQLite storage for imported reports (swap for PostgreSQL in production — the schema is plain SQL)."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config as C

DB_PATH = os.environ.get("ADS_DB_PATH", os.path.join(os.path.dirname(__file__), "..", "..", "data", "ads.db"))
_lock = threading.Lock()
STAGE = "stg_"   # rows written during validation, promoted on import (so large files are read once)
DIM_COLS = C.ALL_DIMS
METRIC_COLS = C.METRIC_KEYS


def _q(name: str) -> str:
    return '"' + name + '"'


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def init() -> None:
    with _lock, connect() as con:
        con.execute("PRAGMA journal_mode=WAL")   # dashboard can read while a large import is writing
        con.execute("""CREATE TABLE IF NOT EXISTS datasets (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, rows INTEGER NOT NULL,
            min_day INTEGER, max_day INTEGER, marketplaces TEXT, imported_at TEXT NOT NULL)""")
        cols = ", ".join([f"{_q(d)} TEXT" for d in DIM_COLS] + [f"{_q(m)} REAL" for m in METRIC_COLS])
        con.execute(f"""CREATE TABLE IF NOT EXISTS facts (
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            source TEXT NOT NULL, day INTEGER NOT NULL, {cols})""")
        con.execute("CREATE INDEX IF NOT EXISTS ix_facts_src ON facts(source, marketplace, day)")
        con.execute("CREATE INDEX IF NOT EXISTS ix_facts_ds ON facts(dataset_id)")
        for (sid,) in con.execute("SELECT id FROM datasets WHERE id LIKE 'stg_%'").fetchall():   # leftovers from a crash
            con.execute("DELETE FROM facts WHERE dataset_id = ?", (sid,))
            con.execute("DELETE FROM datasets WHERE id = ?", (sid,))


class DatasetWriter:
    """Streams records into SQLite in batches inside one transaction (all-or-nothing)."""
    BATCH = 20000

    def __init__(self, ds_id: str, name: str, source: str):
        self.id, self.name, self.source = ds_id, name, source
        self.cols = ["dataset_id", "source", "day"] + DIM_COLS + METRIC_COLS
        self.sql = f"INSERT INTO facts ({', '.join(_q(c) for c in self.cols)}) VALUES ({', '.join('?' * len(self.cols))})"
        self.buf, self.rows, self.min, self.max, self.mks = [], 0, None, None, set()
        _lock.acquire()
        self.con = connect()
        self.con.execute("BEGIN")
        self.con.execute("INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?)", (ds_id, name, source, 0, None, None, "[]", ""))

    def add(self, r: dict) -> None:
        self.buf.append([self.id, self.source, r["day"]] + [r.get(d) for d in DIM_COLS] + [r.get(m) for m in METRIC_COLS])
        self.rows += 1
        d = r["day"]
        self.min = d if self.min is None or d < self.min else self.min
        self.max = d if self.max is None or d > self.max else self.max
        self.mks.add(r["marketplace"])
        if len(self.buf) >= self.BATCH:
            self.flush()

    def flush(self) -> None:
        if self.buf:
            self.con.executemany(self.sql, self.buf)
            self.buf = []

    def close(self) -> dict:
        try:
            self.flush()
            meta = {"id": self.id, "name": self.name, "source": self.source, "rows": self.rows, "minDay": self.min,
                    "maxDay": self.max, "marketplaces": sorted(self.mks), "importedAt": datetime.now(timezone.utc).isoformat()}
            self.con.execute("UPDATE datasets SET rows=?, min_day=?, max_day=?, marketplaces=?, imported_at=? WHERE id=?",
                             (self.rows, self.min, self.max, json.dumps(meta["marketplaces"]), meta["importedAt"], self.id))
            self.con.commit()
            return meta
        finally:
            self.con.close(); _lock.release()

    def abort(self) -> None:
        try:
            self.con.rollback()
        finally:
            self.con.close(); _lock.release()


def insert_dataset(ds_id: str, name: str, source: str, records: list[dict]) -> dict:
    w = DatasetWriter(ds_id, name, source)
    try:
        for r in records:
            w.add(r)
    except Exception:
        w.abort(); raise
    return w.close()


def list_datasets() -> list[dict]:
    with connect() as con:
        rows = con.execute("SELECT * FROM datasets WHERE id NOT LIKE 'stg_%' ORDER BY imported_at").fetchall()
    return [{"id": r["id"], "name": r["name"], "source": r["source"], "rows": r["rows"], "minDay": r["min_day"],
             "maxDay": r["max_day"], "marketplaces": json.loads(r["marketplaces"] or "[]"), "importedAt": r["imported_at"]} for r in rows]


def delete_dataset(ds_id: str) -> bool:
    with _lock, connect() as con:
        con.execute("DELETE FROM facts WHERE dataset_id = ?", (ds_id,))
        n = con.execute("DELETE FROM datasets WHERE id = ?", (ds_id,)).rowcount
    return n > 0


GRAIN_FILTER = {"keyword": "keyword", "asin": "asin", "placement": "placement", "searchTerm": "searchTerm"}
WEIGHTED = {"tosIs", "searchIs"}


def explode_multi(raw_id: str, new_id: str, name: str, grains: list[str]) -> dict:
    """Split a multi-level report into one aggregated fact set per grain (campaign, keyword, asin, …).
    Every grain sums to the same totals; dimensions a grain doesn't have are rolled up.
    Runs as SQL GROUP BYs inside SQLite, so millions of rows never enter Python memory."""
    with _lock, connect() as con:
        for g in grains:
            dims = C.SOURCES[g]
            where = f"dataset_id = ? AND {_q(GRAIN_FILTER[g])} IS NOT NULL AND {_q(GRAIN_FILTER[g])} <> ''" if g in GRAIN_FILTER else "dataset_id = ?"
            aggs = []
            for m in METRIC_COLS:
                if m in WEIGHTED:   # impression-weighted averages, not sums
                    aggs.append(f"SUM({_q(m)} * impressions) / NULLIF(SUM(CASE WHEN {_q(m)} IS NOT NULL THEN impressions END), 0)")
                else:
                    aggs.append(f"SUM({_q(m)})")   # all-NULL stays NULL -> N/A, never 0
            cols = ["dataset_id", "source", "day"] + dims + METRIC_COLS
            con.execute(f"""INSERT INTO facts ({', '.join(_q(c) for c in cols)})
                SELECT ?, ?, day, {', '.join(_q(d) for d in dims)}, {', '.join(aggs)}
                FROM facts WHERE {where} GROUP BY day, {', '.join(_q(d) for d in dims)}""", (new_id, g, raw_id))
        con.execute("DELETE FROM facts WHERE dataset_id = ?", (raw_id,))
        con.execute("UPDATE datasets SET id = ?, name = ?, source = ?, imported_at = ? WHERE id = ?",
                    (new_id, name, C.MULTI, datetime.now(timezone.utc).isoformat(), raw_id))
    meta = next(d for d in list_datasets() if d["id"] == new_id)
    meta["grains"] = grains
    return meta


def promote(stage_id: str, new_id: str, name: str) -> dict:
    """Turn validated staging rows into a real dataset without re-reading the file."""
    with _lock, connect() as con:
        con.execute("UPDATE facts SET dataset_id = ? WHERE dataset_id = ?", (new_id, stage_id))
        con.execute("UPDATE datasets SET id = ?, name = ?, imported_at = ? WHERE id = ?",
                    (new_id, name, datetime.now(timezone.utc).isoformat(), stage_id))
    return next(d for d in list_datasets() if d["id"] == new_id)


def overlapping(source: str, min_day: int, max_day: int, marketplaces: list[str]) -> list[dict]:
    return [d for d in list_datasets() if d["source"] == source and d["maxDay"] >= min_day and d["minDay"] <= max_day
            and set(d["marketplaces"]) & set(marketplaces)]


_cache: dict = {"key": None}


def _uint(n: int) -> str:
    return "u8" if n < 256 else "u16" if n < 65536 else "u32"


_build_lock = threading.Lock()


def binary_payload() -> tuple[dict, bytes]:
    """All imported facts as typed-array columns: a small JSON header + one binary buffer.
    Dimensions are dictionary-encoded (1-4 bytes per value), metrics are float32 with NaN = not reported.
    Built in ONE streaming pass over the table (chunks of 200k rows); the browser maps the buffer
    straight into typed arrays with no per-row parsing. Cached until the data changes."""
    ds = list_datasets()
    key = tuple((d["id"], d["rows"]) for d in ds)
    if _cache["key"] == key:
        return _cache["meta"], _cache["blob"]
    with _build_lock:
        if _cache["key"] == key:
            return _cache["meta"], _cache["blob"]
        parts, offset, tables = [], 0, {}

        def put(arr: np.ndarray) -> int:
            nonlocal offset
            pad = (-offset) % 4
            if pad:
                parts.append(b"\0" * pad); offset += pad
            start = offset
            b = arr.tobytes(); parts.append(b); offset += len(b)
            return start

        with connect() as con:
            where = "source = ? AND dataset_id NOT LIKE 'stg_%'"
            for source, dims in C.SOURCES.items():
                n = con.execute(f"SELECT COUNT(*) FROM facts WHERE {where}", (source,)).fetchone()[0]
                if not n:
                    continue
                dim_cols = dims + ["dataset_id"]
                day = np.empty(n, np.uint16)
                codes = {d: np.empty(n, np.uint32) for d in dim_cols}
                lookup = {d: {} for d in dim_cols}
                mets = {m: np.empty(n, np.float32) for m in METRIC_COLS}
                sql = f"SELECT day, {', '.join(_q(c) for c in dim_cols + METRIC_COLS)} FROM facts WHERE {where}"
                pos = 0
                for chunk in pd.read_sql_query(sql, con, params=(source,), chunksize=200_000):
                    k = len(chunk); sl = slice(pos, pos + k)
                    day[sl] = chunk["day"].to_numpy(np.uint16)
                    for d in dim_cols:
                        col = chunk[d].fillna("").astype(str)
                        lk = lookup[d]
                        for v in col.unique():
                            if v not in lk:
                                lk[v] = len(lk)
                        codes[d][sl] = col.map(lk).to_numpy(np.uint32)
                    for m in METRIC_COLS:
                        mets[m][sl] = pd.to_numeric(chunk[m], errors="coerce").to_numpy(np.float32)
                    pos += k
                meta = {"length": int(pos), "minDay": int(day[:pos].min()), "maxDay": int(day[:pos].max()),
                        "day": {"type": "u16", "offset": put(day[:pos])}, "dims": {}, "metrics": []}
                for d in dim_cols:
                    t = _uint(len(lookup[d]))
                    arr = codes[d][:pos].astype({"u8": np.uint8, "u16": np.uint16, "u32": np.uint32}[t])
                    meta["dims"]["fileId" if d == "dataset_id" else d] = {"type": t, "offset": put(arr), "values": list(lookup[d].keys())}
                for m in METRIC_COLS:
                    v = mets[m][:pos]
                    meta["metrics"].append(None if np.isnan(v).all() else {"type": "f32", "offset": put(v)})
                tables[source] = meta
        blob = b"".join(parts)
        header = {"datasets": ds, "tables": tables, "bytes": len(blob), "version": abs(hash(key)) % 10**12}
        _cache.update(key=key, meta=header, blob=blob)
        return header, blob


def facts_frame(source: str, marketplace: str, start: int | None, end: int | None) -> pd.DataFrame:
    sql = "SELECT * FROM facts WHERE source = ? AND marketplace = ?"
    args: list = [source, marketplace]
    if start is not None:
        sql += " AND day >= ?"; args.append(start)
    if end is not None:
        sql += " AND day <= ?"; args.append(end)
    with connect() as con:
        return pd.read_sql_query(sql, con, params=args)
