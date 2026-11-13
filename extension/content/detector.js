// Filla content-script entry point. Answers the panel's messages.
// A generation guard lets a newer injected copy supersede this one without
// a page reload: stale copies go silent instead of answering first.

(() => {
  const FILLA_CONTENT_VERSION = 4;
  window.__fillaGen = (window.__fillaGen || 0) + 1;
  const MY_GEN = window.__fillaGen;

  const adapter = FillaAdapters.detect();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (window.__fillaGen !== MY_GEN) return; // a newer copy owns this page

    if (msg.action === "ping") {
      sendResponse({ pong: true, v: FILLA_CONTENT_VERSION });
      return;
    }

    if (msg.action === "get_job") {
      if (!adapter) {
        sendResponse({ supported: false });
        return;
      }
      Promise.resolve()
        .then(() => adapter.scrape())
        .catch(() => ({
          ats: adapter.name, title: "", company: "",
          description: document.body.innerText.slice(0, 18000),
        }))
        .then((job) => {
          job.url = location.href;
          job.supported = true;
          sendResponse(job);
        });
      return true; // async response
    }

    if (msg.action === "fill") {
      FillaFill.run({ ...msg.payload, hints: adapter?.hints || {} })
        .then((summary) => sendResponse({ ok: true, ...summary }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  });
})();
