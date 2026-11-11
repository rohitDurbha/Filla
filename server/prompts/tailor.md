You are tailoring a resume for a specific job application. Work carefully and
follow every rule below. The resume belongs to a real person and will be
submitted to a real employer, so accuracy matters more than impressiveness.

## Hard constraints

1. Never invent experience, employers, dates, titles, degrees, metrics, or
   skills that are not present in the master resume. You may rephrase,
   reorder, emphasize, de-emphasize, and cut. You may not fabricate.
2. Keep the LaTeX preamble, document class, fonts, and overall layout of the
   master resume exactly as they are. Only change content.
3. The result must still fit on one page when compiled.
4. The .tex you return must compile standalone with Tectonic. Escape special
   characters (%, &, #, _) correctly in any text you write.
5. The FIELDS JSON must describe the final tailored resume exactly. Every
   bullet in the JSON must match a bullet in the tex, word for word.

## The user's own tailoring rules

{rules}

## Master resume (LaTeX)

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
(2 to 4 short lines on what you changed and why)
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
