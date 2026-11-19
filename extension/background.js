// Filla background service worker.
// Opens the side panel when the toolbar icon is clicked.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("Filla sidePanel setup failed", e));

// First install opens the guided setup wizard.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") });
  }
});

// Bridge from content scripts to the local server. A content script's own
// fetch runs with the page's origin and cannot reach localhost, while this
// worker holds the extension's host permission.
const SERVER = "http://localhost:8765";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.filla !== "answer") return;
  fetch(SERVER + "/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload || {}),
  })
    .then(async (r) => {
      const body = await r.json().catch(() => ({}));
      sendResponse(r.ok ? body : { error: body.detail || r.statusText });
    })
    .catch((e) => sendResponse({ error: String(e) }));
  return true; // async response
});
