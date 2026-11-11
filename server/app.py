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
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import claude_client
import db as dbmod
import latex

ROOT = Path(__file__).resolve().parent.parent   # repo root
SERVER = Path(__file__).resolve().parent

CFG = yaml.safe_load((ROOT / "config.yaml").read_text())
RUNS = SERVER / CFG.get("output_dir", "runs")
RUNS.mkdir(exist_ok=True)
DB = dbmod.connect(SERVER / "filla.db")

TAILOR_PROMPT = (SERVER / "prompts" / "tailor.md").read_text()
REVISE_PROMPT = (SERVER / "prompts" / "revise.md").read_text()

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


def _run_dir(app_id: str) -> Path:
    d = RUNS / app_id
    if not d.exists():
        raise HTTPException(404, "Unknown app_id")
    return d


def _compile(app_id: str, tex: str, fields: dict, notes: str) -> dict:
    d = RUNS / app_id
    d.mkdir(exist_ok=True)
    tex_path = d / "resume.tex"
    tex_path.write_text(tex)
    (d / "fields.json").write_text(json.dumps(fields, indent=2))
    try:
        latex.compile_tex(tex_path, d)
    except latex.LatexError as e:
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
        resume_tex=resume_path.read_text(),
        job_title=req.job.title or "(not captured)",
        job_company=req.job.company or "(not captured)",
        job_description=req.job.description[:20000],
    )

    try:
        result = claude_client.tailor(prompt, CFG)
    except claude_client.ClaudeError as e:
        raise HTTPException(502, str(e))

    app_id = uuid.uuid4().hex[:12]
    out = _compile(app_id, result["tex"], result["fields"], result["notes"])
    dbmod.log_application(DB, app_id, req.job.model_dump(), req.track,
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
        result = claude_client.revise(prompt, CFG)
    except claude_client.ClaudeError as e:
        raise HTTPException(502, str(e))
    return _compile(req.app_id, result["tex"], result["fields"], result["notes"])


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
    dbmod.set_status(DB, req.app_id, req.status)
    return {"ok": True}


@app.get("/applications")
def applications():
    return dbmod.list_applications(DB)


if __name__ == "__main__":
    import uvicorn
    scfg = CFG.get("server", {})
    uvicorn.run(app, host=scfg.get("host", "127.0.0.1"),
                port=int(scfg.get("port", 8765)))
