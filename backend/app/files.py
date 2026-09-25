"""Large-file handling: uploads are streamed to disk, compressed files are unpacked,
and rows are read lazily so a multi-GB report never has to fit in memory."""
from __future__ import annotations

import csv
import gzip
import io
import os
import shutil
import zipfile
from datetime import date, datetime
from itertools import islice

from . import config as C

TABULAR = (".csv", ".tsv", ".txt", ".xlsx", ".xls")
csv.field_size_limit(10 * 1024 * 1024)


def kind_of(name: str) -> str:
    n = name.lower()
    return "xlsx" if n.endswith(".xlsx") else "xls" if n.endswith(".xls") else "csv"


def unpack(path: str, name: str, work_dir: str) -> tuple[str, str]:
    """Return (data_path, data_name). .zip -> largest report inside; .gz -> decompressed file."""
    low = name.lower()
    if low.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            members = [m for m in z.infolist() if not m.is_dir() and m.filename.lower().endswith(TABULAR)
                       and not os.path.basename(m.filename).startswith(("._", "~$"))]
            if not members:
                raise ValueError("The ZIP file has no CSV or Excel report inside.")
            m = max(members, key=lambda x: x.file_size)
            inner = os.path.basename(m.filename)
            out = os.path.join(work_dir, "unzipped_" + inner)
            with z.open(m) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
        os.remove(path)
        return out, inner
    if low.endswith(".gz"):
        inner = os.path.basename(name[:-3])
        if not inner.lower().endswith(TABULAR):
            inner += ".csv"
        out = os.path.join(work_dir, "unzipped_" + inner)
        with gzip.open(path, "rb") as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        os.remove(path)
        return out, inner
    if not low.endswith(TABULAR):
        raise ValueError("That file type is not supported. Use CSV, TSV, TXT, XLSX, XLS, ZIP or GZ.")
    return path, name


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, float) and v != v:
        return ""
    if hasattr(v, "item"):
        return v.item()
    return v


# --------------------------------------------------------------------------- CSV
def _csv_encoding(path: str) -> str:
    with open(path, "rb") as f:
        head = f.read(4)
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    return "utf-8-sig"


def _csv_dialect(path: str, enc: str) -> str:
    with open(path, encoding=enc, errors="replace", newline="") as f:
        first = f.readline()
    return max([",", ";", "\t", "|"], key=first.count)


def _count_lines(path: str) -> int:
    n = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            n += chunk.count(b"\n")
    return n + 1


def _iter_csv(path: str):
    enc = _csv_encoding(path)
    delim = _csv_dialect(path, enc)
    with open(path, encoding=enc, errors="replace", newline="") as f:
        for i, row in enumerate(csv.reader(f, delimiter=delim), start=1):
            yield i, row


# --------------------------------------------------------------------------- Excel
def _xlsx_book(path: str):
    import openpyxl
    return openpyxl.load_workbook(path, read_only=True, data_only=True)


def _iter_xlsx(path: str, sheet_idx: int):
    wb = _xlsx_book(path)
    try:
        ws = wb.worksheets[sheet_idx]
        for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            yield i, [_cell(v) for v in row]
    finally:
        wb.close()


def _iter_xls(path: str, sheet_idx: int):
    import pandas as pd
    df = pd.read_excel(path, sheet_name=sheet_idx, header=None, dtype=object)
    for i, row in enumerate(df.itertuples(index=False, name=None), start=1):
        yield i, [_cell(v) for v in row]


# --------------------------------------------------------------------------- public API
def sheets(path: str, name: str) -> list[dict]:
    k = kind_of(name)
    if k == "csv":
        return [{"name": name, "rows": _count_lines(path)}]
    if k == "xlsx":
        wb = _xlsx_book(path)
        try:
            return [{"name": ws.title, "rows": ws.max_row or 0} for ws in wb.worksheets]
        finally:
            wb.close()
    import pandas as pd
    xl = pd.ExcelFile(path)
    return [{"name": n, "rows": xl.book.sheet_by_name(n).nrows if hasattr(xl.book, "sheet_by_name") else 0} for n in xl.sheet_names]


def iter_rows(path: str, name: str, sheet_idx: int = 0):
    """Yield (file_row_number, row) for every non-blank row, lazily."""
    k = kind_of(name)
    it = _iter_csv(path) if k == "csv" else _iter_xlsx(path, sheet_idx) if k == "xlsx" else _iter_xls(path, sheet_idx)
    for i, row in it:
        if any(str(c).strip() for c in row if c is not None):
            yield i, row


def head(path: str, name: str, sheet_idx: int = 0, n: int = 1000) -> list[tuple[int, list]]:
    return list(islice(iter_rows(path, name, sheet_idx), n))


def data_rows(path: str, name: str, sheet_idx: int, header_row_no: int):
    """Rows after the header row (header_row_no is the file row number of the header)."""
    for i, row in iter_rows(path, name, sheet_idx):
        if i > header_row_no:
            yield i, row


def max_upload_bytes() -> int:
    return C.MAX_UPLOAD_BYTES
