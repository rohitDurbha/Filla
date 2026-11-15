# Filla

A Chrome extension that tailors your resume with your own Claude for every
job you apply to, then fills the application for you. Built around a simple
idea. A profile saved once goes stale, but a resume rewritten per job
description stays sharp, so the tailoring step belongs inside the apply
loop.

Everything runs locally and everything is free and open source. Claude
usage rides on your existing Claude subscription through Claude Code, so
no API key exists anywhere in this project.

## Features

- **Per-job tailoring with your own Claude.** One click sends the job
  description and your base resume through your tailoring rules. Claude
  scores the resume against the posting, weaves missing keywords into
  honest bullets, and returns a recruiter-ready one-page PDF compiled
  with Tectonic.
- **GitHub-aware project selection.** Filla keeps a cached inventory of
  your public repositories, so Claude swaps projects in and out per job
  based on what actually fits, grounded in each repo's README.
- **Review everything before it ships.** An editable field-by-field
  review screen, a similarity score showing before and after, collapsible
  notes on what changed, and a free-form box to ask Claude for further
  refinements.
- **Full LaTeX control.** Zoom the final preview, double-click any spot
  on it to jump to that exact place in the LaTeX source, edit, and
  recompile. Compile errors go back to Claude for one automatic repair
  pass first.
- **Verified autofill that walks the page.** Filling scrolls to each
  field, flashes it, and streams a live feed. A checkmark means the value
  verifiably landed. Anything uncertain goes to a double-check list, so
  the feed never lies. Standard and custom EEO questions fill from a
  one-time profile stored only in your browser.
- **Bring a PDF instead.** Already have a tailored resume? Drop it on the
  panel and Filla extracts your details locally, no AI involved, and
  fills with that.
- **Model choice and plan visibility.** Pick Sonnet, Opus, or Haiku per
  tailoring run, and see your Claude plan's 5-hour and 7-day usage bars
  with reset times at the top of the panel.
- **A tracker you never maintain.** Every posting you tailor for is a
  Seen row, every application you mark applied moves to Submitted
  history, one row per job, at localhost:8765/tracker.
- **Thoughtful flow details.** Draggable in-page launcher, cancellable
  Claude calls that actually kill the process, desktop notification when
  tailoring finishes while you are on another tab, and a guided setup
  wizard so nobody edits files by hand.

## Supported job sites

Greenhouse, Lever, Ashby, and SmartRecruiters are the primary surfaces,
including their application-form pages. Workday is supported as a newer
surface. Basics, resume upload, and the voluntary-disclosure dropdowns
fill through Workday's stable automation ids, and its multi-step flow
works with one Fill per page, though its stranger widgets land in the
double-check list by design. Expect to confirm more by hand there while
this surface matures.

## Getting started

Three things need to exist on the computer once. Python 3.10 or newer,
Tectonic (the LaTeX compiler, `brew install tectonic` on a Mac), and
Claude Code installed and logged in with a Claude Pro or Max account.

1. Download this repository (Code, then Download ZIP, works fine).
2. Double-click `start-mac.command` on macOS or `start-windows.bat` on
   Windows, and keep that window open while applying. The first run
   builds everything it needs.
3. Open `chrome://extensions`, turn on Developer mode, click Load
   unpacked, and select the `extension/` folder.

The setup wizard opens on install and handles the rest in the browser.
It live-checks the environment, then collects your GitHub username, your
resume tracks (paste or upload each .tex), your tailoring rules (start
from the proven pipeline template, upload a rules.md, or write your own),
and your one-time application answers. Start Filla writes it all to the
server, and you are ready to apply.

Prefer the terminal? `./setup.sh` checks prerequisites and builds the
virtualenv, and `cd server && ./run.sh` starts the server with
auto-reload.

## Daily loop

Open a job posting, click the F chip, pick a track and model, and Tailor
with Claude. Review the fields, refine if needed, approve the PDF, and
Fill this page. On multi-step applications click Fill again after each
step. Mark applied moves the job into your Submitted history.

## Adding things later

The Profile page (footer link) holds your one-time application answers
and lets you add new resume tracks any time without rerunning setup.
`config.yaml` at the repo root holds the model default, timeouts, GitHub
settings, and the PDF filename recruiters see. Every tailoring run keeps
an audit trail under `server/runs/` with the exact prompt and response.

## Sharing Filla with someone else

Nothing personal is baked into the code. A friend downloads the repo,
installs the three prerequisites, double-clicks the starter for their
system, loads the extension, and the wizard makes Filla theirs with
their own Claude login, GitHub, resumes, and rules. Mac and Windows both
work. The server is plain Python with portable paths, and both Tectonic
and Claude Code ship Windows builds.

## Notes on usage

Headless Claude Code calls draw from your Claude subscription limits,
the same pool as interactive use. The usage bars in the panel read the
same data Claude Code itself reads, through an unofficial endpoint, so
if they ever stop appearing the feature has hidden itself harmlessly.
At heavy volume, the per-run model picker helps. Haiku is a fine
tailor for routine postings and spends far less of the window.

## Privacy

Your resumes, rules, tailored PDFs, application log, and EEO answers
never leave your machine except as part of applications you submit
yourself. The only network calls are to your own Claude account, the
public GitHub API for your repo inventory, and the job sites you visit.
