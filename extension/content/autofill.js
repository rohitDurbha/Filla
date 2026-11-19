// Filla autofill engine, v3.
//
// Two layers. Widget drivers are code: they know how to operate a native
// select, a radio group, a Workday listbox, a typeahead combobox, a text
// box, and they verify every action before reporting it. The answer layer
// decides what each question should get: the user's profile first, by
// question meaning, and anything left over goes to Claude in one batch per
// page with the exact options on screen. Choices are always made FROM the
// options the form shows, never typed in raw.

const FillaFill = (() => {
  // ================= DOM helpers (shadow-root aware) =================

  function collectRoots() {
    const roots = [document];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  }
  let ROOTS = [document];
  const deepAll = (sel) => ROOTS.flatMap((r) => [...r.querySelectorAll(sel)]);

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[*:]/g, "").trim();
  const words = (s) => (s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[\[\]_\-.]+/g, " ");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function rootOf(el) { return el.getRootNode ? el.getRootNode() : document; }
  function byId(el, id) {
    const root = rootOf(el);
    return (root.getElementById && root.getElementById(id)) || document.getElementById(id);
  }
  function labelFor(el) {
    if (!el.id) return null;
    const q = `label[for="${CSS.escape(el.id)}"]`;
    const root = rootOf(el);
    return (root.querySelector && root.querySelector(q)) || document.querySelector(q);
  }

  // What a human reads as this control's label.
  function labelText(el) {
    const bits = [];
    const l = labelFor(el);
    if (l) bits.push(l.textContent);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) lb.split(/\s+/).forEach((id) => { const n = byId(el, id); if (n) bits.push(n.textContent); });
    if (el.getAttribute("aria-label")) bits.push(el.getAttribute("aria-label"));
    const wrap = el.closest("label");
    if (wrap && wrap !== l) bits.push(wrap.textContent);
    const host = rootOf(el).host;
    if (host) {
      for (const a of ["label", "aria-label"]) if (host.getAttribute(a)) bits.push(host.getAttribute(a));
      const hl = labelFor(host);
      if (hl) bits.push(hl.textContent);
    }
    return bits.join(" | ").replace(/\s+/g, " ").trim();
  }

  // Machine hints: name, id, automation ids, split into words, so
  // "legalNameSection_firstName" reads as "legal name section first name".
  function machineText(el) {
    const host = rootOf(el).host;
    const parts = [el.name, el.id, el.getAttribute("data-automation-id"),
                   host && host.id, host && host.getAttribute("name")];
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const d = p.getAttribute && p.getAttribute("data-automation-id");
      if (d) { parts.push(d); break; }
    }
    return words(parts.filter(Boolean).join(" "));
  }

  // Question text when no label exists: climb the DOM and read what remains
  // once the control's own option labels are removed.
  function findQuestionText(start, optionTexts = []) {
    let node = start.closest("div,fieldset,li,section") || start.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      let t = (node.innerText || node.textContent || "").replace(/\s+/g, " ");
      for (const o of optionTexts) if (o) t = t.split(o).join(" ");
      t = t.replace(/\s+/g, " ").trim();
      if (t.length > 6) return t.slice(0, 400);
      node = node.parentElement;
    }
    return "";
  }

  // Short, human, noise-free name for the progress feed.
  function displayName(q) {
    let s = (q || "").split(/\s\|\s|\n/)[0]
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{3,}\b/gi, "")
      .replace(/system\s*_?field\w*/gi, "")
      .replace(/\b(select one|required|type here)\b\.*/gi, "")
      .replace(/[*]/g, "")
      .replace(/\s+/g, " ").trim();
    if (s.length > 52) s = s.slice(0, 50).trim() + "…";
    return s ? s[0].toUpperCase() + s.slice(1) : "Field";
  }

  const PLACEHOLDER_RE = /^(select|choose|please select|please choose|--|—|select one|select\.\.\.|none selected)\b/i;
  const isPlaceholder = (t) => !norm(t) || PLACEHOLDER_RE.test((t || "").trim());

  // ================= option picking =================

  // First want that matches an option wins. Matching is on whole words so
  // "male" never picks "Female" and "no" never picks "not".
  function pickIndex(optionTexts, wants) {
    const opts = optionTexts.map((t) => norm(t));
    for (const w0 of wants) {
      const w = norm(w0);
      if (!w) continue;
      let i = opts.findIndex((o) => o === w);
      if (i > -1 && !isPlaceholder(optionTexts[i])) return i;
      const re = new RegExp(`(^|[^a-z0-9])${escRe(w)}([^a-z0-9]|$)`);
      i = opts.findIndex((o, k) => !isPlaceholder(optionTexts[k]) && re.test(o));
      if (i > -1) return i;
    }
    return -1;
  }

  // ================= events and drivers =================

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try { el.focus({ preventScroll: true }); } catch {}
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function blur(el) {
    el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  }

  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
      } catch {}
    }
  }

  function key(el, k) {
    for (const t of ["keydown", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(t, { key: k, bubbles: true, composed: true }));
    }
  }

  let styleInjected = false;
  function flash(el) {
    if (!el || !el.classList) return;
    if (!styleInjected) {
      const st = document.createElement("style");
      st.textContent = `.filla-flash{outline:2px solid #99A5F2!important;outline-offset:2px!important;border-radius:6px;transition:outline-color .6s ease}`;
      document.documentElement.appendChild(st);
      styleInjected = true;
    }
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
    el.classList.add("filla-flash");
    setTimeout(() => el.classList.remove("filla-flash"), 1200);
  }

  function visibleOptions() {
    return deepAll('[role="option"], [role="listbox"] li, [data-automation-id="promptOption"]')
      .filter((o) => visible(o) && norm(o.textContent) && !isPlaceholder(o.textContent));
  }

  async function driveText(el, value) {
    flash(el);
    setNativeValue(el, value);
    blur(el);
    await sleep(60);
    return norm(el.value) === norm(value) ? "filled" : (el.value ? "check" : null);
  }

  async function driveSelect(el, wants) {
    const opts = [...el.options];
    const i = pickIndex(opts.map((o) => o.textContent), wants);
    if (i < 0) return null;
    flash(el);
    setNativeValue(el, opts[i].value);
    await sleep(60);
    return el.value === opts[i].value ? "filled" : "check";
  }

  async function clickRadio(input) {
    const targets = [];
    const l = labelFor(input);
    if (l) targets.push(l);
    const wrap = input.closest("label");
    if (wrap && !targets.includes(wrap)) targets.push(wrap);
    targets.push(input);
    for (const t of targets) {
      flash(visible(t) ? t : input.closest("fieldset") || t);
      fireClick(t);
      await sleep(120);
      if (input.checked) return true;
    }
    try {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set.call(input, true);
      input.dispatchEvent(new Event("click", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {}
    await sleep(120);
    return input.checked;
  }

  async function driveRadio(unit, wants) {
    const i = pickIndex(unit.options, wants);
    if (i < 0) return null;
    return (await clickRadio(unit.radios[i])) ? "filled" : "check";
  }

  // Workday style: a button that opens a listbox of options.
  async function openListbox(btn) {
    fireClick(btn);
    await sleep(320);
    return visibleOptions();
  }
  function closeListbox(btn) {
    key(btn, "Escape");
    key(document.activeElement || document.body, "Escape");
  }

  async function readListboxOptions(btn) {
    const opts = await openListbox(btn);
    const texts = opts.map((o) => o.textContent.trim());
    closeListbox(btn);
    await sleep(150);
    return texts;
  }

  async function driveListbox(btn, wants) {
    flash(btn);
    const opts = await openListbox(btn);
    const i = pickIndex(opts.map((o) => o.textContent), wants);
    if (i < 0) { closeListbox(btn); return null; }
    const chosen = opts[i].textContent.trim();
    fireClick(opts[i]);
    await sleep(260);
    return norm(btn.textContent).includes(norm(chosen)) ? "filled" : "check";
  }

  // Typeahead and select-like comboboxes (React Select, SmartRecruiters,
  // Workday prompts). Open, optionally search, then click a real option.
  // Anything typed that does not end in a picked option is cleared, so no
  // raw guess is ever left in the box.
  async function driveCombobox(input, wants, typed) {
    flash(input);
    try { input.focus(); } catch {}
    fireClick(input);
    if (typed) setNativeValue(input, typed);
    else key(input, "ArrowDown");
    await sleep(450);
    let opts = visibleOptions();
    let i = pickIndex(opts.map((o) => o.textContent), wants);
    if (i < 0 && !typed && wants[0]) {
      setNativeValue(input, String(wants[0]).slice(0, 40));
      await sleep(600);
      opts = visibleOptions();
      i = pickIndex(opts.map((o) => o.textContent), wants);
      if (i < 0 && opts.length === 1) i = 0;
    }
    if (i < 0) {
      setNativeValue(input, "");
      key(input, "Escape");
      blur(input);
      return null;
    }
    const chosen = opts[i].textContent.trim();
    fireClick(opts[i]);
    await sleep(260);
    blur(input);
    const shown = norm(input.value) + " " + norm(input.closest("div")?.textContent || "");
    return shown.includes(norm(chosen).slice(0, 24)) ? "filled" : "check";
  }

  // ================= what we know about the candidate =================

  const STATES = {
    al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
    ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
    il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
    me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
    ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
    nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
    nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon",
    pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
    tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
    wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
  };

  const EEO_WANTS = {
    gender: {
      male: ["male", "man"], female: ["female", "woman"],
      nonbinary: ["non-binary", "nonbinary", "non binary"],
      decline: ["decline", "don't wish", "do not wish", "prefer not", "not to disclose"],
    },
    hispanic_latino: {
      yes: ["yes", "hispanic or latino"], no: ["no", "not hispanic"],
      decline: ["decline", "don't wish", "do not wish", "prefer not"],
    },
    race: {
      american_indian: ["american indian", "alaska native"], asian: ["asian"],
      black: ["black", "african american"], hispanic: ["hispanic or latino", "hispanic"],
      pacific_islander: ["native hawaiian", "pacific islander"], white: ["white"],
      two_or_more: ["two or more"],
      decline: ["decline", "don't wish", "do not wish", "prefer not", "not to disclose"],
    },
    veteran: {
      not_protected: ["i am not a protected veteran", "not a protected veteran", "i am not a veteran", "not a veteran", "no"],
      protected: ["identify as one or more", "protected veteran", "yes"],
      decline: ["don't wish", "do not wish", "decline", "prefer not", "not to disclose"],
    },
    disability: {
      yes: ["yes, i have", "yes i have", "yes"],
      no: ["no, i do not", "no, i don't", "no i do not", "no"],
      decline: ["do not want to answer", "don't wish", "do not wish", "decline", "prefer not"],
    },
    work_authorized: { yes: ["yes"], no: ["no"] },
    requires_sponsorship: { yes: ["yes"], no: ["no"] },
  };

  function makeFacts(fields, personal, eeo) {
    const R = fields?.personal || {};
    const P = personal || {};
    const resumeWords = (R.full_name || [R.first_name, R.last_name].filter(Boolean).join(" ")).split(/\s+/);
    const first = P.legal_first_name || R.first_name || resumeWords[0] || "";
    const last = P.legal_last_name || R.last_name || resumeWords.slice(-1)[0] || "";
    const stateRaw = (P.state || "").trim();
    const stateFull = STATES[stateRaw.toLowerCase()] || stateRaw.toLowerCase();
    const stateAbbr = Object.keys(STATES).find((k) => STATES[k] === stateFull) || "";
    const country = P.country || "United States";
    const city = P.city || (R.location || "").split(",")[0].trim();
    const exp0 = (fields?.work_experience || [])[0] || {};
    const edu0 = (fields?.education || [])[0] || {};
    return {
      first, last, middle: P.legal_middle_name || "",
      preferred: P.preferred_name || "",
      full: [first, P.legal_middle_name, last].filter(Boolean).join(" "),
      email: R.email || "", phone: P.phone || R.phone || "",
      phone_type: P.phone_type || "",
      address1: P.address_line1 || "", address2: P.address_line2 || "",
      city, stateFull, stateAbbr, postal: P.postal_code || "",
      country, countryWants: /united states|^us$|^usa$/i.test(country)
        ? ["united states of america", "united states", "usa", "us"] : [country],
      location: city && (stateAbbr || stateRaw)
        ? `${city}, ${stateAbbr ? stateAbbr.toUpperCase() : stateRaw}`
        : (R.location || ""),
      linkedin: R.linkedin || "", github: R.github || "", website: R.website || R.github || "",
      company: exp0.company || "", title: exp0.role || "",
      school: edu0.school || "", degree: edu0.degree || "", gpa: edu0.gpa || "",
      salary: P.salary_expectation || "", start: P.earliest_start || "",
      hear: P.hear_about || "",
      over_18: P.over_18 || "", relocate: P.willing_relocate || "",
      previously: P.previously_employed || "no",
      eeo: eeo || {},
    };
  }

  const yn = (v) => (v === "yes" ? ["yes"] : v === "no" ? ["no"] : null);

  // Ordered: first match wins. "short" rules only apply to short labels,
  // so a references box mentioning "first and last name" is not a name.
  const RULES = [
    { key: "preferred_name", name: "Preferred name", short: true, re: /preferred\s*(first\s*)?name|nick\s*name/, text: (f) => f.preferred },
    { key: "middle_name", name: "Middle name", short: true, re: /middle\s*name/, text: (f) => f.middle },
    { key: "first_name", name: "First name", short: true, re: /first\s*name|given\s*name/, text: (f) => f.first },
    { key: "last_name", name: "Last name", short: true, re: /last\s*name|family\s*name|surname/, text: (f) => f.last },
    { key: "full_name", name: "Name", short: true, re: /^(your\s*)?(full\s*)?(legal\s*)?name\b|full\s*name/, text: (f) => f.full },
    { key: "email", name: "Email", short: true, re: /e-?mail/, text: (f) => f.email },
    { key: "phone_type", name: "Phone type", short: true, re: /phone.*(type|device)|device\s*type/, choice: (f) => (f.phone_type ? [f.phone_type] : null) },
    { key: "phone_code", name: "Phone country code", short: true, re: /country\s*(phone|calling)?\s*code|phone.*country|calling\s*code/, choice: (f) => [...f.countryWants, "+1"] },
    { key: "phone", name: "Phone", short: true, re: /phone|mobile|telephone/, text: (f) => f.phone },
    { key: "address_line2", name: "Address line 2", short: true, re: /address\s*(line)?\s*2|apartment|suite|\bunit\b/, text: (f) => f.address2 },
    { key: "address_line1", name: "Street address", short: true, re: /address\s*(line)?\s*1|street|^address\b|mailing\s*address/, text: (f) => f.address1 },
    { key: "postal_code", name: "Postal code", short: true, re: /postal|zip/, text: (f) => f.postal },
    { key: "city", name: "City", short: true, re: /\bcity\b|\btown\b/, text: (f) => f.city, choice: (f) => (f.city ? [f.city] : null) },
    { key: "state", name: "State", short: true, re: /\bstate\b|province/, text: (f) => f.stateFull && (f.stateFull[0].toUpperCase() + f.stateFull.slice(1)), choice: (f) => [f.stateFull, f.stateAbbr].filter(Boolean) },
    { key: "country", name: "Country", short: true, re: /\bcountry\b/, text: (f) => f.country, choice: (f) => f.countryWants },
    { key: "location", name: "Location", short: true, re: /location|where are you (based|located)|current city/, text: (f) => f.location, choice: (f) => [f.location, f.city].filter(Boolean) },
    { key: "linkedin", name: "LinkedIn", short: true, re: /linked\s?in/, text: (f) => f.linkedin },
    { key: "github", name: "GitHub", short: true, re: /git\s?hub/, text: (f) => f.github },
    { key: "website", name: "Website", short: true, re: /portfolio|website|personal\s*site|\bblog\b/, text: (f) => f.website },
    { key: "company", name: "Current company", short: true, re: /current\s*(company|employer)|most recent (company|employer)/, text: (f) => f.company },
    { key: "title", name: "Current title", short: true, re: /current\s*(job\s*)?title|current\s*role|most recent title/, text: (f) => f.title },
    { key: "school", name: "School", short: true, re: /school|university|college|institution/, text: (f) => f.school, choice: (f) => (f.school ? [f.school] : null) },
    { key: "degree", name: "Degree", short: true, re: /\bdegree\b/, text: (f) => f.degree, choice: (f) => (f.degree ? [f.degree, f.degree.split(" ")[0]] : null) },
    { key: "gpa", name: "GPA", short: true, re: /\bgpa\b|grade point/, text: (f) => f.gpa },
    { key: "salary", name: "Desired salary", re: /salary|compensation expectation|pay expectation|expected (salary|compensation)/, text: (f) => f.salary },
    { key: "start", name: "Start date", re: /start date|available to start|notice period|earliest (start|date)/, text: (f) => f.start },
    { key: "hear", name: "How you heard", re: /how did you (hear|learn|find)|referral source|^source\b/, text: (f) => f.hear, choice: (f) => (f.hear ? [f.hear, "linkedin", "job board", "company website"] : null) },
    { key: "over_18", name: "Age 18 or older", re: /(at least|over|older than)\s*18|18 years|legal age/, choice: (f) => yn(f.over_18) },
    { key: "relocate", name: "Relocation", re: /relocat/, choice: (f) => yn(f.relocate), text: (f) => (f.relocate ? (f.relocate === "yes" ? "Yes" : "No") : "") },
    { key: "previously", name: "Previous employment", re: /(previously|ever|formerly|currently)\s*(been\s*)?(employed|worked)|former employee|worked (here|for us)/, choice: (f) => yn(f.previously), text: (f) => (f.previously === "yes" ? "Yes" : "No") },
    { key: "documentation", name: "Work documentation", re: /provide (such )?documentation|proof of (identity|employment eligibility)/, choice: (f) => yn(f.eeo.work_authorized) },
    { key: "gender", name: "Gender", re: /\bgender\b|\bsex\b/, eeo: "gender" },
    { key: "race", name: "Race and ethnicity", re: /\brace\b|ethnicit/, eeo: "race" },
    { key: "hispanic_latino", name: "Hispanic or Latino", re: /hispanic|latin[oax]/, eeo: "hispanic_latino" },
    { key: "veteran", name: "Veteran status", re: /veteran/, eeo: "veteran" },
    { key: "disability", name: "Disability status", re: /disabilit/, eeo: "disability" },
    // Sponsorship before authorization: sponsorship questions often say
    // "answer yes if you are currently authorized... but need sponsorship".
    { key: "requires_sponsorship", name: "Visa sponsorship", re: /sponsor|require\w*.{0,20}visa|h-?1b/, eeo: "requires_sponsorship" },
    { key: "work_authorized", name: "Work authorization", re: /authoriz\w*\s*(to\s*)?work|legally\s*\w*\s*(to\s*)?work|eligib\w*\s*to\s*work|right to work/, eeo: "work_authorized" },
  ];

  function eeoWants(f, key, options = []) {
    const answer = f.eeo[key];
    if (!answer) return null;
    let wants = EEO_WANTS[key]?.[answer] || [answer];
    // Workday and others fold Hispanic into the race list.
    if (key === "race" && f.eeo.hispanic_latino === "yes" &&
        options.some((o) => /hispanic/i.test(o))) {
      wants = ["hispanic or latino", ...wants];
    }
    return wants;
  }

  // Fields Filla corrects even when something is already there, because a
  // resume parser (Workday, SmartRecruiters) often guesses them wrong.
  const OVERRIDE_KEYS = new Set(["first_name", "middle_name", "last_name", "full_name",
    "preferred_name", "email", "phone", "address_line1", "address_line2", "city", "postal_code"]);

  // Inputs inside repeated experience or education entries belong to that
  // entry, never to the candidate's own location or title.
  const inEntrySection = (el) =>
    /work\s?experience|education-\d|education--/i.test(el.id || "") ||
    !!el.closest('[data-automation-id^="workExperience"],[data-automation-id^="education"]');

  function matchRule(matchStr, isShortLabel) {
    for (const r of RULES) {
      if (r.short && !isShortLabel) continue;
      if (r.re.test(matchStr)) return r;
    }
    return null;
  }

  // ================= discovering the form =================

  const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "number"]);

  function isComboInput(el) {
    return el.getAttribute("role") === "combobox" ||
      !!el.getAttribute("aria-autocomplete") ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      !!el.closest('[role="combobox"]');
  }

  function collectUnits(hintMap) {
    const units = [];
    const seenRadioNames = new Set();

    for (const el of deepAll("input, textarea, select")) {
      if (el.disabled || el.readOnly) continue;
      const type = (el.getAttribute("type") || "").toLowerCase();

      if (el.tagName === "SELECT") {
        if (!visible(el)) continue;
        units.push({ kind: "select", el, label: labelText(el),
                     options: [...el.options].map((o) => o.textContent.trim()) });
        continue;
      }

      if (type === "radio") {
        const name = el.name || "";
        const groupKey = name || el.closest("fieldset,[role=radiogroup],div")?.textContent?.slice(0, 80);
        if (seenRadioNames.has(groupKey)) continue;
        seenRadioNames.add(groupKey);
        const radios = name
          ? deepAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
          : [el];
        const options = radios.map((r) => (labelText(r) || r.value || "").trim());
        const rg = el.closest('[role="radiogroup"],fieldset');
        const legend = rg?.querySelector("legend")?.textContent || rg?.getAttribute("aria-label") || "";
        units.push({ kind: "radio", el: radios[0], radios, options,
                     label: legend || findQuestionText(radios[0], options) });
        continue;
      }

      if (el.tagName === "TEXTAREA" || TEXT_TYPES.has(type)) {
        if (!visible(el)) continue;
        const kind = el.tagName !== "TEXTAREA" && isComboInput(el) ? "combobox" : "text";
        let label = labelText(el);
        if (!label || label.length < 3) label = findQuestionText(el, [el.value]);
        units.push({ kind, el, label: label || el.placeholder || "" });
      }
    }

    // Workday-style listbox buttons.
    for (const btn of deepAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]')) {
      if (!visible(btn)) continue;
      let label = labelText(btn);
      if (!label || label.length < 3) label = findQuestionText(btn, [btn.textContent]);
      units.push({ kind: "listbox", el: btn, label });
    }

    for (const u of units) {
      u.match = norm(words(u.label) + " " + machineText(u.el));
      u.short = norm(u.label).length <= 80;
      u.required = u.el.required || u.el.getAttribute("aria-required") === "true" || /\*/.test(u.label);
      u.hintKey = hintMap.get(u.el) || null;
      u.name = displayName(u.label);
    }
    return units;
  }

  function isAnswered(u) {
    if (u.kind === "radio") return u.radios.some((r) => r.checked);
    if (u.kind === "select") return u.el.selectedIndex > -1 && !isPlaceholder(u.el.options[u.el.selectedIndex]?.textContent) && u.el.value !== "";
    if (u.kind === "listbox") return !isPlaceholder(u.el.textContent);
    return !!(u.el.value || "").trim();
  }

  // ================= resume upload =================

  function base64ToFile(b64, filename) {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new File([arr], filename, { type: "application/pdf" });
  }

  function contextText(el) {
    const bits = [labelText(el), el.name, el.id, el.getAttribute("data-automation-id")];
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      const t = (p.innerText || p.textContent || "").replace(/\s+/g, " ").slice(0, 200);
      if (t) { bits.push(t); break; }
    }
    // nearest heading above the input
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      n = n.parentElement;
      const h = n && n.querySelector && n.querySelector("h1,h2,h3,h4,legend");
      if (h) { bits.push(h.textContent); break; }
    }
    return norm(bits.filter(Boolean).join(" | "));
  }

  // Pick the input that is actually for the resume. Photo inputs, cover
  // letters, and "additional attachments" lose; resume and CV wording wins.
  function scoreFileInput(el, hintSet) {
    let s = hintSet.has(el) ? 3 : 0;
    const accept = (el.getAttribute("accept") || "").toLowerCase();
    const ctx = contextText(el);
    if (/resume|\bcv\b|curriculum/.test(ctx)) s += 6;
    if (accept && /image/.test(accept) && !/pdf|doc/.test(accept)) s -= 20;
    if (/photo|picture|avatar|profile image|headshot/.test(ctx)) s -= 12;
    if (/cover letter|additional|other attachment|transcript|portfolio|writing sample/.test(ctx)) s -= 6;
    return s;
  }

  async function uploadResume(pdfBase64, filename, hints, report) {
    const hintSet = new Set((hints?.resume || []).flatMap((sel) => deepAll(sel)));
    const inputs = deepAll('input[type="file"]').filter((el) => !el.disabled);
    if (!inputs.length) { report("Resume upload", "skipped"); return false; }
    const ranked = inputs.map((el) => ({ el, s: scoreFileInput(el, hintSet) }))
                         .sort((a, b) => b.s - a.s);
    if (ranked[0].s < -2) { report("Resume upload", "skipped"); return false; }
    const el = ranked[0].el;
    try {
      flash(el.closest("div") || el);
      const dt = new DataTransfer();
      dt.items.add(base64ToFile(pdfBase64, filename || "resume.pdf"));
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      report("Resume upload", el.files.length ? "filled" : "check");
      return true;
    } catch {
      report("Resume upload", "skipped");
      return false;
    }
  }

  // ================= Workday work experience =================

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8,
                   sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function parseDate(s) {
    const m = (s || "").toLowerCase().match(/([a-z]{3,})\.?\s*(\d{4})|(\d{1,2})\/(\d{4})|(\d{4})/);
    if (!m) return null;
    if (m[1]) return { month: MONTHS[m[1].slice(0, 4)] || MONTHS[m[1].slice(0, 3)] || null, year: m[2] };
    if (m[3]) return { month: Number(m[3]), year: m[4] };
    return { month: null, year: m[5] };
  }

  async function fillExperienceSections(fields, report) {
    const jobs = fields?.work_experience || [];
    if (!jobs.length) return;
    const groups = new Map();
    for (const el of deepAll("input, textarea")) {
      const sec = el.closest('[data-automation-id^="workExperience-"]');
      const gid = (el.id || "").match(/workExperience-\d+/i)?.[0] ||
                  sec?.getAttribute("data-automation-id");
      if (!gid || !visible(el)) continue;
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid).push(el);
    }
    let i = 0;
    for (const els of groups.values()) {
      const job = jobs[i++];
      if (!job) break;
      let touched = 0;
      const start = parseDate(job.start);
      const end = /present|current/i.test(job.end || "") ? null : parseDate(job.end);
      for (const el of els) {
        const k = norm(words((el.id || "") + " " + (el.getAttribute("data-automation-id") || "")));
        if (el.type === "checkbox") {
          if (/currently work/.test(k) && !end && !el.checked) { fireClick(el); touched++; }
          continue;
        }
        if (el.value) continue;
        const zone = /start date/.test(k) ? start : /end date/.test(k) ? end : null;
        let v = null;
        if (/job title/.test(k)) v = job.role;
        else if (/company/.test(k)) v = job.company;
        else if (/location/.test(k)) v = job.location;
        else if (/description/.test(k)) v = (job.bullets || []).join("\n");
        else if (zone && /month/.test(k) && zone.month) v = String(zone.month).padStart(2, "0");
        else if (zone && /year/.test(k)) v = zone.year;
        if (v) { await driveText(el, v); touched++; }
      }
      if (touched) report(`Experience at ${job.company || "previous role"}`, "check");
    }
  }

  // ================= the answer brain bridge =================

  const READABLE = {
    gender: { male: "Male", female: "Female", nonbinary: "Non-binary", decline: "Declines to self-identify" },
    hispanic_latino: { yes: "Hispanic or Latino", no: "Not Hispanic or Latino", decline: "Declines to say" },
    veteran: { not_protected: "Not a protected veteran", protected: "Protected veteran", decline: "Declines to say" },
    disability: { yes: "Has a disability", no: "Does not have a disability", decline: "Declines to say" },
    work_authorized: { yes: "Authorized to work in the United States", no: "Not authorized to work in the United States" },
    requires_sponsorship: { yes: "Will require visa sponsorship now or in the future", no: "Does not require visa sponsorship now or in the future" },
  };

  function profileForBrain(f, personal) {
    const out = { ...personal, legal_name: f.full };
    for (const [k, v] of Object.entries(f.eeo || {})) {
      out[k] = READABLE[k]?.[v] || v.replace(/_/g, " ");
    }
    return out;
  }

  function askBrain(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ filla: "answer", payload }, (r) => {
          resolve(r || { error: chrome.runtime.lastError?.message || "No answer" });
        });
      } catch (e) {
        resolve({ error: String(e) });
      }
    });
  }

  // ================= main =================

  function progress(label, status) {
    try { chrome.runtime.sendMessage({ filla: "fill_progress", label, status }); } catch {}
  }

  async function run({ fields, eeo, personal, pdfBase64, pdfFilename, hints, appId, job }) {
    ROOTS = collectRoots();
    const f = makeFacts(fields || {}, personal || {}, eeo || {});
    const filled = [], check = [], skipped = [];
    const report = (name, status) => {
      if (status === "filled") filled.push(name);
      else if (status === "check") check.push(name);
      else skipped.push(name);
      progress(name, status);
    };
    const PACE = 300;

    // 1. Resume first. Many ATSes parse it into the form, and our values
    //    then overwrite whatever the parser guessed.
    if (pdfBase64) {
      progress("Uploading your resume", "info");
      if (await uploadResume(pdfBase64, pdfFilename, hints, report)) {
        await sleep(1800);
        ROOTS = collectRoots();
      }
    }

    // 2. Workday experience entries, only into empty boxes.
    await fillExperienceSections(fields, report);

    // 3. Map every question by meaning and answer what the profile covers.
    progress("Reading the form", "info");
    const hintMap = new Map();
    for (const [k, sels] of Object.entries(hints || {})) {
      if (k === "resume") continue;
      for (const sel of sels) for (const el of deepAll(sel)) hintMap.set(el, k);
    }
    const units = collectUnits(hintMap);
    const leftovers = [];

    for (const u of units) {
      if (inEntrySection(u.el)) continue;
      const rule = (u.hintKey && RULES.find((r) => r.key === u.hintKey)) || matchRule(u.match, u.short);
      const override = rule && OVERRIDE_KEYS.has(rule.key) && u.kind === "text";
      if (isAnswered(u) && !override) continue;

      let status = null;
      let name = rule ? rule.name : u.name;
      if (rule) {
        if (u.kind === "text") {
          const v = rule.text ? rule.text(f) : null;
          if (v && norm(u.el.value) !== norm(v)) status = await driveText(u.el, v);
          else if (v) status = "filled";
        } else {
          let options = u.options;
          if (u.kind === "listbox" && rule.eeo) options = await readListboxOptions(u.el);
          const wants = rule.eeo ? eeoWants(f, rule.eeo, options || []) : rule.choice ? rule.choice(f) : null;
          const typed = rule.text ? rule.text(f) : null;
          if (wants && wants.length) {
            if (u.kind === "select") status = await driveSelect(u.el, wants);
            else if (u.kind === "radio") status = await driveRadio(u, wants);
            else if (u.kind === "listbox") status = await driveListbox(u.el, wants);
            else if (u.kind === "combobox") status = await driveCombobox(u.el, wants, typed && !rule.eeo ? typed : null);
          } else if (rule.eeo && !f.eeo[rule.eeo]) {
            if (u.required) report(name, "skipped");
            continue;
          }
        }
      }
      if (status) { report(name, status); await sleep(PACE); continue; }
      leftovers.push(u);
    }

    // 4. Everything else goes to the answer brain in one batch, with the
    //    real options for every choice question.
    const ask = [];
    for (const u of leftovers) {
      if (u.kind === "text") {
        if (isAnswered(u)) continue;
        if (/upload|attach|password|signature/.test(u.match)) continue;
        if (!u.required && !/\?/.test(u.label)) continue;
      }
      if (["select", "radio"].includes(u.kind) && isAnswered(u)) continue;
      let options = u.options;
      if (u.kind === "listbox") {
        if (isAnswered(u)) continue;
        options = await readListboxOptions(u.el);
      } else if (u.kind === "combobox") {
        if (isAnswered(u)) continue;
        u.el.focus(); key(u.el, "ArrowDown");
        await sleep(350);
        options = visibleOptions().map((o) => o.textContent.trim());
        key(u.el, "Escape");
        blur(u.el);
      }
      options = (options || []).filter((o) => o && !isPlaceholder(o));
      const kind = u.kind === "text" ? "text" : options.length ? "choice" : "text";
      u.askId = "q" + ask.length;
      u.askKind = kind;
      ask.push({ id: u.askId, question: u.label.slice(0, 600), kind, options, required: !!u.required });
      if (ask.length >= 30) break;
    }

    if (ask.length) {
      progress(`Asking Claude about ${ask.length} question${ask.length === 1 ? "" : "s"}`, "info");
      const res = await askBrain({ app_id: appId || "", questions: ask, job: job || {},
                                   profile: profileForBrain(f, personal || {}) });
      if (res.error) {
        progress("Claude could not answer right now", "info");
        for (const u of leftovers) if (u.askId && u.required) report(u.name, "skipped");
      } else {
        const answers = res.answers || {};
        for (const u of leftovers) {
          if (!u.askId) continue;
          const v = answers[u.askId];
          if (v === undefined || v === null) { if (u.required) report(u.name, "skipped"); continue; }
          let status = null;
          if (u.askKind === "text") {
            status = u.kind === "combobox" ? await driveCombobox(u.el, [v], v) : await driveText(u.el, v);
            // Written answers always get a human look before submitting.
            if (status && String(v).length > 60) status = "check";
          } else {
            const wants = [String(v)];
            if (u.kind === "select") status = await driveSelect(u.el, wants);
            else if (u.kind === "radio") status = await driveRadio(u, wants);
            else if (u.kind === "listbox") status = await driveListbox(u.el, wants);
            else if (u.kind === "combobox") status = await driveCombobox(u.el, wants, null);
          }
          report(u.name, status || "skipped");
          await sleep(PACE);
        }
      }
    }

    progress("", "done");
    return {
      filled: [...new Set(filled)],
      check: [...new Set(check)],
      skipped: [...new Set(skipped)].filter((s) => !filled.includes(s) && !check.includes(s)),
    };
  }

  return {
    run,
    // exposed for the test harness
    _t: { pickIndex, makeFacts, matchRule, displayName, scoreFileInput, collectRoots,
          setRoots: (r) => { ROOTS = r; }, parseDate, eeoWants, norm, words },
  };
})();
