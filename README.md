# Filla

A personal Chrome extension that tailors your resume with your own Claude for
every job you apply to, then autofills the application. Built around a simple
idea. A profile saved once goes stale, but a resume rewritten per job
description stays sharp, so the tailoring step belongs inside the apply loop.

Everything runs locally and everything is free and open source. Claude usage
rides on your existing Claude subscription through Claude Code headless mode,
so no API key is needed anywhere.

## How the loop works

1. Open a job posting on Greenhouse, Lever, Ashby, or SmartRecruiters. The
   side panel picks up the posting and suggests a resume track.
2. Click Tailor with Claude. The job description and the matching master
   resume go to your local Claude, which returns a tailored .tex plus a
   structured JSON of every field in it. The server compiles the PDF with
   Tectonic.
3. Review the extracted fields in the panel and edit anything that looks off.
   Edits are applied back into the LaTeX and the PDF is rebuilt.
4. Approve the final PDF. It downloads to your machine automatically.
5. Click Fill this page. The extension uploads the tailored PDF, fills the
   standard fields, and answers the EEO questions from your one-time profile.
   On multi-step applications you click fill once per page.
6. Mark applied. The application lands in a local SQLite log.

Already have a tailored PDF? Drop it onto the panel (or click Use a PDF I
already have) and Filla skips Claude entirely. Contact fields are extracted
locally with simple heuristics, you fix anything they missed, and the fill
step works exactly the same.

When a tailored resume fails to compile, the server hands the compiler error
back to Claude for one automatic repair round before giving up, and the panel
shows the real error lines from the TeX log if it still fails.

The structured JSON is the backbone of the design. Claude wrote the resume,
so Claude already knows every field in it, which means no PDF parsing or
recognition step is ever needed.

## Setup

### 1. Server

```bash
cd server
pip install -r requirements.txt
```

Install Tectonic for LaTeX compilation (single binary, no TeX Live needed).

```bash
brew install tectonic        # macOS
# or: cargo install tectonic
```

Make sure Claude Code is installed and logged in with your Claude account.

```bash
claude --version
```

Drop your files into `server/resumes/` as described in the README there
(four .tex resumes plus rules.md), then start the server.

```bash
python app.py
```

### 2. Extension

1. Open `chrome://extensions`, turn on Developer mode.
2. Click Load unpacked and select the `extension/` folder.
3. The one-time profile page opens on first install. Fill in the EEO answers
   once (gender, race, veteran status, work authorization, sponsorship, and
   so on). They are stored only in your browser.
4. Pin Filla and click the icon on any supported job page to open the panel.

## Configuration

Everything lives in `config.yaml` at the repo root. The model, the resume
track names and paths, the downloaded PDF filename, and timeouts.

## Notes on usage limits

Headless Claude Code calls draw from your Claude subscription limits, the
same pool as interactive use. At heavy volume (40 to 50 applications per
day) you may bump into the five hour usage windows on busy days. Spreading
sessions across the day helps, and `claude.extra_args` in config.yaml
accepts a fallback model if you ever want one.

## Status

v0.1 scaffold. Working surface areas are Greenhouse, Lever, Ashby, and
SmartRecruiters. Workday support is planned for a later version since its
multi-page flow needs its own adapter work.
