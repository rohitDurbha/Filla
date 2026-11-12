#!/usr/bin/env bash
# One-command setup for a new Filla user.
# Checks prerequisites, builds the virtualenv, and tells you exactly what
# personal pieces are still yours to add.

set -e
cd "$(dirname "$0")"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
miss() { printf "  \033[31m✗\033[0m %s\n" "$1"; MISSING=1; }

echo "Filla setup"
echo
echo "Checking prerequisites"
MISSING=0
command -v python3 >/dev/null 2>&1 && ok "python3 $(python3 -V 2>&1 | cut -d' ' -f2)" \
  || miss "python3 not found. Install Python 3.10 or newer."
command -v tectonic >/dev/null 2>&1 && ok "tectonic (LaTeX compiler)" \
  || miss "tectonic not found. Install it: brew install tectonic (or cargo install tectonic)."
command -v claude >/dev/null 2>&1 && ok "claude (Claude Code CLI)" \
  || miss "claude not found. Install Claude Code and log in with your Claude account."
if [ "$MISSING" = "1" ]; then
  echo
  echo "Install the missing pieces above, then run ./setup.sh again."
  exit 1
fi

echo
echo "Creating virtualenv and installing server dependencies"
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r server/requirements.txt
ok "server ready"

echo
echo "Yours to personalize"
echo "  1. config.yaml at the repo root:"
echo "       github.username   -> your GitHub handle (projects are picked from it)"
echo "       pdf_filename      -> the filename recruiters will see"
echo "       tracks            -> rename or remove resume tracks to match yours"
echo "  2. server/resumes/: drop your .tex resume for each track, plus rules.md"
echo "     with your own tailoring rules (what may change, what is frozen,"
echo "     how projects get picked). Filla is only as good as this file."
echo
echo "Load the extension"
echo "  chrome://extensions -> Developer mode on -> Load unpacked -> select extension/"
echo "  The one-time profile page opens on first install."
echo
echo "Run the server"
echo "  cd server && ./run.sh"
echo
echo "Your application tracker lives at http://localhost:8765/tracker"
