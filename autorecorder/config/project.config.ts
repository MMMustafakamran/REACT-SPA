/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ADAPT THIS FILE — 1 of 3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Who this project is: which CopilotKit integration it tests, where its docs
 * live, and how its two services are reached and started.
 *
 * Everything else derives from this. Doc and demo URLs are built from
 * `docBaseUrl` and `frontendUrl`, so a page never repeats them and no page can
 * point at a different framework's docs by accident.
 *
 * `npm run doctor` rejects any field still set to REPLACE_ME, so a half-done
 * adaptation cannot pass as finished.
 *
 * ── What is different about this repo ──────────────────────────────────────
 * Other repos in this family record one Next.js app with a demo route per doc
 * page. `/react-spa` documents a *single* page whose whole subject is that a
 * single-page app has no server, so the app under test is the Vite project the
 * quickstart tells the reader to create, and the "backend" is the standalone
 * Copilot Runtime the same page tells them to write.
 *
 * The quickstart publishes npm, pnpm and yarn install tabs over byte-identical
 * source, so the repo carries one scaffold per package manager and `TRACK`
 * selects which one a run drives. Both tracks bind the same ports, so they run
 * one after the other, never at once.
 */

/** Sentinel for values an adaptation must supply. Doctor fails while any remain. */
export const REPLACE_ME = 'REPLACE_ME' as const;

/**
 * Which package-manager scaffold this run records.
 *
 * One per install tab the quickstart publishes. The source is byte-identical
 * across all three — only resolution differs, which is exactly what a per-track
 * run is for.
 */
export type Track = 'npm' | 'pnpm' | 'yarn';

const TRACK: Track = (process.env.TRACK as Track) || 'npm';

/** Repo-relative root of the scaffold being recorded. Prefixes every `ideFile`. */
const TRACK_DIRS: Record<Track, string> = {
  npm: 'Npm/my-copilot-app',
  pnpm: 'Pnpm/my-copilot-app',
  yarn: 'Yarn/my-copilot-app',
};

/**
 * How each track starts its two services.
 *
 * Only the npm entry is the doc's own wording. The quickstart publishes three
 * *install* tabs, then gives one run step for all of them — `npx tsx server.ts`
 * and `npm run dev`, with no per-manager variant. The pnpm entry here is the
 * literal translation of that step, and the yarn track deliberately keeps the
 * doc's npx/npm commands rather than inventing yarn equivalents the page never
 * publishes: what is under test is the page, not our idea of it.
 */
const TRACK_CMDS: Record<Track, { dev: string; exec: string }> = {
  npm: { dev: 'npm run dev', exec: 'npm exec tsx server.ts' },
  pnpm: { dev: 'pnpm run dev', exec: 'pnpm exec tsx server.ts' },
  yarn: { dev: 'npm run dev', exec: 'npx tsx server.ts' },
};

export interface ProjectConfig {
  /**
   * Doc slug, exactly as it appears in the URL:
   * `https://docs.copilotkit.ai/<framework>/...`
   */
  framework: string;

  /** Human name for logs and the README. */
  frameworkLabel: string;

  /**
   * Filename prefix for exported videos. Files are named
   * `<videoPrefix>-<NN>-<videoName>.webm`, the index coming from page order.
   * Carries the track, so an npm run and a pnpm run cannot overwrite each other.
   */
  videoPrefix: string;

  /** Doc root this repo tracks. Every page's docPath is appended to it. */
  docBaseUrl: string;

  /** Where the app runs. Every page's route is appended to it. */
  frontendUrl: string;

  /** Where the runtime runs. Used only for the pre-flight health check. */
  backendUrl: string;

  /** Health path on the backend. The check falls back to `/docs` then `/`. */
  backendHealthPath: string;

  /** Printed verbatim when the pre-flight check fails, so the fix is copy-pasteable. */
  frontendStartCmd: string;
  backendStartCmd: string;

  /**
   * Appended to each page's route to reach the chrome-free demo.
   * Empty here: the SPA *is* the demo. There is no chrome to strip and no
   * router to add a segment to.
   */
  demoSuffix: string;

  /**
   * Project-wide overrides of the recorder's fixed waits. Optional; the
   * defaults in `core/timeouts.ts` suit a warm Next.js dev server. Raise
   * `demoNavMs` for a stack whose first request compiles the route.
   */
  timeouts?: Partial<import('../core/types').RecorderTimeouts>;

  /** Which scaffold is being recorded. */
  track: Track;

  /** Repo-relative root of that scaffold. `pages.config.ts` builds ideFiles from it. */
  projectDir: string;

  /** The exact command lines this track uses, typed into the recorded terminal. */
  devCmd: string;
  runtimeCmd: string;
}

export const PROJECT: ProjectConfig = {
  framework: 'react-spa',
  frameworkLabel: 'React SPA',
  videoPrefix: `RSPA-${TRACK}`,

  docBaseUrl: 'https://docs.copilotkit.ai/react-spa',

  // Vite's default. Note that Vite ignores the PORT environment variable --
  // the doc page says so explicitly -- so moving the app means `--port`, and
  // FRONTEND_URL here has to be changed to match by hand.
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // The quickstart's standalone runtime. Different origin from the app, on
  // purpose: that separation is the entire subject of the page.
  backendUrl: process.env.BACKEND_URL || 'http://localhost:8200',
  backendHealthPath: '/api/copilotkit/info',

  frontendStartCmd: `cd ${TRACK_DIRS[TRACK]} && ${TRACK_CMDS[TRACK].dev}`,
  backendStartCmd: `cd ${TRACK_DIRS[TRACK]} && ${TRACK_CMDS[TRACK].exec}`,

  demoSuffix: '',

  track: TRACK,
  projectDir: TRACK_DIRS[TRACK],
  devCmd: TRACK_CMDS[TRACK].dev,
  runtimeCmd: TRACK_CMDS[TRACK].exec,
};

/**
 * Where the recorded terminal reads a service's real output from.
 *
 * These logs are written by whoever starts the services — see the README's tee
 * commands, and `ci/` once the pipeline exists. The recorder never generates
 * this text; a missing log fails the run.
 */
export function logPathFor(service: 'runtime' | 'dev'): string {
  return `autorecorder/videos/logs/${TRACK}-${service}.log`;
}

/** Absolute doc URL for a page's `docPath`. */
export function docUrlFor(docPath: string): string {
  const base = PROJECT.docBaseUrl.replace(/\/$/, '');
  const path = docPath.replace(/^\//, '');
  // The one recordable page IS the doc root, so `docPath` is empty and a naive
  // join would leave a trailing slash. The docs site answers that with a 308.
  return path ? `${base}/${path}` : base;
}

/** Absolute demo URL for a page's `route`. */
export function demoUrlFor(route: string): string {
  return `${PROJECT.frontendUrl.replace(/\/$/, '')}/${route.replace(/^\//, '')}${PROJECT.demoSuffix}`;
}
