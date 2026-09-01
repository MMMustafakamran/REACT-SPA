# Project Goal

QA on the CopilotKit React SPA docs
(<https://docs.copilotkit.ai/react-spa>). The job is **finding bugs and
ambiguity in those doc pages**. The deliverable is a written QA report of the findings plus one
recording per page. Everything here is tooling for that; a clean run that finds
nothing when the docs are broken is a failed run, not a passing one.

## Layout

| Path | What it is |
|---|---|
| `doc-snapshot/` | Version-controlled copy of the upstream doc pages, plus `CHANGELOG.md` of drift |
| `Npm/`, `Pnpm/`, `Yarn/` | The harness — one scaffolded app per package manager, each doc page a live route |
| `autorecorder/` | Per-page demo capture (doc → code → live feature), paced to look human |
| `ci/` | `automate.mjs`: drift → preflight → deps → servers → record → report |

## Cycle

```
drift check → implement changed pages into the harness → record → report
```

## Rules

1. Snippets go in **verbatim**, highlighted ones especially. A snippet that fails
   as published is the finding — do not fix it.
2. Broken pages keep their broken implementation; the clip exists to show the
   defect.
3. Ambiguity is a defect: missing steps, undefined identifiers, unstated
   prerequisites. Report it even if inference makes the page work.
4. Every finding pins installed vs declared versions.

## Gaps the pipeline misses — check by hand

- **New pages** — no route, no recorder entry, no diff; snapshotted but untested.
- **Removed/renamed pages** — leave a live route and a passing recording behind.
- **Legacy code** — the old implementation surviving beside the new one and
  keeping a page falsely green.
- **Pages with no `/demo` route** — unregistered in the recorder, never recorded.
- **Silent failures** — clean console, no error; drift and recording both pass.
- **Divergence from the Next.js/Angular build** of the same guide; nothing compares them.

## Done

Drift implemented · §gaps reconciled · superseded code deleted · all routes
recorded · report rebuilt · **clips actually watched**.
