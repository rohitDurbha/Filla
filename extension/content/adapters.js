// Per-ATS knowledge: how to recognize the site, scrape the job posting,
// and any selector hints that beat generic label matching.
// scrape() may be async: application-form pages often carry no posting
// text, so adapters fall back to fetching the posting page itself.

const FillaAdapters = (() => {
  const text = (sel, doc = document) => doc.querySelector(sel)?.textContent?.trim() || "";

  function genericDescription(doc = document) {
    const main = doc.querySelector("main") || doc.body;
    return main.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 18000);
  }

  async function fetchDoc(url) {
    const resp = await fetch(url, { credentials: "same-origin" });
    const html = await resp.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  // Ashby embeds the posting as JSON in window.__appData inside a script
  // tag, which survives even on the bare /application route.
  function ashbyAppData(doc = document) {
    for (const s of doc.querySelectorAll("script")) {
      const t = s.textContent || "";
      const i = t.indexOf("window.__appData");
      if (i === -1) continue;
      const start = t.indexOf("{", i);
      const end = t.lastIndexOf("}");
      if (start === -1 || end <= start) continue;
      try { return JSON.parse(t.slice(start, end + 1)); } catch { /* keep looking */ }
    }
    return null;
  }

  function deepFind(obj, keys, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 6) return undefined;
    for (const k of keys) if (typeof obj[k] === "string" && obj[k].length > 2) return obj[k];
    for (const v of Object.values(obj)) {
      const hit = deepFind(v, keys, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  const htmlToText = (html) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.innerText.replace(/\n{3,}/g, "\n\n");
  };

  const adapters = {
    greenhouse: {
      hosts: /(^|\.)greenhouse\.io$/,
      async scrape() {
        return {
          ats: "greenhouse",
          title: text("h1.app-title") || text(".job__title h1") || text("h1"),
          company: text(".company-name") || text(".job__company") ||
                   document.title.split(" at ").pop()?.trim() || "",
          description: text("#content") || text(".job__description") || genericDescription(),
        };
      },
      hints: {
        first_name: ["#first_name"],
        last_name: ["#last_name"],
        email: ["#email"],
        phone: ["#phone"],
        resume: ["#resume", 'input[type="file"][name*="resume" i]'],
      },
    },

    lever: {
      hosts: /(^|\.)lever\.co$/,
      async scrape() {
        let doc = document;
        // The /apply page has the form but not the posting text.
        if (/\/apply\/?$/.test(location.pathname)) {
          try { doc = await fetchDoc(location.href.replace(/\/apply\/?$/, "")); } catch {}
        }
        return {
          ats: "lever",
          title: text(".posting-headline h2", doc) || text("h2", doc),
          company: document.title.split(" - ")[0]?.trim() || "",
          description: text(".content", doc) || genericDescription(doc),
        };
      },
      hints: {
        full_name: ['input[name="name"]'],
        email: ['input[name="email"]'],
        phone: ['input[name="phone"]'],
        location: ['input[name="location"]'],
        company: ['input[name="org"]'],
        linkedin: ['input[name="urls[LinkedIn]"]'],
        github: ['input[name="urls[GitHub]"]', 'input[name="urls[Github]"]'],
        website: ['input[name="urls[Portfolio]"]', 'input[name="urls[Other]"]'],
        resume: ['input[name="resume"]', 'input[type="file"]'],
      },
    },

    ashby: {
      hosts: /(^|\.)ashbyhq\.com$/,
      async scrape() {
        let data = ashbyAppData();
        if (!data && /\/application\/?$/.test(location.pathname)) {
          try {
            const doc = await fetchDoc(location.href.replace(/\/application\/?$/, ""));
            data = ashbyAppData(doc);
          } catch {}
        }
        let title = "", description = "";
        if (data) {
          title = deepFind(data, ["title", "jobTitle"]) || "";
          description = deepFind(data, ["descriptionPlainText"]) || "";
          if (!description) {
            const html = deepFind(data, ["descriptionHtml", "description"]);
            if (html) description = htmlToText(html);
          }
        }
        return {
          ats: "ashby",
          title: title || text("h1"),
          company: document.title.split(" @ ").pop()?.trim() ||
                   location.pathname.split("/")[1] || "",
          description: (description || genericDescription()).slice(0, 18000),
        };
      },
      hints: {
        resume: ['input[type="file"]'],
      },
    },

    smartrecruiters: {
      hosts: /(^|\.)smartrecruiters\.com$/,
      async scrape() {
        return {
          ats: "smartrecruiters",
          title: text("h1.job-title") || text("h1"),
          company: text(".company-name") || document.title.split(" at ").pop()?.trim() || "",
          description: text("#st-jobDescription") || genericDescription(),
        };
      },
      hints: {
        first_name: ['input[name="firstName"]', "#first-name"],
        last_name: ['input[name="lastName"]', "#last-name"],
        email: ['input[name="email"]'],
        phone: ['input[name="phoneNumber"]'],
        resume: ['input[type="file"]'],
      },
    },
  };

  function detect() {
    const host = location.hostname;
    for (const [name, a] of Object.entries(adapters)) {
      if (a.hosts.test(host)) return { name, ...a };
    }
    return null;
  }

  return { detect };
})();
