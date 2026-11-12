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
