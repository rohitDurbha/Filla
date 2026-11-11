// Filla side panel state machine.
// idle -> job -> busy -> review -> pdf -> fill -> done

const SERVER = "http://127.0.0.1:8765";

const state = {
  tab: null,          // active tab id
  job: null,          // scraped job info
  tracks: {},         // from server /health
  pdfFilename: "resume.pdf",
  appId: null,
  fields: null,
  dirty: false,       // user edited fields since last compile
};

const $ = (id) => document.getElementById(id);
const views = ["nosite", "job", "busy", "review", "pdf", "fill"];

function show(view) {
  for (const v of views) $("view-" + v).classList.toggle("hidden", v !== view);
  $("error").textContent = "";
}

function fail(msg) {
  console.error(msg);
  $("error").textContent = String(msg).slice(0, 160);
}

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
    $("server-dot").title = h.tectonic ? "Server online" : "Server online, but Tectonic is missing";
    state.tracks = h.tracks;
    state.pdfFilename = h.pdf_filename;
    const sel = $("track");
    sel.innerHTML = "";
    for (const [key, name] of Object.entries(h.tracks)) {
      const o = document.createElement("option");
      o.value = key; o.textContent = name;
      sel.appendChild(o);
    }
  } catch {
    $("server-dot").classList.remove("ok");
    $("server-dot").title = "Filla server is not running (python server/app.py)";
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
    show("nosite"); // content script not present on this page
  }
}

// ---------- tailoring ----------

$("apply").addEventListener("click", async () => {
  show("busy");
  $("busy-text").textContent = "Claude is reading the posting and tailoring your resume… this usually takes a minute.";
  try {
    const out = await api("/tailor", { job: {
      title: state.job.title, company: state.job.company,
      url: state.job.url, ats: state.job.ats,
      description: state.job.description,
    }, track: $("track").value });
    state.appId = out.app_id;
    state.fields = out.fields;
    state.dirty = false;
    renderEditor(out.fields);
    show("review");
  } catch (e) { show("job"); fail(e); }
});

// ---------- fields editor ----------

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

  if (f.summary !== undefined) {
    const [sd, sb] = section("Summary");
    sb.appendChild(inp("Summary", f.summary, (v) => (f.summary = v), true));
    root.appendChild(sd);
  }

  const lists = [
    ["Work experience", f.work_experience, (e) => `${e.role || "?"} @ ${e.company || "?"}`,
      (b, e) => {
        b.appendChild(inp("Role", e.role, (v) => (e.role = v)));
        b.appendChild(inp("Company", e.company, (v) => (e.company = v)));
        b.appendChild(inp("Dates", [e.start, e.end].filter(Boolean).join(" to "), (v) => {
          const [s2, e2] = v.split(/\s+to\s+|–|—/); e.start = (s2 || "").trim(); e.end = (e2 || "").trim();
        }));
        bulletsArea(b, e);
      }],
    ["Research experience", f.research_experience, (e) => `${e.role || "?"} @ ${e.org || "?"}`,
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
      h.style.fontWeight = "600";
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
  if (state.dirty) {
    show("busy");
    $("busy-text").textContent = "Applying your edits to the resume…";
    try {
      const out = await api("/revise", { app_id: state.appId, fields: state.fields });
      state.fields = out.fields;
      state.dirty = false;
    } catch (e) { show("review"); return fail(e); }
  }
  $("pdf-frame").src = `${SERVER}/pdf/${state.appId}#toolbar=0&t=${Date.now()}`;
  show("pdf");
});

// ---------- pdf approval ----------

$("pdf-back").addEventListener("click", () => { renderEditor(state.fields); show("review"); });

$("pdf-approve").addEventListener("click", async () => {
  try {
    await chrome.downloads.download({
      url: `${SERVER}/pdf/${state.appId}`,
      filename: state.pdfFilename,
      conflictAction: "uniquify",
    });
  } catch (e) { fail(e); }
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
    res.filled.forEach((x) => { const d = document.createElement("div"); d.textContent = x; okBox.appendChild(d); });
    if (res.skipped.length) {
      const h = document.createElement("div");
      h.className = "head";
      h.textContent = "Needs you:";
      skipBox.appendChild(h);
      res.skipped.slice(0, 15).forEach((x) => { const d = document.createElement("div"); d.textContent = x; skipBox.appendChild(d); });
    }
    $("fill-summary").classList.remove("hidden");
  } catch (e) { fail(e); }
  $("fill").disabled = false;
});

$("done").addEventListener("click", async () => {
  try { await api("/status", { app_id: state.appId, status: "applied" }); } catch {}
  state.appId = null; state.fields = null;
  detectJob();
});

// ---------- misc ----------

$("recheck").addEventListener("click", detectJob);
$("open-options").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
chrome.tabs.onActivated.addListener(() => { if (!state.appId) detectJob(); });

checkServer().then(detectJob);
setInterval(checkServer, 30000);
