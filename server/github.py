"""Builds a cached inventory of the user's public GitHub projects.

The tailoring rules ask Claude to pick the projects best suited to each job,
so the prompt needs a view of everything on GitHub, not just what the master
resume happens to list. Fetching live per application would be slow and would
burn the unauthenticated API limit, so the inventory is cached and refreshed
on an interval.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

API = "https://api.github.com"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={
        "User-Agent": "filla",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def _get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "filla"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def _build(cfg: dict) -> str:
    gcfg = cfg.get("github") or {}
    user = gcfg.get("username")
    if not user:
        return "(no GitHub username configured)"

    repos = _get_json(f"{API}/users/{user}/repos?per_page=100&sort=pushed")
    repos = [r for r in repos if not r.get("fork")][: int(gcfg.get("max_repos", 20))]

    parts = []
    for r in repos:
        head = f"### {r['name']}"
        meta = []
        if r.get("description"):
            meta.append(r["description"])
        if r.get("language"):
            meta.append(f"Language: {r['language']}")
        if r.get("topics"):
            meta.append("Topics: " + ", ".join(r["topics"]))
        meta.append(f"Last pushed: {(r.get('pushed_at') or '')[:10]}")
        block = head + "\n" + "\n".join(meta)
        if gcfg.get("include_readmes", True):
            readme = _get_text(
                f"https://raw.githubusercontent.com/{user}/{r['name']}/"
                f"{r.get('default_branch', 'main')}/README.md"
            )
            if readme:
                block += "\n\nREADME excerpt:\n" + readme[:1500]
        parts.append(block)

    return "\n\n".join(parts) if parts else "(no public repositories found)"


def inventory(cfg: dict, cache_path: Path) -> str:
    """Return the project inventory as markdown, refreshing the cache if stale."""
    gcfg = cfg.get("github") or {}
    max_age = float(gcfg.get("cache_hours", 24)) * 3600

    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text())
            if time.time() - cached["fetched_at"] < max_age:
                return cached["markdown"]
        except Exception:
            pass

    try:
        md = _build(cfg)
        cache_path.write_text(json.dumps(
            {"fetched_at": time.time(), "markdown": md}
        ))
        return md
    except Exception as e:
        # Stale cache beats no inventory, and no inventory beats a failed tailor.
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text())["markdown"]
            except Exception:
                pass
        return f"(GitHub inventory unavailable right now: {e})"
