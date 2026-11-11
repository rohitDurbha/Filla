"""Compile LaTeX to PDF with Tectonic (single-binary, open source)."""

from __future__ import annotations

import subprocess
from pathlib import Path


class LatexError(RuntimeError):
    pass


def compile_tex(tex_path: Path, out_dir: Path) -> Path:
    """Compile tex_path into out_dir, returning the PDF path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            ["tectonic", "--outdir", str(out_dir), str(tex_path)],
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
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-25:]
        raise LatexError("LaTeX compilation failed:\n" + "\n".join(tail))

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
