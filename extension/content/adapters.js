// Per-ATS knowledge: how to recognize the site, scrape the job posting,
// and any selector hints that beat generic label matching.
// Everything falls back to the generic label matcher in autofill.js.

const FillaAdapters = (() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() || "";

  function genericDescription() {
    // Claude copes fine with some surrounding noise, so a trimmed body dump
    // is an acceptable fallback when no specific container matches.
    const main = document.querySelector("main") || document.body;
    return main.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 18000);
  }

  const adapters = {
    greenhouse: {
      hosts: /(^|\.)greenhouse\.io$/,
      scrape() {
        return {
          ats: "greenhouse",
          title: text("h1.app-title") || text(".job__title h1") || text("h1"),
          company: text(".company-name") || text(".job__company") ||
                   document.title.split(" at ").pop()?.trim() || "",
          description: text("#content") || text(".job__description") || genericDescription(),
        };
      },
      // Known stable ids on Greenhouse application forms.
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
      scrape() {
        return {
          ats: "lever",
          title: text(".posting-headline h2") || text("h2"),
          company: document.title.split(" - ")[0]?.trim() || "",
          description: text(".content") || genericDescription(),
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
      scrape() {
        return {
          ats: "ashby",
          title: text("h1"),
          company: document.title.split(" @ ").pop()?.trim() ||
                   location.pathname.split("/")[1] || "",
          description: genericDescription(),
        };
      },
      hints: {
        resume: ['input[type="file"]'],
      },
    },

    smartrecruiters: {
      hosts: /(^|\.)smartrecruiters\.com$/,
      scrape() {
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
