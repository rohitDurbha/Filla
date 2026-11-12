// Filla panel state machine.
// job -> (tailor with Claude | use own PDF) -> review -> final PDF -> fill

// localhost, not 127.0.0.1: Chrome exempts the localhost name from mixed
// content checks but flags bare IP literals, which spammed the errors page.
const SERVER = "http://localhost:8765";

const state = {
  job: null,
  tracks: {},
  pdfFilename: "resume.pdf",
  appId: null,
  fields: null,
  dirty: false,
  source: null,   // "claude" | "pdf"
  zoom: 1,
  cancelId: null,
  busyReturn: "job",
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

let currentView = "nosite";

function show(view) {
  currentView = view;
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

async function api(path, body, signal) {
  const resp = await fetch(SERVER + path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  } : { signal });
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return resp.json();
}

// ---------- talking to the page ----------

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const CONTENT_FILES = ["content/adapters.js", "content/autofill.js", "content/detector.js"];
const CONTENT_VERSION = 3;

// Self-heal: after an extension reload, pages keep orphaned or outdated
// content scripts. On a dead connection or an old version, inject the
// current bundle (its generation guard silences stale copies) and retry.
async function sendToTab(message) {
  const tab = await getTab();
  if (!tab?.id) throw new Error("No active tab.");
  let needsInject = false;
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { action: "ping" });
    if ((pong?.v || 0) < CONTENT_VERSION) needsInject = true;
  } catch {
    needsInject = true;
  }
  if (needsInject) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
  }
  return await chrome.tabs.sendMessage(tab.id, message);
}

// ---------- cancellable busy state ----------

let busyCtl = null;

function startBusy(returnView, text) {
  state.cancelId = crypto.randomUUID();
  state.busyReturn = returnView;
  busyCtl = new AbortController();
  $("busy-text").textContent = text;
  show("busy");
  return busyCtl.signal;
}

$("busy-cancel").addEventListener("click", () => {
  busyCtl?.abort();
  const id = state.cancelId;
  if (id) fetch(SERVER + "/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cancel_id: id }),
  }).catch(() => {});
  if (state.busyReturn === "review") renderEditor(state.fields);
  show(state.busyReturn || "job");
});

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
  try {
    const job = await sendToTab({ action: "get_job" });
    if (!job?.supported) return show("nosite");
    state.job = job;
    $("job-title").textContent = job.title || "(title not detected)";
    $("job-company").textContent = job.company || "";
    $("job-ats").textContent = job.ats;
    $("jd-warn").classList.toggle("hidden", (job.description || "").length >= 400);
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

function resetFlow() {
  state.appId = null; state.fields = null; state.source = null;
  state.dirty = false; state.zoom = 1;
  $("stage-resume-label").textContent = "Resume";
  detectJob();
}

// ---------- path one: tailor with Claude ----------

$("apply").addEventListener("click", async () => {
  state.source = "claude";
  $("stage-resume-label").textContent = "Resume";
  const signal = startBusy("job",
    "Claude is reading the posting and tailoring your resume. This usually takes a minute.");
  try {
    const out = await api("/tailor", {
      job: {
        title: state.job.title, company: state.job.company,
        url: state.job.url, ats: state.job.ats,
        description: state.job.description,
      },
      track: $("track").value,
      cancel_id: state.cancelId,
    }, signal);
    if (document.hidden) {
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "Resume ready",
          message: `Your tailored resume for ${state.job.company || "this job"} is ready to review.`,
        });
      } catch {}
    }
    enterReview(out);
  } catch (e) {
    if (e.name === "AbortError") return;
    show("job"); fail(e);
  }
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
  const signal = startBusy("job", "Reading your PDF…");
  try {
    const form = new FormData();
    form.append("resume", file, file.name);
    form.append("title", state.job?.title || "");
    form.append("company", state.job?.company || "");
    form.append("url", state.job?.url || "");
    form.append("ats", state.job?.ats || "");
    const resp = await fetch(SERVER + "/upload", { method: "POST", body: form, signal });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    enterReview(await resp.json());
  } catch (e) {
    if (e.name === "AbortError") return;
    show("job"); fail(e);
  }
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
  const refine = $("refine-box");
  if (state.source === "claude") {
    refine.classList.remove("hidden");
    refine.open = false;
  } else {
    refine.classList.add("hidden");
  }
  if (state.source === "claude" && out.notes) {
    renderNotes(out.notes);
    notes.classList.remove("hidden");
    notes.open = false;
  } else {
    notes.classList.add("hidden");
  }
  renderEditor(out.fields);
  show("review");
}

function renderNotes(text) {
  const scoreBox = $("notes-score");
  const list = $("claude-notes-list");
  scoreBox.innerHTML = "";
  list.innerHTML = "";

  const m = text.match(/\b(\d{1,3})\s*(?:to|→|->)\s*(\d{1,3})\b/);
  if (m) {
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = m[1];
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = " → ";
    const to = document.createElement("span");
    to.className = "to";
    to.textContent = m[2];
    scoreBox.append(from, arrow, to);
  }

  text.split("\n")
    .map((l) => l.replace(/^[-•·*]\s*/, "").replace(/^Score\s+\d+\s*(?:to|→|->)\s*\d+[.,]?\s*/i, "").trim())
    .filter(Boolean)
    .forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    });
}

$("review-restart").addEventListener("click", resetFlow);
$("fill-restart").addEventListener("click", resetFlow);

$("refine-go").addEventListener("click", async () => {
  const instruction = $("refine-text").value.trim();
  if (!instruction) return;
  const signal = startBusy("review", "Claude is applying your refinements…");
  try {
    const out = await api("/refine", {
      app_id: state.appId, instruction, cancel_id: state.cancelId,
    }, signal);
    $("refine-text").value = "";
    state.fields = out.fields;
    state.dirty = false;
    if (out.notes) renderNotes(out.notes);
    renderEditor(out.fields);
    show("review");
    $("claude-notes").open = true;
  } catch (e) {
    if (e.name === "AbortError") return;
    renderEditor(state.fields); show("review"); fail(e);
  }
});

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
  d.className = "sec";
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

  if (f.summary !== undefined) {
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
    ["Research experience", f.research_experience, (e) => `${e.role || "?"}`,
      (b, e) => {
        b.appendChild(inp("Title or role", e.role, (v) => (e.role = v)));
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
    try { await api(`/fields/${state.appId}`, state.fields); } catch (e) { return fail(e); }
  } else if (state.dirty) {
    const signal = startBusy("review", "Applying your edits to the resume…");
    try {
      const out = await api("/revise", {
        app_id: state.appId, fields: state.fields, cancel_id: state.cancelId,
      }, signal);
      state.fields = out.fields;
      state.dirty = false;
    } catch (e) {
      if (e.name === "AbortError") return;
      renderEditor(state.fields); show("review"); return fail(e);
    }
  }
  enterPdfView();
});

// ---------- final pdf: preview, zoom, jump-to-source ----------

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
      img.dataset.page = i;
      box.appendChild(img);
    }
  } catch (e) {
    box.innerHTML = "";
    fail(e);
  }
}

function applyZoom() {
  $("pdf-pages").style.setProperty("--zoom", state.zoom);
  $("zoom-level").textContent = Math.round(state.zoom * 100) + "%";
}
$("zoom-in").addEventListener("click", () => { state.zoom = Math.min(2.5, state.zoom + 0.25); applyZoom(); });
$("zoom-out").addEventListener("click", () => { state.zoom = Math.max(0.5, state.zoom - 0.25); applyZoom(); });

function enterPdfView() {
  $("pdf-approve").textContent = state.source === "pdf"
    ? "Approve and continue"
    : "Approve and download";
  const noTex = state.source === "pdf";
  $("edit-tex").classList.toggle("hidden", noTex);
  $("jump-hint").classList.toggle("hidden", noTex);
  closeTexEditor();
  applyZoom();
  loadPreview();
  show("pdf");
}

function closeTexEditor() {
  $("tex-editor").classList.add("hidden");
  $("pdf-pages").classList.remove("hidden");
  $("pdf-actions").classList.remove("hidden");
}

async function openTexEditor(cursorIndex = null, cursorLength = 0) {
  try {
    const { tex } = await api(`/tex/${state.appId}`);
    const ta = $("tex-area");
    ta.value = tex;
    $("pdf-pages").classList.add("hidden");
    $("pdf-actions").classList.add("hidden");
    $("tex-editor").classList.remove("hidden");
    if (cursorIndex !== null) {
      ta.focus();
      ta.setSelectionRange(cursorIndex, cursorIndex + cursorLength);
      const line = tex.slice(0, cursorIndex).split("\n").length;
      ta.scrollTop = Math.max(0, (line - 6) * 16.5);
    }
  } catch (e) { fail(e); }
}

$("edit-tex").addEventListener("click", () => openTexEditor());
$("tex-cancel").addEventListener("click", closeTexEditor);

// Overleaf-style jump: double-click the preview, land in the LaTeX.
$("pdf-pages").addEventListener("dblclick", async (e) => {
  const img = e.target.closest("img");
  if (!img || state.source === "pdf") return;
  const rect = img.getBoundingClientRect();
  try {
    const hit = await api("/locate", {
      app_id: state.appId,
      page: Number(img.dataset.page || 0),
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
    openTexEditor(hit.index, hit.length);
  } catch (err) { fail(err); }
});

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
  $("fill-ok").innerHTML = "";
  $("fill-check").innerHTML = "";
  $("fill-skip").innerHTML = "";
  $("fill-summary").classList.add("hidden");
});

// ---------- autofill, with a live follow-along feed ----------

const FILL_BUCKETS = {
  filled: { id: "fill-ok", head: null },
  check: { id: "fill-check", head: "Set these, double-check them" },
  skipped: { id: "fill-skip", head: "Still needs you" },
};

chrome.runtime.onMessage.addListener((m) => {
  if (m?.filla !== "fill_progress" || m.status === "done" || !m.label) return;
  const bucket = FILL_BUCKETS[m.status] || FILL_BUCKETS.skipped;
  const box = $(bucket.id);
  if (bucket.head && !box.querySelector(".head")) {
    const h = document.createElement("div");
    h.className = "head";
    h.textContent = bucket.head;
    box.appendChild(h);
  }
  if ([...box.children].some((c) => c.textContent === m.label)) return;
  const d = document.createElement("div");
  d.textContent = m.label;
  box.appendChild(d);
  $("fill-summary").classList.remove("hidden");
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

$("fill").addEventListener("click", async () => {
  const { eeoProfile } = await chrome.storage.local.get("eeoProfile");
  $("fill").disabled = true;
  $("fill-ok").innerHTML = "";
  $("fill-check").innerHTML = "";
  $("fill-skip").innerHTML = "";
  try {
    // The panel fetches the PDF (its origin is allowed by the server) and
    // hands the bytes over, since content scripts cannot cross-origin fetch.
    const resp = await fetch(`${SERVER}/pdf/${state.appId}`);
    if (!resp.ok) throw new Error("Could not load the resume PDF from the server.");
    const pdfBase64 = await blobToBase64(await resp.blob());
    const res = await sendToTab({
      action: "fill",
      payload: {
        fields: state.fields,
        eeo: eeoProfile || {},
        pdfBase64,
        pdfFilename: state.pdfFilename,
      },
    });
    if (!res?.ok) throw new Error(res?.error || "Fill failed");
  } catch (e) { fail(e); }
  $("fill").disabled = false;
});

$("done").addEventListener("click", async () => {
  try { await api("/status", { app_id: state.appId, status: "applied" }); } catch {}
  resetFlow();
});

// ---------- misc ----------

$("recheck").addEventListener("click", detectJob);
$("open-options").addEventListener("click", (e) => {
  e.preventDefault(); chrome.runtime.openOptionsPage();
});
$("open-tracker").addEventListener("click", (e) => {
  e.preventDefault(); chrome.tabs.create({ url: SERVER + "/tracker" });
});
// Re-detect on tab switches only when the flow is idle. Mid-flow views
// (tailoring, review, final, fill) must survive the user tabbing away.
chrome.tabs.onActivated.addListener(() => {
  if (currentView === "nosite" || currentView === "job") detectJob();
});

checkServer().then(detectJob);
setInterval(checkServer, 30000);
