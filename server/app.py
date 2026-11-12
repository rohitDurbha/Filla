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

import json
import shutil
import uuid
from pathlib import Path

import yaml
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import claude_client
import db as dbmod
import extract
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


class ReviseRequest(BaseModel):
    app_id: str
    fields: dict


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
    (d / "fields.json").write_text(json.dumps(fields, indent=2))
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


@app.get("/health")
def health():
    return {
        "ok": True,
        "tectonic": latex.tectonic_available(),
        "tracks": {k: v["name"] for k, v in CFG["tracks"].items()},
        "pdf_filename": CFG.get("pdf_filename", "resume.pdf"),
    }


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

    try:
        result = claude_client.tailor(prompt, CFG, log_dir=run_dir)
    except claude_client.ClaudeError as e:
        raise HTTPException(502, str(e))

    out = _compile(app_id, result["tex"], result["fields"], result["notes"])
    dbmod.log_application(DB_PATH, app_id, req.job.model_dump(), req.track,
                          RUNS / app_id / "resume.pdf")
    return out


@app.post("/revise")
def revise(req: ReviseRequest):
    d = _run_dir(req.app_id)
    prompt = REVISE_PROMPT.format(
        resume_tex=(d / "resume.tex").read_text(),
        fields_json=json.dumps(req.fields, indent=2),
    )
    try:
        result = claude_client.revise(prompt, CFG, log_dir=d)
    except claude_client.ClaudeError as e:
        raise HTTPException(502, str(e))
    return _compile(req.app_id, result["tex"], result["fields"], result["notes"])


@app.post("/upload")
async def upload(resume: UploadFile = File(...), title: str = Form(""),
                 company: str = Form(""), url: str = Form(""), ats: str = Form("")):
    """Own-PDF path: the user already has a tailored PDF, no Claude involved."""
    if not (resume.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a PDF file.")
    app_id = uuid.uuid4().hex[:12]
    d = RUNS / app_id
    d.mkdir(parents=True, exist_ok=True)
    pdf_path = d / "resume.pdf"
    pdf_path.write_bytes(await resume.read())
    try:
        fields = extract.extract_fields(pdf_path)
    except Exception:
        fields = {"personal": {}}
    (d / "fields.json").write_text(json.dumps(fields, indent=2))
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
    (d / "fields.json").write_text(json.dumps(fields, indent=2))
    return {"ok": True}


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


@app.get("/pdf/{app_id}")
def pdf(app_id: str):
    d = _run_dir(app_id)
    pdf_path = d / "resume.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "PDF not built yet")
    return FileResponse(pdf_path, media_type="application/pdf",
                        filename=CFG.get("pdf_filename", "resume.pdf"))


@app.get("/fields/{app_id}")
def fields(app_id: str):
    d = _run_dir(app_id)
    return json.loads((d / "fields.json").read_text())


@app.post("/status")
def status(req: StatusRequest):
    dbmod.set_status(DB_PATH, req.app_id, req.status)
    return {"ok": True}


@app.get("/applications")
def applications():
    return dbmod.list_applications(DB_PATH)


if __name__ == "__main__":
    import uvicorn
    scfg = CFG.get("server", {})
    uvicorn.run(app, host=scfg.get("host", "127.0.0.1"),
                port=int(scfg.get("port", 8765)))
