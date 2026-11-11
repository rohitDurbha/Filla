const KEYS = [
  "gender", "hispanic_latino", "race", "veteran",
  "disability", "work_authorized", "requires_sponsorship",
];

async function load() {
  const { eeoProfile } = await chrome.storage.local.get("eeoProfile");
  if (!eeoProfile) return;
  for (const k of KEYS) {
    if (eeoProfile[k]) document.getElementById(k).value = eeoProfile[k];
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const eeoProfile = {};
  for (const k of KEYS) {
    const v = document.getElementById(k).value;
    if (v) eeoProfile[k] = v;
  }
  await chrome.storage.local.set({ eeoProfile });
  const saved = document.getElementById("saved");
  saved.textContent = "Saved";
  setTimeout(() => (saved.textContent = ""), 2000);
});

load();
