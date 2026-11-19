// One profile schema, rendered by both the Profile page and the setup
// wizard. Personal answers live in chrome.storage under personalProfile,
// EEO answers under eeoProfile (the original key, kept for continuity).

const YES_NO = [["", "Skip this question"], ["yes", "Yes"], ["no", "No"]];

const PROFILE_SCHEMA = [
  {
    title: "Your name",
    note: "Workday and others ask for your legal name separately from a preferred one.",
    fields: [
      { key: "legal_first_name", label: "Legal first name", group: "personal",
        placeholder: "As on official documents" },
      { key: "legal_middle_name", label: "Middle name (optional)", group: "personal" },
      { key: "legal_last_name", label: "Legal last name", group: "personal" },
      { key: "preferred_name", label: "Preferred first name (optional)", group: "personal",
        placeholder: "Used only where a form asks for it" },
    ],
  },
  {
    title: "Contact and address",
    note: "Filled into address sections exactly as written here.",
    fields: [
      { key: "phone", label: "Phone", group: "personal", placeholder: "(408) 555 0100" },
      { key: "phone_type", label: "Phone type", group: "personal", type: "select",
        options: [["", "Skip this question"], ["mobile", "Mobile"], ["home", "Home"], ["work", "Work"]] },
      { key: "address_line1", label: "Street address", group: "personal" },
      { key: "address_line2", label: "Apartment or unit (optional)", group: "personal" },
      { key: "city", label: "City", group: "personal" },
      { key: "state", label: "State or province", group: "personal", placeholder: "California" },
      { key: "postal_code", label: "Postal code", group: "personal" },
      { key: "country", label: "Country", group: "personal", placeholder: "United States" },
    ],
  },
  {
    title: "Application defaults",
    note: "Answers to questions most applications ask in some form.",
    fields: [
      { key: "hear_about", label: "How did you hear about jobs, by default", group: "personal",
        placeholder: "LinkedIn" },
      { key: "over_18", label: "Are you at least 18 years old?", group: "personal",
        type: "select", options: YES_NO },
      { key: "willing_relocate", label: "Willing to relocate?", group: "personal",
        type: "select", options: YES_NO },
      { key: "salary_expectation", label: "Desired salary", group: "personal",
        placeholder: "120000" },
      { key: "earliest_start", label: "Earliest start date or notice", group: "personal",
        placeholder: "Two weeks after an offer" },
      { key: "previously_employed", label: "Have you worked for the hiring company before? (default)",
        group: "personal", type: "select", options: [["no", "No"], ["yes", "Yes"], ["", "Skip this question"]] },
    ],
  },
  {
    title: "Self identification",
    note: "Picking Skip leaves the question untouched on applications.",
    fields: [
      { key: "gender", label: "Gender", group: "eeo", type: "select", options: [
        ["", "Skip this question"], ["male", "Male"], ["female", "Female"],
        ["nonbinary", "Non-binary"], ["decline", "Decline to self-identify"]] },
      { key: "hispanic_latino", label: "Are you Hispanic or Latino?", group: "eeo", type: "select",
        options: [["", "Skip this question"], ["yes", "Yes"], ["no", "No"],
                  ["decline", "Decline to self-identify"]] },
      { key: "race", label: "Race", group: "eeo", type: "select", options: [
        ["", "Skip this question"],
        ["american_indian", "American Indian or Alaska Native"], ["asian", "Asian"],
        ["black", "Black or African American"], ["hispanic", "Hispanic or Latino"],
        ["pacific_islander", "Native Hawaiian or Other Pacific Islander"],
        ["white", "White"], ["two_or_more", "Two or More Races"],
        ["decline", "Decline to self-identify"]] },
      { key: "veteran", label: "Protected veteran status", group: "eeo", type: "select", options: [
        ["", "Skip this question"], ["not_protected", "I am not a protected veteran"],
        ["protected", "I identify as one or more classes of protected veteran"],
        ["decline", "I do not wish to answer"]] },
      { key: "disability", label: "Disability status", group: "eeo", type: "select", options: [
        ["", "Skip this question"], ["yes", "Yes, I have a disability (or previously had one)"],
        ["no", "No, I do not have a disability"], ["decline", "I do not want to answer"]] },
    ],
  },
  {
    title: "Work eligibility",
    note: "Asked on nearly every application in the United States.",
    fields: [
      { key: "work_authorized", label: "Are you legally authorized to work in the United States?",
        group: "eeo", type: "select", options: YES_NO },
      { key: "requires_sponsorship", label: "Will you now or in the future require sponsorship?",
        group: "eeo", type: "select", options: YES_NO },
    ],
  },
];

function renderProfileForm(container) {
  container.innerHTML = "";
  for (const sec of PROFILE_SCHEMA) {
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("h2");
    h.textContent = sec.title;
    const p = document.createElement("p");
    p.textContent = sec.note;
    card.append(h, p);
    for (const f of sec.fields) {
      const label = document.createElement("label");
      label.textContent = f.label;
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const [v, t] of f.options) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = t;
          input.appendChild(o);
        }
      } else {
        input = document.createElement("input");
        input.type = "text";
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.dataset.key = f.key;
      input.dataset.group = f.group;
      label.appendChild(input);
      card.appendChild(label);
    }
    container.appendChild(card);
  }
}

async function loadProfileInto(container) {
  const { personalProfile = {}, eeoProfile = {} } =
    await chrome.storage.local.get(["personalProfile", "eeoProfile"]);
  const src = { personal: personalProfile, eeo: eeoProfile };
  container.querySelectorAll("[data-key]").forEach((el) => {
    const v = src[el.dataset.group]?.[el.dataset.key];
    if (v !== undefined && v !== null) el.value = v;
  });
}

async function saveProfileFrom(container) {
  const personalProfile = {};
  const eeoProfile = {};
  container.querySelectorAll("[data-key]").forEach((el) => {
    const v = el.value.trim();
    if (!v) return;
    (el.dataset.group === "eeo" ? eeoProfile : personalProfile)[el.dataset.key] = v;
  });
  await chrome.storage.local.set({ personalProfile, eeoProfile });
  return { personalProfile, eeoProfile };
}
