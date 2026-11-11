// Filla autofill engine.
// Strategy: adapter selector hints first, then generic label matching over
// every visible form control on the page. React-safe value setting
// throughout. Returns a summary of what was filled and what was skipped so
// the side panel can show the user what still needs a human.

const FillaFill = (() => {
  // ---------- low-level helpers ----------

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function norm(s) {
    return (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[*:]/g, "").trim();
  }

  function labelFor(el) {
    const bits = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) bits.push(l.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) bits.push(wrap.textContent);
    if (el.getAttribute("aria-label")) bits.push(el.getAttribute("aria-label"));
    const ariaBy = el.getAttribute("aria-labelledby");
    if (ariaBy) {
      ariaBy.split(/\s+/).forEach((id) => {
        const n = document.getElementById(id);
        if (n) bits.push(n.textContent);
      });
    }
    if (el.placeholder) bits.push(el.placeholder);
    if (el.name) bits.push(el.name.replace(/[\[\]_-]+/g, " "));
    // Last resort: nearest field container's text (common in Ashby/React forms)
    if (!bits.length) {
      const box = el.closest("div,fieldset");
      if (box) bits.push(box.textContent.slice(0, 120));
    }
    return norm(bits.join(" | "));
  }

  function fuzzyPickOption(options, wanted) {
    // wanted: array of lowercase substrings, first match wins
    for (const w of wanted) {
      const hit = options.find((o) => norm(o.label).includes(w));
      if (hit) return hit;
    }
    return null;
  }

  // ---------- value sources ----------

  // EEO canonical answers -> substrings to look for in option text.
  const EEO_OPTION_SYNONYMS = {
    gender: {
      male: ["male"],
      female: ["female"],
      nonbinary: ["non-binary", "nonbinary", "non binary"],
      decline: ["decline", "don't wish", "do not wish", "prefer not"],
    },
    hispanic_latino: {
      yes: ["yes"],
      no: ["no"],
      decline: ["decline", "don't wish", "do not wish", "prefer not"],
    },
    race: {
      american_indian: ["american indian", "alaska native"],
      asian: ["asian"],
      black: ["black", "african american"],
      hispanic: ["hispanic", "latino"],
      pacific_islander: ["hawaiian", "pacific islander"],
      white: ["white"],
      two_or_more: ["two or more"],
      decline: ["decline", "don't wish", "do not wish", "prefer not"],
    },
    veteran: {
      not_protected: ["not a protected veteran", "i am not"],
      protected: ["identify as one or more", "protected veteran"],
      decline: ["decline", "don't wish", "do not wish", "prefer not"],
    },
    disability: {
      yes: ["yes, i have"],
      no: ["no, i do not", "no, i don't"],
      decline: ["do not want to answer", "don't wish", "decline", "prefer not"],
    },
    work_authorized: { yes: ["yes"], no: ["no"] },
    requires_sponsorship: { yes: ["yes"], no: ["no"] },
  };

  // label regex -> how to resolve the value from {fields, eeo}
  function buildRules(fields, eeo) {
    const p = fields.personal || {};
    const exp0 = (fields.work_experience || [])[0] || {};
    const edu0 = (fields.education || [])[0] || {};
    const fullName =
      p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ");

    return [
      { re: /first\s*name|given\s*name/, value: p.first_name },
      { re: /last\s*name|family\s*name|surname/, value: p.last_name },
      { re: /full\s*name|your\s*name|^name\b/, value: fullName },
      { re: /e-?mail/, value: p.email },
      { re: /phone|mobile/, value: p.phone },
      { re: /location|city|address/, value: p.location },
      { re: /linked\s?in/, value: p.linkedin },
      { re: /git\s?hub/, value: p.github },
      { re: /portfolio|website|personal\s*site/, value: p.website || p.github },
      { re: /current\s*company|employer|organization|^company\b/, value: exp0.company },
      { re: /current\s*(job\s*)?title|current\s*role/, value: exp0.role },
      { re: /school|university|college|institution/, value: edu0.school },
      { re: /degree/, value: edu0.degree },
      { re: /gpa/, value: edu0.gpa },
      // EEO single-choice questions (selects and radio groups)
      { re: /gender(?!\s*identity\s*option)/, eeo: "gender" },
      { re: /hispanic|latino|latinx|ethnicit/, eeo: "hispanic_latino" },
      { re: /\brace\b/, eeo: "race" },
      { re: /veteran/, eeo: "veteran" },
      { re: /disabilit/, eeo: "disability" },
      { re: /authoriz.*work|legally.*work|eligible.*work/, eeo: "work_authorized" },
      { re: /sponsorship|sponsor.*(now|future|visa)|require.*visa/, eeo: "requires_sponsorship" },
    ];
  }

  // ---------- fillers ----------

  function fillSelect(sel, rule, eeo) {
    const options = [...sel.options].map((o) => ({ label: o.textContent, value: o.value }));
    let pick = null;
    if (rule.eeo) {
      const answer = eeo?.[rule.eeo];
      if (!answer) return false;
      const syn = EEO_OPTION_SYNONYMS[rule.eeo]?.[answer] || [answer];
      pick = fuzzyPickOption(options, syn);
    } else if (rule.value) {
      pick = fuzzyPickOption(options, [norm(rule.value)]);
    }
    if (!pick) return false;
    setNativeValue(sel, pick.value);
    return true;
  }

  function fillRadioGroup(radios, rule, eeo) {
    if (!rule.eeo) return false;
    const answer = eeo?.[rule.eeo];
    if (!answer) return false;
    const syn = EEO_OPTION_SYNONYMS[rule.eeo]?.[answer] || [answer];
    const labelled = radios.map((r) => ({ el: r, label: labelFor(r) }));
    for (const w of syn) {
      const hit = labelled.find((x) => x.label.includes(w));
      if (hit) {
        hit.el.click();
        hit.el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  async function attachResume(input, pdfUrl, filename) {
    const resp = await fetch(pdfUrl);
    if (!resp.ok) throw new Error(`PDF fetch failed (${resp.status})`);
    const blob = await resp.blob();
    const file = new File([blob], filename, { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---------- main entry ----------

  async function run({ fields, eeo, pdfUrl, pdfFilename, hints }) {
    const rules = buildRules(fields || {}, eeo || {});
    const filled = [];
    const skipped = [];
    const used = new Set();

    // 1. Adapter hints: exact selectors for known ATS fields.
    const p = fields?.personal || {};
    const hintValues = {
      first_name: p.first_name,
      last_name: p.last_name,
      full_name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" "),
      email: p.email,
      phone: p.phone,
      location: p.location,
      linkedin: p.linkedin,
      github: p.github,
      website: p.website,
      company: (fields?.work_experience || [])[0]?.company,
    };
    for (const [key, selectors] of Object.entries(hints || {})) {
      if (key === "resume") continue;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && visible(el) && hintValues[key]) {
          setNativeValue(el, hintValues[key]);
          used.add(el);
          filled.push(key);
          break;
        }
      }
    }

    // 2. Resume upload.
    if (pdfUrl) {
      const fileSelectors = (hints?.resume || []).concat(['input[type="file"]']);
      let attached = false;
      for (const sel of fileSelectors) {
        const el = document.querySelector(sel);
        if (el && !used.has(el)) {
          try {
            await attachResume(el, pdfUrl, pdfFilename || "resume.pdf");
            used.add(el);
            filled.push("resume upload");
            attached = true;
            break;
          } catch (e) {
            skipped.push(`resume upload (${e.message})`);
            break;
          }
        }
      }
      if (!attached && !skipped.some((s) => s.startsWith("resume"))) {
        skipped.push("resume upload (no file input found on this page)");
      }
    }

    // 3. Generic pass over remaining text inputs, textareas, selects.
    const controls = [
      ...document.querySelectorAll(
        'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select'
      ),
    ].filter((el) => visible(el) && !used.has(el));

    for (const el of controls) {
      const label = labelFor(el);
      if (!label) continue;
      const rule = rules.find((r) => r.re.test(label));
      if (!rule) {
        if (el.required || label.includes("required")) {
          skipped.push(label.slice(0, 70));
        }
        continue;
      }
      let ok = false;
      if (el instanceof HTMLSelectElement) {
        ok = fillSelect(el, rule, eeo);
      } else if (rule.value) {
        if (!el.value) {
          setNativeValue(el, rule.value);
          ok = true;
        }
      } else if (rule.eeo && eeo?.[rule.eeo]) {
        // Text input asking an EEO question (rare). Use the stored answer verbatim.
        const map = { yes: "Yes", no: "No", decline: "Decline to self-identify" };
        setNativeValue(el, map[eeo[rule.eeo]] || eeo[rule.eeo]);
        ok = true;
      }
      if (ok) {
        used.add(el);
        filled.push(label.slice(0, 50));
      } else {
        skipped.push(label.slice(0, 70));
      }
    }

    // 4. Radio groups (EEO questions frequently render as radios).
    const radios = [...document.querySelectorAll('input[type="radio"]')].filter(visible);
    const groups = {};
    radios.forEach((r) => {
      const key = r.name || r.closest("fieldset,div")?.textContent?.slice(0, 60) || "x";
      (groups[key] ||= []).push(r);
    });
    for (const [key, group] of Object.entries(groups)) {
      const groupLabel = norm(
        group[0].closest("fieldset")?.querySelector("legend")?.textContent ||
          group[0].name ||
          key
      );
      const rule = rules.find((r) => r.eeo && r.re.test(groupLabel));
      if (rule && fillRadioGroup(group, rule, eeo)) {
        filled.push(groupLabel.slice(0, 50));
      }
    }

    return { filled, skipped: [...new Set(skipped)] };
  }

  return { run };
})();
