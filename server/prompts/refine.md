The user reviewed the tailored resume below and asked for specific
refinements in their own words. Apply exactly what they asked for, keep
everything else as it is, and stay within their standing rules.

## The user's refinement request

{instruction}

## The user's standing rules (still in force)

{rules}

## Current tailored resume (LaTeX)

```
{resume_tex}
```

## Constraints

- Apply the requested refinements faithfully. Where a request conflicts
  with the standing rules, the request wins for this revision, since the
  user wrote it after seeing the result.
- Keep the preamble and layout untouched, keep it one page, keep valid
  LaTeX escaping, and compile-ready for Tectonic.
- The FIELDS JSON must match the final tex exactly, every bullet word for
  word.

## Output format

Answer with ONLY the following sections, nothing before or after:

===TEX===
(the complete updated .tex file, raw, no markdown fences)
===FIELDS===
(the fields JSON matching the updated tex, same schema as before, no fences)
===NOTES===
(1 to 3 short lines on what you changed)
===END===
