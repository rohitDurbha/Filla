"""Field extraction from an uploaded resume PDF, no AI involved.

Two sources of truth:
- Link annotations carry the real URLs. Resume links usually render as
  display text like "LinkedIn", so the text layer never contains the URL.
- The text layer, parsed structurally: section headers split the document,
  date ranges mark entries, and bullet glyphs mark bullet lines, with
  wrapped continuations folded back into their bullet.

Anything the heuristics miss gets fixed by the user in the review panel.
"""

from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader

SECTION_PATTERNS = [
    ("summary", re.compile(r"^(summary|objective|profile|about)$", re.I)),
    ("skills", re.compile(r"^(technical skills|skills|core competencies|technologies)$", re.I)),
    ("experience", re.compile(r"^(work experience|professional experience|experience|employment( history)?)$", re.I)),
    ("research", re.compile(r"^(research experience|research)$", re.I)),
    ("projects", re.compile(r"^((personal|selected|academic) )?projects$", re.I)),
    ("education", re.compile(r"^education$", re.I)),
    ("other", re.compile(r"^(certifications?|awards?|publications?|leadership|activities)$", re.I)),
]

DATE_RE = re.compile(
    r"(?P<start>(?:[A-Z][a-z]{2,8}\.?\s+)?(?:19|20)\d{2})\s*[–—−-]\s*"
    r"(?P<end>(?:[A-Z][a-z]{2,8}\.?\s+)?(?:19|20)\d{2}|Present|Current|Now)",
    re.I,
)
BULLET_RE = re.compile(r"^[◦•▪·‣*]\s*|^[-–]\s+")
# Multi-word city names nearly always start with one of these, which is how
# "San Jose State University San Jose, California" splits at the right spot.
_CITY_PREFIX = (
    r"(?:San|Santa|New|Los|Las|St\.?|Fort|Ft\.?|Mount|Mt\.?|East|West|North|South|"
    r"Palo|El|La|Salt|Lake|Redwood|Menlo|Mountain|Long|Grand|Little|Kansas|Oklahoma)"
)
LOCATION_TAIL_RE = re.compile(
    r"^(?P<head>.+?)\s+(?P<loc>(?:" + _CITY_PREFIX + r"\s+)?[A-Z][a-zA-Z.]+,\s*"
    r"(?:[A-Z]{2}|D\.C\.|[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?))$"
)
CITY_STATE_RE = re.compile(r"\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?,\s*[A-Z]{2}\b")
NOISE_LINE_RE = re.compile(r"^(github|linkedin|link|demo)$", re.I)


def _first(pattern: str, text: str, flags=0) -> str:
    m = re.search(pattern, text, flags)
    return m.group(0).strip().rstrip(".,;|") if m else ""


def _link_urls(reader: PdfReader) -> list[str]:
    urls = []
    for page in reader.pages:
        for a in (page.get("/Annots") or []):
            try:
                uri = a.get_object().get("/A", {}).get("/URI")
                if uri and uri not in urls:
                    urls.append(str(uri))
            except Exception:
                continue
    return urls


def _profile_links(urls: list[str]) -> dict:
    out = {"linkedin": "", "github": "", "website": ""}
    for u in urls:
        low = u.lower()
        if "linkedin.com" in low and not out["linkedin"]:
            out["linkedin"] = u
        elif "github.com" in low:
            # The profile link has one path segment; repo links have more.
            path = low.split("github.com/", 1)[-1].strip("/")
            if path and "/" not in path and not out["github"]:
                out["github"] = u
        elif not out["website"] and not any(
            d in low for d in ("github.com", "linkedin.com", "mailto:")
        ):
            out["website"] = u
    return out


def _split_sections(lines: list[str]) -> dict[str, list[str]]:
    sections = {"header": []}
    current = "header"
    for line in lines:
        matched = None
        for key, pat in SECTION_PATTERNS:
            if pat.match(line.strip()):
                matched = key
                break
        if matched:
            current = matched
            sections.setdefault(current, [])
        else:
            sections.setdefault(current, []).append(line)
    return sections


def _collect_bullets(lines: list[str], start: int) -> tuple[list[str], int]:
    """Gather bullet lines from start, folding wrapped lines into bullets."""
    bullets = []
    i = start
    while i < len(lines):
        line = lines[i]
        if BULLET_RE.match(line):
            bullets.append(BULLET_RE.sub("", line).strip())
        elif bullets and not DATE_RE.search(line) and not LOCATION_TAIL_RE.match(line):
            bullets[-1] += " " + line.strip()
        else:
            break
        i += 1
    return bullets, i


def _parse_experience(lines: list[str]) -> list[dict]:
    entries = []
    i = 0
    while i < len(lines):
        m = DATE_RE.search(lines[i])
        if not m:
            i += 1
            continue
        role = DATE_RE.sub("", lines[i]).strip(" |,–—-")
        company, location = "", ""
        if i > 0 and not BULLET_RE.match(lines[i - 1]):
            prev = lines[i - 1]
            lm = LOCATION_TAIL_RE.match(prev)
            if lm:
                company, location = lm.group("head").strip(), lm.group("loc").strip()
            else:
                company = prev.strip()
        bullets, i = _collect_bullets(lines, i + 1)
        entries.append({
            "company": company, "role": role, "location": location,
            "start": m.group("start"), "end": m.group("end"), "bullets": bullets,
        })
    return entries


def _parse_titled_entries(lines: list[str]) -> list[dict]:
    """Research and project sections: a title line, optional noise or date
    lines, then bullets."""
    entries = []
    i = 0
    title = ""
    dates = ("", "")
    while i < len(lines):
        line = lines[i]
        if BULLET_RE.match(line):
            bullets, i = _collect_bullets(lines, i)
            entries.append({"title": title, "start": dates[0], "end": dates[1],
                            "bullets": bullets})
            title, dates = "", ("", "")
            continue
        m = DATE_RE.search(line)
        if m:
            dates = (m.group("start"), m.group("end"))
            rest = DATE_RE.sub("", line).strip(" |,–—-")
            if rest and not NOISE_LINE_RE.match(rest) and not title:
                title = rest
        elif not NOISE_LINE_RE.match(line):
            title = line.strip() if not title else title
        i += 1
    return entries


def _parse_education(lines: list[str]) -> list[dict]:
    entries = []
    school = ""
    for line in lines:
        m = DATE_RE.search(line)
        if m:
            rest = DATE_RE.sub("", line).strip(" |,–—-")
            gpa = _first(r"GPA\s*:?\s*[\d.]+(\s*/\s*[\d.]+)?", rest, re.I)
            degree = rest.replace(gpa, "").strip(" |,–—-") if gpa else rest
            entries.append({
                "school": school, "degree": degree,
                "start": m.group("start"), "end": m.group("end"),
                "gpa": re.sub(r"(?i)GPA\s*:?\s*", "", gpa),
            })
            school = ""
        else:
            lm = LOCATION_TAIL_RE.match(line)
            school = (lm.group("head") if lm else line).strip()
    return entries


def _parse_skills(lines: list[str]) -> list[dict]:
    groups = []
    for line in lines:
        if "," not in line:
            continue
        if ":" in line.split(",")[0]:
            category, rest = line.split(":", 1)
            items = [x.strip() for x in rest.split(",") if x.strip()]
        else:
            items = [x.strip() for x in line.split(",") if x.strip()]
            category = ""
            # "Programming Languages Python, TypeScript" has the category
            # fused to the first item; peel all but the last word off.
            head = items[0].split() if items else []
            if len(head) >= 3:
                category = " ".join(head[:-1])
                items[0] = head[-1]
        if items:
            groups.append({"category": category.strip(), "items": items})
    return groups


def _norm_token(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _split_project_name(title: str, repo_urls: list[str]) -> tuple[str, str]:
    """Project titles come out as 'Name Tech, Tech, Tech'. The PDF's own
    GitHub repo links tell us where the name ends."""
    words = title.split()
    repos = {_norm_token(u.rstrip("/").split("/")[-1]) for u in repo_urls}
    for k in range(len(words), 0, -1):
        if _norm_token("".join(words[:k])) in repos:
            return " ".join(words[:k]), " ".join(words[k:]).strip(" ,|")
    return title, ""


def extract_fields(pdf_path: Path) -> dict:
    reader = PdfReader(str(pdf_path))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    all_urls = _link_urls(reader)
    links = _profile_links(all_urls)
    repo_urls = [u for u in all_urls if "github.com" in u.lower()
                 and u.lower().split("github.com/", 1)[-1].strip("/").count("/") >= 1]
    sections = _split_sections(lines)

    header = sections.get("header", [])
    name_line = header[0] if header else ""
    words = [w for w in name_line.split() if w[0].isalpha()] if name_line else []
    header_text = "\n".join(header)

    research = [
        {"org": "", "role": e["title"], "start": e["start"], "end": e["end"],
         "bullets": e["bullets"]}
        for e in _parse_titled_entries(sections.get("research", []))
    ]
    projects = []
    for e in _parse_titled_entries(sections.get("projects", [])):
        name, tech = _split_project_name(e["title"], repo_urls)
        projects.append({"name": name, "tech": tech, "bullets": e["bullets"]})

    return {
        "personal": {
            "first_name": words[0] if words else "",
            "last_name": words[-1] if len(words) > 1 else "",
            "full_name": name_line,
            "email": _first(r"[\w.+-]+@[\w-]+\.[\w.-]+", header_text),
            "phone": _first(r"(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}", header_text),
            "location": _first(CITY_STATE_RE.pattern, header_text),
            "linkedin": links["linkedin"],
            "github": links["github"],
            "website": links["website"],
        },
        "summary": " ".join(sections.get("summary", [])),
        "work_experience": _parse_experience(sections.get("experience", [])),
        "research_experience": research,
        "projects": projects,
        "education": _parse_education(sections.get("education", [])),
        "skills": _parse_skills(sections.get("skills", [])),
    }
