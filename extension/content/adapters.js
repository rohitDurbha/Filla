// Per-ATS knowledge: how to recognize the site, scrape the job posting,
// and any selector hints that beat generic label matching.
// scrape() may be async: application-form pages often carry no posting
// text, so adapters fall back to fetching the posting page itself.

const FillaAdapters = (() => {
  // innerText keeps line breaks between blocks, textContent glued words
  // across them ("andMachine Learning").
  const text = (sel, doc = document) => {
    const el = doc.querySelector(sel);
    return el ? (el.innerText || el.textContent || "").trim() : "";
  };

  function genericDescription(doc = document) {
    const main = doc.querySelector("main") || doc.body;
    return main.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 18000);
  }

  async function fetchDoc(url) {
    const resp = await fetch(url, { credentials: "same-origin" });
    const html = await resp.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  // Extract a balanced JSON object starting at text[start], respecting
  // strings. lastIndexOf('}') is wrong when code follows the object.
  function balancedJson(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (inStr) { if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  // Ashby embeds the posting as JSON in window.__appData inside a script
  // tag, which survives even on the bare /application route.
  function ashbyAppData(doc = document) {
    for (const s of doc.querySelectorAll("script")) {
      const t = s.textContent || "";
      const i = t.indexOf("window.__appData");
      if (i === -1) continue;
      const start = t.indexOf("{", i);
      if (start === -1) continue;
      const raw = balancedJson(t, start);
      if (!raw) continue;
      try { return JSON.parse(raw); } catch { /* keep looking */ }
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

  // https://acme.wd5.myworkdayjobs.com/en-US/External/job/Dallas-TX/Analyst_R1/apply
  //   -> https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Dallas-TX/Analyst_R1
  // https://wd5.myworkdaysite.com/recruiting/acme/External/job/X/Y_R1
  //   -> https://wd5.myworkdaysite.com/wday/cxs/acme/External/job/X/Y_R1
  function workdayCxsUrl(loc) {
    let segs = loc.pathname.split("/").filter(Boolean);
    let tenant = loc.hostname.split(".")[0];
    if (segs[0] === "recruiting") { tenant = segs[1]; segs = segs.slice(2); }
    if (/^[a-z]{2}-[A-Z]{2}$/.test(segs[0] || "")) segs = segs.slice(1);
    const site = segs[0];
    const j = segs.indexOf("job");
    if (!site || j < 1) return null;
    const rest = segs.slice(j);
    const cut = rest.findIndex((s, i) => i > 0 && /^apply/i.test(s));
    const jobPath = (cut > -1 ? rest.slice(0, cut) : rest).join("/");
    if (jobPath.split("/").length < 2) return null;
    return `${loc.origin}/wday/cxs/${tenant}/${site}/${jobPath}`;
  }

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
        resume: ['input[name="resume"]'],
      },
    },

    ashby: {
      hosts: /(^|\.)ashbyhq\.com$/,
      async scrape() {
        const onApply = /\/application\/?$/.test(location.pathname);
        let data = ashbyAppData();
        let overview = null;
        if (!data && onApply) {
          try {
            overview = await fetchDoc(location.href.replace(/\/application\/?$/, ""));
            data = ashbyAppData(overview);
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
        // The application route's own DOM is just the form, so when the
        // JSON route fails, the fetched overview page's text is the JD.
        if (!description && onApply) {
          if (!overview) {
            try { overview = await fetchDoc(location.href.replace(/\/application\/?$/, "")); } catch {}
          }
          if (overview) {
            title = title || text("h1", overview);
            description = genericDescription(overview);
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
      hints: {},
    },

    smartrecruiters: {
      hosts: /(^|\.)smartrecruiters\.com$/,
      async scrape() {
        let doc = document;
        let description = text("#st-jobDescription", doc);
        // Apply routes carry the form, not the posting text.
        if (!description && /\/apply\/?$/.test(location.pathname)) {
          try {
            doc = await fetchDoc(location.href.replace(/\/apply\/?$/, ""));
            description = text("#st-jobDescription", doc);
          } catch {}
        }
        return {
          ats: "smartrecruiters",
          title: text("h1.job-title", doc) || text("h1", doc) || text("h1"),
          company: text(".company-name", doc) || document.title.split(" at ").pop()?.trim() || "",
          description: description || genericDescription(doc),
        };
      },
      hints: {
        first_name: ['input[name="firstName"]', "#first-name"],
        last_name: ['input[name="lastName"]', "#last-name"],
        email: ['input[name="email"]'],
        phone: ['input[name="phoneNumber"]'],
      },
    },

    workday: {
      hosts: /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/,
      async scrape() {
        // Every Workday page, including sign in and account creation inside
        // the apply flow, keeps the job path in its URL. Workday serves the
        // posting as JSON at /wday/cxs/<tenant>/<site>/job/..., same origin.
        let title = "", description = "", company = "";
        const cxs = workdayCxsUrl(location);
        if (cxs) {
          try {
            const r = await fetch(cxs, { credentials: "same-origin",
                                         headers: { Accept: "application/json" } });
            if (r.ok) {
              const data = await r.json();
              const info = data.jobPostingInfo || {};
              title = info.title || "";
              description = info.jobDescription ? htmlToText(info.jobDescription) : "";
              company = data.hiringOrganization?.name || "";
            }
          } catch {}
        }
        const tenant = location.hostname.split(".")[0] || "";
        return {
          ats: "workday",
          title: title || text('[data-automation-id="jobPostingHeader"]') || text("h2") || text("h1"),
          company: company || tenant,
          description: (description || text('[data-automation-id="jobPostingDescription"]') ||
                        genericDescription()).slice(0, 18000),
        };
      },
      // Workday names fields with data-automation-id in older tenants and
      // with ids like "name--legalName--firstName" in newer ones.
      hints: {
        first_name: ['input[data-automation-id="legalNameSection_firstName"]', 'input[id$="legalName--firstName"]'],
        middle_name: ['input[data-automation-id="legalNameSection_middleName"]', 'input[id$="legalName--middleName"]'],
        last_name: ['input[data-automation-id="legalNameSection_lastName"]', 'input[id$="legalName--lastName"]'],
        email: ['input[data-automation-id="email"]', 'input[id$="--email"]'],
        phone: ['input[data-automation-id="phone-number"]', 'input[id$="phoneNumber--phoneNumber"]'],
        address_line1: ['input[data-automation-id="addressSection_addressLine1"]', 'input[id$="address--addressLine1"]'],
        address_line2: ['input[data-automation-id="addressSection_addressLine2"]', 'input[id$="address--addressLine2"]'],
        city: ['input[data-automation-id="addressSection_city"]', 'input[id$="address--city"]'],
        postal_code: ['input[data-automation-id="addressSection_postalCode"]', 'input[id$="address--postalCode"]'],
        resume: ['input[data-automation-id="file-upload-input-ref"]'],
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
