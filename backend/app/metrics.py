"""Metric engine (server side) — same formulas as frontend/lib/config.js. ROAS = Ad Sales / Ad Spend everywhere."""
from __future__ import annotations

import pandas as pd

ADDITIVE = ["adSpend", "adSales", "impressions", "clicks", "orders", "units", "dpv", "sameSkuSales", "otherSkuSales",
            "ntbOrders", "ntbSales", "incrementalSales", "budget", "reach", "videoViews", "viewableImpressions", "engagements"]

DIRECTION = {"adSpend": "neutral", "adSales": "positive", "impressions": "positive", "clicks": "positive", "ctr": "positive",
             "cpc": "negative", "orders": "positive", "units": "positive", "cvr": "positive", "acos": "negative", "roas": "positive"}


def _ratio(n, d, k=1.0):
    return None if n is None or d in (None, 0) or pd.isna(n) or pd.isna(d) else float(n) / float(d) * k


def derive(s: dict) -> dict:
    """s: sums of additive metrics (None where not reported) -> dict incl. derived metrics."""
    out = {k: (None if s.get(k) is None or pd.isna(s.get(k)) else float(s[k])) for k in ADDITIVE}
    out["ctr"] = _ratio(out["clicks"], out["impressions"], 100)
    out["cpc"] = _ratio(out["adSpend"], out["clicks"])
    out["cvr"] = _ratio(out["orders"], out["clicks"], 100)
    out["acos"] = _ratio(out["adSpend"], out["adSales"], 100)
    out["roas"] = _ratio(out["adSales"], out["adSpend"])
    out["aov"] = _ratio(out["adSales"], out["orders"])
    return out


def summarize(df: pd.DataFrame, group_by: str | None = None) -> list[dict] | dict:
    cols = [c for c in ADDITIVE if c in df.columns]
    agg = lambda g: g[cols].sum(min_count=1)  # all-null stays null -> N/A, never 0
    if not group_by:
        return derive(agg(df).to_dict()) if len(df) else derive({})
    rows = []
    for key, g in df.groupby(group_by, dropna=False):
        rows.append({group_by: key, **derive(agg(g).to_dict())})
    return sorted(rows, key=lambda r: -(r["adSales"] or 0))


def change(key: str, cur, prev):
    if cur is None or prev in (None, 0):
        return None
    pct = (cur - prev) / abs(prev) * 100
    d = DIRECTION.get(key, "neutral")
    tone = "neutral" if d == "neutral" or abs(pct) < 0.05 else ("good" if (pct > 0) == (d == "positive") else "bad")
    return {"pct": round(pct, 2), "tone": tone}
