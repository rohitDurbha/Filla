@echo off
rem Double-click to start Filla on Windows. Keep this window open while applying.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo First run, setting things up...
  python -m venv .venv
  .venv\Scripts\python -m pip install -q -r server\requirements.txt
)
cd server
echo Filla server on http://localhost:8765  (close this window to stop)
..\.venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8765 --reload
pause
