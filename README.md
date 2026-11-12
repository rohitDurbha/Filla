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

Fastest path, from the repo root:

```bash
./setup.sh
```

The script checks prerequisites (Python, Tectonic, Claude Code), builds the
virtualenv, installs dependencies, and lists exactly which personal pieces
you still need to add. The sections below cover the same ground by hand.

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
./run.sh
```

The script frees port 8765 if an old server still holds it, activates the
virtualenv, and runs with auto-reload, so code changes and git pulls apply
without restarting. Stop with Ctrl+C. Avoid Ctrl+Z, which suspends the
process and keeps the port, though run.sh clears that up on the next start
either way.

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

## Sharing Filla with someone else

Nothing personal is baked into the code. Everything that makes Filla yours
lives in exactly three places, all gitignored or plainly editable:

1. `config.yaml` carries your GitHub username, your resume track names and
   paths, and the PDF filename recruiters see.
2. `server/resumes/` holds your .tex resumes and your rules.md. The rules
   file is the heart of the system, since it tells Claude what may change,
   what stays frozen, and how projects get picked from GitHub.
3. The one-time profile (work authorization, EEO answers) lives only in
   each person's own browser storage.

A friend gets their own Filla with no terminal and no file editing:

1. Download the repo (Code, Download ZIP works fine) and install the three
   prerequisites once: Python, Tectonic, and Claude Code logged in with
   their own Claude account.
2. Double-click `start-mac.command` (Mac) or `start-windows.bat` (Windows)
   and keep the window open. First run installs everything it needs.
3. Load `extension/` unpacked at chrome://extensions. The setup wizard
   opens by itself: it checks the environment live, then collects their
   GitHub username, resume tracks (paste or upload each .tex), tailoring
   rules (a starter template is one click away), and the one-time
   application answers, and writes it all to their server on Start.

Claude usage rides on each person's own subscription through their own
Claude Code login, so nobody shares accounts or keys. The server is plain
Python with portable paths, and both Tectonic and Claude Code ship Windows
builds, so Mac and Windows both work.

The extension loads unpacked because the Chrome Web Store is built for
hosted apps, while Filla deliberately keeps everything local to the user's
machine. If this ever grows beyond friends, publishing to the store with a
guided first-run setup would be the next step.

## Application tracker

Every tailored resume and every application marked applied is logged to a
local SQLite database at `server/filla.db`. View it any time at
http://localhost:8765/tracker, or from the Applications link in the
panel's footer. The raw data is also served as JSON at /applications for
anything you want to build on top of it.

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
