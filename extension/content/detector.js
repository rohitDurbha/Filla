// Filla content-script entry point. Answers the panel's messages.

(() => {
  const adapter = FillaAdapters.detect();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "ping") {
      sendResponse({ pong: true });
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
