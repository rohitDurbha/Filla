"""Talks to the user's own Claude via Claude Code headless mode (claude -p).

Authentication rides on the local Claude Code login, so usage draws from the
user's Claude subscription. No API key is involved anywhere in this project.

The tailor/revise prompts ask Claude to answer in a delimiter format instead
of raw JSON, because a full LaTeX document inside a JSON string is fragile.

    ===TEX===
    ...the complete .tex file...
    ===FIELDS===
    {...json object...}
    ===NOTES===
    free text (optional)
    ===END===
"""

from __future__ import annotations

import json
import re
import subprocess


class ClaudeError(RuntimeError):
    pass


def run_claude(prompt: str, cfg: dict) -> str:
    """Run claude -p with the prompt on stdin and return the text result."""
    ccfg = cfg["claude"]
    cmd = [
        ccfg.get("command", "claude"),
        "-p",
        "--model", ccfg.get("model", "sonnet"),
        "--output-format", "json",
    ] + list(ccfg.get("extra_args") or [])

    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=int(ccfg.get("timeout_seconds", 420)),
        )
    except FileNotFoundError:
        raise ClaudeError(
            "The 'claude' command was not found. Install Claude Code and log in "
            "with your Claude account, then restart the server."
        )
    except subprocess.TimeoutExpired:
        raise ClaudeError("Claude timed out. Try again, or raise claude.timeout_seconds in config.yaml.")

    if proc.returncode != 0:
        raise ClaudeError(f"claude -p failed (exit {proc.returncode}): {proc.stderr.strip()[:2000]}")

    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise ClaudeError(f"Unexpected output from claude -p: {proc.stdout[:500]}")

    if envelope.get("is_error"):
        raise ClaudeError(f"Claude returned an error: {envelope.get('result', '')[:2000]}")

    return envelope.get("result", "")


def parse_delimited(text: str) -> dict:
    """Parse the ===TEX=== / ===FIELDS=== / ===NOTES=== answer format."""

    def section(name: str, source: str) -> str | None:
        m = re.search(
            rf"==={name}===\s*\n(.*?)(?=\n===(?:TEX|FIELDS|NOTES|END)===|\Z)",
            source,
            re.DOTALL,
        )
        return m.group(1).strip() if m else None

    tex = section("TEX", text)
    fields_raw = section("FIELDS", text)
    notes = section("NOTES", text) or ""

    if not tex or not fields_raw:
        raise ClaudeError(
            "Claude's answer was missing the TEX or FIELDS section. "
            f"Answer started with: {text[:300]}"
        )

    # Strip a stray markdown fence if Claude wrapped the JSON anyway.
    fields_raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", fields_raw.strip())

    try:
        fields = json.loads(fields_raw)
    except json.JSONDecodeError as e:
        raise ClaudeError(f"Could not parse the FIELDS JSON: {e}")

    return {"tex": tex, "fields": fields, "notes": notes}


def parse_tex_only(text: str) -> str:
    """Parse an answer that carries only a ===TEX=== section (repair calls)."""
    m = re.search(
        r"===TEX===\s*\n(.*?)(?=\n===(?:FIELDS|NOTES|END)===|\Z)", text, re.DOTALL
    )
    if not m or not m.group(1).strip():
        raise ClaudeError(
            f"Claude's repair answer was missing the TEX section. Started with: {text[:300]}"
        )
    return m.group(1).strip()


def tailor(prompt: str, cfg: dict) -> dict:
    return parse_delimited(run_claude(prompt, cfg))


def revise(prompt: str, cfg: dict) -> dict:
    return parse_delimited(run_claude(prompt, cfg))


def repair(prompt: str, cfg: dict) -> str:
    return parse_tex_only(run_claude(prompt, cfg))
