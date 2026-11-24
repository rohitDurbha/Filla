"""Filla companion server.

Runs on localhost next to the Chrome extension. Receives a job description,
asks the user's own Claude (via Claude Code headless mode) to tailor one of
the master resumes, compiles the result with Tectonic, and serves the PDF
back to the extension along with a structured fields JSON that drives the
review UI and the autofill engine.

Run:  uvicorn app:app --host 127.0.0.1 --port 8765
(or:  python app.py)
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
from pathlib import Path

import yaml
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

import claude_client
import claude_usage
import db as dbmod
import extract
import fields_shape
import github
import latex

ROOT = Path(__file__).resolve().parent.parent   # repo root
SERVER = Path(__file__).resolve().parent

CFG = yaml.safe_load((ROOT / "config.yaml").read_text())
RUNS = SERVER / CFG.get("output_dir", "runs")
RUNS.mkdir(exist_ok=True)
DB_PATH = SERVER / "filla.db"
dbmod.init(DB_PATH)

TAILOR_PROMPT = (SERVER / "prompts" / "tailor.md").read_text()
REVISE_PROMPT = (SERVER / "prompts" / "revise.md").read_text()
FIX_PROMPT = (SERVER / "prompts" / "fixtex.md").read_text()
REFINE_PROMPT = (SERVER / "prompts" / "refine.md").read_text()

app = FastAPI(title="Filla server")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*|https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


class Job(BaseModel):
    title: str = ""
    company: str = ""
    url: str = ""
    ats: str = ""
    description: str


class TailorRequest(BaseModel):
    job: Job
    track: str
    cancel_id: str = ""
    model: str = ""


class ReviseRequest(BaseModel):
    app_id: str
    fields: dict
    cancel_id: str = ""
    model: str = ""


class CancelRequest(BaseModel):
    cancel_id: str


class RefineRequest(BaseModel):
    app_id: str
    instruction: str
    cancel_id: str = ""
    model: str = ""


class LocateRequest(BaseModel):
    app_id: str
    page: int
    x: float  # fraction of page width, from the left
    y: float  # fraction of page height, from the top


class StatusRequest(BaseModel):
    app_id: str
    status: str


class RetexRequest(BaseModel):
    app_id: str
    tex: str


def _run_dir(app_id: str) -> Path:
    d = RUNS / app_id
    if not d.exists():
        raise HTTPException(404, "Unknown app_id")
    return d


def _clear_previews(d: Path) -> None:
    for p in d.glob("page_*.png"):
        p.unlink()


def _render_previews(d: Path) -> int:
    """Render the PDF to page PNGs (Chrome's PDF plugin refuses to run
    inside an extension side panel, so the panel shows images instead)."""
    import pypdfium2 as pdfium

    existing = sorted(d.glob("page_*.png"))
    pdf_path = d / "resume.pdf"
    if existing and existing[0].stat().st_mtime > pdf_path.stat().st_mtime:
        return len(existing)
    _clear_previews(d)
    doc = pdfium.PdfDocument(pdf_path)
    try:
        for i, page in enumerate(doc):
            page.render(scale=2.0).to_pil().save(d / f"page_{i}.png")
        return len(doc)
    finally:
        doc.close()


def _compile(app_id: str, tex: str, fields: dict, notes: str,
             allow_repair: bool = True) -> dict:
    d = RUNS / app_id
    d.mkdir(exist_ok=True)
    tex_path = d / "resume.tex"
    tex_path.write_text(tex)
    fields = fields_shape.normalize(fields)
    (d / "fields.json").write_text(json.dumps(fields, indent=2))
    if notes:
        (d / "notes.txt").write_text(notes)
    try:
        latex.compile_tex(tex_path, d)
        _clear_previews(d)
    except latex.LatexError as e:
        # One automatic repair round: hand the error back to Claude, which
        # fixes most escaping and brace mistakes, then compile once more.
        if allow_repair:
            try:
                fixed = claude_client.repair(
                    FIX_PROMPT.format(error=str(e)[:4000], resume_tex=tex), CFG,
                    log_dir=d,
                )
                return _compile(app_id, fixed, fields,
                                notes + " Auto-repaired a LaTeX error.",
                                allow_repair=False)
            except claude_client.ClaudeError:
                pass
        raise HTTPException(502, str(e))
    return {"app_id": app_id, "fields": fields, "notes": notes,
            "pdf_url": f"/pdf/{app_id}"}


def _is_configured() -> bool:
    tracks = CFG.get("tracks") or {}
    if not tracks:
        return False
    rules = SERVER / CFG.get("rules_file", "resumes/rules.md")
    return rules.exists() and all(
        (SERVER / t["resume"]).exists() for t in tracks.values()
    )


@app.get("/health")
def health():
    return {
        "ok": True,
        "tectonic": latex.tectonic_available(),
        "claude": shutil.which((CFG.get("claude") or {}).get("command", "claude")) is not None,
        "configured": _is_configured(),
        "tracks": {k: v["name"] for k, v in (CFG.get("tracks") or {}).items()},
        "pdf_filename": CFG.get("pdf_filename", "resume.pdf"),
    }


class SetupTrack(BaseModel):
    name: str
    tex: str


class SetupRequest(BaseModel):
    github_username: str = ""
    pdf_filename: str = "resume.pdf"
    tracks: list[SetupTrack]
    rules: str


@app.get("/limits")
def limits():
    """Claude plan usage for the panel's bars. See claude_usage.py."""
    return claude_usage.get_usage()


class TrackAddRequest(BaseModel):
    name: str
    tex: str


@app.post("/tracks")
def add_track(req: TrackAddRequest):
    """Add a resume track after initial setup, from the profile page."""
    if not req.name.strip() or not req.tex.strip():
        raise HTTPException(400, "A track needs both a name and its LaTeX source.")
    if "\\documentclass" not in req.tex:
        raise HTTPException(400, "That does not look like a complete .tex file (no \\documentclass found).")
    tracks = CFG.setdefault("tracks", {})
    key = re.sub(r"[^a-z0-9]+", "_", req.name.lower()).strip("_")[:24] or "track"
    base, n = key, 2
    while key in tracks:
        key = f"{base}{n}"
        n += 1
    resumes_dir = SERVER / "resumes"
    resumes_dir.mkdir(exist_ok=True)
    (resumes_dir / f"{key}.tex").write_text(req.tex)
    tracks[key] = {"name": req.name.strip(), "resume": f"resumes/{key}.tex"}
    (ROOT / "config.yaml").write_text(yaml.safe_dump(CFG, sort_keys=False))
    return {"ok": True, "tracks": {k: v["name"] for k, v in tracks.items()}}


@app.post("/setup")
def setup(req: SetupRequest):
    """First-run wizard: receives everything personal from the extension
    and writes config, resumes, and rules, no terminal needed."""
    if not req.tracks:
        raise HTTPException(400, "Add at least one resume track.")
    if not req.rules.strip():
        raise HTTPException(400, "Rules cannot be empty, they drive the tailoring.")

    resumes_dir = SERVER / "resumes"
    resumes_dir.mkdir(exist_ok=True)

    tracks_cfg = {}
    for i, t in enumerate(req.tracks):
        if not t.name.strip() or not t.tex.strip():
            raise HTTPException(400, f"Track {i + 1} needs both a name and its LaTeX.")
        key = re.sub(r"[^a-z0-9]+", "_", t.name.lower()).strip("_")[:24] or f"track{i + 1}"
        base = key
        n = 2
        while key in tracks_cfg:
            key = f"{base}{n}"
            n += 1
        (resumes_dir / f"{key}.tex").write_text(t.tex)
        tracks_cfg[key] = {"name": t.name.strip(), "resume": f"resumes/{key}.tex"}

    (resumes_dir / "rules.md").write_text(req.rules)

    CFG["tracks"] = tracks_cfg
    CFG["rules_file"] = "resumes/rules.md"
    CFG["pdf_filename"] = (req.pdf_filename or "resume.pdf").strip()
    CFG.setdefault("github", {})["username"] = req.github_username.strip()
    (ROOT / "config.yaml").write_text(yaml.safe_dump(CFG, sort_keys=False))
    # Invalidate the GitHub cache so the new username takes effect at once.
    cache = SERVER / "github_cache.json"
    if cache.exists():
        cache.unlink()

    return {"ok": True, "tracks": {k: v["name"] for k, v in tracks_cfg.items()}}


@app.post("/tailor")
def tailor(req: TailorRequest):
    track = CFG["tracks"].get(req.track)
    if not track:
        raise HTTPException(400, f"Unknown track '{req.track}'")

    resume_path = SERVER / track["resume"]
    if not resume_path.exists():
        raise HTTPException(500, f"Resume file missing: {track['resume']}. "
                                 "Drop your .tex files into server/resumes/.")
    rules_path = SERVER / CFG.get("rules_file", "resumes/rules.md")
    rules = rules_path.read_text() if rules_path.exists() else "(no extra rules)"

    prompt = TAILOR_PROMPT.format(
        rules=rules,
        github_projects=github.inventory(CFG, SERVER / "github_cache.json"),
        resume_tex=resume_path.read_text(),
        job_title=req.job.title or "(not captured)",
        job_company=req.job.company or "(not captured)",
        job_description=req.job.description[:20000],
    )

    app_id = uuid.uuid4().hex[:12]
    run_dir = RUNS / app_id
    run_dir.mkdir(parents=True, exist_ok=True)
    ticket = req.cancel_id or None
    if ticket:
        _tickets[ticket] = {"status": "running", "app_id": app_id}

    try:
        result = claude_client.tailor(prompt, CFG, log_dir=run_dir,
                                      cancel_id=ticket,
                                      model=req.model or None)
        out = _compile(app_id, result["tex"], result["fields"], result["notes"])
    except claude_client.ClaudeCancelled:
        if ticket:
            _tickets[ticket] = {"status": "cancelled"}
        raise HTTPException(409, "Cancelled.")
    except claude_client.ClaudeError as e:
        if ticket:
            _tickets[ticket] = {"status": "error", "detail": str(e)}
        raise HTTPException(502, str(e))
    except HTTPException as e:
        if ticket:
            _tickets[ticket] = {"status": "error", "detail": str(e.detail)}
        raise

    dbmod.log_application(DB_PATH, app_id, req.job.model_dump(), req.track,
                          RUNS / app_id / "resume.pdf")
    if ticket:
        _tickets[ticket] = {"status": "done", "result": out}
    return out


# A tailor outlives the page that started it: clicking Apply on Workday
# reloads the panel mid-request. The panel keeps its ticket (the cancel id)
# and asks here for the result once it comes back.
_tickets: dict[str, dict] = {}


@app.get("/ticket/{ticket}")
def ticket_status(ticket: str):
    return _tickets.get(ticket, {"status": "unknown"})


@app.post("/revise")
def revise(req: ReviseRequest):
    d = _run_dir(req.app_id)
    prompt = REVISE_PROMPT.format(
        resume_tex=(d / "resume.tex").read_text(),
        fields_json=json.dumps(req.fields, indent=2),
    )
    try:
        result = claude_client.revise(prompt, CFG, log_dir=d,
                                      cancel_id=req.cancel_id or None,
                                      model=req.model or None)
    except claude_client.ClaudeCancelled:
        raise HTTPException(409, "Cancelled.")
    except claude_client.ClaudeError as e:
        raise HTTPException(502, str(e))
    return _compile(req.app_id, result["tex"], result["fields"], result["notes"])


_hash_cache: dict[str, tuple[float, str]] = {}


def _find_run_by_hash(digest: str) -> str | None:
    """The run whose resume.pdf has this sha256, newest first."""
    runs = sorted(
        (p for p in RUNS.glob("*/resume.pdf") if (p.parent / "fields.json").exists()),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    for p in runs:
        mtime = p.stat().st_mtime
        cached = _hash_cache.get(str(p))
        if not cached or cached[0] != mtime:
            cached = (mtime, hashlib.sha256(p.read_bytes()).hexdigest())
            _hash_cache[str(p)] = cached
        if cached[1] == digest:
            return p.parent.name
    return None


@app.post("/upload")
async def upload(resume: UploadFile = File(...), title: str = Form(""),
                 company: str = Form(""), url: str = Form(""), ats: str = Form("")):
    """Own-PDF path: the user already has a tailored PDF, no Claude involved.
    A PDF that Filla itself built is recognized by its hash and reopens its
    original run, exact fields and LaTeX included, so nothing is re-parsed."""
    if not (resume.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a PDF file.")
    data = await resume.read()
    known = _find_run_by_hash(hashlib.sha256(data).hexdigest())
    if known:
        kd = RUNS / known
        has_tex = (kd / "resume.tex").exists()
        notes_path = kd / "notes.txt"
        return {
            "app_id": known,
            "fields": json.loads((kd / "fields.json").read_text()),
            "pdf_url": f"/pdf/{known}",
            "source": "claude" if has_tex else "pdf",
            "notes": notes_path.read_text() if notes_path.exists() else "",
            "recognized": True,
        }
    app_id = uuid.uuid4().hex[:12]
    d = RUNS / app_id
    d.mkdir(parents=True, exist_ok=True)
    pdf_path = d / "resume.pdf"
    pdf_path.write_bytes(data)
    try:
        fields = extract.extract_fields(pdf_path)
    except Exception:
        fields = {"personal": {}}
    (d / "fields.json").write_text(json.dumps(fields_shape.normalize(fields), indent=2))
    dbmod.log_application(
        DB_PATH, app_id,
        {"title": title, "company": company, "url": url, "ats": ats},
        "own-pdf", pdf_path,
    )
    return {"app_id": app_id, "fields": fields, "pdf_url": f"/pdf/{app_id}",
            "source": "pdf"}


@app.post("/fields/{app_id}")
def save_fields(app_id: str, fields: dict):
    """Persist user edits for runs that have no LaTeX to revise (own-PDF)."""
    d = _run_dir(app_id)
    (d / "fields.json").write_text(json.dumps(fields_shape.normalize(fields), indent=2))
    return {"ok": True}


@app.post("/refine")
def refine(req: RefineRequest):
    """Free-form follow-up refinements from the review screen."""
    d = _run_dir(req.app_id)
    tex_path = d / "resume.tex"
    if not tex_path.exists():
        raise HTTPException(404, "This run has no LaTeX source (own-PDF path).")
    if not req.instruction.strip():
        raise HTTPException(400, "Tell Claude what to change first.")
    rules_path = SERVER / CFG.get("rules_file", "resumes/rules.md")
    rules = rules_path.read_text() if rules_path.exists() else "(no extra rules)"
    fields_path = d / "fields.json"
    prompt = REFINE_PROMPT.format(
        instruction=req.instruction.strip()[:4000],
        rules=rules,
        resume_tex=tex_path.read_text(),
        fields_json=fields_path.read_text() if fields_path.exists() else "{}",
    )
    try:
        result = claude_client.refine(prompt, CFG, log_dir=d,
                                      cancel_id=req.cancel_id or None,
                                      model=req.model or None)
    except claude_client.ClaudeCancelled:
        raise HTTPException(409, "Cancelled.")
    except claude_client.ClaudeError as e:
        raise HTTPException(502, str(e))
    return _compile(req.app_id, result["tex"], result["fields"], result["notes"])


ANSWER_PROMPT = (SERVER / "prompts" / "answer.md").read_text()
DEFAULT_ANSWER_STYLE = (
    "Warm, grounded, specific prose in the first person. No em dashes, "
    "colons, or semicolons. No contractions. Every sentence at least eight "
    "words long. Never copy sentences from the job description."
)


class AnswerQuestion(BaseModel):
    id: str
    question: str
    kind: str = "text"          # choice | multi | text
    options: list[str] = []
    required: bool = False


class AnswerRequest(BaseModel):
    app_id: str = ""
    questions: list[AnswerQuestion]
    profile: dict = {}
    job: dict = {}


def _answer_key(q: AnswerQuestion) -> str:
    norm = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()
    raw = q.kind + "|" + norm(q.question) + "|" + "|".join(sorted(norm(o) for o in q.options))
    return hashlib.sha1(raw.encode()).hexdigest()


def _cacheable(q: AnswerQuestion, value, company: str) -> bool:
    """Choice answers about the candidate generalize across applications.
    Anything naming this company, and any free-text writing, does not."""
    if value is None:
        return False
    if company and company.lower() in q.question.lower():
        return False
    if q.kind == "text":
        return isinstance(value, str) and len(value) <= 60 and "\n" not in value
    return True


def _valid_answer(q: AnswerQuestion, value):
    """Enforce rule one in code too: a choice must be one of the options."""
    if value is None:
        return None
    if q.kind == "choice":
        if not isinstance(value, str):
            return None
        for o in q.options:
            if o.strip().lower() == value.strip().lower():
                return o
        return None
    if q.kind == "multi":
        vals = value if isinstance(value, list) else [value]
        picked = [o for o in q.options
                  if any(isinstance(v, str) and o.strip().lower() == v.strip().lower() for v in vals)]
        return picked or None
    return value if isinstance(value, str) and value.strip() else None


@app.post("/answer")
def answer(req: AnswerRequest):
    """The answer brain for questions the extension could not map with
    certainty. Choice answers are cached, so each distinct question costs
    one Claude call ever."""
    company = (req.job or {}).get("company", "")
    answers, cached, pending = {}, [], []
    for q in req.questions[:40]:
        hit = dbmod.get_answer(DB_PATH, _answer_key(q))
        if hit is not None and _valid_answer(q, hit) is not None:
            answers[q.id] = _valid_answer(q, hit)
            cached.append(q.id)
        else:
            pending.append(q)

    if pending:
        resume = {}
        run_dir = RUNS / req.app_id if req.app_id else None
        if run_dir and (run_dir / "fields.json").exists():
            resume = json.loads((run_dir / "fields.json").read_text())
        acfg = CFG.get("answers") or {}
        prompt = ANSWER_PROMPT.format(
            style=acfg.get("style") or DEFAULT_ANSWER_STYLE,
            profile=json.dumps(req.profile, indent=1)[:6000],
            resume=json.dumps(resume, indent=1)[:12000],
            company=company or "(unknown)",
            title=(req.job or {}).get("title") or "(unknown)",
            questions=json.dumps(
                [{"id": q.id, "question": q.question[:600], "kind": q.kind,
                  "options": q.options[:60]} for q in pending], indent=1),
        )
        try:
            out = claude_client.answer(prompt, CFG, log_dir=run_dir if run_dir and run_dir.exists() else None,
                                       model=acfg.get("model", "haiku"))
        except claude_client.ClaudeError as e:
            raise HTTPException(502, str(e))
        raw = out.get("answers", {}) if isinstance(out, dict) else {}
        for q in pending:
            v = _valid_answer(q, raw.get(q.id))
            if v is None:
                continue
            answers[q.id] = v
            if _cacheable(q, v, company):
                dbmod.put_answer(DB_PATH, _answer_key(q), q.question, v)

    return {"answers": answers, "cached": cached}


@app.post("/answers/forget")
def forget_answers():
    """Clear the answer cache, for when the profile changes."""
    return {"cleared": dbmod.forget_answers(DB_PATH)}


@app.get("/tex/{app_id}")
def get_tex(app_id: str):
    d = _run_dir(app_id)
    tex_path = d / "resume.tex"
    if not tex_path.exists():
        raise HTTPException(404, "This run has no LaTeX source (own-PDF path).")
    return {"tex": tex_path.read_text()}


@app.post("/retex")
def retex(req: RetexRequest):
    """Direct LaTeX edit from the panel. Compiled as-is, no Claude repair,
    so the user sees the real compiler error for their own edit."""
    d = _run_dir(req.app_id)
    tex_path = d / "resume.tex"
    tex_path.write_text(req.tex)
    try:
        latex.compile_tex(tex_path, d)
        _clear_previews(d)
    except latex.LatexError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "pdf_url": f"/pdf/{req.app_id}"}


@app.post("/locate")
def locate(req: LocateRequest):
    """Map a click on the preview to a position in the LaTeX source, the
    Overleaf jump-to-source idea. Reads the words under the click from the
    PDF's text layer, then finds them in the tex."""
    import pypdfium2 as pdfium

    d = _run_dir(req.app_id)
    tex_path = d / "resume.tex"
    if not tex_path.exists():
        raise HTTPException(404, "This run has no LaTeX source.")
    tex = tex_path.read_text()

    doc = pdfium.PdfDocument(d / "resume.pdf")
    try:
        if not 0 <= req.page < len(doc):
            raise HTTPException(400, "No such page")
        page = doc[req.page]
        w, h = page.get_size()
        x, y = req.x * w, (1 - req.y) * h  # PDF origin is bottom left
        snippet = page.get_textpage().get_text_bounded(
            left=x - 80, bottom=y - 9, right=x + 80, top=y + 9
        )
    finally:
        doc.close()

    words = [w2 for w2 in re.findall(r"[A-Za-z0-9%+.\-]{4,}", snippet or "")]
    if not words:
        raise HTTPException(404, "No text under the click.")

    # Longest word is the most distinctive anchor; disambiguate repeated
    # occurrences with a neighboring word from the same snippet.
    anchor = max(words, key=len)
    spots = [m.start() for m in re.finditer(re.escape(anchor), tex)]
    if not spots:
        raise HTTPException(404, "Could not find that text in the LaTeX.")
    best = spots[0]
    if len(spots) > 1:
        neighbors = [w2 for w2 in words if w2 != anchor]
        for s in spots:
            window = tex[max(0, s - 160): s + 160]
            if any(n in window for n in neighbors):
                best = s
                break
    return {"index": best, "length": len(anchor)}


@app.get("/preview/{app_id}")
def preview_meta(app_id: str):
    d = _run_dir(app_id)
    if not (d / "resume.pdf").exists():
        raise HTTPException(404, "PDF not built yet")
    return {"pages": _render_previews(d)}


@app.get("/preview/{app_id}/{page}")
def preview_page(app_id: str, page: int):
    d = _run_dir(app_id)
    png = d / f"page_{page}.png"
    if not png.exists():
        raise HTTPException(404, "No such page")
    return FileResponse(png, media_type="image/png")


def download_name(company: str = "") -> str:
    """Rohit_Durbha_Resume_Method_Financial.pdf: the configured base name
    with the company appended, so every download and upload is distinct."""
    base = re.sub(r"\.pdf$", "", CFG.get("pdf_filename", "resume.pdf"), flags=re.I)
    co = re.sub(r"[^A-Za-z0-9]+", "_", company or "").strip("_")
    return f"{base}_{co}.pdf" if co else f"{base}.pdf"


@app.get("/pdf/{app_id}")
def pdf(app_id: str, company: str = ""):
    d = _run_dir(app_id)
    pdf_path = d / "resume.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "PDF not built yet")
    return FileResponse(pdf_path, media_type="application/pdf",
                        filename=download_name(company))


@app.get("/fields/{app_id}")
def fields(app_id: str):
    d = _run_dir(app_id)
    return json.loads((d / "fields.json").read_text())


@app.post("/cancel")
def cancel(req: CancelRequest):
    """Kill a running Claude call so an accidental click costs nothing more."""
    return {"ok": claude_client.cancel(req.cancel_id)}


@app.post("/status")
def status(req: StatusRequest):
    dbmod.set_status(DB_PATH, req.app_id, req.status)
    return {"ok": True}


@app.get("/applications")
def applications():
    return dbmod.list_applications(DB_PATH)


@app.get("/tracker")
def tracker():
    """The application tracker as a page, at http://localhost:8765/tracker."""
    import html as h

    rows = dbmod.list_applications(DB_PATH, limit=1000)
    submitted = [r for r in rows if r["status"] == "applied"]
    seen = [r for r in rows if r["status"] != "applied"]

    def table(items):
        body = "".join(
            f"""<tr>
              <td class="dt">{h.escape((r['created_at'] or '')[:16])}</td>
              <td class="co">{h.escape(r['company'] or '(unknown)')}</td>
              <td>{h.escape(r['title'] or '')}</td>
              <td><span class="pill">{h.escape(r['ats'] or '')}</span></td>
              <td>{h.escape(r['track'] or '')}</td>
              <td>{f'<a href="{h.escape(r["url"])}" target="_blank">open</a>' if r['url'] else ''}</td>
            </tr>"""
            for r in items
        )
        return ("<table><tr><th>When</th><th>Company</th><th>Role</th>"
                "<th>ATS</th><th>Track</th><th></th></tr>" + body + "</table>")
    page = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Filla applications</title>
<style>
  :root {{ --bg:#F6F6F9; --card:#fff; --text:#17181D; --muted:#7A7F8E;
          --line:#E8E9F0; --accent:#99A5F2; --soft:#EAEDFD; --ink:#5B67C7; --ok:#4EAE85; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--text);
         font:15px/1.6 Georgia, 'Times New Roman', serif; }}
  .wrap {{ max-width:1000px; margin:0 auto; padding:48px 24px 80px; }}
  .logo {{ font-size:22px; font-weight:800; }}
  .logo i {{ display:inline-block; width:8px; height:8px; margin-left:3px;
            border-radius:50%; background:var(--accent); }}
  h1 {{ font-size:20px; margin:16px 0 4px; }}
  .sub {{ color:var(--muted); margin:0 0 24px; }}
  .sub b {{ color:var(--ink); }}
  table {{ width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:14px; overflow:hidden;
          box-shadow:0 1px 2px rgba(23,24,29,.05), 0 8px 24px rgba(23,24,29,.06); }}
  th, td {{ text-align:left; padding:10px 14px; border-bottom:1px solid var(--line);
           font-size:13.5px; }}
  th {{ color:var(--muted); font-weight:600; background:#FBFBFD; }}
  tr:last-child td {{ border-bottom:none; }}
  .dt {{ color:var(--muted); white-space:nowrap; }}
  .co {{ font-weight:700; }}
  .pill {{ background:var(--soft); color:var(--ink); border-radius:99px;
          padding:1px 9px; font-size:11.5px; text-transform:capitalize; }}
  a {{ color:var(--ink); }}
  .empty {{ padding:36px; text-align:center; color:var(--muted);
            background:var(--card); border:1px solid var(--line); border-radius:14px; }}
  h2 {{ font-size:15px; margin:34px 0 10px; }}
  h2 .n {{ color:var(--ink); }}
</style></head><body><div class="wrap">
<div class="logo">Filla<i></i></div>
<h1>Applications</h1>
<p class="sub">One row per job. Re-tailoring a posting updates its row, and
submitting it moves it up for good.</p>
<h2>Submitted <span class="n">{len(submitted)}</span></h2>
{table(submitted) if submitted else '<div class="empty">Nothing submitted yet. Mark an application as applied in the panel and it lands here.</div>'}
<h2>Seen <span class="n">{len(seen)}</span></h2>
{table(seen) if seen else '<div class="empty">No postings in progress.</div>'}
</div></body></html>"""
    return HTMLResponse(page)


if __name__ == "__main__":
    import uvicorn
    scfg = CFG.get("server", {})
    uvicorn.run(app, host=scfg.get("host", "127.0.0.1"),
                port=int(scfg.get("port", 8765)))
