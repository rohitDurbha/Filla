// Filla side panel state machine.
// job -> (tailor with Claude | use own PDF) -> review -> final PDF -> fill

const SERVER = "http://127.0.0.1:8765";

const state = {
  tab: null,
  job: null,
  tracks: {},
  pdfFilename: "resume.pdf",
  appId: null,
  fields: null,
  dirty: false,
  source: null, // "claude" | "pdf"
};

const $ = (id) => document.getElementById(id);
const views = ["nosite", "job", "busy", "review", "pdf", "fill"];
const VIEW_STAGE = { nosite: 0, job: 0, busy: 1, review: 2, pdf: 3, fill: 4 };

function setStage(n) {
  document.querySelectorAll("#stage-list li").forEach((li) => {
    const s = Number(li.dataset.stage);
    li.classList.toggle("done", s < n);
    li.classList.toggle("active", s === n);
  });
  $("track-fill").style.width = (n / 4) * 100 + "%";
}

function show(view) {
  for (const v of views) $("view-" + v).classList.toggle("hidden", v !== view);
  setStage(VIEW_STAGE[view]);
  hideError();
}

function fail(msg) {
  console.error(msg);
  $("error-text").textContent = String(msg).slice(0, 4000);
  $("error-box").classList.remove("hidden");
}
function hideError() { $("error-box").classList.add("hidden"); }
$("error-close").addEventListener("click", hideError);

async function api(path, body) {
  const resp = await fetch(SERVER + path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined);
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return resp.json();
}

// ---------- startup ----------

async function checkServer() {
  try {
    const h = await api("/health");
    $("server-dot").classList.add("ok");
    $("server-label").textContent = h.tectonic ? "ready" : "no tectonic";
    state.tracks = h.tracks;
    state.pdfFilename = h.pdf_filename;
    const sel = $("track");
    if (!sel.options.length) {
      for (const [key, name] of Object.entries(h.tracks)) {
        const o = document.createElement("option");
        o.value = key; o.textContent = name;
        sel.appendChild(o);
      }
    }
  } catch {
    $("server-dot").classList.remove("ok");
    $("server-label").textContent = "offline";
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function suggestTrack(job) {
  const t = ((job.title || "") + " " + (job.description || "")).toLowerCase();
  const scores = {
    da: ["analyst", "analytics", "tableau", "power bi", "dashboards", "excel", "reporting"],
    ds: ["data scientist", "machine learning", "ml ", "model", "deep learning", "statistic"],
    research: ["research", "phd", "publication", "lab ", "scientist i"],
    swe: ["software engineer", "backend", "frontend", "full stack", "developer", "swe"],
  };
  let best = "ds", bestScore = 0;
  for (const [track, words] of Object.entries(scores)) {
    const s = words.reduce((n, w) => n + (t.split(w).length - 1), 0);
    if (s > bestScore) { best = track; bestScore = s; }
  }
  return { track: best, confident: bestScore > 1 };
}

async function detectJob() {
  const tab = await getActiveTab();
  state.tab = tab?.id;
  if (!tab?.id) return show("nosite");
  try {
    const job = await chrome.tabs.sendMessage(tab.id, { action: "get_job" });
    if (!job?.supported) return show("nosite");
    state.job = job;
    $("job-title").textContent = job.title || "(title not detected)";
    $("job-company").textContent = job.company || "";
    $("job-ats").textContent = job.ats;
    const s = suggestTrack(job);
    if (state.tracks[s.track]) $("track").value = s.track;
    $("track-hint").textContent = s.confident
      ? `Suggested ${state.tracks[s.track] || s.track} based on the posting.`
      : "Could not infer the track from the posting, pick one.";
    show("job");
  } catch {
    show("nosite");
  }
}

// ---------- path one: tailor with Claude ----------

$("apply").addEventListener("click", async () => {
  state.source = "claude";
  $("stage-resume-label").textContent = "Resume";
  show("busy");
  $("busy-text").textContent =
    "Claude is reading the posting and tailoring your resume. This usually takes a minute.";
  try {
    const out = await api("/tailor", {
      job: {
        title: state.job.title, company: state.job.company,
        url: state.job.url, ats: state.job.ats,
        description: state.job.description,
      },
      track: $("track").value,
    });
    enterReview(out);
  } catch (e) { show("job"); fail(e); }
});

// ---------- path two: use an existing PDF ----------

$("upload-btn").addEventListener("click", () => $("upload-input").click());
$("upload-input").addEventListener("change", (e) => {
  if (e.target.files?.[0]) handlePdf(e.target.files[0]);
  e.target.value = "";
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!$("view-job").classList.contains("hidden")) document.body.classList.add("dropping");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dropping");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dropping");
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type === "application/pdf" &&
      !$("view-job").classList.contains("hidden")) {
    handlePdf(file);
  }
});

async function handlePdf(file) {
  state.source = "pdf";
  $("stage-resume-label").textContent = "PDF";
  show("busy");
  $("busy-text").textContent = "Reading your PDF…";
  try {
    const form = new FormData();
    form.append("resume", file, file.name);
    form.append("title", state.job?.title || "");
    form.append("company", state.job?.company || "");
    form.append("url", state.job?.url || "");
    form.append("ats", state.job?.ats || "");
    const resp = await fetch(SERVER + "/upload", { method: "POST", body: form });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    enterReview(await resp.json());
  } catch (e) { show("job"); fail(e); }
}

// ---------- review ----------

function enterReview(out) {
  state.appId = out.app_id;
  state.fields = out.fields;
  state.dirty = false;
  $("review-note").textContent = state.source === "pdf"
    ? "Extracted from your PDF without any AI. Fix anything it missed, then continue."
    : "Everything below comes from the tailored resume. Edits are written back into the LaTeX before the final PDF.";
  const notes = $("claude-notes");
  if (state.source === "claude" && out.notes) {
    notes.innerHTML = "<b>What Claude changed</b>\n";
    notes.appendChild(document.createTextNode(out.notes));
    notes.classList.remove("hidden");
  } else {
    notes.classList.add("hidden");
  }
  renderEditor(out.fields);
  show("review");
}

function inp(label, value, onchange, textarea = false) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.textContent = label;
  const el = document.createElement(textarea ? "textarea" : "input");
  if (!textarea) el.type = "text";
  el.value = value || "";
  el.addEventListener("input", () => { onchange(el.value); state.dirty = true; });
  wrap.appendChild(el);
  return wrap;
}

function section(title, open = false) {
  const d = document.createElement("details");
  if (open) d.open = true;
  const s = document.createElement("summary");
  s.textContent = title;
  const body = document.createElement("div");
  body.className = "body";
  d.append(s, body);
  return [d, body];
}

function bulletsArea(parent, obj) {
  parent.appendChild(inp("Bullets (one per line)", (obj.bullets || []).join("\n"),
    (v) => { obj.bullets = v.split("\n").filter(Boolean); }, true));
}

function renderEditor(f) {
  const root = $("fields-editor");
  root.innerHTML = "";
  f.personal = f.personal || {};

  const [pd, pb] = section("Personal", true);
  const P = f.personal;
  pb.appendChild(inp("First name", P.first_name, (v) => (P.first_name = v)));
  pb.appendChild(inp("Last name", P.last_name, (v) => (P.last_name = v)));
  pb.appendChild(inp("Email", P.email, (v) => (P.email = v)));
  pb.appendChild(inp("Phone", P.phone, (v) => (P.phone = v)));
  pb.appendChild(inp("Location", P.location, (v) => (P.location = v)));
  pb.appendChild(inp("LinkedIn", P.linkedin, (v) => (P.linkedin = v)));
  pb.appendChild(inp("GitHub", P.github, (v) => (P.github = v)));
  root.appendChild(pd);

  if (f.summary !== undefined && state.source === "claude") {
    const [sd, sb] = section("Summary");
    sb.appendChild(inp("Summary", f.summary, (v) => (f.summary = v), true));
    root.appendChild(sd);
  }

  const lists = [
    ["Work experience", f.work_experience, (e) => `${e.role || "?"} at ${e.company || "?"}`,
      (b, e) => {
        b.appendChild(inp("Role", e.role, (v) => (e.role = v)));
        b.appendChild(inp("Company", e.company, (v) => (e.company = v)));
        b.appendChild(inp("Dates", [e.start, e.end].filter(Boolean).join(" to "), (v) => {
          const [s2, e2] = v.split(/\s+to\s+|–|—/);
          e.start = (s2 || "").trim(); e.end = (e2 || "").trim();
        }));
        bulletsArea(b, e);
      }],
    ["Research experience", f.research_experience, (e) => `${e.role || "?"} at ${e.org || "?"}`,
      (b, e) => {
        b.appendChild(inp("Role", e.role, (v) => (e.role = v)));
        b.appendChild(inp("Organization", e.org, (v) => (e.org = v)));
        bulletsArea(b, e);
      }],
    ["Projects", f.projects, (e) => e.name || "?",
      (b, e) => {
        b.appendChild(inp("Name", e.name, (v) => (e.name = v)));
        b.appendChild(inp("Tech", e.tech, (v) => (e.tech = v)));
        bulletsArea(b, e);
      }],
    ["Education", f.education, (e) => e.school || "?",
      (b, e) => {
        b.appendChild(inp("School", e.school, (v) => (e.school = v)));
        b.appendChild(inp("Degree", e.degree, (v) => (e.degree = v)));
        b.appendChild(inp("GPA", e.gpa, (v) => (e.gpa = v)));
      }],
  ];
  for (const [title, arr, head, build] of lists) {
    if (!arr?.length) continue;
    const [d, body] = section(`${title} (${arr.length})`);
    arr.forEach((e) => {
      const box = document.createElement("div");
      box.className = "entry";
      const h = document.createElement("div");
      h.className = "entry-head";
      h.textContent = head(e);
      box.appendChild(h);
      build(box, e);
      body.appendChild(box);
    });
    root.appendChild(d);
  }

  if (f.skills?.length) {
    const [d, body] = section("Skills");
    f.skills.forEach((g) => {
      body.appendChild(inp(g.category || "Skills", (g.items || []).join(", "),
        (v) => (g.items = v.split(",").map((x) => x.trim()).filter(Boolean))));
    });
    root.appendChild(d);
  }
}

$("review-approve").addEventListener("click", async () => {
  if (state.source === "pdf") {
    // No LaTeX to rebuild; just persist the edits for the autofill step.
    try { await api(`/fields/${state.appId}`, state.fields); } catch (e) { return fail(e); }
  } else if (state.dirty) {
    show("busy");
    $("busy-text").textContent = "Applying your edits to the resume…";
    try {
      const out = await api("/revise", { app_id: state.appId, fields: state.fields });
      state.fields = out.fields;
      state.dirty = false;
    } catch (e) { show("review"); return fail(e); }
  }
  enterPdfView();
});

// ---------- pdf approval ----------

async function loadPreview() {
  const box = $("pdf-pages");
  box.innerHTML = '<div class="loading">Rendering preview…</div>';
  try {
    const meta = await api(`/preview/${state.appId}`);
    box.innerHTML = "";
    for (let i = 0; i < meta.pages; i++) {
      const img = document.createElement("img");
      img.src = `${SERVER}/preview/${state.appId}/${i}?t=${Date.now()}`;
      img.alt = `Resume page ${i + 1}`;
      box.appendChild(img);
    }
  } catch (e) {
    box.innerHTML = "";
    fail(e);
  }
}

function enterPdfView() {
  $("pdf-approve").textContent = state.source === "pdf"
    ? "Approve and continue"
    : "Approve and download";
  $("edit-tex").classList.toggle("hidden", state.source === "pdf");
  closeTexEditor();
  loadPreview();
  show("pdf");
}

function closeTexEditor() {
  $("tex-editor").classList.add("hidden");
  $("pdf-pages").classList.remove("hidden");
  $("pdf-actions").classList.remove("hidden");
}

$("edit-tex").addEventListener("click", async () => {
  try {
    const { tex } = await api(`/tex/${state.appId}`);
    $("tex-area").value = tex;
    $("pdf-pages").classList.add("hidden");
    $("pdf-actions").classList.add("hidden");
    $("tex-editor").classList.remove("hidden");
  } catch (e) { fail(e); }
});

$("tex-cancel").addEventListener("click", closeTexEditor);

$("tex-recompile").addEventListener("click", async () => {
  const btn = $("tex-recompile");
  btn.disabled = true;
  btn.textContent = "Compiling…";
  try {
    await api("/retex", { app_id: state.appId, tex: $("tex-area").value });
    closeTexEditor();
    loadPreview();
  } catch (e) { fail(e); }
  btn.disabled = false;
  btn.textContent = "Recompile";
});

$("pdf-back").addEventListener("click", () => { renderEditor(state.fields); show("review"); });

$("pdf-approve").addEventListener("click", async () => {
  if (state.source === "claude") {
    try {
      await chrome.downloads.download({
        url: `${SERVER}/pdf/${state.appId}`,
        filename: state.pdfFilename,
        conflictAction: "uniquify",
      });
    } catch (e) { fail(e); }
  }
  show("fill");
  $("fill-summary").classList.add("hidden");
});

// ---------- autofill ----------

$("fill").addEventListener("click", async () => {
  const { eeoProfile } = await chrome.storage.local.get("eeoProfile");
  $("fill").disabled = true;
  try {
    const res = await chrome.tabs.sendMessage(state.tab, {
      action: "fill",
      payload: {
        fields: state.fields,
        eeo: eeoProfile || {},
        pdfUrl: `${SERVER}/pdf/${state.appId}`,
        pdfFilename: state.pdfFilename,
      },
    });
    if (!res?.ok) throw new Error(res?.error || "Fill failed");
    const okBox = $("fill-ok"), skipBox = $("fill-skip");
    okBox.innerHTML = ""; skipBox.innerHTML = "";
    res.filled.forEach((x) => {
      const d = document.createElement("div"); d.textContent = x; okBox.appendChild(d);
    });
    if (res.skipped.length) {
      const h = document.createElement("div");
      h.className = "head";
      h.textContent = "Still needs you";
      skipBox.appendChild(h);
      res.skipped.slice(0, 15).forEach((x) => {
        const d = document.createElement("div"); d.textContent = x; skipBox.appendChild(d);
      });
    }
    $("fill-summary").classList.remove("hidden");
  } catch (e) { fail(e); }
  $("fill").disabled = false;
});

$("done").addEventListener("click", async () => {
  try { await api("/status", { app_id: state.appId, status: "applied" }); } catch {}
  state.appId = null; state.fields = null; state.source = null;
  $("stage-resume-label").textContent = "Resume";
  detectJob();
});

// ---------- misc ----------

$("recheck").addEventListener("click", detectJob);
$("open-options").addEventListener("click", (e) => {
  e.preventDefault(); chrome.runtime.openOptionsPage();
});
chrome.tabs.onActivated.addListener(() => { if (!state.appId) detectJob(); });

checkServer().then(detectJob);
setInterval(checkServer, 30000);
