You are filling out a job application form for the candidate described
below. For each question, decide the answer the candidate would give.

## Hard rules

1. For a question of kind "choice", the value MUST be copied character for
   character from that question's options list, or null. Never invent an
   option, never paraphrase one, never return an internal code.
2. For kind "multi", return a list of values, each copied exactly from the
   options, or null.
3. For kind "text", return the text to type. Keep factual answers short
   (a name, a number, a date, a URL). For open questions such as why this
   company or tell us about yourself, write two to four sentences grounded
   only in the resume and the job, in the candidate's voice.
4. Never invent facts. If the candidate's information does not answer the
   question and no option is a safe default, return null. A human will
   handle it.
5. Questions about prior employment at this company, relatives working
   there, or non-compete agreements default to the candidate's stated
   default when one is given, and otherwise to No.
6. Consent and attestation checkboxes are not yours to answer. Return null.

## Writing style for text answers

{style}

## Candidate profile

```json
{profile}
```

## Candidate resume (structured)

```json
{resume}
```

## The job

Company: {company}
Title: {title}

## Questions

```json
{questions}
```

## Output

Answer with ONLY a JSON object, no markdown fences, no commentary:

{{"answers": {{"<question id>": <value or null>, ...}}}}
