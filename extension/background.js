// Filla background service worker.
// Opens the side panel when the toolbar icon is clicked.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("Filla sidePanel setup failed", e));

// First-install nudge to set up the one-time profile (EEO answers etc.)
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const { eeoProfile } = await chrome.storage.local.get("eeoProfile");
    if (!eeoProfile) chrome.runtime.openOptionsPage();
  }
});
