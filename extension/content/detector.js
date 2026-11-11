// Filla content-script entry point. Answers the side panel's messages.

(() => {
  const adapter = FillaAdapters.detect();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "get_job") {
      if (!adapter) {
        sendResponse({ supported: false });
        return;
      }
      let job;
      try {
        job = adapter.scrape();
      } catch (e) {
        job = { ats: adapter.name, title: "", company: "", description: document.body.innerText.slice(0, 18000) };
      }
      job.url = location.href;
      job.supported = true;
      sendResponse(job);
      return;
    }

    if (msg.action === "fill") {
      FillaFill.run({ ...msg.payload, hints: adapter?.hints || {} })
        .then((summary) => sendResponse({ ok: true, ...summary }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // keep the message channel open for the async response
    }
  });
})();
