// Profile page: personal answers, EEO answers, and resume tracks.

const form = document.getElementById("profile-form");
renderProfileForm(form);
loadProfileInto(form);

document.getElementById("save").addEventListener("click", async () => {
  await saveProfileFrom(form);
  // Cached form answers were derived from the old profile.
  fetch("http://localhost:8765/answers/forget", { method: "POST" }).catch(() => {});
  const saved = document.getElementById("saved");
  saved.classList.add("on");
  setTimeout(() => saved.classList.remove("on"), 2200);
});

// ---------- resume tracks (post-setup additions) ----------

const SERVER = "http://localhost:8765";

async function loadTracks() {
  const list = document.getElementById("track-list");
  try {
    const h = await (await fetch(SERVER + "/health")).json();
    const names = Object.values(h.tracks || {});
    list.textContent = names.length
      ? "Current tracks: " + names.join(", ")
      : "No tracks yet.";
  } catch {
    list.textContent = "Server offline. Start Filla's server to manage tracks.";
  }
}

document.getElementById("nt-upload").addEventListener("click", () =>
  document.getElementById("nt-file").click());
document.getElementById("nt-file").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  document.getElementById("nt-tex").value = await f.text();
  const name = document.getElementById("nt-name");
  if (!name.value) name.value = f.name.replace(/\.tex$/i, "").replace(/[_-]+/g, " ");
  e.target.value = "";
});

document.getElementById("nt-add").addEventListener("click", async () => {
  const msg = document.getElementById("nt-msg");
  msg.style.color = "var(--muted)";
  msg.textContent = "Adding…";
  try {
    const resp = await fetch(SERVER + "/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("nt-name").value,
        tex: document.getElementById("nt-tex").value,
      }),
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    document.getElementById("nt-name").value = "";
    document.getElementById("nt-tex").value = "";
    msg.style.color = "var(--ok)";
    msg.textContent = "Added";
    setTimeout(() => (msg.textContent = ""), 2500);
    loadTracks();
  } catch (e) {
    msg.style.color = "#C25B6B";
    msg.textContent = String(e.message || e);
  }
});

loadTracks();
