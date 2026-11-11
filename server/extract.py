"""Heuristic field extraction from an uploaded resume PDF.

Used by the own-PDF path, which deliberately never calls Claude. The
heuristics catch the fields applications actually autofill (contact info and
links). Anything they miss gets fixed by the user in the review panel.
"""

from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader


def _first(pattern: str, text: str, flags=0) -> str:
    m = re.search(pattern, text, flags)
    return m.group(0).strip().rstrip(".,;|") if m else ""


def _guess_name(text: str) -> tuple[str, str]:
    """The name is nearly always the first short line of capitalized words."""
    for line in text.splitlines()[:6]:
        line = line.strip()
        if not line or "@" in line or any(c.isdigit() for c in line):
            continue
        words = line.split()
        if 2 <= len(words) <= 4 and all(w[0].isupper() for w in words if w[0].isalpha()):
            return words[0], words[-1]
    return "", ""


def extract_fields(pdf_path: Path) -> dict:
    reader = PdfReader(str(pdf_path))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)

    first, last = _guess_name(text)
    email = _first(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    phone = _first(r"(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}", text)
    linkedin = _first(r"(https?://)?(www\.)?linkedin\.com/[^\s|)]+", text, re.I)
    github = _first(r"(https?://)?(www\.)?github\.com/[^\s|)]+", text, re.I)
    location = _first(r"\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?,\s*[A-Z]{2}\b", text)

    return {
        "personal": {
            "first_name": first,
            "last_name": last,
            "full_name": f"{first} {last}".strip(),
            "email": email,
            "phone": phone,
            "location": location,
            "linkedin": linkedin,
            "github": github,
            "website": "",
        },
        "work_experience": [],
        "education": [],
        "skills": [],
    }
