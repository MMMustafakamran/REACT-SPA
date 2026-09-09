# Autorecorder

Automated screen-recording suite for CopilotKit framework integrations. It
produces one narrated-looking demo video per documentation page: read the doc,
switch to VS Code and show the code that implements it, switch to the browser and
drive the live feature.

Currently configured for **React SPA** — `https://docs.copilotkit.ai/react-spa`.

> **Porting this to another framework?** Read **[ADAPT.md](ADAPT.md)** first. It
> is written for the person or agent doing the port, and it is the contract the
> `doctor` command enforces.

---

## What is different here

Every other repo in this family records one Next.js app with a demo route per
doc page. `/react-spa` documents a **single** page, and its entire subject is
that a single-page app has no server — so:

- **The app under test is the scaffold the quickstart tells you to create**, not
  a committed frontend. It lives in `Npm/my-copilot-app`,
  `Pnpm/my-copilot-app` and `Yarn/my-copilot-app`, one per install tab the doc
  publishes.
- **The "backend" is the quickstart's own `server.ts`** — a standalone Copilot
  Runtime on `:8200`, a different origin from Vite on `:5173`. That separation
  is the thing being filmed.
- **One page, three IDE tabs, two terminals.** The doc makes exactly three
  claims and each lives in its own file, so the take shows `server.ts`
  (`cors: true`), `main.tsx` (the stylesheet import) and `App.tsx` (the
  absolute `runtimeUrl`) — then the integrated terminal, holding the two
  processes those files describe.

`TRACK` selects which scaffold a run drives. All three bind the same ports, so
run them one after the other, never at once.

Only the *install* commands differ between tracks. The quickstart publishes
three install tabs and then a single run step for all of them, so the yarn
track starts its services with the page's own `npx tsx server.ts` and
`npm run dev` rather than yarn equivalents the page never publishes.

---

## Run it

Both services must be up first — the recorder refuses to start otherwise, because
a video of a dead page is worse than no video. Start them **through
`capture.ts`**, which runs the command exactly as you typed it and records the
session the video replays:

```bash
cd Npm/my-copilot-app
export OPENAI_API_KEY=sk-...
npx tsx ../../autorecorder/capture.ts npm-runtime -- npm exec tsx server.ts   # :8200

# second terminal
cd Npm/my-copilot-app
npx tsx ../../autorecorder/capture.ts npm-dev -- npm run dev                  # :5173
```

The wrapper mirrors everything to your terminal, so it is invisible in use —
you watch the dev server exactly as you would have. Session files land in
`videos/logs/<track>-<service>.log`. Starting a service without it means no
capture, and `npm run doctor` fails before a browser is launched.

Then:

```bash
cd autorecorder
npm install
npx playwright install chromium

npm run doctor                        # is the configuration sane?
npm run doctor:online                 # also probe the doc URL, the app and the selectors
npm run record -- --quickstart        # the npm track

TRACK=pnpm npm run record -- --quickstart   # after restarting the servers from Pnpm/
TRACK=yarn npm run record -- --quickstart   # ... and from Yarn/
```

| Flag | Effect |
|---|---|
| `--list`, `--help` | Print every registered route and exit |
| `--doctor` | Validate the configuration; exits 1 on error |
| `--doctor --online` | Also probe every doc/demo URL and the selectors |
| `--<page-id>` | Record one page — here, `--quickstart` |
| `--page=<id>` | Same thing, explicit form |
| `--filter=<query>` | Record every page whose id or name contains the query |
| `--force` | Record even if the pre-flight health check fails |

| Env | Effect |
|---|---|
| `TRACK` | `npm` (default), `pnpm` or `yarn` — picks the scaffold, the session logs and the video prefix |
| `FRONTEND_URL` | Override `http://localhost:5173` |
| `BACKEND_URL` | Override `http://localhost:8200` |

Videos land in `videos/` as `RSPA-<track>-<NN>-<name>.webm`, 1920×1080, ~25fps
(Playwright's capture rate; it is not configurable). The track is in the
filename so an npm run and a pnpm run cannot overwrite each other.

**`videos/` is gitignored on purpose.** Recordings are build output —
reproducible from this folder plus `npm run record` — and committing them is
expensive. Publish them as release assets or to a bucket.

---

## Reading the summary

```
   ✅ [PASS]  (99.0s) React SPA Quickstart -> RSPA-npm-01-Quickstart.webm
   ⚠️  [PASS*] (31.7s) React SPA Quickstart -> RSPA-npm-01-Quickstart.webm
        · Doc page (…/react-spa): Timeout 25000ms exceeded
   ❌ [FAIL]  (19.4s) React SPA Quickstart
        · Demo step failed: Agent never produced a response within 30s
```

- **PASS** — every step completed.
- **PASS\*** — recorded, with a note. Either the external doc page misbehaved
  (intro footage degraded, feature not implicated), or the browser console
  logged errors during the demo step.
- **FAIL** — the app never rendered a chat surface, the agent never answered, or
  the IDE view could not be built. The clip is still saved as evidence. The
  process exits 1, so this is safe to gate CI on.

Every run also writes `videos/RECORD_RESULTS.json` — the verdict, duration,
warnings and distinct console errors per page. `ci/automate.mjs` moves it to
`RECORD_RESULTS.<track>.json` after each track, and the run report reads those
rather than listing every `.webm` in the folder.

On this project a FAIL is nearly always one of the two things the doc page warns
about: `cors: true` missing from `server.ts`, or a relative `runtimeUrl` in
`App.tsx`. Both produce a chat that renders and never answers.

---

## Layout

The split between what you edit and what you don't is the point of this folder.

```
autorecorder/
├── ADAPT.md                    ← how to port this; read before editing
├── cli.ts                      ← entrypoint, arg parsing, summary
├── capture.ts                  ← run a service through this; records its session
│
├── config/                     ← ★ THE ADAPTATION SURFACE
│   ├── project.config.ts         slug, doc root, URLs, TRACK → scaffold dir
│   ├── pages.config.ts           one entry per doc page
│   └── selectors.config.ts       how to find the chat surface
│
├── actions/                    ← ★ what to DO on each page
│   └── index.ts                  page id → handler registry (one entry here)
│
├── core/                       ← locally forked; see the note below
│   ├── CORE_MANIFEST.json        hash per core file; `npm run core:check` enforces it
│   ├── engine.ts                 browser lifecycle, the 4-step sequence, pass/fail
│   ├── actions.ts                sendPrompt, response detection, standard action
│   ├── doctor.ts                 the adaptation contract, as a command
│   ├── diagnostics.ts            pre-flight health check
│   ├── console-capture.ts        browser console/page/network errors, per take
│   ├── select.ts                 which pages a `record` invocation means
│   ├── timeouts.ts               every fixed wait, with project/page overrides
│   ├── types.ts                  PageDefinition → PageRecordConfig, ActionContext
│   ├── versions.ts               declared vs installed @copilotkit/* for this track
│   ├── ide/generator.ts          VS Code simulator with the integrated terminal
│   └── overlays/                 Windows 11 taskbar, virtual cursor, human pacing
│
├── scripts/core-manifest.mjs   ← core/ drift check (--check / --write / --diff)
├── test/                       ← unit tests for the pure modules (`npm test`)
│
└── videos/                     ← output, plus RECORD_RESULTS.json per run
```

**`core/` is a local fork in this repo.** In the sibling repos it is frozen
shared code, and ADAPT.md still says so. The integrated terminal required a new
step in `engine.ts`, a panel in `ide/generator.ts` and a check in `doctor.ts`,
and the decision was to keep that here rather than change the shared suite. If
the terminal is ever wanted elsewhere, it should be lifted into `core/` as an
opt-in — gated on a page having `terminals` — so the other repos stay
byte-identical until they ask for it. Everything else in `core/` tracks the
shared suite: `node scripts/core-manifest.mjs --diff ../../MsPy-angular/autorecorder`
lists exactly which files this fork differs in.

`actions/index.ts` holds one handler, and only just: driving CopilotKit's own
`<CopilotChat />` with a single prompt is exactly `runStandardAction`, and the
handler calls it and then writes the versions note. The reference repo's sixteen
handlers all addressed demo routes that do not exist in a single-page app, so
they were deleted rather than kept.

---

## What a recording actually does

1. **Doc page** — opens `https://docs.copilotkit.ai/react-spa`, waits for
   hydration, then scrolls at reading pace and rests the cursor on a code block.
   Clicks VS Code on the simulated taskbar.
2. **IDE** — renders `server.ts`, `main.tsx`, `App.tsx` and `package.json` from
   disk, Shiki-highlighted, switching tabs. Each source file's range covers the
   `[!code highlight]` marker the doc itself prints on that line; `package.json`
   carries no marker and its range is the two `@copilotkit/*` dependency lines.
3. **Terminal** — opens the IDE's integrated panel and moves between the two
   sessions: the runtime on `:8200`, then Vite on `:5173`. Clicks Chrome on the
   taskbar.
4. **Demo** — opens `http://localhost:5173`, types the prompt, waits for the
   reply to finish streaming, pauses for reading, then opens Notepad over the
   answer and writes down the versions it ran on.

### Versions, on both sides

PROJECT_GOAL rule 4 asks every finding to pin installed against declared, so a
clip states both. Step 2's `package.json` tab is the declared side, ranges and
all. Step 4's note is the installed side: `core/versions.ts` reads the track's
own `node_modules` at record time, so what the video claims is what the prompt
actually ran against, and a package declared but never installed is written out
as `NOT INSTALLED` and warned into the run summary rather than quietly falling
back to the range.

The note goes in Notepad, not on the page. A banner rendered into the demo route
would duplicate this and the narration, and it would take vertical space from
the chat that is the thing being demonstrated.

### What makes it read as a person

Every pace in a take comes from `core/overlays/human.ts`, seeded from the
page id, so tonight's clip is identical to last night's and two recordings
stay comparable frame for frame.

- **Typing** has a person's rhythm: jittered keystrokes, a beat after
  punctuation, the odd mid-sentence pause. A retry after a swallowed submit is
  typed quickly instead; that is the recorder recovering, not a performance.
- **Scrolling** is in bursts: a few wheel notches, a reading pause, a few more,
  sometimes a nudge back up.
- **Pauses** vary by about a quarter around their nominal length.
- **The cursor** overshoots slightly on long travel and settles, hovers a
  variable moment before a click, drifts while a reply streams instead of
  freezing, and starts each take somewhere plausible rather than dead centre.
- **The IDE window** fades in over 180ms instead of cutting.

### The terminal is a recording, not a mock-up

Nothing in that panel is composed. `capture.ts` writes a session file whose
header is the running process's own working directory and argv, followed by its
stdout as it arrives; the panel renders that file, ANSI colours included. There
is no `command` field in `pages.config.ts` to get out of step with reality, and
a log without a capture header is rejected rather than displayed — the one line
a viewer trusts most, the command, is the one that could otherwise be edited
into saying something that never ran.

Two consequences worth knowing. The panel shows a bare caret under the output
rather than a fresh prompt, because these processes are still running when the
frame is taken. And whatever the services actually printed is what appears —
including a deprecation warning or an `[vite] (client)` line that arrived
mid-run. That is the point.

Because step 3 drives the app from the Vite origin, the cross-origin request to
`:8200` is genuinely exercised — which is the one thing this doc page exists to
teach. A recording that hit the runtime origin directly would test everything
except that.

---

## Troubleshooting

**`Aborting before launching a browser`** — a service is down. The message names
which one and the command to start it. `--force` overrides.

**`Agent never produced a response within 30s`** — either the demo is genuinely
broken (see the CORS/`runtimeUrl` note above), or
`selectors.config.ts → assistantMessage` does not match this app's messages. Run
`npm run doctor:online` to tell the two apart.

**Something else is listening on :8200.** Windows lets a second process bind a
port another already holds, and requests then land on whichever accepts first.
A stale uvicorn from a sibling repo answering `{"detail":"Not Found"}` looks
exactly like a broken runtime. Check with
`Get-NetTCPConnection -LocalPort 8200 -State Listen` — two rows means stop one.

**`terminal "vite": ... has no capture header`** — that service was started by
hand instead of through `capture.ts`, so there is no recorded prompt line. Stop
it and restart it through the wrapper; nothing here will invent one.

**The IDE highlights the wrong lines** — the range drifted. `npm run doctor`
names the file and where its markers actually are now. Keep the
`[!code highlight]` comments in the scaffold: they are what makes that check
possible, and they are what the doc prints.

**Vite ignores `PORT`.** The doc page says so. Moving the app means
`npm run dev -- --port N`, and `FRONTEND_URL` has to be set to match.

**A recording passes but the video is wrong** — the doctor cannot see cursor
placement or highlight correctness. Watch it.
