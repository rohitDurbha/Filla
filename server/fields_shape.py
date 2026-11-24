"""Coerce whatever fields JSON Claude returns into the one shape the panel
and autofill expect. Claude occasionally returns bullets as a single string,
skills as a dict, or a section as an object, and the panel cannot render
those. Normalizing here means no single answer can wedge the UI."""

from __future__ import annotations

LIST_SECTIONS = ("work_experience", "research_experience", "projects", "education")


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values()) if all(isinstance(x, dict) for x in v.values()) else [v]
    return [v]


def _bullets(v) -> list[str]:
    if isinstance(v, str):
        return [line.strip(" -•\t") for line in v.splitlines() if line.strip(" -•\t")]
    return [str(b).strip() for b in _as_list(v) if str(b).strip()]


def _str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v)
    return str(v)


def normalize(fields) -> dict:
    f = fields if isinstance(fields, dict) else {}
    out = dict(f)
    personal = f.get("personal") if isinstance(f.get("personal"), dict) else {}
    out["personal"] = {k: _str(v) for k, v in personal.items()}
    if "summary" in f:
        out["summary"] = _str(f.get("summary"))

    for sec in LIST_SECTIONS:
        if sec not in f:
            continue
        entries = []
        for e in _as_list(f.get(sec)):
            if not isinstance(e, dict):
                e = {"name": _str(e)} if sec == "projects" else {"role": _str(e)}
            e = {k: (v if k == "bullets" else _str(v)) for k, v in e.items()}
            if "bullets" in e or sec != "education":
                e["bullets"] = _bullets(e.get("bullets"))
            entries.append(e)
        out[sec] = entries

    if "skills" in f:
        skills = f.get("skills")
        groups = []
        if isinstance(skills, dict):
            for cat, items in skills.items():
                groups.append({"category": _str(cat), "items": _skill_items(items)})
        else:
            for g in _as_list(skills):
                if isinstance(g, dict):
                    groups.append({"category": _str(g.get("category")),
                                   "items": _skill_items(g.get("items"))})
                else:
                    groups.append({"category": "", "items": _skill_items(g)})
        out["skills"] = groups
    return out


def _skill_items(v) -> list[str]:
    if isinstance(v, str):
        return [x.strip() for x in v.split(",") if x.strip()]
    return [_str(x).strip() for x in _as_list(v) if _str(x).strip()]
