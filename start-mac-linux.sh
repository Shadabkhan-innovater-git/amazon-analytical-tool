#!/usr/bin/env bash
cd "$(dirname "$0")"
# Largest upload allowed, in MB. Change this number if you need bigger files.
export MAX_UPLOAD_MB=2048
command -v python3 >/dev/null || { echo "Python 3 is not installed. Get it from https://www.python.org/downloads/"; exit 1; }
if [ ! -d .venv ]; then
  echo "First run: setting up... this takes a minute."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt
fi
.venv/bin/python run.py
