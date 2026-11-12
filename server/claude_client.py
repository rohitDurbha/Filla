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

import atexit
import json
import re
import shutil
import subprocess


class ClaudeError(RuntimeError):
    pass


class ClaudeCancelled(ClaudeError):
    pass


# Running claude -p subprocesses by cancel id, so a user-side cancel can
# actually kill the process instead of letting it finish and spend usage.
_running: dict[str, subprocess.Popen] = {}
_cancelled: set[str] = set()


@atexit.register
def _kill_orphans():
    """Server shutdown must not leave claude -p processes running."""
    for proc in list(_running.values()):
        try:
            proc.kill()
        except Exception:
            pass


def cancel(cancel_id: str) -> bool:
    proc = _running.get(cancel_id)
    if proc is None:
        return False
    _cancelled.add(cancel_id)
    try:
        proc.kill()
    except Exception:
        pass
    return True


def run_claude(prompt: str, cfg: dict, log: tuple | None = None,
               cancel_id: str | None = None) -> str:
    """Run claude -p with the prompt on stdin and return the text result.

    log, when given, is (directory, name): the exact prompt and raw answer
    are written there so a run can be audited afterwards. cancel_id, when
    given, registers the subprocess so cancel() can kill it mid-flight.
    """
    ccfg = cfg["claude"]
    if log:
        log_dir, name = log
        (log_dir / f"{name}.prompt.txt").write_text(prompt)
    # shutil.which resolves Windows shims like claude.cmd, which Popen
    # cannot find from a bare name without a shell.
    exe = shutil.which(ccfg.get("command", "claude")) or ccfg.get("command", "claude")
    cmd = [
        exe,
        "-p",
        "--model", ccfg.get("model", "sonnet"),
        "--output-format", "json",
    ] + list(ccfg.get("extra_args") or [])

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        raise ClaudeError(
            "The 'claude' command was not found. Install Claude Code and log in "
            "with your Claude account, then restart the server."
        )

    if cancel_id:
        _running[cancel_id] = proc
    try:
        stdout, stderr = proc.communicate(
            prompt, timeout=int(ccfg.get("timeout_seconds", 420))
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        raise ClaudeError("Claude timed out. Try again, or raise claude.timeout_seconds in config.yaml.")
    finally:
        if cancel_id:
            _running.pop(cancel_id, None)

    if cancel_id and cancel_id in _cancelled:
        _cancelled.discard(cancel_id)
        raise ClaudeCancelled("Cancelled by user.")

    if proc.returncode != 0:
        raise ClaudeError(f"claude -p failed (exit {proc.returncode}): {(stderr or '').strip()[:2000]}")

    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError:
        raise ClaudeError(f"Unexpected output from claude -p: {stdout[:500]}")

    result = envelope.get("result", "")
    if log:
        (log_dir / f"{name}.response.txt").write_text(result)

    if envelope.get("is_error"):
        raise ClaudeError(f"Claude returned an error: {result[:2000]}")

    return result


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


def tailor(prompt: str, cfg: dict, log_dir=None, cancel_id=None) -> dict:
    return parse_delimited(run_claude(prompt, cfg, (log_dir, "tailor") if log_dir else None, cancel_id))


def revise(prompt: str, cfg: dict, log_dir=None, cancel_id=None) -> dict:
    return parse_delimited(run_claude(prompt, cfg, (log_dir, "revise") if log_dir else None, cancel_id))


def repair(prompt: str, cfg: dict, log_dir=None, cancel_id=None) -> str:
    return parse_tex_only(run_claude(prompt, cfg, (log_dir, "repair") if log_dir else None, cancel_id))


def refine(prompt: str, cfg: dict, log_dir=None, cancel_id=None) -> dict:
    return parse_delimited(run_claude(prompt, cfg, (log_dir, "refine") if log_dir else None, cancel_id))
