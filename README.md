# Amazon Ads Intelligence: full-stack dashboard

This is a working Amazon Ads reporting dashboard. It has two parts:

- **Python back end** (FastAPI, pandas and SQLite). It receives your uploaded report files, reads them with pandas, matches their columns, checks the data and saves it to a database on your computer.
- **JavaScript front end** (HTML, CSS and JS). This is the dashboard you use: KPIs, WoW/MoM/QoQ/YoY comparisons, filters, charts, tables, insights and Excel/PowerPoint/PDF/CSV exports.

## Start it (about 2 minutes the first time)

1. Install **Python 3.10 or newer** from https://www.python.org/downloads/. On Windows, tick **"Add python.exe to PATH"** during setup.
2. Unzip this folder.
3. Start it:
   - **Windows:** double-click `start-windows.bat`
   - **Mac / Linux:** open Terminal in this folder and run `./start-mac-linux.sh`
4. Your browser opens **http://localhost:8000**. Leave the black window open while you use the dashboard. To stop, close that window or press Ctrl+C.

The first run installs the Python packages; later runs start straight away.

If you'd rather use a terminal directly:
```
pip install -r requirements.txt
python run.py
```

## Upload your report data

1. Click the blue **Upload report** button at the top of the dashboard.
2. Drag in a file, or click to browse. Accepted: CSV, TSV, TXT, XLSX and XLS files, such as the campaign, placement, targeting, search term and advertised product reports downloaded from the Amazon Ads console, and bulk files. **Zipped reports (.zip or .gz) are accepted too.**
3. Check the detected report type, ad type and marketplace. If the file has no marketplace or currency column, pick one.
4. Check the column matches. "Spend", "Cost" and "Ad Spend" all map to Ad Spend automatically. Change any match that looks wrong.
5. **Validate**. The server lists bad dates, missing campaigns, negative spend, invalid numbers, invalid ASINs and duplicates, with the row numbers affected. You can download the full issue list as a CSV.
6. **Import**. The data is saved to `data/ads.db` and the dashboard refreshes.

Upload several report types (for example a campaign report *and* a search term report) to fill every page. Uploads stay after you restart. To remove one, go to **Settings → Data sources**.

Until you upload anything, the dashboard shows a clearly labelled **DEMO DATA** set.

### Large files

- **Limit:** 2 GB per upload by default. To change it, edit the `MAX_UPLOAD_MB=2048` line in `start-windows.bat` or `start-mac-linux.sh` (or set the `MAX_UPLOAD_MB` environment variable). The limit applies to the file as uploaded, so a zipped report counts at its zipped size.
- **Zip big reports.** Amazon CSVs shrink about 6–10×: a 205 MB search term report is a 32 MB .gz file. That makes uploading faster and keeps you well under the limit.
- **Use CSV for very large reports rather than Excel.** Excel files are capped at about 1 million rows and are slower to read.
- **Memory:** files are streamed to disk and processed in one pass, so memory use stays flat. In testing, a 205 MB CSV with 1.6 million rows peaked at about 0.5–1 GB of RAM on the server.
- **Timing** (1.6 million rows, typical laptop): upload a few seconds, validate about 1 minute, import about 5 seconds (rows are staged during validation), dashboard load about 3 seconds. Heavy pages such as Search Terms take 1–2 seconds with that much data.
- **Practical ceiling:** the dashboard loads all imported rows into the browser for instant filtering. That works well up to a few million rows in total. Beyond that, the next step is to move aggregation to the server; the `/api/report/summary` endpoint is the starting point.

### Try it with the sample files (`sample-data/`)

- `Sponsored_Products_Search_term_report.xlsx`: 1,596 rows with Amazon's own column names
- `Sponsored_Products_Campaign_report.csv`: 570 rows
- `report_with_errors.csv`: deliberately broken rows, to see validation catch them
- `make_samples.py`: regenerates the sample files

## Standalone version (no Python)

`standalone/amazon-ads-intelligence.html` is the whole dashboard in one file. It processes uploads in the browser and keeps data in browser storage. Rebuild it after changing `frontend/` with `python tools/build_standalone.py`.

## Project layout

```
run.py                      starts the server and opens the browser
requirements.txt            Python packages
backend/app/
  main.py                   API routes and serving the dashboard
  importer.py               file reading, header detection, column mapping, validation, normalising
  db.py                     SQLite storage (datasets + facts tables)
  metrics.py                KPI formulas (ROAS = Ad Sales / Ad Spend) for the reporting API
  config.py                 metric list, report types, column-name synonyms
frontend/
  index.html, styles.css    the dashboard page
  services/api.js           talks to the Python server
  lib/                      metric engine, filter engine, dates, state, i18n, data store
  components/, views.js     charts, tables, upload wizard, pages
  services/                 insights, exports, in-browser import fallback
tests/                      python -m pytest tests
data/ads.db                 your imported data (created on first upload)
```

## API (http://localhost:8000/docs for interactive documentation)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Server status |
| POST | `/api/import/upload` | Upload a file; returns detected headers, mapping and a preview |
| POST | `/api/import/inspect` | Re-read with another sheet or header row |
| POST | `/api/import/validate` | Validate with your mapping; returns issues and counts |
| POST | `/api/import/commit` | Validate again and save to the database |
| GET | `/api/import/{token}/issues.csv` | Download the issue report |
| GET | `/api/datasets` / DELETE `/api/datasets/{id}` | List or remove uploaded data |
| GET | `/api/data` | All stored data, in the compact format the dashboard loads |
| GET | `/api/report/summary?marketplace=US&start=2026-09-01&end=2026-09-22&source=campaign&group_by=portfolio` | KPIs computed by pandas |

## Notes

- Everything runs on your own computer. Nothing is sent anywhere except the dashboard fetching its fonts, and its Excel/PowerPoint/PDF export libraries, from public CDNs.
- The role switch in Settings is a preview only. Real per-user logins need an authentication layer added in front of the API.
- To move to PostgreSQL later, replace `backend/app/db.py`. The rest of the app only calls its functions.
- Opening `frontend/index.html` directly (without the server) still works, but uploads are then processed and stored only in that browser.
