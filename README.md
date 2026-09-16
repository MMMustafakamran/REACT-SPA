# CopilotKit React SPA — Doc Test

A verification harness for the CopilotKit **React SPA** doc page. The page is one
quickstart, so this repo is one quickstart run twice — once per package manager
tab the docs publish.

|                     |                                                                              |
| ------------------- | ---------------------------------------------------------------------------- |
| **Docs root**       | <https://docs.copilotkit.ai/react-spa>                                        |
| **Pages tracked**   | 2 — `/react-spa` (the quickstart) and `/react-spa/using-these-docs`            |
| **Doc sync date**   | Machine-maintained — `doc-snapshot/manifest.json` → `syncedAt`                 |
| **Toolchain**       | Node 26.7.0 · npm 12.0.2 · pnpm 11.23.0                                       |
| **Packages**        | `@copilotkit/react-core` ^1.70.3 · `@copilotkit/runtime` ^1.70.3               |
| **Test status**     | All three tracks pass — install, runtime, app, and a streamed reply            |

---

## What this is

`/react-spa` is not a framework integration page. It is the React docs plus a
single correction: **where Copilot Runtime lives.** Every other quickstart
assumes Next.js serves the app and the runtime from one origin and uses a
relative `runtimeUrl` of `/api/copilotkit`. A single-page app has no server, so
that path resolves to nothing — the page replaces it with a standalone Node
runtime on port 8200 and an absolute `runtimeUrl`.

Two things in that setup are easy to get wrong and are what these runs exist to
check:

- `cors: true` on `createCopilotNodeListener` — off by default, unlike the
  Express and Hono adapters. Without it every browser request fails preflight.
- The absolute `runtimeUrl`. Copying the relative one from another quickstart
  404s.

## Layout

```
React-SPA/
├── doc-snapshot/          the tracked docs, verbatim
│   ├── manifest.json      per-page sha256, byte/line counts, fetch headers
│   ├── CHANGELOG.md       doc drift, once a sync finds any
│   └── pages/
│       ├── react-spa.md                  the quickstart
│       └── react-spa__using-these-docs.md
├── Npm/my-copilot-app/    quickstart followed with the npm tab
├── Pnpm/my-copilot-app/   quickstart followed with the pnpm tab
├── Yarn/my-copilot-app/   quickstart followed with the yarn tab
├── info.txt               the docs root URL
└── README.md
```

The snapshot format matches the sibling repos (`Agno-react`, `MsPy-react`,
`Mastra-react`), so their `/doc-sync` tooling reads it unchanged: flat
`pages/` filenames with `/` → `__`, one manifest key per unique doc page.

## The test tracks

Both tracks follow the quickstart verbatim — same commands, same three files
(`server.ts`, `src/main.tsx`, `src/App.tsx`), differing only in the package
manager tab:

| Step                | `Npm/`                              | `Pnpm/`                  | `Yarn/`                 |
| ------------------- | ----------------------------------- | ------------------------ | ----------------------- |
| Scaffold            | `npm create vite@latest` (react-ts) | same                     | same                    |
| Runtime + core      | `npm install @copilotkit/…`         | `pnpm add @copilotkit/…` | `yarn add @copilotkit/…`|
| Dev deps            | `npm install -D tsx …`              | `pnpm add -D …`          | `yarn add -D …`         |
| Runtime server      | `npx tsx --env-file=.env server.ts` on :8200 | same                     | same                    |
| App                 | `npm run dev` on :5173              | same                     | same                    |

Only the install row differs. The page publishes three install tabs and then a
single run step for all of them, so the yarn track starts its services with the
page's own `npx`/`npm` commands rather than yarn equivalents the page never
gives.

Each run is checked at four points:

1. Install resolves, and the versions it lands on are recorded.
2. `tsc --noEmit` and `vite build` pass on the documented source.
3. `http://localhost:8200/api/copilotkit/info` returns agent information.
4. The dev server serves the app and a chat message streams back through the
   runtime.

Anything that needs a step the docs do not mention is a finding, and belongs in
this README rather than being fixed silently in the track.

All three tracks currently pass all four. The only edit any scaffold carries
beyond the doc's own source is the `[!code highlight]` comments — the doc prints
them on the same lines, so they make a diff against the page line up.

## Findings

Observations from running the page, kept here rather than patched away in the
tracks.

**1 · pnpm can fail to start the app, on pnpm's own gate.** When pnpm judges
`node_modules` out of sync it re-runs `pnpm install` from inside `pnpm run dev`,
which then fails:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @scarf/scarf@1.4.0, esbuild@0.28.2
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

Intermittent — it depends on pnpm's sync judgement, and a plain `pnpm run dev`
on an in-sync tree works. The page's pnpm tab says nothing about approving build
scripts. Reproduced on pnpm 11.23.0; not carried as a scaffold edit.

**2 · yarn 1 can exit 0 on an incomplete install.** A first `yarn install`
finished with exit code 0 but wrote no `yarn.lock` and left `node_modules/.bin`
empty, so `npx tsx server.ts` died with `'tsx' is not recognized`. A second run
completed properly (`Done in 112.78s`, 60 binaries, lockfile present). Worth
knowing because the failure surfaces at the *run* step, several minutes after
the install that actually caused it.

**3 · The model call is the flakiest part of the run.** Two runs failed with
the agent never answering; both times the runtime log held
`AI_APICallError` → `ConnectTimeoutError` against
`https://api.openai.com/v1/responses`. Nothing to do with the page — but it is
the single most likely cause of a failed run, so check the runtime log before
suspecting the docs.

**4 · `/react-spa/quickstart` answers 200 with the root page's body.** It is not
in the sitemap and is not tracked as a separate page.

**5 · Watch for a squatter on :8200.** A uvicorn from a sibling repo was found
holding `0.0.0.0:8200` while the runtime held `::`. Windows allows both, and
requests then land on whichever accepts first — `localhost` reached the runtime,
`127.0.0.1` reached uvicorn and answered `{"detail":"Not Found"}`, which reads
exactly like a broken runtime.

**6 · The pnpm tab installs an older CopilotKit than the npm and yarn tabs,
for 24 hours after every release.** pnpm 11 defaults `minimumReleaseAge` to 1440
minutes and refuses any version published more recently. The 2026-09-09 run
caught it: 1.70.2 and 1.70.3 had shipped the evening before, so npm and yarn took
1.70.3 while pnpm took **1.70.1**, six days old — the newest version that cleared
the gate. Same range, same command, same morning, two different minor versions.

Two consequences the page does not mention. A reader comparing the three tabs
gets three different trees for a day after any release. And once the range is
raised to `^1.70.3` — which only 1.70.3 satisfies — pnpm's non-strict default
installs it anyway and writes a `minimumReleaseAgeExclude` list into
`pnpm-workspace.yaml`, a file and a setting the quickstart never names.

Not a defect in the page's instructions; a defect in what the page leaves
unsaid. Nothing here is worked around in the scaffolds.

`OPENAI_API_KEY` must be exported in the terminal running the runtime — the
runtime process holds it, and it never reaches the browser.

## Running a track

```bash
cd Npm/my-copilot-app               # or Pnpm/, Yarn/
npx tsx --env-file=.env server.ts   # runtime on :8200
npm run dev                         # app on :5173, in a second terminal
```

Every finding pins its versions on both sides. The **declared** side is the
`^1.70.3` ranges the doc's install step wrote into `package.json`; the
**installed** side is whatever that track's `node_modules` holds. A package that
is declared but absent from `node_modules` is itself a finding.

Open the app at `http://localhost:5173`, not `:8200`: the chat must go from the
Vite origin to the runtime, so a working reply exercises the cross-origin call
for real — the single thing this doc page exists to correct.

## Re-syncing the docs

The snapshot is fetched from the undocumented raw-markdown endpoint: append
`.md` to any doc URL. The corpus comes from `https://docs.copilotkit.ai/sitemap.xml`
filtered to the `/react-spa/` prefix. A response that is not
`text/markdown` or `text/plain` is the app shell, not the page — discard the run
rather than committing it, or the baseline is destroyed and every page reports
as rewritten next time.

Note that `/react-spa/quickstart` answers 200 with the same body as
`/react-spa`. It is not in the sitemap and is not tracked as a separate page.
