// Filla autofill engine, v2.
// Fills sequentially, scrolling to each field and flashing it so the user
// can follow along. Honesty rules: a field is reported "filled" only after
// its state is verified (checked flag flipped, value present); actions
// whose effect cannot be verified report "check" instead. Labels shown to
// the user are human text, never the internal matching string.

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

  // The concatenated matching string: label + aria + name + placeholder.
  // Good for regex matching, never shown to the user.
  function matchText(el) {
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

  // Human display name: first meaningful label source, scrubbed of ids,
  // placeholders, and system noise.
  function scrub(s) {
    if (!s) return "";
    let out = s
      .replace(/\b[0-9a-f]{6,}\b/gi, "")
      .replace(/\b[0-9a-f]{2,}(?:-[0-9a-f]{2,}){2,}\b/gi, "")
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{3,}\b/gi, "")
      .replace(/system\s*_?field\w*/gi, "")
      .replace(/type here\.*/gi, "")
      .replace(/\.{3,}|…/g, "")
      .replace(/[_|]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s\-–—·,.:]+|[\s\-–—·,.:*]+$/g, "")
      .trim();
    if (out.length < 3) return "";
    if (/\d/.test(out) && /^[\da-f\s-]+$/i.test(out)) return "";
    return out[0].toUpperCase() + out.slice(1);
  }

  const EEO_NAMES = {
    gender: "Gender",
    hispanic_latino: "Hispanic or Latino",
    race: "Race",
    veteran: "Veteran status",
    disability: "Disability status",
    work_authorized: "Work authorization",
    requires_sponsorship: "Visa sponsorship",
  };

  function prettyName(el, rule) {
    if (rule?.eeo) return EEO_NAMES[rule.eeo];
    const cands = [];
    if (el?.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) cands.push(l.textContent);
    }
    const wrap = el?.closest("label");
    if (wrap) cands.push(wrap.textContent);
    cands.push(el?.getAttribute("aria-label"));
    const legend = el?.closest("fieldset")?.querySelector("legend");
    if (legend) cands.push(legend.textContent);
    cands.push((el?.name || "").replace(/[\[\]_-]+/g, " "));
    cands.push(el?.placeholder);
    for (const c of cands) {
      const s = scrub(c);
      if (s) return s.slice(0, 48);
    }
    return "Field";
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
    if (!el || !el.classList) return;
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
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
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
      yes: ["yes", "hispanic or latino"],
      no: ["no", "not hispanic"],
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
      yes: ["yes, i have", "yes i have"],
      no: ["no, i do not", "no, i don't", "no i do not"],
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
      { re: /first\s*name|given\s*name/, value: p.first_name, name: "First name" },
      { re: /last\s*name|family\s*name|surname/, value: p.last_name, name: "Last name" },
      { re: /full\s*name|your\s*name|^name\b/, value: fullName, name: "Name" },
      { re: /e-?mail/, value: p.email, name: "Email" },
      { re: /phone|mobile/, value: p.phone, name: "Phone" },
      { re: /location|city|address/, value: p.location, name: "Location" },
      { re: /linked\s?in/, value: p.linkedin, name: "LinkedIn" },
      { re: /git\s?hub/, value: p.github, name: "GitHub" },
      { re: /portfolio|website|personal\s*site/, value: p.website || p.github, name: "Website" },
      { re: /current\s*company|employer|organization|^company\b/, value: exp0.company, name: "Current company" },
      { re: /current\s*(job\s*)?title|current\s*role/, value: exp0.role, name: "Current title" },
      { re: /school|university|college|institution/, value: edu0.school, name: "School" },
      { re: /degree/, value: edu0.degree, name: "Degree" },
      { re: /gpa/, value: edu0.gpa, name: "GPA" },
      { re: /gender(?!\s*identity\s*option)/, eeo: "gender" },
      { re: /hispanic|latino|latinx|ethnicit/, eeo: "hispanic_latino" },
      { re: /\brace\b/, eeo: "race" },
      { re: /veteran/, eeo: "veteran" },
      { re: /disabilit/, eeo: "disability" },
      { re: /authoriz\w*\s*(to\s*)?work|legally\s*\w*\s*work|eligible\s*to\s*work/, eeo: "work_authorized" },
      { re: /sponsorship|sponsor\w*\s*(now|in|for|a|an)?\s*(the\s*)?(future|visa|employment)|require\w*\s*(a\s*)?visa/, eeo: "requires_sponsorship" },
    ];
  }

  // ---------- verified interactions ----------

  // A full pointer sequence: React forms sometimes listen below click().
  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(type.startsWith("pointer")
          ? new PointerEvent(type, opts)
          : new MouseEvent(type, opts));
      } catch {}
    }
  }

  // Radios are usually hidden inputs behind styled labels; React apps listen
  // on the label. Click the visible thing, then verify AFTER a beat: a
  // controlled React radio can flip checked natively and get reverted on
  // the next render, so an instant check reports false success.
  async function clickRadio(input) {
    const targets = [];
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) targets.push(l);
    }
    const wrap = input.closest("label");
    if (wrap && !targets.includes(wrap)) targets.push(wrap);
    targets.push(input);
    for (const t of targets) {
      flash(visible(t) ? t : input.closest("fieldset") || t);
      fireClick(t);
      await sleep(120);
      if (input.checked) return true;
    }
    // Last resort: set the flag natively and announce it.
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set;
      setter.call(input, true);
      input.dispatchEvent(new Event("click", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {}
    await sleep(120);
    return input.checked;
  }

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
    return sel.value === pick.value;
  }

  function base64ToFile(b64, filename) {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new File([arr], filename, { type: "application/pdf" });
  }

  function isCombobox(el) {
    return el.getAttribute("role") === "combobox" ||
           !!el.getAttribute("aria-autocomplete") ||
           el.closest('[role="combobox"]') !== null;
  }

  // ---------- main entry ----------

  async function run({ fields, eeo, pdfBase64, pdfFilename, hints }) {
    const rules = buildRules(fields || {}, eeo || {});
    const filled = [];
    const check = [];
    const skipped = [];
    const used = new Set();
    const satisfied = new Set(); // eeo keys already handled on this page
    const PACE = 350;

    const report = (name, status) => {
      ({ filled, check, skipped })[
        status === "filled" ? "filled" : status === "check" ? "check" : "skipped"
      ].push(name);
      progress(name, status);
    };

    const p = fields?.personal || {};
    const hintValues = {
      first_name: ["First name", p.first_name],
      last_name: ["Last name", p.last_name],
      full_name: ["Name", p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ")],
      email: ["Email", p.email],
      phone: ["Phone", p.phone],
      location: ["Location", p.location],
      linkedin: ["LinkedIn", p.linkedin],
      github: ["GitHub", p.github],
      website: ["Website", p.website],
      company: ["Current company", (fields?.work_experience || [])[0]?.company],
    };

    // 1. Adapter hints: exact selectors for known ATS fields.
    for (const [key, selectors] of Object.entries(hints || {})) {
      if (key === "resume") continue;
      const [name, value] = hintValues[key] || [];
      if (!value) continue;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && visible(el)) {
          flash(el);
          setNativeValue(el, value);
          used.add(el);
          report(name, el.value ? "filled" : "check");
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
            const dt = new DataTransfer();
            dt.items.add(base64ToFile(pdfBase64, pdfFilename || "resume.pdf"));
            el.files = dt.files;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("input", { bubbles: true }));
            used.add(el);
            report("Resume upload", el.files.length ? "filled" : "check");
            attached = true;
            await sleep(PACE);
          } catch {
            report("Resume upload", "skipped");
          }
          break;
        }
      }
      if (!attached && !skipped.includes("Resume upload")) {
        report("Resume upload", "skipped");
      }
    }

    // 3. Generic pass over text inputs, textareas, selects.
    const controls = [
      ...document.querySelectorAll(
        'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select'
      ),
    ].filter((el) => visible(el) && !used.has(el));

    for (const el of controls) {
      const mt = matchText(el);
      if (!mt) continue;
      const rule = rules.find((r) => r.re.test(mt));
      const name = rule ? (rule.name || EEO_NAMES[rule.eeo]) : prettyName(el, rule);
      if (!rule) {
        if (el.required || mt.includes("required")) {
          const pn = prettyName(el, null);
          if (pn !== "Field") report(pn, "skipped");
        }
        continue;
      }
      let status = null;
      if (el instanceof HTMLSelectElement) {
        flash(el);
        status = fillSelect(el, rule, eeo) ? "filled" : null;
      } else if (rule.value) {
        if (!el.value) {
          flash(el);
          setNativeValue(el, rule.value);
          // A combobox accepted the text but may still need a pick from its
          // dropdown, which only a human can confirm.
          status = isCombobox(el) ? "check" : (el.value ? "filled" : null);
        }
      } else if (rule.eeo && eeo?.[rule.eeo]) {
        const map = { yes: "Yes", no: "No", decline: "Decline to self-identify" };
        flash(el);
        setNativeValue(el, map[eeo[rule.eeo]] || eeo[rule.eeo]);
        status = el.value ? "filled" : null;
      }
      if (status) {
        used.add(el);
        if (rule.eeo) satisfied.add(rule.eeo);
        report(name, status);
        await sleep(PACE);
      } else if (rule.eeo && !eeo?.[rule.eeo]) {
        report(name, "skipped");
      }
    }

    // 4. Radio groups. No visibility filter: real inputs are usually hidden
    //    behind styled labels.
    const optionLabelOf = (r) => {
      let t = "";
      if (r.id) {
        const l = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        if (l) t = l.textContent;
      }
      if (!t) t = r.closest("label")?.textContent || "";
      return norm(t);
    };

    // Custom ATS questions often carry opaque uuid field names, so the
    // question text has to be found in the DOM: walk up from the group and
    // read what remains once the option labels are stripped away.
    const findQuestionText = (group) => {
      const opts = group.map(optionLabelOf).filter(Boolean);
      let node = group[0].closest("div,fieldset")?.parentElement;
      for (let i = 0; i < 5 && node; i++) {
        let t = norm(node.textContent).slice(0, 400);
        for (const o of opts) t = t.split(o).join(" ");
        t = t.replace(/\s+/g, " ").trim();
        if (t.length > 8) return t;
        node = node.parentElement;
      }
      return "";
    };

    const radios = [...document.querySelectorAll('input[type="radio"]')];
    const groups = {};
    radios.forEach((r) => {
      const key = r.name || r.closest("fieldset,div")?.textContent?.slice(0, 60) || "x";
      (groups[key] ||= []).push(r);
    });
    for (const group of Object.values(groups)) {
      const g0 = group[0];
      const rg = g0.closest('[role="radiogroup"],fieldset');
      // Underscores are word characters, so field names like
      // "systemfield_eeoc_race" defeat \b patterns unless split apart.
      const groupText = norm(
        (rg?.querySelector("legend")?.textContent ||
         rg?.getAttribute("aria-label") ||
         g0.name || "").replace(/[\[\]_-]+/g, " ")
      );
      let rule = rules.find((r) => r.eeo && r.re.test(groupText));
      if (!rule) {
        const q = findQuestionText(group);
        if (q) rule = rules.find((r) => r.eeo && r.re.test(q));
      }

      // Ashby-style combined question: "I'm authorized to work in the US"
      // versus "I'm looking for visa sponsorship" as one group.
      if (!rule) {
        const joined = group.map(optionLabelOf).join(" | ");
        if (/authoriz\w* to work/.test(joined) && /sponsorship/.test(joined)) {
          let wantRe = null;
          let key = null;
          if (eeo?.requires_sponsorship === "yes") {
            wantRe = /sponsorship/; key = "requires_sponsorship";
          } else if (eeo?.work_authorized === "yes") {
            wantRe = /authoriz\w* to work/; key = "work_authorized";
          }
          if (wantRe) {
            const hit = group.find((r) => wantRe.test(optionLabelOf(r)));
            if (hit) {
              const ok = await clickRadio(hit);
              satisfied.add(key);
              report("Employment status", ok ? "filled" : "check");
              await sleep(PACE);
            }
          }
          continue;
        }
      }
      if (!rule || satisfied.has(rule.eeo)) continue;
      const name = EEO_NAMES[rule.eeo];
      const answer = eeo?.[rule.eeo];
      if (!answer) { report(name, "skipped"); continue; }
      const syn = EEO_OPTION_SYNONYMS[rule.eeo]?.[answer] || [answer];
      const labelled = group.map((r) => ({ el: r, label: matchText(r) }));
      let hit = null;
      for (const w of syn) {
        hit = labelled.find((x) => x.label.includes(w));
        if (hit) break;
      }
      if (!hit) { report(name, "skipped"); continue; }
      const ok = await clickRadio(hit.el);
      satisfied.add(rule.eeo);
      report(name, ok ? "filled" : "check");
      await sleep(PACE);
    }

    // 5. Yes/No button toggles (segmented controls that are neither radios
    //    nor selects, common on Ashby for work authorization).
    for (const key of ["work_authorized", "requires_sponsorship"]) {
      if (satisfied.has(key)) continue;
      const answer = eeo?.[key];
      if (!answer) continue;
      const rule = rules.find((r) => r.eeo === key);
      const name = EEO_NAMES[key];
      const questions = [...document.querySelectorAll("label,legend,p,span,strong,b,h3,h4,div")]
        .filter((n) => n.childElementCount <= 2 &&
                       n.textContent.trim().length < 240 &&
                       rule.re.test(norm(n.textContent)));
      let done = false;
      for (const q of questions) {
        let scope = q;
        for (let up = 0; up < 4 && scope && !done; up++) {
          const btns = [...scope.querySelectorAll('button,[role="radio"],[role="button"],[role="option"]')]
            .filter((b) => /^(yes|no)$/i.test(b.textContent.trim()) && visible(b));
          const hit = btns.find((b) => b.textContent.trim().toLowerCase() === answer);
          if (hit) {
            flash(hit);
            fireClick(hit);
            await sleep(150);
            const verified =
              hit.getAttribute("aria-checked") === "true" ||
              hit.getAttribute("aria-pressed") === "true" ||
              /select|active|checked/i.test(hit.className);
            satisfied.add(key);
            report(name, verified ? "filled" : "check");
            await sleep(PACE);
            done = true;
          }
          scope = scope.parentElement;
        }
        if (done) break;
      }
    }

    progress("", "done");
    return {
      filled: [...new Set(filled)],
      check: [...new Set(check)],
      skipped: [...new Set(skipped)].filter((s) => !filled.includes(s) && !check.includes(s)),
    };
  }

  return { run };
})();
