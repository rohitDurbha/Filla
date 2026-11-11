"""Compile LaTeX to PDF with Tectonic (single-binary, open source)."""

from __future__ import annotations

import subprocess
from pathlib import Path


class LatexError(RuntimeError):
    pass


def _extract_errors(log_text: str) -> str:
    """Pull the actual error lines out of a TeX log instead of the banner.

    TeX errors start with '!' and Tectonic prefixes its own with 'error:'.
    The first lines of a log are version banners and are never the problem,
    which is why surfacing the head of the output is useless.
    """
    lines = log_text.splitlines()
    picked: list[str] = []
    for i, ln in enumerate(lines):
        low = ln.strip().lower()
        if ln.startswith("!") or low.startswith("error:") or "fatal" in low:
            picked.extend(lines[i : i + 8])
            picked.append("")
            if len(picked) > 70:
                break
    if picked:
        return "\n".join(picked[:70])
    # No recognizable error marker, fall back to the tail where TeX
    # reports what it was doing when it died.
    return "\n".join(lines[-30:])


def compile_tex(tex_path: Path, out_dir: Path) -> Path:
    """Compile tex_path into out_dir, returning the PDF path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            ["tectonic", "--outdir", str(out_dir), "--print", str(tex_path)],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except FileNotFoundError:
        raise LatexError(
            "Tectonic was not found. Install it from https://tectonic-typesetting.github.io "
            "(brew install tectonic, or cargo install tectonic) and restart the server."
        )
    except subprocess.TimeoutExpired:
        raise LatexError("LaTeX compilation timed out after 180 seconds.")

    if proc.returncode != 0:
        combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
        log_file = out_dir / (tex_path.stem + ".log")
        if log_file.exists():
            combined += "\n" + log_file.read_text(errors="replace")
        raise LatexError("LaTeX compilation failed.\n" + _extract_errors(combined))

    pdf = out_dir / (tex_path.stem + ".pdf")
    if not pdf.exists():
        raise LatexError("Tectonic reported success but no PDF was produced.")
    return pdf


def tectonic_available() -> bool:
    try:
        subprocess.run(["tectonic", "--version"], capture_output=True, timeout=10)
        return True
    except Exception:
        return False
