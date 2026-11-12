// Filla autofill engine.
// Fills sequentially, scrolling to each field and flashing it as it fills,
// so the user can follow along on the page while the panel shows a live
// list. Strategy per field: adapter selector hints first, then generic
// label matching, React-safe value setting throughout.

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

  // Strip machine noise (uuids, system field ids) so labels read as humans
  // wrote them.
  function cleanLabel(s) {
    const out = (s || "")
      .replace(/\b[0-9a-f]{6,}\b/gi, "")
      .replace(/\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b/gi, "")
      .replace(/\bsystem\s*field\w*\b/gi, "")
      .replace(/_{2,}/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/[|,]\s*$/g, "")
      .trim();
    return out.length >= 3 ? out : "";
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
    if (!bits.length) {
      const box = el.closest("div,fieldset");
      if (box) bits.push(box.textContent.slice(0, 120));
    }
    return norm(bits.join(" | "));
  }

  function fuzzyPickOption(options, wanted) {
    for (const w of wanted) {
      const hit = options.find((o) => norm(o.label).includes(w));
      if (hit) return hit;
    }
    return null;
  }

  // ---------- follow-along visuals ----------

  let styleInjected = false;
  function flash(el) {
    if (!styleInjected) {
      const st = document.createElement("style");
      st.textContent = `
        .filla-flash {
          outline: 2px solid #99A5F2 !important;
          outline-offset: 2px !important;
          border-radius: 6px;
          transition: outline-color 0.6s ease;
        }`;
      document.documentElement.appendChild(st);
      styleInjected = true;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("filla-flash");
    setTimeout(() => el.classList.remove("filla-flash"), 1200);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function progress(label, status) {
    try {
      chrome.runtime.sendMessage({ filla: "fill_progress", label, status });
    } catch {}
  }

  // ---------- value sources ----------

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

  function base64ToFile(b64, filename) {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new File([arr], filename, { type: "application/pdf" });
  }

  function attachResume(input, pdfBase64, filename) {
    const dt = new DataTransfer();
    dt.items.add(base64ToFile(pdfBase64, filename));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---------- main entry ----------

  async function run({ fields, eeo, pdfBase64, pdfFilename, hints }) {
    const rules = buildRules(fields || {}, eeo || {});
    const filled = [];
    const skipped = [];
    const used = new Set();
    const PACE = 350; // ms between fields, slow enough to follow along

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

    // 1. Adapter hints.
    for (const [key, selectors] of Object.entries(hints || {})) {
      if (key === "resume") continue;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && visible(el) && hintValues[key]) {
          flash(el);
          setNativeValue(el, hintValues[key]);
          used.add(el);
          filled.push(key.replace(/_/g, " "));
          progress(key.replace(/_/g, " "), "filled");
          await sleep(PACE);
          break;
        }
      }
    }

    // 2. Resume upload, as real bytes handed over by the panel.
    if (pdfBase64) {
      const fileSelectors = (hints?.resume || []).concat(['input[type="file"]']);
      let attached = false;
      for (const sel of fileSelectors) {
        const el = document.querySelector(sel);
        if (el && !used.has(el)) {
          try {
            flash(el.closest("div") || el);
            attachResume(el, pdfBase64, pdfFilename || "resume.pdf");
            used.add(el);
            filled.push("resume upload");
            progress("resume upload", "filled");
            attached = true;
            await sleep(PACE);
          } catch (e) {
            skipped.push("resume upload");
            progress("resume upload", "skipped");
          }
          break;
        }
      }
      if (!attached && !skipped.includes("resume upload")) {
        skipped.push("resume upload (no file box on this page)");
        progress("resume upload", "skipped");
      }
    }

    // 3. Generic pass over remaining controls.
    const controls = [
      ...document.querySelectorAll(
        'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select'
      ),
    ].filter((el) => visible(el) && !used.has(el));

    for (const el of controls) {
      const rawLabel = labelFor(el);
      const label = cleanLabel(rawLabel);
      if (!rawLabel) continue;
      const rule = rules.find((r) => r.re.test(rawLabel));
      if (!rule) {
        if ((el.required || rawLabel.includes("required")) && label) {
          skipped.push(label.slice(0, 60));
          progress(label.slice(0, 60), "skipped");
        }
        continue;
      }
      let ok = false;
      if (el instanceof HTMLSelectElement) {
        ok = fillSelect(el, rule, eeo);
      } else if (rule.value) {
        if (!el.value) {
          flash(el);
          setNativeValue(el, rule.value);
          ok = true;
        }
      } else if (rule.eeo && eeo?.[rule.eeo]) {
        const map = { yes: "Yes", no: "No", decline: "Decline to self-identify" };
        flash(el);
        setNativeValue(el, map[eeo[rule.eeo]] || eeo[rule.eeo]);
        ok = true;
      }
      const shown = label || "field";
      if (ok) {
        used.add(el);
        filled.push(shown.slice(0, 50));
        progress(shown.slice(0, 50), "filled");
        await sleep(PACE);
      } else if (label) {
        skipped.push(shown.slice(0, 60));
        progress(shown.slice(0, 60), "skipped");
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
          group[0].name || key
      );
      const rule = rules.find((r) => r.eeo && r.re.test(groupLabel));
      if (rule) {
        flash(group[0].closest("fieldset") || group[0]);
        if (fillRadioGroup(group, rule, eeo)) {
          const shown = cleanLabel(groupLabel) || "choice";
          filled.push(shown.slice(0, 50));
          progress(shown.slice(0, 50), "filled");
          await sleep(PACE);
        }
      }
    }

    progress("", "done");
    return { filled: [...new Set(filled)], skipped: [...new Set(skipped)] };
  }

  return { run };
})();
