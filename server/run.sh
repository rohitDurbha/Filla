#!/usr/bin/env bash
# Start (or restart) the Filla server.
# Frees the port first, so a suspended or orphaned old server never blocks
# a restart, then runs uvicorn with auto-reload so code changes and git
# pulls take effect without a manual restart. Stop with Ctrl+C.

set -e
cd "$(dirname "$0")"

PORT="${FILLA_PORT:-$(python3 -c "
import yaml
print(yaml.safe_load(open('../config.yaml'))['server'].get('port', 8765))
" 2>/dev/null || echo 8765)}"

PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "Port $PORT is held by process(es) $PIDS, freeing it."
  kill -9 $PIDS 2>/dev/null || true
  sleep 0.3
fi

for venv in ../.venv/bin/activate .venv/bin/activate; do
  if [ -f "$venv" ]; then
    # shellcheck disable=SC1090
    source "$venv"
    break
  fi
done

echo "Filla server on http://127.0.0.1:$PORT (Ctrl+C to stop)"
exec python3 -m uvicorn app:app --host 127.0.0.1 --port "$PORT" --reload
