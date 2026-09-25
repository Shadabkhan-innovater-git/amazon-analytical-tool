@echo off
cd /d "%~dp0"
rem Largest upload allowed, in MB. Change this number if you need bigger files.
set MAX_UPLOAD_MB=2048
where python >nul 2>nul || (echo Python is not installed. Get it from https://www.python.org/downloads/ and tick "Add python.exe to PATH". & pause & exit /b 1)
if not exist .venv (
  echo First run: setting up... this takes a minute.
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip >nul
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python run.py
pause
