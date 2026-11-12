// Filla first-run wizard. Collects everything personal in the browser and
// hands it to the local server, so nobody edits files or uses a terminal.

const SERVER = "http://localhost:8765";
const $ = (id) => document.getElementById(id);
const STEPS = 6;
let step = 0;

// The proven pipeline: the five-step process this extension was built
// around, generalized. Bracketed parts are the user's to fill in.
const RULES_TEMPLATE = `MASTER RULES FOR ALL JOB DESCRIPTIONS

The 5-step pipeline (run for every job, in order)

Step 1. Choose the base resume
Pick the right track by analyzing the job description.
[Explain which of your tracks maps to which role types. For example, a
Data track for Data Scientist, Data Analyst, and BI roles, a Software
track for Software Engineer and ML Engineer roles.]

Step 2. Recruiter analysis
Score the base resume against the job description out of 100, identify
the top 5 missing keywords, and call out the 3 red flags a hiring
manager would spot in under 10 seconds.

Step 3. Rewrite experience and skills
Use the XYZ formula (Accomplished X as measured by Y by doing Z) to
weave missing keywords, skills, and tools naturally into work experience
bullets with concrete measurable impact. Keep every claim honest and
never exaggerate beyond what I actually did. Project core ideas and
narratives stay the same, only the tools referenced within them may
shift toward the job. Never use sentences verbatim from the job
description.

Step 4. Summary and skills section
Summary is one line to avoid clutter. Customize the skills section to
the job plus a few forward-looking extras. Only actual skills someone
would put on a resume, never phrases lifted from the posting to inflate
the score. Keep every skills row short enough that nothing overflows
the line.

Step 5. ATS and hiring manager rescan
Act as an ATS filter and an exhausted recruiter reading 200 resumes.
Flag sections that would get skipped, rewrite them with the same rules,
and rescore. The final score must be at least 90.

Fixed facts
Contact info, dates, employers, titles, and degrees never change.
[List any bullets whose wording is frozen word for word, such as a
research result you always state the same way.]

Project selection
Choose projects from the base resume and my public GitHub, picking
whichever combination best fits the job. The number of projects is
whatever relevance and the one-page limit call for.
[Name any project that should lead for certain role types.]

Layout
The compiled PDF is always exactly one page, without fail.
[Add any margin, spacing, or section-order rules your template needs.]

Writing style
Start bullets with strong action verbs, two lines maximum per bullet.
No em dashes, colons, or semicolons in bullets. Keywords woven in
naturally, never listed or manufactured.`;

function showStep(n) {
  step = n;
  document.querySelectorAll(".step").forEach((s) => {
    s.classList.toggle("hidden", Number(s.dataset.step) !== n);
  });
  document.querySelectorAll("#dots i").forEach((d, i) => {
    d.classList.toggle("on", i <= n);
  });
  window.scrollTo({ top: 0 });
}

// dots
for (let i = 0; i < STEPS - 1; i++) {
  const d = document.createElement("i");
  $("dots").appendChild(d);
}

// generic nav
document.querySelectorAll("[data-back]").forEach((b) =>
  b.addEventListener("click", () => showStep(step - 1)));
document.querySelectorAll("[data-next]").forEach((b) =>
  b.addEventListener("click", () => {
    if (validate(step)) showStep(step + 1);
  }));

// ---------- step 0: environment checks ----------

async function checkEnv() {
  const set = (id, state) => {
    const el = $(id);
    el.classList.remove("ok", "bad");
    if (state !== null) el.classList.add(state ? "ok" : "bad");
  };
  try {
    const h = await (await fetch(SERVER + "/health")).json();
    set("chk-server", true);
    set("chk-tectonic", h.tectonic);
    set("chk-claude", h.claude);
    $("next0").disabled = !(h.tectonic && h.claude);
    if (h.tracks && Object.keys(h.tracks).length) prefillTracks(Object.values(h.tracks));
    return h;
  } catch {
    set("chk-server", false);
    set("chk-tectonic", null);
    set("chk-claude", null);
    $("next0").disabled = true;
    return null;
  }
}
$("recheck").addEventListener("click", checkEnv);
$("next0").addEventListener("click", () => showStep(1));
checkEnv();
setInterval(() => { if (step === 0) checkEnv(); }, 4000);

// ---------- step 2: tracks ----------

let prefillNames = ["Data Science", "Software Engineering", "Research"];
function prefillTracks(names) { prefillNames = names; renderTracks(); }

function renderTracks() {
  const count = Number($("track-count").value);
  const existing = [...document.querySelectorAll(".trackcard")].map((c) => ({
    name: c.querySelector(".t-name").value,
    tex: c.querySelector(".t-tex").value,
  }));
  const box = $("tracks");
  box.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.className = "card trackcard";
    card.innerHTML = `
      <div class="rowtop">
        <label>Track ${i + 1} name
          <input type="text" class="t-name" placeholder="Software Engineering" />
        </label>
        <button class="filebtn">Upload .tex</button>
        <input type="file" accept=".tex,text/x-tex,text/plain" hidden />
      </div>
      <label>LaTeX source
        <textarea class="t-tex tex" placeholder="\\documentclass..."></textarea>
      </label>`;
    card.querySelector(".t-name").value =
      existing[i]?.name ?? prefillNames[i] ?? "";
    card.querySelector(".t-tex").value = existing[i]?.tex ?? "";
    const fileInput = card.querySelector('input[type="file"]');
    card.querySelector(".filebtn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      card.querySelector(".t-tex").value = await f.text();
      if (!card.querySelector(".t-name").value) {
        card.querySelector(".t-name").value =
          f.name.replace(/\.tex$/i, "").replace(/[_-]+/g, " ");
      }
    });
    box.appendChild(card);
  }
}
$("track-count").addEventListener("change", renderTracks);
renderTracks();

$("rules-template").addEventListener("click", () => {
  const ta = $("rules");
  if (!ta.value.trim() || confirm("Replace what you have written with the pipeline template?")) {
    ta.value = RULES_TEMPLATE;
    ta.focus();
    const i = ta.value.indexOf("[");
    if (i > -1) ta.setSelectionRange(i, ta.value.indexOf("]") + 1);
  }
});

$("rules-upload").addEventListener("click", () => $("rules-file").click());
$("rules-file").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  $("rules").value = await f.text();
  e.target.value = "";
});

// ---------- validation ----------

function validate(n) {
  const err = (id, msg) => { $(id).textContent = msg; return !msg; };
  if (n === 1) {
    return err("err-1", "");
  }
  if (n === 2) {
    for (const [i, c] of [...document.querySelectorAll(".trackcard")].entries()) {
      const name = c.querySelector(".t-name").value.trim();
      const tex = c.querySelector(".t-tex").value;
      if (!name) return err("err-2", `Track ${i + 1} needs a name.`);
      if (!tex.trim()) return err("err-2", `Track ${i + 1} needs its LaTeX source.`);
      if (!tex.includes("\\documentclass")) {
        return err("err-2", `Track ${i + 1} does not look like a complete .tex file (no \\documentclass found).`);
      }
    }
    return err("err-2", "");
  }
  if (n === 3) {
    if (!$("rules").value.trim()) return err("err-3", "Rules cannot be empty. The starter template is a fine beginning.");
    return err("err-3", "");
  }
  return true;
}

// ---------- finish ----------

const EEO_KEYS = ["gender", "hispanic_latino", "race", "veteran",
                  "disability", "work_authorized", "requires_sponsorship"];

$("finish").addEventListener("click", async () => {
  const btn = $("finish");
  btn.disabled = true;
  btn.textContent = "Setting up…";
  try {
    const eeoProfile = {};
    for (const k of EEO_KEYS) {
      const v = $(k).value;
      if (v) eeoProfile[k] = v;
    }
    await chrome.storage.local.set({ eeoProfile });

    const tracks = [...document.querySelectorAll(".trackcard")].map((c) => ({
      name: c.querySelector(".t-name").value.trim(),
      tex: c.querySelector(".t-tex").value,
    }));
    const resp = await fetch(SERVER + "/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: $("gh-user").value.trim(),
        pdf_filename: $("pdf-name").value.trim() || "resume.pdf",
        tracks,
        rules: $("rules").value,
      }),
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    showStep(5);
  } catch (e) {
    $("err-4").textContent = String(e.message || e);
  }
  btn.disabled = false;
  btn.textContent = "Start Filla";
});

// restore any existing eeo answers for re-runs of the wizard
chrome.storage.local.get("eeoProfile").then(({ eeoProfile }) => {
  if (!eeoProfile) return;
  for (const k of EEO_KEYS) if (eeoProfile[k]) $(k).value = eeoProfile[k];
});
