#!/usr/bin/env bash
# Double-click to start Filla on macOS. Keep this window open while applying.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "First run, setting things up (about a minute)..."
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r server/requirements.txt
fi
cd server && exec ./run.sh
