"""Import pipeline: read file -> detect header -> auto-map columns -> validate -> normalise.

Nothing is dropped silently: every excluded row is counted, and listed in the issue report.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from functools import lru_cache

import pandas as pd

from . import config as C

EPOCH = date(1970, 1, 1)


def to_day(d: date) -> int:
    return (d - EPOCH).days


def from_day(n: int) -> date:
    return EPOCH + timedelta(days=int(n))


# (file reading lives in files.py — streamed, supports ZIP/GZ and multi-GB CSVs)


# --------------------------------------------------------------------------- 2-4. headers + mapping
_WINDOW = re.compile(r"\b(1|7|14|30)[\s-]*days?\b")


def norm(h) -> str:
    s = str(h if h is not None else "").lower()
    s = _WINDOW.sub("", s)
    s = s.replace("(#)", "").replace("($)", "").replace("(%)", "")
    return re.sub(r"[^a-z0-9]", "", s)


def synonyms(extra: dict | None = None) -> dict:
    extra = extra or {}
    return {f: lst + [norm(x) for x in extra.get(f, []) if norm(x)] for f, lst in C.FIELD_SYNONYMS.items()}


def detect_header_row(rows: list[list], extra=None) -> int:
    syn = {s for lst in synonyms(extra).values() for s in lst}
    best, best_score = 0, -1
    for i, row in enumerate(rows[:15]):
        score = sum(1 for c in row if norm(c) in syn)
        if score > best_score:
            best, best_score = i, score
    return best


def auto_map(headers: list[str], extra=None) -> dict:
    syn = synonyms(extra)
    nh = [norm(h) for h in headers]
    mapping, confidence, used = {}, {}, set()
    for pass_no in (1, 2):
        for field, lst in syn.items():
            if field in mapping:
                continue
            for i, h in enumerate(nh):
                if i in used or not h or h in C.RECALCULATED:
                    continue
                if pass_no == 1:
                    hit = h in lst
                else:
                    hit = any(len(s) > 4 and (s in h or (len(h) > 5 and h in s)) for s in lst)
                if hit:
                    mapping[field] = i
                    confidence[field] = "high" if pass_no == 1 else "medium"
                    used.add(i)
                    break
    unmapped = [{"header": h, "i": i, "status": "recalculated" if nh[i] in C.RECALCULATED else "ignored"}
                for i, h in enumerate(headers) if i not in used]
    return {"mapping": mapping, "confidence": confidence, "unmapped": unmapped}


ASIN_RE = re.compile(r"^(B0[A-Z0-9]{8}|\d{9}[\dX])$")


def refine_mapping(mapping: dict, headers: list, sample_rows: list) -> dict:
    """Content-based fixes: an 'Advertised product SKU' column full of ASINs is the ASIN."""
    if "asin" not in mapping and "sku" in mapping:
        ci = mapping["sku"]
        vals = [str(r[ci]).strip().upper() for r in sample_rows if ci < len(r) and str(r[ci]).strip()]
        if vals and sum(bool(ASIN_RE.match(v)) for v in vals) / len(vals) >= 0.8:
            mapping["asin"] = mapping.pop("sku")
    return mapping


def detect_source(mapping: dict, sheet_name: str = "", file_name: str = "") -> dict:
    txt = f"{sheet_name} {file_name}".lower()
    ad_type = None
    if re.search(r"sponsored[ _-]?brands?|\bsb\b|_sb_|headline", txt):
        ad_type = "SB"
    elif re.search(r"sponsored[ _-]?display|\bsd\b|_sd_", txt):
        ad_type = "SD"
    elif re.search(r"sponsored[ _-]?products?|\bsp\b|_sp_", txt):
        ad_type = "SP"
    has = lambda f: f in mapping
    levels = [f for f in ("keyword", "asin", "placement", "searchTerm") if has(f)]
    if len(levels) >= 2 and not (levels == ["keyword", "searchTerm"]):
        source = C.MULTI          # one detailed file -> split into several grains on import
    else:
        source = ("searchTerm" if has("searchTerm") else "asin" if has("asin") else "placement" if has("placement")
                  else "keyword" if has("keyword") else "campaign")
    return {"source": source, "adType": ad_type, "bulk": has("entity")}


# --------------------------------------------------------------------------- value normalisers
_NA = re.compile(r"^(-|—|n/?a|null|nan)$", re.I)


def parse_number(v):
    if isinstance(v, str):
        return _parse_number_str(v)
    return _parse_number_any(v)


@lru_cache(maxsize=200000)
def _parse_number_str(v):
    return _parse_number_any(v)


def _parse_number_any(v):
    """None for blank, float for numbers, float('nan') for invalid."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v) if pd.notna(v) else None
    s = str(v).strip()
    if not s or _NA.match(s):
        return None
    neg = (s.startswith("(") and s.endswith(")")) or s.startswith("-")
    s = re.sub(r"[()\s%]", "", s).lstrip("-")
    s = re.sub(r"[^\d.,-]", "", s)
    if re.fullmatch(r"\d{1,3}(\.\d{3})+(,\d+)?", s) or re.fullmatch(r"\d+,\d{1,2}", s):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    if not re.fullmatch(r"\d*\.?\d+", s):
        return float("nan")
    n = float(s)
    return -n if neg else n


MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def date_order(values) -> str:
    dmy = mdy = 0
    for v in values:
        m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", str(v))
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2))
        if 12 < a <= 31 and b <= 12:
            dmy += 1
        elif 12 < b <= 31 and a <= 12:
            mdy += 1
    return "dmy" if dmy > mdy else "mdy"


def _valid(y, mo, d):
    try:
        if not 2000 <= y <= 2100:
            return None
        return to_day(date(y, mo, d))
    except ValueError:
        return None


def parse_date(v, order="mdy"):
    if isinstance(v, str):
        return _parse_date_str(v, order)
    return _parse_date_any(v, order)


@lru_cache(maxsize=65536)
def _parse_date_str(v, order):
    return _parse_date_any(v, order)


def _parse_date_any(v, order="mdy"):
    """Return day number, None for blank, or False for invalid."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return to_day(v.date())
    if isinstance(v, date):
        return to_day(v)
    if isinstance(v, (int, float)):
        if 20000 < v < 80000:  # Excel serial
            return to_day(date(1899, 12, 30) + timedelta(days=int(round(v))))
        if 19000000 < v < 21000000:
            v = str(int(v))
        else:
            return False
    s = str(v).strip()
    m = re.match(r"^(\d{4})-?(\d{2})-?(\d{2})", s)
    if m:
        r = _valid(int(m[1]), int(m[2]), int(m[3]))
        return r if r is not None else False
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", s)
    if m:
        y = int(m[3]) + (2000 if int(m[3]) < 100 else 0)
        a, b = int(m[1]), int(m[2])
        r = _valid(y, b, a) if order == "dmy" else _valid(y, a, b)
        return r if r is not None else False
    m = re.match(r"^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})", s)
    if m and m[1].lower() in MONTHS:
        r = _valid(int(m[3]), MONTHS[m[1].lower()], int(m[2]))
        return r if r is not None else False
    m = re.match(r"^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})", s)
    if m and m[2].lower() in MONTHS:
        r = _valid(int(m[3]), MONTHS[m[2].lower()], int(m[1]))
        return r if r is not None else False
    return False


@lru_cache(maxsize=4096)
def norm_ad_type(v):
    s = re.sub(r"[^a-z]", "", str(v or "").lower())
    if not s:
        return None
    if s in ("sp", "sponsoredproduct", "sponsoredproducts", "products") or "sponsoredproduct" in s:
        return "SP"
    if s in ("sb", "sponsoredbrand", "sponsoredbrands", "headlinesearch", "hsa", "brands") or "sponsoredbrand" in s:
        return "SB"
    if s in ("sd", "sponsoreddisplay", "display") or "sponsoreddisplay" in s:
        return "SD"
    return "?"


@lru_cache(maxsize=4096)
def norm_match(v, kw):
    s, k = str(v or "").lower(), str(kw or "").lower()
    if s == "targeting_expression_predefined" or k in ("close-match", "loose-match", "substitutes", "complements"):
        return "Auto"
    if s == "theme": return "Theme"
    if s == "unallocated" or k == "unallocated": return "Unallocated"
    if "exact" in s: return "Exact"
    if "phrase" in s: return "Phrase"
    if "broad" in s: return "Broad"
    if re.search(r"auto|close|loose|substitut|complement", s) or k in ("close-match", "loose-match", "substitutes", "complements"):
        return "Auto"
    if re.search(r"audience|views|purchases|remarketing", s) or re.match(r"^(views|purchases|audience)", k):
        return "Audience"
    if re.search(r"asin|category|product|targeting_expression", s) or re.match(r"^(asin|category)=", k):
        return "Product"
    if v:
        return str(v).strip()
    return "Unknown" if kw else None


@lru_cache(maxsize=4096)
def norm_placement(v):
    s = str(v or "").lower()
    if not s: return None
    if "top" in s: return "Top of Search"
    if "rest" in s or "other on" in s or s == "other": return "Rest of Search"
    if "detail" in s or "product page" in s: return "Product Pages"
    if "off" in s: return "Off-Amazon"
    if "business" in s: return "Amazon Business"
    return str(v).strip()


@lru_cache(maxsize=4096)
def norm_marketplace(v):
    s = str(v or "").strip()
    if not s:
        return None
    up = s.upper().replace("AMAZON.", "")
    if up in C.MARKETPLACES:
        return up
    if up == "GB":
        return "UK"
    for code, mk in C.MARKETPLACES.items():
        if mk["name"].upper() == up or mk["domain"].upper() == s.upper():
            return code
    return "?"


@lru_cache(maxsize=4096)
def market_from_currency(c):
    hits = [k for k, m in C.MARKETPLACES.items() if m["currency"] == str(c or "").upper()]
    return hits[0] if len(hits) == 1 else None


@lru_cache(maxsize=65536)
def _kw_type(kw, match, brand_terms, competitor_terms):
    return keyword_type(kw, match, list(brand_terms), list(competitor_terms))


def keyword_type(kw, match, brand_terms, competitor_terms):
    if not kw:
        return None
    k = kw.lower()
    if match == "Auto": return "Auto"
    if match == "Audience": return "Audience"
    if match == "Theme": return "Theme"
    if match == "Unallocated": return "Unallocated"
    if any(b in k for b in competitor_terms): return "Competitor"
    if any(b in k for b in brand_terms): return "Branded"
    if k.startswith("category="): return "Contextual"
    if re.match(r"^asin(-expanded)?=", k): return "Product"
    return "Generic"


_AD_TYPE_IN_NAME = re.compile(r"(?:^|[\s|/_(\[-])(SP|SBV|SB|SD)(?:$|[\s|/_)\]-])")


@lru_cache(maxsize=8192)
def ad_type_from_name(campaign: str):
    """Agency naming conventions put the ad type in the name: 'SP | WW | …', 'A/B1 SB | …', 'SD | …'."""
    m = _AD_TYPE_IN_NAME.search(campaign or "")
    return ("SB" if m.group(1) == "SBV" else m.group(1)) if m else None


@lru_cache(maxsize=4096)
def norm_status(v):
    s = str(v).lower()
    if re.search(r"out.?of.?stock|oos", s): return "Out of Stock"
    if "suppress" in s: return "Suppressed"
    if re.search(r"inactive|paused|archived|ineligible", s): return "Inactive"
    return "Active"


def _terms(s):
    return [x.strip().lower() for x in str(s or "").split(",") if x.strip()]


# --------------------------------------------------------------------------- 6. validate + normalise
MAX_EXCLUDED_LISTED = 50000   # rows listed individually in the issue report


def process(rows_iter, mapping: dict, settings: dict, source: str, on_record=None, date_sample=None) -> dict:
    """Stream-validate rows. rows_iter yields (row_no, row). Records go to on_record (never held in memory)."""
    issues: dict[tuple, dict] = {}
    counts = {"total": 0, "ok": 0, "warn": 0, "err": 0, "dup": 0, "excludedEntity": 0}
    excluded: list = []
    stats = {"ready": 0, "minDay": None, "maxDay": None, "marketplaces": set()}

    def add(rule, severity, row_no, field):
        key = (rule, field or "")
        it = issues.setdefault(key, {"rule": rule, "severity": severity, "field": field, "count": 0, "rows": []})
        it["count"] += 1
        if row_no is not None and len(it["rows"]) < 12:
            it["rows"].append(row_no)

    mapping = {k: int(v) for k, v in mapping.items() if v is not None and v != ""}
    get = lambda r, f: (r[mapping[f]] if mapping[f] < len(r) else "") if f in mapping else None
    date_override = settings.get("dateOverride") or None

    missing = [f for f in C.REQUIRED_FIELDS if f not in mapping and not (f == "date" and date_override)]
    for f in missing:
        add("missingColumn", "error", None, f)
    for f in C.RECOMMENDED_FIELDS:
        if f == "orders" and "units" in mapping and settings.get("unitsAsOrders"):
            add("unitsAsOrders", "warning", None, "orders"); continue
        if f not in mapping:
            add("optionalMissing", "warning", None, f)
    if "marketplace" not in mapping and "currency" not in mapping and not settings.get("marketplace"):
        add("missingMarketplace", "error", None, "marketplace")
    if missing:
        return {"issues": list(issues.values()), "counts": counts, "excluded": [], "ready": 0, "blocked": True,
                "minDay": None, "maxDay": None, "marketplaces": []}

    order = date_order([get(r, "date") for r in (date_sample or [])]) if "date" in mapping else "mdy"
    metric_fields = [k for k in C.METRIC_KEYS if k in mapping]
    units_as_orders = "orders" not in mapping and "units" in mapping and bool(settings.get("unitsAsOrders"))
    key_dims = C.ALL_DIMS if source == C.MULTI else C.SOURCES[source]
    grains = set()
    brand_terms, comp_terms = _terms(settings.get("brandTerms")), _terms(settings.get("competitorTerms"))
    today = to_day(date.today())
    fixed_day = parse_date(date_override) if date_override else None
    seen = set()   # hashes of (day, dims, metrics) — compact duplicate detection
    entity = settings.get("entity")

    def exclude(row_no, status, r):
        if len(excluded) < MAX_EXCLUDED_LISTED:
            excluded.append((row_no, status, r))

    for row_no, r in rows_iter:
        if entity and "entity" in mapping and str(get(r, "entity")).lower() != entity.lower():
            counts["excludedEntity"] += 1
            continue
        counts["total"] += 1
        err = warn = False
        day = fixed_day if fixed_day is not None else parse_date(get(r, "date"), order)
        if day is None or day is False:
            add("invalidDate", "error", row_no, "date"); err = True
        elif day > today + 1:
            add("futureDate", "warning", row_no, "date"); warn = True

        campaign = str(get(r, "campaign") or "").strip()
        if not campaign:
            add("missingCampaign", "error", row_no, "campaign"); err = True

        mk = norm_marketplace(get(r, "marketplace")) if "marketplace" in mapping else None
        if mk == "?":
            add("unknownMarketplace", "error", row_no, "marketplace"); err = True; mk = None
        if not mk and "currency" in mapping:
            mk = market_from_currency(get(r, "currency"))
        mk = mk or settings.get("marketplace") or None
        if not mk and not err:
            add("missingMarketplace", "error", row_no, "marketplace"); err = True

        ad_type = norm_ad_type(get(r, "adType")) if "adType" in mapping else None
        if ad_type == "?":
            add("unknownAdType", "warning", row_no, "adType"); warn = True; ad_type = None
        ad_type = ad_type or ad_type_from_name(campaign) or settings.get("adType") or "SP"

        m = {}
        for f in metric_fields:
            v = parse_number(get(r, f))
            if v is not None and v != v:  # NaN
                add("invalidNumber", "error", row_no, f); err = True
                continue
            m[f] = v
        if units_as_orders:  # report has no Orders column; user chose Units sold in its place
            m["orders"] = m.get("units")
        if (m.get("adSpend") or 0) < 0:
            add("negativeSpend", "error", row_no, "adSpend"); err = True
        if (m.get("adSales") or 0) < 0:
            add("negativeSales", "error", row_no, "adSales"); err = True
        for b in C.BASE_METRICS:  # never store 0 for a metric this ad type does not report
            if b.get("ad_types") and ad_type not in b["ad_types"] and m.get(b["key"]) == 0:
                m[b["key"]] = None

        asin = get(r, "asin")
        asin = str(asin).strip().upper() if asin not in (None, "") else None
        if asin and not re.fullmatch(r"B0[A-Z0-9]{8}|\d{9}[\dX]", asin):
            add("skuNotAsin", "warning", row_no, "asin"); warn = True   # e.g. seller SKU or UPC — kept as-is
        if source == "asin" and not asin:
            add("missingAsin", "error", row_no, "asin"); err = True

        kw = get(r, "keyword")
        kw = str(kw).strip() if kw not in (None, "") else None
        match = norm_match(get(r, "matchType"), kw)
        tg = get(r, "targeting")
        targeting = ("Auto" if re.search("auto", str(tg), re.I) else "Manual") if tg else \
            ("Auto" if match == "Auto" or re.search(r"\bauto\b", campaign, re.I) else "Manual")
        st = get(r, "searchTerm")
        dims = {
            "marketplace": mk, "account": str(get(r, "account") or settings.get("account") or "Imported account").strip()[:200],
            "adType": ad_type, "targeting": targeting, "campaign": campaign[:300],
            "campaignType": str(get(r, "campaignType") or (f"SP {targeting}" if ad_type == "SP" else ad_type)).strip(),
            "portfolio": str(get(r, "portfolio") or "No portfolio").strip(),
            "placement": norm_placement(get(r, "placement")), "keyword": kw, "matchType": match,
            "keywordType": _kw_type(kw, match, tuple(brand_terms), tuple(comp_terms)),
            "searchTerm": str(st).strip().lower() if st not in (None, "") else None,
            "asin": asin, "title": str(get(r, "title")).strip() if get(r, "title") else asin,
            "brand": str(get(r, "brand") or "Unknown").strip(), "category": str(get(r, "category") or "Unknown").strip(),
            "asinStatus": norm_status(get(r, "asinStatus")) if get(r, "asinStatus") else "Active",
        }
        if err:
            counts["err"] += 1; exclude(row_no, "error", r)
            continue
        key = hash(tuple(str(c) for c in r))   # a duplicate is an identical line in the file
        if key in seen:
            add("duplicate", "warning", row_no, None)
            counts["dup"] += 1; exclude(row_no, "duplicate", r)
            continue
        seen.add(key)
        counts["warn" if warn else "ok"] += 1
        stats["ready"] += 1
        stats["minDay"] = day if stats["minDay"] is None else min(stats["minDay"], day)
        stats["maxDay"] = day if stats["maxDay"] is None else max(stats["maxDay"], day)
        stats["marketplaces"].add(mk)
        if source == C.MULTI:
            for g, f in C.GRAIN_KEYS.items():
                if dims.get(f):
                    grains.add(g)
        if on_record:
            on_record({"day": day, **dims, **m})

    return {"issues": list(issues.values()), "counts": counts, "excluded": excluded, "ready": stats["ready"],
            "blocked": stats["ready"] == 0, "minDay": stats["minDay"], "maxDay": stats["maxDay"],
            "marketplaces": sorted(stats["marketplaces"]), "order": order,
            "grains": (["campaign"] + sorted(grains)) if source == C.MULTI else [source]}


def validate(rows: list[list], header_row: int, mapping: dict, settings: dict, source: str) -> dict:
    """In-memory convenience wrapper (tests, small files)."""
    records = []
    res = process(((header_row + i + 2, r) for i, r in enumerate(rows)), mapping, settings, source,
                  on_record=records.append, date_sample=rows[:500])
    res["records"] = records
    return res





def template_rows():
    return [["Date", "Marketplace", "Ad Type", "Portfolio name", "Campaign Name", "Targeting", "Match Type",
             "Customer Search Term", "Impressions", "Clicks", "Spend", "7 Day Total Sales", "7 Day Total Orders (#)", "7 Day Total Units (#)"],
            ["2026-09-01", "US", "Sponsored Products", "Core Scrubs", "Core Pants – Exact", "scrub pants women", "EXACT",
             "scrub pants women", "12840", "104", "96.20", "412.50", "13", "14"]]
