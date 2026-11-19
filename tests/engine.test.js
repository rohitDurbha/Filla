// Drives the real autofill.js against mock forms that copy how each ATS
// builds its widgets. Run with: node engine.test.js
const fs = require("fs");
const { JSDOM } = require("jsdom");

const ENGINE = fs.readFileSync(require("path").join(__dirname, "..", "extension", "content", "autofill.js"), "utf8");
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok    " : "  FAIL  ") + msg);
  if (!cond) failures++;
};

function boot(html, brain) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, { pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  // jsdom has no layout. Treat anything not display:none or [hidden] as visible.
  w.Element.prototype.getBoundingClientRect = function () {
    const hidden = this.closest("[hidden]") || w.getComputedStyle(this).display === "none";
    return { width: hidden ? 0 : 10, height: hidden ? 0 : 10, top: 0, left: 0 };
  };
  w.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  w.PointerEvent = w.MouseEvent;
  w.DataTransfer = class { constructor() { const f = []; this.files = f; this.items = { add: (x) => f.push(x) }; } };
  Object.defineProperty(w.HTMLInputElement.prototype, "files", {
    get() { return this._files || []; }, set(v) { this._files = v; }, configurable: true,
  });
  const progress = [];
  const asked = [];
  w.chrome = { runtime: {
    sendMessage(msg, cb) {
      if (msg.filla === "fill_progress") progress.push([msg.status, msg.label]);
      if (msg.filla === "answer") {
        asked.push(...msg.payload.questions);
        setTimeout(() => cb({ answers: brain ? brain(msg.payload.questions) : {} }), 5);
      }
    },
    lastError: null,
  } };
  w.eval(ENGINE + "\nwindow.FillaFill = FillaFill;");
  return { w, d: w.document, progress, asked, F: w.FillaFill };
}

// ---------- mock widget behaviors ----------

function closePopups(d) { d.querySelectorAll(".popup").forEach((p) => p.remove()); }

// Workday listbox: button opens a popup list appended to body.
function wireListbox(w, btn, options) {
  const d = w.document;
  btn.addEventListener("click", () => {
    closePopups(d);
    const ul = d.createElement("ul");
    ul.className = "popup";
    ul.setAttribute("role", "listbox");
    for (const o of ["Select One", ...options]) {
      const li = d.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = o;
      li.addEventListener("click", () => { if (o !== "Select One") btn.textContent = o; closePopups(d); });
      ul.appendChild(li);
    }
    d.body.appendChild(ul);
  });
  d.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopups(d); });
}

// SmartRecruiters and React Select: an input that filters a popup list.
function wireCombobox(w, input, options) {
  const d = w.document;
  const render = (filter) => {
    closePopups(d);
    const ul = d.createElement("ul");
    ul.className = "popup";
    ul.setAttribute("role", "listbox");
    const hits = options.filter((o) => !filter || o.toLowerCase().includes(filter.toLowerCase()));
    if (!hits.length) { const p = d.createElement("div"); p.textContent = "No options"; ul.appendChild(p); }
    for (const o of hits) {
      const li = d.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = o;
      li.addEventListener("click", () => { input.value = o; closePopups(d); });
      ul.appendChild(li);
    }
    d.body.appendChild(ul);
  };
  input.addEventListener("click", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") render("");
    if (e.key === "Escape") closePopups(d);
  });
  input.addEventListener("input", () => render(input.value));
}

const FIELDS = {
  personal: { first_name: "Prasanna", last_name: "Durbha", full_name: "Prasanna Sai Rohit Durbha",
              email: "test@example.com", phone: "(408) 555-0100", location: "San Jose, CA",
              linkedin: "https://www.linkedin.com/in/example/", github: "https://github.com/example" },
  work_experience: [{ company: "Schneider Electric", role: "Software Developer", location: "Bengaluru, India",
                      start: "May 2021", end: "Aug. 2024", bullets: ["Built things.", "Shipped things."] }],
  education: [{ school: "San Jose State University", degree: "M.S. in Data Science", gpa: "3.5" }],
};
const PERSONAL = {
  legal_first_name: "Prasanna Sai Rohit", legal_last_name: "Durbha",
  address_line1: "1 Main Street", city: "San Jose", state: "CA", postal_code: "95112",
  country: "United States", over_18: "yes", previously_employed: "no", phone_type: "mobile",
};
const EEO = { gender: "male", hispanic_latino: "no", race: "asian", veteran: "not_protected",
              disability: "no", work_authorized: "yes", requires_sponsorship: "yes" };
const payload = (extra = {}) => ({ fields: FIELDS, personal: PERSONAL, eeo: EEO, hints: {},
                                   appId: "t", job: { company: "Kaizen", title: "Engineer" }, ...extra });

(async () => {
  // ================= unit checks =================
  console.log("option picking");
  const { F } = boot("");
  const pick = (opts, wants) => F._t.pickIndex(opts, wants);
  ok(pick(["Female", "Male", "Decline"], ["male"]) === 1, "male picks Male, never Female");
  ok(pick(["I am not a protected veteran", "No"], ["no"]) === 1, "no picks No, never 'not'");
  ok(pick(["Select One", "Yes", "No"], ["yes"]) === 1, "placeholder Select One is never chosen");
  ok(pick(["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)"], ["asian"]) === 0, "asian finds Asian (Not Hispanic or Latino)");
  ok(pick(["I am not a protected veteran", "I identify as one or more", "I don't wish to answer"],
          ["i am not a protected veteran"]) === 0, "veteran answer matched by phrase");

  console.log("rules map questions by meaning");
  const rule = (q, short = true) => F._t.matchRule(F._t.norm(q), short)?.key;
  ok(rule("Will you now, or in the future, require sponsorship for employment visa status? Please answer yes if you are currently authorized to work through OPT", false) === "requires_sponsorship",
     "long sponsorship question that mentions 'authorized' is still sponsorship");
  ok(rule("Do you have a legal right to work in the United States?", false) === "work_authorized", "legal right to work");
  ok(rule("Are you legally authorized to work in the US?", false) === "work_authorized", "legally authorized");
  ok(rule("Professional References 1 Please provide First and Last Name Relationship Telephone Number Email Address", false) === undefined,
     "references box is not a name, phone, or email field");
  ok(rule(F._t.norm(F._t.words("legalNameSection_firstName"))) === "first_name", "Workday automation id reads as first name");
  ok(rule(F._t.norm(F._t.words("name--legalName--lastName"))) === "last_name", "new Workday id reads as last name");
  ok(rule("Country Phone Code") === "phone_code", "country phone code is not phone or country");

  // ================= Workday page =================
  console.log("Workday application questions page");
  {
    const env = boot(`
      <div data-automation-id="formField-name">
        <label for="fn">First Name*</label><input id="fn" data-automation-id="legalNameSection_firstName" value="Prasanna">
        <label for="ln">Last Name*</label><input id="ln" data-automation-id="legalNameSection_lastName">
        <label for="a1">Address Line 1*</label><input id="a1" data-automation-id="addressSection_addressLine1">
        <label for="ci">City*</label><input id="ci" data-automation-id="addressSection_city">
        <label for="pc">Postal Code*</label><input id="pc" data-automation-id="addressSection_postalCode">
      </div>
      <div><label for="b1">Will you now, or in the future, require sponsorship for employment visa status? Please answer yes if you are currently authorized to work through OPT*</label>
        <button id="b1" aria-haspopup="listbox">Select One</button></div>
      <div><label for="b2">Are you at least 18 years of age?*</label><button id="b2" aria-haspopup="listbox">Select One</button></div>
      <div><label for="b3">Are you legally authorized to work in the US?*</label><button id="b3" aria-haspopup="listbox">Select One</button></div>
      <div><label for="b4">Please indicate the best way to reach you:*</label><button id="b4" aria-haspopup="listbox">Select One</button></div>
      <div><label for="b5">Ethnicity</label><button id="b5" aria-haspopup="listbox">Select One</button></div>
      <div><label for="r1">Professional References 1 Please provide professional references who are familiar with your work. First and Last Name Relationship Telephone Number Email Address</label>
        <textarea id="r1"></textarea></div>
      <div data-automation-id="workExperience-1">
        <label for="jt">Job Title*</label><input id="jt" data-automation-id="jobTitle">
        <label for="co">Company*</label><input id="co" data-automation-id="company">
        <label for="lo">Location</label><input id="lo" data-automation-id="location">
      </div>`,
      (qs) => Object.fromEntries(qs.map((q) => [q.id, /reach you/i.test(q.question) ? "Email" : null])));
    const { w, d } = env;
    wireListbox(w, d.getElementById("b1"), ["Yes", "No"]);
    wireListbox(w, d.getElementById("b2"), ["Yes", "No"]);
    wireListbox(w, d.getElementById("b3"), ["Yes", "No"]);
    wireListbox(w, d.getElementById("b4"), ["Email", "Phone", "Text Message"]);
    wireListbox(w, d.getElementById("b5"), ["Hispanic or Latino (United States of America)",
      "Asian (Not Hispanic or Latino) (United States of America)", "White (Not Hispanic or Latino) (United States of America)"]);
    const res = await env.F.run(payload());
    ok(d.getElementById("fn").value === "Prasanna Sai Rohit", "legal first name overrides the parser's guess");
    ok(d.getElementById("ln").value === "Durbha", "last name");
    ok(d.getElementById("a1").value === "1 Main Street", "street address from profile");
    ok(d.getElementById("ci").value === "San Jose" && d.getElementById("pc").value === "95112", "city and postal code, not 'San Jose, CA, US'");
    ok(d.getElementById("b1").textContent === "Yes", "sponsorship listbox answered from profile");
    ok(d.getElementById("b2").textContent === "Yes", "age listbox answered");
    ok(d.getElementById("b3").textContent === "Yes", "authorization listbox answered");
    ok(d.getElementById("b4").textContent === "Email", "unknown question answered by the brain from real options");
    ok(d.getElementById("b5").textContent.startsWith("Asian"), "Workday Ethnicity list picks the race option");
    ok(d.getElementById("r1").value === "", "references box left alone");
    ok(d.getElementById("jt").value === "Software Developer" && d.getElementById("co").value === "Schneider Electric",
       "experience entry filled from the resume");
    ok(d.getElementById("lo").value === "Bengaluru, India", "experience location is the job's, not the candidate's");
    const q = env.asked.find((x) => /reach you/i.test(x.question));
    ok(q && q.kind === "choice" && !q.options.includes("Select One") && q.options.includes("Email"),
       "brain saw the real options without the placeholder");
    ok(!env.asked.some((x) => /sponsorship|18 years|authorized/i.test(x.question)),
       "profile-covered questions never cost a Claude call");
  }

  // ================= SmartRecruiters page =================
  console.log("SmartRecruiters apply page");
  {
    const env = boot(`
      <section><h2>Easy Apply</h2><p>Choose an option to autocomplete your application.</p>
        <input type="file" id="easy"></section>
      <section><h2>Personal information</h2>
        <div><input type="file" id="photo" accept="image/png,image/jpeg"><span>Profile photo</span></div>
        <label for="em">Email*</label><input id="em" type="email">
        <label for="cem">Confirm your email*</label><input id="cem" type="email">
        <label for="city">City</label><input id="city" role="combobox" aria-autocomplete="list">
      </section>
      <section><h2>Resume</h2><div><span>Choose a file or drop it here</span><input type="file" id="res"></div></section>
      <section><label for="vet">Veteran Status</label><input id="vet" role="combobox" placeholder="Select..."></section>
      <section><label for="msg">Message to the Hiring Team</label><textarea id="msg"></textarea></section>`);
    const { w, d } = env;
    wireCombobox(w, d.getElementById("city"), ["San Jose, CA, United States", "San Jose, Costa Rica"]);
    wireCombobox(w, d.getElementById("vet"), ["I am not a protected veteran",
      "I identify as one or more of the classifications of a protected veteran", "I don't wish to answer"]);
    await env.F.run(payload({ pdfBase64: Buffer.from("%PDF-1.4 test").toString("base64"), pdfFilename: "R.pdf" }));
    ok(d.getElementById("res").files.length === 1, "resume went to the Resume section");
    ok(d.getElementById("photo").files.length === 0, "nothing uploaded to the profile photo input");
    ok(d.getElementById("easy").files.length === 0, "Easy Apply box skipped in favor of the Resume box");
    ok(d.getElementById("em").value === "test@example.com" && d.getElementById("cem").value === "test@example.com", "email and confirm email");
    ok(d.getElementById("city").value === "San Jose, CA, United States", "city picked from the dropdown, not typed raw");
    ok(d.getElementById("vet").value === "I am not a protected veteran", "veteran picked from the dropdown options");
    ok(![...d.querySelectorAll("input,textarea")].some((e) => /not_protected|^yes$|^no$/.test(e.value)), "no internal codes typed anywhere");
    ok(d.getElementById("msg").value === "", "optional message box left alone");
  }

  // ================= Ashby page with hidden radios =================
  console.log("Ashby radios and custom questions");
  {
    const env = boot(`
      <div><p>Gender</p>
        <input type="radio" id="g1" name="gender" style="opacity:0"><label for="g1">Male</label>
        <input type="radio" id="g2" name="gender" style="opacity:0"><label for="g2">Female</label>
        <input type="radio" id="g3" name="gender" style="opacity:0"><label for="g3">Decline to self-identify</label></div>
      <div><p>Employment Status*</p>
        <input type="radio" id="e1" name="8a0c-uuid" style="opacity:0"><label for="e1">I'm authorized to work in the United States</label>
        <input type="radio" id="e2" name="8a0c-uuid" style="opacity:0"><label for="e2">I'm looking for visa sponsorship</label></div>
      <div><label for="why">Why do you want to work at Kaizen?*</label><textarea id="why"></textarea></div>`,
      (qs) => Object.fromEntries(qs.map((q) => [q.id,
        /employment status/i.test(q.question) ? "I'm looking for visa sponsorship"
        : /why do you want/i.test(q.question) ? "I want to build public software that serves people well, and this team ships it with real care every week." : null])));
    const { d, progress } = env;
    await env.F.run(payload());
    ok(d.getElementById("g1").checked && !d.getElementById("g2").checked, "gender radio Male, not Female");
    ok(d.getElementById("e2").checked, "combined Employment Status group answered by the brain");
    ok(d.getElementById("why").value.length > 40, "essay question drafted");
    ok(progress.some(([s, l]) => s === "check" && /why do you want/i.test(l)), "drafted essay lands in double-check, not as verified");
    ok(!progress.some(([, l]) => /systemfield|[0-9a-f]{8}/.test(l || "")), "feed labels carry no ids");
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall engine checks passed");
  process.exit(failures ? 1 : 0);
})();
