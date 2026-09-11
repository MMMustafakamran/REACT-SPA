# `ci/` — the verification pipeline

Everything that checks, builds, starts and records this repo lives here. The
only piece outside this folder is `.github/workflows/daily-doc-check.yml`,
because GitHub requires that path.

## Layout

```
ci/
├── automate.mjs          entry point — one process, start to finish
├── check-doc-drift.mjs   compares doc-snapshot/ against the live docs
├── run-name.mjs          names the run's artifacts (React-SPA-28Aug2026-0600UTC)
└── lib/
    ├── config.mjs        paths, ports, the three tracks
    ├── env.mjs           loads .env
    ├── preflight.mjs     port and credential checks
    └── report.mjs        RUN_REPORT.md / .json
```

## Commands

| Command | What it does |
|---|---|
| `npm run automate` | Full pipeline: drift → preflight → install → serve → record, per track |
| `npm run automate -- --tracks=npm` | One track only |
| `npm run automate:locked` | Same, but installing the committed lockfiles |
| `npm run drift` | Doc drift check on its own |
| `npm run drift:sync` | Update `doc-snapshot/` to match the live docs |

Anything not consumed by `automate.mjs` is forwarded to the recorder:

```bash
node ci/automate.mjs --tracks=pnpm --skip-install
node ci/automate.mjs --quickstart --ignore-doc-drift
```


## Flags

| Flag | Effect |
|---|---|
| `--tracks=npm,pnpm,yarn` | Which scaffolds to run (default: all three) |
| `--skip-install` | Skip dependency installation |
| `--use-lockfile` | Install the committed lockfiles instead of re-resolving |
| `--ignore-doc-drift` / `--force` | Record even if the live docs moved |
| `--skip-credential-check` | Skip the model-credential preflight |
| `--pull` | `git pull` first |

## What runs, in order

1. **Doc drift** — every `doc-snapshot/pages/*.md` hash against the live page.
   Gating severity halts the run with exit code 2. See below.
2. **Preflight** — loads `.env`, then refuses to continue if `:8200` or `:5173`
   is already held, or the model credential is missing or rejected.
3. Then, **once per track** (npm → pnpm → yarn):
   1. **Install** — the manager's own install command.
   2. **Serve** — Copilot Runtime on `:8200` and Vite on `:5173`, both started
      through `autorecorder/capture.ts`.
   3. **Health** — poll `/api/copilotkit/info` and the app root until both
      answer, on `127.0.0.1` *and* `[::1]`. See § "Why the health check probes
      both loopback addresses".
   4. **Record** — hand off to the recorder with `TRACK` set.
   5. **Stop** — every service is torn down before the next track starts.
4. **Report** — `RUN_REPORT.md` / `.json`, always, success or failure.

## Why drift gates on severity

Not every doc change invalidates a recording, and a nightly that dies on a
reworded sentence gets muted within a week. `check-doc-drift.mjs` classifies
each changed page by *what part of it* moved:

| Severity | Trigger | Effect |
|---|---|---|
| **HIGH** | code fences added/removed, code content changed, page 404s | halt + notify |
| **MEDIUM** | headings or structure changed | halt + notify |
| **LOW** | prose only | announce, record anyway |

"Code" means the contents of a fenced block, found by scanning for fences and
dedenting each block to its own indentation — not "a line that starts with
four spaces". That distinction is load-bearing on this page, whose every fence
sits eight spaces deep inside an MDX `<Step>`, alongside prose indented exactly
the same way. The indentation rule read that prose as code and classified a
reworded sentence as HIGH, halting the nightly over a comma; it also never
looked inside a fence, so a changed `port` on a page that does not nest came
out LOW and recorded through. Both directions are now covered, and headings are
matched at any depth so an indented `### ...` still registers as MEDIUM.

HIGH matters here more than in the sibling repos, because the three scaffolds
are transcribed from this page's code blocks. A change there means `server.ts`,
`main.tsx` or `App.tsx` no longer match what a reader would copy, so a green run
would be verifying our own stale copy of the page rather than the page.

A third outcome is neither drift nor cleanliness: the docs site can be
unreachable, or answer `text/html` instead of markdown. That exits 1 and is
reported as **drift unknown**. Recording that as "no drift" would be the worst
of the three, and writing an HTML app shell into the snapshot would destroy the
baseline and report every page as rewritten on the next run.

## Why the services start through `capture.ts`

`automate.mjs` never spawns `npm run dev` directly. It spawns
`autorecorder/capture.ts`, which runs the command and records a session file
carrying the process's own working directory, argv and stdout.

That file is what the recorded video's terminal panel replays. Starting a
service any other way leaves no session, and the recorder's doctor then fails
the run before launching a browser — intended, not an inconvenience to work
around. It is also why there is no `--allow-port-reuse` here, unlike the sibling
repos: recording against an already-running server would replay one process's
session while a different process answered the demo.

## Why yarn runs npm commands

The quickstart publishes three **install** tabs and then a single run step for
all of them — `npx tsx server.ts` and `npm run dev`, with no per-manager
variant. So the yarn track installs with `yarn` and runs with the page's own
`npx`/`npm` commands.

Inventing `yarn dev` and `yarn run tsx` would mean testing our idea of the page
instead of the page. (It also does not work: Yarn 1's `run` does not reach
`node_modules/.bin` the way `npm exec` does.) If the page ever adds per-manager
run tabs, `TRACKS` in `lib/config.mjs` is the one place to change.

## Why the health check probes both loopback addresses

`localhost` is two addresses, and a server does not necessarily hold both.

`server.ts` calls `listen(port)` with no host, so Node binds the wildcard and
both families answer. Vite binds the *name* `localhost`, and Node has resolved
names verbatim rather than IPv4-first since v17 — so on a GitHub
`ubuntu-latest` runner, where `localhost` resolves to `::1` first, Vite listens
on `::1` alone and `http://127.0.0.1:5173` is refused.

That is not a hypothetical. Every CI run this pipeline made failed on it: the
job log shows Vite printing `ready in 285 ms` and the pipeline reporting
`Timeout waiting for npm Vite app at http://127.0.0.1:5173` ninety seconds
later, on the same page. It never reproduced locally, because Windows resolves
`localhost` to `127.0.0.1` first.

The probe now tries every address in `loopbackUrls()` and takes the first that
answers. Passing `--host` to Vite would also work and is the wrong fix: the dev
command is transcribed from the doc page, a reader following the page does not
pass `--host`, and the recorded terminal shows whatever we type.

A response that arrives but is not `ok` is now remembered and printed with the
timeout, so "answered 403 on `::1`" can never again look identical to "never
bound".

## Why the pnpm scaffold carries a `pnpm-workspace.yaml`

pnpm 10 stopped running dependency install scripts unless each package is
approved, and pnpm **exits non-zero** afterwards with
`ERR_PNPM_IGNORED_BUILDS`. Both of this scaffold's offenders — `esbuild`,
pulled in by Vite, and `@scarf/scarf` — are transitive, so `pnpm install`
failed *after* printing `dependencies: + @copilotkit/react-core ... done`: the
log reads like a clean install right up to the exit code. That failed the pnpm
track of every CI run.

`Pnpm/my-copilot-app/pnpm-workspace.yaml` sets `dangerouslyAllowAllBuilds:
true`, which restores what `npm install` and `yarn install` do here anyway. An
`allowBuilds:` allowlist was the alternative and is worse for this repo: the
three tracks would stop installing the same tree, and the list would need
re-approving every time a transitive dependency gained an install script —
breaking the nightly for a reason that has nothing to do with the page.

It is a file of its own rather than a `pnpm` key in `package.json` because the
three scaffolds' manifests are byte-identical transcriptions of what the
quickstart tells a reader to create, and only the install command is supposed
to differ between tracks.

Worth carrying into the doc review: a reader on the quickstart's pnpm tab
running pnpm 10 or newer hits this too, and the page says nothing about it.

## Which versions get tested

A run re-resolves dependencies by default: the lockfile is dropped and the
manager picks the newest versions the ranges in `package.json` already allow.
`@copilotkit/*` is a caret range, so a release is verified the night it ships,
and a major still cannot arrive without someone editing the manifest.

`--use-lockfile` opts back into the committed versions — for reproducing an
older run, or telling a broken page apart from a broken dependency tree.

What no run does is rewrite the ranges. Raising one is a reviewed edit to
`package.json`, not something a nightly does to itself.

## CI shape

```
drift ──gating──→ notify (issue) + stop ─────────────────┐
  │                                                      │
  └──clean / prose-only──→ record: npm │ pnpm │ yarn ──→ bundle
                           (matrix, fail-fast: false)    (one artifact)
```

`fail-fast` is off on purpose. pnpm breaking is not a reason to stop learning
whether npm and yarn work — *which* manager fails is itself the finding.

Each track uploads its own artifact and the `bundle` job merges all of them —
plus the drift report — into a single zip named for the run, deleting the
originals. Otherwise a green nightly leaves four zips on the run page to
download and unpack separately. It runs on `always()`, because a failed track
is a result worth reading and a halted run still has a drift report worth
keeping.

That zip is **flat**: three clips, one `logs/` folder, the reports beside them.

```
React-SPA-09Sep2026-0640UTC/
├── RSPA-npm-01-Quickstart.webm
├── RSPA-pnpm-01-Quickstart.webm
├── RSPA-yarn-01-Quickstart.webm
├── logs/            npm-, pnpm- and yarn-prefixed session and console logs
├── RUN_REPORT.<track>.md / .json
├── RECORD_RESULTS.<track>.json
└── drift.txt
```

It used to open as `npm/`, `pnpm/`, `yarn/` and `drift/`, because three tracks
each write `RUN_REPORT.md` at the same path and a flat merge would silently keep
one of them. Everything else was already stamped with its track by whatever
wrote it — the video filenames, `logs/npm-dev.log`, `RECORD_RESULTS.npm.json` —
so the fix is to stamp those two reports in a staging step before upload and let
the merge flatten. Four folders to dig through was a high price for two
filenames.

The track list is computed in the `drift` job and passed to the matrix as JSON.
Turning `npm,pnpm` into a matrix array with inline expressions takes three
nested `fromJSON`/`format` calls that cannot be read or tested; one line of
`node` either prints valid JSON or fails loudly.

## Secrets and variables

| Name | Kind | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | secret | The model the quickstart's `BuiltInAgent` uses |

That is the whole list. This page documents no threads, no Intelligence and no
license-gated feature, so there is nothing else to provide.

The key is passed to the runtime process — the doc page has you export it in
the terminal running `server.ts` — and never reaches the browser.

## Troubleshooting

**"Ports already in use"** — a previous run's servers survived, or a sibling
repo is squatting. Both have happened: a uvicorn from another project was found
holding `0.0.0.0:8200` while the runtime held `::`, and because Windows allows
both, `localhost` reached the runtime while `127.0.0.1` reached uvicorn and
answered `{"detail":"Not Found"}` — indistinguishable from a broken runtime.
Stop the listed PIDs.

**`terminal "vite": ... has no capture header`** — a service was started outside
`capture.ts`. Stop it and let the pipeline start it.

**Agent never produced a response** — check
`autorecorder/videos/logs/<track>-runtime.log` before suspecting the page. Two
local failures were `AI_APICallError` → `ConnectTimeoutError` against
`api.openai.com`, which is the single most likely cause of a red run.

**A track fails to install** — that is a result, not an outage. Yarn 1 has been
seen exiting 0 on an incomplete install (no lockfile, empty `node_modules/.bin`),
with the damage surfacing minutes later as `'tsx' is not recognized`. pnpm has
been seen doing the reverse, exiting 1 on a *complete* install because it
declined to run a transitive dependency's build script. Read the install log
before re-running.

**Vite times out while its own log says `ready in ... ms`** — the two are not
in conflict: the server is up on an address the probe was not asking about. The
timeout now names what each address answered. See § "Why the health check
probes both loopback addresses".
