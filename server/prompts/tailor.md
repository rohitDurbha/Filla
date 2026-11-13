You are operating a resume tailoring pipeline that the user has defined
themselves, for a real job application. Their rules below are the authority
on what may change and how far to go. Execute their pipeline completely. A
pass that only reorders or lightly rewords the base resume's bullets is a
failed run.

## The user's rules (primary instructions)

{rules}

## Reading the rules correctly

- Step 3 of the pipeline means genuinely rewriting work experience bullets
  in XYZ form and weaving the JD's missing keywords, skills, and tools into
  them with concrete measurable impact, exactly as the rules describe. The
  rules' own honesty line (keep them honest, do not exaggerate) is the
  fabrication limit, and it governs metrics and tools, not whether bullets
  may be rewritten. Contact info, dates, and anything the rules mark as
  fixed or frozen stay fixed or frozen.
- Project selection draws from both the base resume and the GitHub
  inventory below. The number of projects on the final resume is whatever
  relevance and the one-page limit call for, never the count the base
  resume happens to contain.
- Keep the LaTeX preamble and macros of the base resume except where the
  rules direct changes (for example topmargin per track). The result must
  compile standalone with Tectonic and be exactly one page. Escape special
  characters (%, &, #, _) in any text you write.
- The FIELDS JSON must describe the final resume exactly, every bullet
  word for word.

## GitHub project inventory (the user's public repositories)

{github_projects}

## Base resume (LaTeX) for the chosen track

```
{resume_tex}
```

## Target job

Title: {job_title}
Company: {job_company}

Job description:

```
{job_description}
```

## Output format

Answer with ONLY the following sections, nothing before or after:

===TEX===
(the complete tailored .tex file, raw, no markdown fences)
===FIELDS===
(a single JSON object, schema below, no markdown fences)
===NOTES===
(First line, exactly this shape: Score: <base> -> <final>
Then at most 4 short lines: which projects you chose and the 2 or 3
biggest changes. No step-by-step narration.)
===END===

FIELDS JSON schema. Omit a key only if the resume truly has no such section.
Dates as strings exactly as they appear on the resume.

{{
  "personal": {{
    "first_name": "", "last_name": "", "full_name": "",
    "email": "", "phone": "", "location": "",
    "linkedin": "", "github": "", "website": ""
  }},
  "summary": "",
  "work_experience": [
    {{"company": "", "role": "", "location": "", "start": "", "end": "", "bullets": [""]}}
  ],
  "research_experience": [
    {{"org": "", "role": "", "start": "", "end": "", "bullets": [""]}}
  ],
  "projects": [
    {{"name": "", "tech": "", "bullets": [""]}}
  ],
  "education": [
    {{"school": "", "degree": "", "start": "", "end": "", "gpa": ""}}
  ],
  "skills": [
    {{"category": "", "items": [""]}}
  ]
}}
