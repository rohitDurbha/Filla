"""Claude plan usage (5-hour and 7-day windows), read the way Claude Code
reads it.

Credentials live in different places per platform. On macOS, Claude Code
keeps its OAuth login in the Keychain under "Claude Code-credentials",
and newer builds add suffixed items "Claude Code-credentials-<hash>"
alongside it. On Linux and Windows it is ~/.claude/.credentials.json.
The usage endpoint is unofficial and rate limited, so results are cached
and the last good reading is kept when a refresh fails.
"""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
KEYCHAIN_SERVICE = "Claude Code-credentials"
CACHE_SECONDS = 300

_cache: dict = {"ts": 0.0, "data": None, "last_good": None}


def _oauth_from_blob(blob: str) -> dict | None:
    try:
        data = json.loads(blob)
    except (json.JSONDecodeError, TypeError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if isinstance(oauth, dict) and oauth.get("accessToken"):
        return oauth
    return None


def _keychain_services() -> list[str]:
    """Every Keychain service name that looks like a Claude Code login."""
    names = [KEYCHAIN_SERVICE]
    try:
        out = subprocess.run(
            ["security", "dump-keychain"], capture_output=True, text=True, timeout=10
        ).stdout
        for m in re.finditer(r'"svce"<blob>="(Claude Code-credentials[^"]*)"', out):
            if m.group(1) not in names:
                names.append(m.group(1))
    except Exception:
        pass
    return names


def _keychain_credentials() -> list[dict]:
    found = []
    for svc in _keychain_services():
        try:
            proc = subprocess.run(
                ["security", "find-generic-password", "-s", svc, "-w"],
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            continue
        if proc.returncode == 0:
            oauth = _oauth_from_blob(proc.stdout.strip())
            if oauth:
                found.append(oauth)
    return found


def _file_credentials() -> list[dict]:
    cfg_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    path = cfg_dir / ".credentials.json"
    if path.exists():
        oauth = _oauth_from_blob(path.read_text())
        if oauth:
            return [oauth]
    return []


def pick_token(candidates: list[dict], now_ms: float | None = None) -> str | None:
    """The freshest unexpired token, so stale suffixed items lose."""
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    live = [c for c in candidates
            if not c.get("expiresAt") or float(c["expiresAt"]) > now_ms]
    if not live:
        return None
    live.sort(key=lambda c: float(c.get("expiresAt") or 0), reverse=True)
    return live[0]["accessToken"]


def find_token() -> tuple[str | None, str]:
    candidates = []
    if platform.system() == "Darwin":
        candidates += _keychain_credentials()
    candidates += _file_credentials()
    if not candidates:
        where = "the macOS Keychain" if platform.system() == "Darwin" else "~/.claude/.credentials.json"
        return None, f"No Claude Code login found in {where}. Run claude and log in."
    token = pick_token(candidates)
    if not token:
        return None, "The Claude Code login has expired. Run claude once to refresh it."
    return token, ""


def _window(node) -> dict | None:
    if not isinstance(node, dict):
        return None
    pct = node.get("utilization", node.get("used_percentage"))
    if pct is None:
        return None
    pct = float(pct)
    if pct <= 1:
        pct *= 100
    resets = node.get("resets_at")
    if isinstance(resets, (int, float)):
        resets = datetime.fromtimestamp(resets, timezone.utc).isoformat()
    return {"pct": round(pct, 1), "resets_at": resets}


def _find(node, key, depth=0):
    if not isinstance(node, dict) or depth > 4:
        return None
    if key in node:
        return node[key]
    for v in node.values():
        hit = _find(v, key, depth + 1)
        if hit is not None:
            return hit
    return None


def parse_usage(raw: dict) -> dict | None:
    five = _window(_find(raw, "five_hour"))
    seven = _window(_find(raw, "seven_day"))
    if not five and not seven:
        return None
    return {"available": True, "five_hour": five, "seven_day": seven}


def get_usage(fetch=None) -> dict:
    """Cached usage reading. fetch is injectable for tests."""
    if _cache["data"] and time.time() - _cache["ts"] < CACHE_SECONDS:
        return _cache["data"]

    def fail(reason: str) -> dict:
        # A failed refresh keeps showing the last good reading, marked stale.
        if _cache["last_good"]:
            return {**_cache["last_good"], "stale": True}
        return {"available": False, "reason": reason}

    token, why = find_token()
    if not token:
        return fail(why)

    def default_fetch(tok: str) -> dict:
        req = urllib.request.Request(USAGE_URL, headers={
            "Authorization": f"Bearer {tok}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "filla",
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    try:
        raw = (fetch or default_fetch)(token)
    except urllib.error.HTTPError as e:
        reason = ("Usage endpoint is rate limiting, will retry shortly."
                  if e.code == 429 else f"Usage endpoint answered {e.code}.")
        return fail(reason)
    except Exception as e:
        return fail(f"Could not reach the usage endpoint ({e.__class__.__name__}).")

    data = parse_usage(raw)
    if not data:
        return fail("Usage endpoint returned an unexpected shape.")
    _cache.update(ts=time.time(), data=data, last_good=data)
    return data
