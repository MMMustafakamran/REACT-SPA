/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ADAPT THIS FILE — 3 of 3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One entry per doc page, in the order the doc nav lists them.
 *
 * ── Why there is exactly one ───────────────────────────────────────────────
 * `/react-spa` publishes two pages. `using-these-docs` is a status note with
 * no feature to drive, so it is tracked for drift in `doc-snapshot/` and not
 * recorded. `/react-spa/quickstart` answers 200 with the same body as the root
 * but is absent from the sitemap; registering it would record the same footage
 * twice under two names. That leaves the root page, and it is the whole repo.
 *
 * The drift checker reads `doc-snapshot/manifest.json` (2 pages) and the
 * recorder reads this file (1 page). That mismatch is correct and deliberate —
 * do not "fix" it by inventing a demo route for a page that documents nothing
 * runnable.
 *
 * ── The line ranges ────────────────────────────────────────────────────────
 * `startLine`/`endLine` are what the simulated IDE highlights, and they are
 * hardcoded. Every file below carries the `[!code highlight]` marker the doc
 * itself prints on that line, so `npm run doctor` can tell you when a range has
 * drifted off the code it is meant to be pointing at. Keep the markers.
 */

import { PROJECT, logPathFor } from './project.config';
import { definePages } from '../core/types';

/** Repo-relative path inside the scaffold this run is recording. */
const src = (file: string) => `${PROJECT.projectDir}/${file}`;

export const PAGES = definePages([
  {
    id: 'quickstart',
    name: 'React SPA Quickstart',
    videoName: 'Quickstart',

    // The page is the doc root, so this is empty. `docUrlFor` handles that.
    docPath: '',

    // The SPA serves one route, and it is the demo.
    route: '',

    // Three tabs, because the page makes exactly three claims and each one
    // lives in its own file:
    //
    //   server.ts   the runtime the SPA does not otherwise have, and `cors: true`
    //   main.tsx    the stylesheet import, without which the chat renders bare
    //   App.tsx     the absolute runtimeUrl — the one instruction that does not
    //               carry over from the Next.js quickstarts
    //
    // Ordered as the doc introduces them, then a fourth tab that is not a
    // claim at all: package.json, on screen so the clip states which versions
    // the three above were verified against. PROJECT_GOAL rule 4 wants every
    // finding pinned to installed vs declared, and this is the declared half —
    // `^1.69.3`, a range. The installed half is read out of node_modules at
    // record time and written into the Notepad note during the demo step, so
    // the two halves are visible in the same clip and can be compared.
    ideFile: src('server.ts'),
    startLine: 16,
    endLine: 26,
    extraTabs: [
      { filePath: src('src/main.tsx'), startLine: 1, endLine: 10 },
      { filePath: src('src/App.tsx'), startLine: 1, endLine: 12 },
      // The two `@copilotkit/*` lines of the dependencies block. The file is
      // 28 lines, so the whole of it is on screen either way and the range is
      // only choosing what the eye lands on.
      { filePath: src('package.json'), startLine: 13, endLine: 14 },
    ],

    // Two terminals, because the page's whole subject is that a SPA needs a
    // second process. They are shown in the order the quickstart starts them:
    // the runtime first, then the app that talks to it.
    //
    // There is no command string here on purpose. Each session file was
    // written by `capture.ts` while that service was running and carries the
    // real working directory and the real argv, so the prompt line in the
    // video is recorded rather than composed. A missing or hand-started log
    // fails the recording instead of falling back to something plausible.
    terminals: [
      { label: 'tsx server.ts', logFile: logPathFor('runtime') },
      { label: 'vite', logFile: logPathFor('dev') },
    ],

    prompt: 'Hey, are you connected? Tell me a quick fun fact about kites.',
    waitAfterPromptMs: 4000,
  },
]);
