"""Create fictional Amazon Ads report files (same column names Amazon uses) for trying the upload.

    python sample-data/make_samples.py
"""
import os
import random
from datetime import date, timedelta

import pandas as pd

random.seed(7)
HERE = os.path.dirname(os.path.abspath(__file__))
START, END = date(2026, 6, 1), date(2026, 9, 22)
CAMPAIGNS = [  # campaign, portfolio, targets [(target, match, [search terms])], cpc, cvr, aov
    ("Brand – Exact", "Brand", [("northpeak scrubs", "EXACT", ["northpeak scrubs", "northpeak scrub pants"])], 0.55, 0.16, 34),
    ("Pants – Exact", "Core", [("scrub pants women", "EXACT", ["scrub pants women", "scrub pants women petite"]),
                                ("jogger scrub pants", "EXACT", ["jogger scrub pants"])], 0.9, 0.12, 31),
    ("Tops – Phrase", "Core", [("scrub tops", "PHRASE", ["scrub tops for women", "cheap scrub tops"])], 0.85, 0.10, 27),
    ("Discovery – Broad", "Core", [("nursing scrubs", "BROAD", ["nursing scrubs set", "nurse uniform", "medical scrubs"])], 0.8, 0.08, 30),
    ("Auto – All", "Core", [("close-match", "-", ["scrubs women", "scrub set"]), ("loose-match", "-", ["nurse shoes", "stethoscope"])], 0.6, 0.07, 29),
]


def rows():
    out = []
    d = START
    while d <= END:
        season = 1 + 0.3 * ((d - START).days / 120) + (1.0 if date(2026, 7, 14) <= d <= date(2026, 7, 17) else 0)
        for camp, pf, targets, cpc, cvr, aov in CAMPAIGNS:
            for tgt, match, terms in targets:
                for term in terms:
                    clicks = max(0, int(random.gauss(18, 6) * season))
                    eff = 0.25 if "cheap" in term or term in ("nurse shoes", "stethoscope") else 1
                    orders = sum(random.random() < cvr * eff for _ in range(clicks))
                    spend = round(clicks * cpc * random.uniform(0.9, 1.1), 2)
                    sales = round(orders * aov * random.uniform(0.9, 1.1), 2)
                    units = orders + sum(random.random() < 0.08 for _ in range(orders))
                    impr = int(clicks / random.uniform(0.004, 0.009)) if clicks else random.randint(0, 300)
                    same = round(sales * 0.82, 2)
                    out.append({
                        "Date": d.strftime("%b %d, %Y"), "Portfolio name": pf, "Currency": "USD", "Campaign Name": camp,
                        "Ad Group Name": camp.split(" – ")[0], "Targeting": tgt, "Match Type": match, "Customer Search Term": term,
                        "Impressions": impr, "Clicks": clicks, "Click-Thru Rate (CTR)": f"{clicks / impr:.2%}" if impr else "0.00%",
                        "Cost Per Click (CPC)": f"${spend / clicks:.2f}" if clicks else "", "Spend": f"${spend:,.2f}",
                        "7 Day Total Sales ": f"${sales:,.2f}", "Total Advertising Cost of Sales (ACOS) ": f"{spend / sales:.2%}" if sales else "",
                        "Total Return on Advertising Spend (ROAS)": round(sales / spend, 2) if spend else "",
                        "7 Day Total Orders (#)": orders, "7 Day Total Units (#)": units,
                        "7 Day Conversion Rate": f"{orders / clicks:.2%}" if clicks else "0.00%",
                        "7 Day Advertised SKU Sales ": f"${same:,.2f}", "7 Day Other SKU Sales ": f"${sales - same:,.2f}",
                    })
        d += timedelta(days=1)
    return out


if __name__ == "__main__":
    df = pd.DataFrame(rows())
    df.to_excel(os.path.join(HERE, "Sponsored_Products_Search_term_report.xlsx"), index=False, sheet_name="Sponsored Product Search Term R")
    camp = df.copy()
    for c in ["Spend", "7 Day Total Sales "]:
        camp[c] = camp[c].str.replace(r"[$,]", "", regex=True).astype(float)
    camp = camp.groupby(["Date", "Portfolio name", "Currency", "Campaign Name"], sort=False)[["Impressions", "Clicks", "Spend", "7 Day Total Sales ", "7 Day Total Orders (#)", "7 Day Total Units (#)"]].sum().reset_index()
    camp.to_csv(os.path.join(HERE, "Sponsored_Products_Campaign_report.csv"), index=False)
    print(f"wrote {len(df)} search-term rows and {len(camp)} campaign rows")
