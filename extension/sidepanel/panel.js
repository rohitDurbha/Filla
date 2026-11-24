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
  score: null,    // {from, to}, kept across refinements
  notes: "",
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

const RUN_VIEWS = ["review", "pdf", "fill"];

function show(view) {
  currentView = view;
  for (const v of views) $("view-" + v).classList.toggle("hidden", v !== view);
  setStage(VIEW_STAGE[view]);
  hideError();
  const ctx = $("run-context");
  if (state.appId && RUN_VIEWS.includes(view) && state.job) {
    ctx.innerHTML = "";
    ctx.append("Applying to ");
    const t = document.createElement("b");
    t.textContent = state.job.title || "this role";
    ctx.append(t, " at ");
    const c = document.createElement("b");
    c.textContent = state.job.company || "this company";
    ctx.append(c);
    ctx.classList.remove("hidden");
  } else {
    ctx.classList.add("hidden");
  }
  if (state.appId && RUN_VIEWS.includes(view)) saveRun();
}

// ---------- the active application survives page loads ----------
// The panel reloads with every navigation (account creation, sign in,
// each step of a multi-page form), so the run lives in extension storage.

const RUN_KEY = "fillaActiveRun";
const RUN_TTL = 3 * 24 * 3600 * 1000;

function saveRun() {
  chrome.storage.local.set({ [RUN_KEY]: {
    appId: state.appId, fields: state.fields, source: state.source,
    score: state.score, notes: state.notes, job: state.job,
    view: RUN_VIEWS.includes(currentView) ? currentView : "review",
    savedAt: Date.now(),
  } });
}

function clearRun() { chrome.storage.local.remove(RUN_KEY); }

const PENDING_KEY = "fillaPendingTailor";

// If the page navigated while Claude was tailoring, the server finished the
// work anyway. Pick the result up by ticket instead of starting over.
async function resumePendingTailor() {
  const { [PENDING_KEY]: p } = await chrome.storage.local.get(PENDING_KEY);
  if (!p || Date.now() - p.startedAt > 20 * 60 * 1000) return false;
  state.job = p.job;
  state.source = "claude";
  state.cancelId = p.ticket;
  state.busyReturn = "job";
  busyCtl = new AbortController();
  $("busy-text").textContent =
    `Still tailoring your resume for ${p.job?.company || "this job"}. It kept going while the page changed.`;
  show("busy");
  for (;;) {
    if (busyCtl.signal.aborted) return true;
    let t;
    try { t = await api(`/ticket/${p.ticket}`); } catch { t = { status: "unknown" }; }
    if (t.status === "done") {
      chrome.storage.local.remove(PENDING_KEY);
      loadLimits();
      enterReview(t.result);
      return true;
    }
    if (t.status !== "running") {
      chrome.storage.local.remove(PENDING_KEY);
      if (t.status === "error") fail(t.detail || "Tailoring failed.");
      return false;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const normCo = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

// Restore when the current page belongs to the same employer: same Workday
// tenant host, or the same company name on shared hosts like Ashby.
async function restoreRun(currentJob) {
  const { [RUN_KEY]: r } = await chrome.storage.local.get(RUN_KEY);
  if (!r || !r.appId || Date.now() - r.savedAt > RUN_TTL) return false;
  const tab = await getTab();
  const host = hostOf(tab?.url);
  const savedHost = hostOf(r.job?.url);
  const sameCompany = currentJob?.company && normCo(currentJob.company) === normCo(r.job?.company);
  const sameTenant = host && host === savedHost && !/^(jobs\.ashbyhq\.com|jobs\.lever\.co|boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.smartrecruiters\.com)$/.test(host);
  const noJobHere = !currentJob?.supported || !currentJob?.title;
  if (!(sameCompany || sameTenant || (noJobHere && host === savedHost))) return false;

  Object.assign(state, {
    appId: r.appId, fields: r.fields, source: r.source,
    score: r.score, notes: r.notes || "", job: r.job,
  });
  $("stage-resume-label").textContent = r.source === "pdf" ? "PDF" : "Resume";
  if (r.view === "review") enterReview({ app_id: r.appId, fields: r.fields, notes: r.notes });
  else if (r.view === "pdf") enterPdfView();
  else enterFill();
  return true;
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
const CONTENT_VERSION = 6;

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
  chrome.storage.local.remove(PENDING_KEY);
  const id = state.cancelId;
  if (id) fetch(SERVER + "/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cancel_id: id }),
  }).catch(() => {});
  if (state.busyReturn === "review") safeRender(state.fields);
  show(state.busyReturn || "job");
});

// ---------- Claude plan usage ----------

function fmtReset(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const soon = d - Date.now() < 22 * 3600 * 1000;
  return soon ? t : d.toLocaleDateString([], { weekday: "short" }) + " " + t;
}

async function loadLimits() {
  try {
    const l = await api("/limits");
    const box = $("limits");
    const msg = $("lim-msg");
    const rows = box.querySelectorAll(".lim");
    if (!l.available) {
      rows.forEach((r) => r.classList.add("hidden"));
      msg.textContent = "Plan usage unavailable. " + (l.reason || "");
      msg.classList.remove("hidden");
      box.classList.remove("hidden");
      return;
    }
    rows.forEach((r) => r.classList.remove("hidden"));
    msg.classList.add("hidden");
    box.classList.toggle("stale", !!l.stale);
    const put = (w, barId, txtId) => {
      const bar = $(barId), txt = $(txtId);
      if (!w) { bar.style.width = "0%"; txt.textContent = ""; return; }
      bar.style.width = Math.min(100, w.pct) + "%";
      bar.className = w.pct >= 90 ? "full" : w.pct >= 75 ? "warn" : "";
      const reset = fmtReset(w.resets_at);
      txt.textContent = Math.round(w.pct) + "%" + (reset ? " · " + reset : "");
    };
    put(l.five_hour, "lim5", "lim5t");
    put(l.seven_day, "lim7", "lim7t");
    $("limits").classList.remove("hidden");
  } catch {
    $("limits").classList.add("hidden");
  }
}

// ---------- startup ----------

async function checkServer() {
  try {
    const h = await api("/health");
    $("server-dot").classList.add("ok");
    $("server-label").textContent = h.tectonic ? "ready" : "no tectonic";
    $("setup-banner").classList.toggle("hidden", h.configured !== false);
    state.tracks = h.tracks;
    state.pdfFilename = h.pdf_filename;
    const sel = $("track");
    if (sel.options.length !== Object.keys(h.tracks).length) sel.innerHTML = "";
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

async function detectJob(allowRestore = false) {
  try {
    const job = await sendToTab({ action: "get_job" }).catch(() => null);
    if (allowRestore && await resumePendingTailor()) return;
    if (allowRestore && await restoreRun(job)) return;
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
  state.dirty = false; state.zoom = 1; state.score = null; state.notes = "";
  clearRun();
  $("stage-resume-label").textContent = "Resume";
  detectJob();
}

// ---------- path one: tailor with Claude ----------

$("apply").addEventListener("click", async () => {
  state.source = "claude";
  state.score = null;
  $("stage-resume-label").textContent = "Resume";
  const signal = startBusy("job",
    "Claude is reading the posting and tailoring your resume. This usually takes a minute.");
  chrome.storage.local.set({ [PENDING_KEY]: {
    ticket: state.cancelId, job: state.job, startedAt: Date.now() } });
  try {
    const out = await api("/tailor", {
      job: {
        title: state.job.title, company: state.job.company,
        url: state.job.url, ats: state.job.ats,
        description: state.job.description,
      },
      track: $("track").value,
      cancel_id: state.cancelId,
      model: $("model").value,
    }, signal);
    chrome.storage.local.remove(PENDING_KEY);
    loadLimits();
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
    chrome.storage.local.remove(PENDING_KEY);
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
    const out = await resp.json();
    if (out.recognized) {
      // A resume Filla built earlier: reopen its run, exact fields intact.
      state.source = out.source;
      $("stage-resume-label").textContent = out.source === "pdf" ? "PDF" : "Resume";
    }
    enterReview(out);
    if (out.recognized) {
      $("review-note").textContent =
        "Recognized this as a resume Filla tailored, so these are its exact fields with nothing re-parsed.";
    }
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
  safeRender(out.fields);
  show("review");
}

function renderNotes(text) {
  state.notes = text;
  const scoreBox = $("notes-score");
  const list = $("claude-notes-list");
  scoreBox.innerHTML = "";
  list.innerHTML = "";

  const m = text.match(/\b(\d{1,3})\s*(?:to|→|->|–)\s*(\d{1,3})\b/) ||
            text.match(/score\D{0,20}?(\d{1,3})\D{1,20}?(\d{1,3})/i);
  // Refinement notes carry no score, so the last known one stays up.
  if (m) state.score = { from: m[1], to: m[2] };
  if (state.score) {
    const label = document.createElement("span");
    label.className = "slabel";
    label.textContent = "Similarity score";
    const nums = document.createElement("span");
    nums.className = "nums";
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = state.score.from;
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = " → ";
    const to = document.createElement("span");
    to.className = "to";
    to.textContent = state.score.to;
    nums.append(from, arrow, to);
    scoreBox.append(label, nums);
  }

  text.split("\n")
    .map((l) => l.replace(/^[-•·*]\s*/, "").replace(/^Score:?\s*\d+\s*(?:to|→|->|–)\s*\d+[.,]?\s*/i, "").trim())
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
      model: $("model").value,
    }, signal);
    $("refine-text").value = "";
    state.fields = out.fields;
    state.dirty = false;
    if (out.notes) renderNotes(out.notes);
    safeRender(out.fields);
    show("review");
    $("claude-notes").open = true;
  } catch (e) {
    if (e.name === "AbortError") return;
    safeRender(state.fields); show("review"); fail(e);
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

const asList = (v) => (Array.isArray(v) ? v : typeof v === "string"
  ? v.split(/\n|,/).map((x) => x.trim()).filter(Boolean) : []);

function bulletsArea(parent, obj) {
  parent.appendChild(inp("Bullets (one per line)", asList(obj.bullets).join("\n"),
    (v) => { obj.bullets = v.split("\n").filter(Boolean); }, true));
}

// A malformed field shape must never strand the panel on a busy screen.
function safeRender(f) {
  try { renderEditor(f || {}); }
  catch (e) {
    $("fields-editor").innerHTML = "";
    // Deferred, since the view switch that follows clears the error box.
    setTimeout(() => fail("Claude returned resume fields Filla could not display, so the editor is empty. " +
      "The PDF is still updated, so continue from the Final step. " + (e.message || e)), 0);
  }
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
    if (!Array.isArray(arr) || !arr.length) continue;
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

  if (Array.isArray(f.skills) && f.skills.length) {
    const [d, body] = section("Skills");
    f.skills.forEach((g) => {
      if (!g || typeof g !== "object") return;
      body.appendChild(inp(g.category || "Skills", asList(g.items).join(", "),
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
        model: $("model").value,
      }, signal);
      state.fields = out.fields;
      state.dirty = false;
    } catch (e) {
      if (e.name === "AbortError") return;
      safeRender(state.fields); show("review"); return fail(e);
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

$("pdf-back").addEventListener("click", () => { safeRender(state.fields); show("review"); });

// Rohit_Durbha_Resume_Method_Financial.pdf, mirroring the server's name.
function downloadName() {
  const base = (state.pdfFilename || "resume.pdf").replace(/\.pdf$/i, "");
  const co = (state.job?.company || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return co ? `${base}_${co}.pdf` : `${base}.pdf`;
}

// The PDF comes down as bytes and is saved from a blob URL. Handing
// chrome.downloads the localhost URL from inside a page-embedded panel
// was not producing PDFs reliably, a blob sidesteps the network entirely.
async function downloadPdf() {
  const resp = await fetch(`${SERVER}/pdf/${state.appId}`);
  if (!resp.ok) throw new Error("Could not load the resume PDF from the server.");
  const blob = new Blob([await resp.arrayBuffer()], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const name = downloadName();
  try {
    await chrome.downloads.download({ url, filename: name, conflictAction: "uniquify", saveAs: false });
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}

function enterFill() {
  show("fill");
  $("fill-ok").innerHTML = "";
  $("fill-check").innerHTML = "";
  $("fill-skip").innerHTML = "";
  $("fill-summary").classList.add("hidden");
}

$("pdf-approve").addEventListener("click", async () => {
  const note = $("saved-as");
  note.classList.add("hidden");
  if (state.source === "claude") {
    try {
      const name = await downloadPdf();
      note.textContent = `Saved to your Downloads as ${name}`;
      note.classList.remove("hidden");
    } catch (e) { fail(e); }
  }
  enterFill();
});

// ---------- autofill, with a live follow-along feed ----------

const FILL_BUCKETS = {
  filled: { id: "fill-ok", head: null },
  check: { id: "fill-check", head: "Set these, double-check them" },
  skipped: { id: "fill-skip", head: "Still needs you" },
};

chrome.runtime.onMessage.addListener((m) => {
  if (m?.filla !== "fill_progress") return;
  const st = $("fill-status");
  if (m.status === "info") { st.textContent = m.label; st.classList.remove("hidden"); return; }
  if (m.status === "done") { st.textContent = "Done with this page."; return; }
  if (!m.label) return;
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
  const { eeoProfile = {}, personalProfile = {} } =
    await chrome.storage.local.get(["eeoProfile", "personalProfile"]);
  $("fill").disabled = true;
  $("fill-status").classList.add("hidden");
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
        eeo: eeoProfile,
        personal: personalProfile,
        appId: state.appId,
        job: { company: state.job?.company || "", title: state.job?.title || "" },
        pdfBase64,
        pdfFilename: downloadName(),
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
$("open-setup").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
});
// Re-detect on tab switches only when the flow is idle. Mid-flow views
// (tailoring, review, final, fill) must survive the user tabbing away.
chrome.tabs.onActivated.addListener(() => {
  if (currentView === "nosite" || currentView === "job") detectJob();
});

// remember the model choice across sessions
chrome.storage.local.get("fillaModel").then(({ fillaModel }) => {
  if (fillaModel !== undefined) $("model").value = fillaModel;
});
$("model").addEventListener("change", () => {
  chrome.storage.local.set({ fillaModel: $("model").value });
});

checkServer().then(() => detectJob(true));
loadLimits();
setInterval(checkServer, 30000);
setInterval(loadLimits, 300000);
