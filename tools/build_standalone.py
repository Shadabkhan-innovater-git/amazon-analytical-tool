#!/usr/bin/env python3
"""Bundle frontend/ into one self-contained HTML page (standalone/amazon-ads-intelligence.html) that runs without the Python server."""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / 'tools' / 'standalone.template.html'
FRONT = ROOT / 'frontend'  # single source of the app code
ORDER = [
    'lib/config.js', 'lib/i18n.js', 'i18n/en.js', 'i18n/locales.js', 'lib/dates.js', 'lib/store.js', 'lib/query.js', 'lib/state.js',
    'data/demo.js', 'components/icons.js', 'components/charts.js', 'components/table.js', 'components/tabledefs.js',
    'services/api.js', 'services/insights.js', 'services/import.js', 'services/export.js', 'components/import-wizard.js', 'views.js', 'app.js',
]
def main(out):
    tpl = TEMPLATE.read_text()
    js = []
    for f in ORDER:
        p = FRONT / f
        if p.exists():
            js.append(f'/* ===== {f} ===== */\n' + p.read_text())
    html = tpl.replace('/*STYLES*/', (FRONT / 'styles.css').read_text()).replace('/*SCRIPTS*/', 'window.__STANDALONE__ = true;\n' + '\n'.join(js))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f'{out} {len(html)/1024:.0f} KB')

if __name__ == '__main__':
    main(pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'standalone' / 'amazon-ads-intelligence.html')
