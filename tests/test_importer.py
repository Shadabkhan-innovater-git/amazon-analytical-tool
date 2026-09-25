"""Run:  python -m pytest tests"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app import importer as I  # noqa: E402
from app import metrics as M  # noqa: E402


def test_parse_number():
    assert I.parse_number("$1,234.50") == 1234.5
    assert I.parse_number("1.234,56") == 1234.56
    assert I.parse_number("(12.00)") == -12.0
    assert I.parse_number("") is None
    assert I.parse_number("abc") != I.parse_number("abc")  # NaN = invalid


def test_parse_date():
    d = I.parse_date("2026-09-01")
    assert I.from_day(d).isoformat() == "2026-09-01"
    assert I.from_day(I.parse_date("09/02/2026", "mdy")).isoformat() == "2026-09-02"
    assert I.from_day(I.parse_date("02/09/2026", "dmy")).isoformat() == "2026-09-02"
    assert I.from_day(I.parse_date("Sep 22, 2026")).isoformat() == "2026-09-22"
    assert I.parse_date("13/40/2026") is False


def test_auto_map_amazon_headers():
    headers = ["Date", "Campaign Name", "Customer Search Term", "Spend", "7 Day Total Sales ", "Total Advertising Cost of Sales (ACOS) "]
    m = I.auto_map(headers)["mapping"]
    assert m["date"] == 0 and m["campaign"] == 1 and m["searchTerm"] == 2 and m["adSpend"] == 3 and m["adSales"] == 4
    assert 5 not in m.values()  # ACOS is recalculated, never imported


def test_validate_flags_and_keeps_good_rows():
    headers = ["Date", "Campaign Name", "Spend", "Sales"]
    rows = [["2026-09-01", "A", "10", "50"], ["2026-09-01", "A", "10", "50"], ["bad", "A", "1", "2"], ["2026-09-02", "", "1", "2"], ["2026-09-03", "B", "-4", "1"]]
    mapping = I.auto_map(headers)["mapping"]
    res = I.validate(rows, 0, mapping, {"marketplace": "US"}, "campaign")
    rules = {i["rule"] for i in res["issues"]}
    assert {"duplicate", "invalidDate", "missingCampaign", "negativeSpend"} <= rules
    assert len(res["records"]) == 1


def test_roas_definition():
    out = M.derive({"adSpend": 100, "adSales": 450, "clicks": 50, "impressions": 10000, "orders": 5})
    assert out["roas"] == 4.5 and out["acos"] == 100 / 450 * 100 and out["cpc"] == 2 and out["cvr"] == 10
