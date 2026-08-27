/**
 * Shared paths, ports and tracks for the CI/CD pipeline.
 *
 * Everything under ci/ imports from here rather than rebuilding paths, so a
 * moved folder or a changed port is a one-line edit.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const CI_DIR = path.join(ROOT_DIR, 'ci');
export const RECORDER_DIR = path.join(ROOT_DIR, 'autorecorder');
export const VIDEOS_DIR = path.join(RECORDER_DIR, 'videos');
export const LOGS_DIR = path.join(VIDEOS_DIR, 'logs');
export const SNAPSHOT_DIR = path.join(ROOT_DIR, 'doc-snapshot');

export const isWindows = process.platform === 'win32';

/**
 * Prefix for CI artifact names. Matches the recorded video filenames
 * (`RSPA-npm-01-Quickstart.webm`) so a downloaded folder and the clips inside
 * it read as the same thing.
 */
export const PROJECT_SLUG = 'React-SPA';

/**
 * The three scaffolds, one per install tab the quickstart publishes.
 *
 * `install` is the only field that differs in substance — the page gives three
 * install tabs and then a *single* run step for all of them, so `runtime` and
 * `dev` carry the page's own `npx`/`npm` commands except where the manager's
 * own equivalent is what a reader on that tab would type.
 *
 * These strings are what the recorded terminal shows, because `capture.ts`
 * records the argv it was handed. Changing one changes the video, which is the
 * only way it should be possible to change the video.
 */
export const TRACKS = {
  npm: {
    dir: path.join(ROOT_DIR, 'Npm', 'my-copilot-app'),
    install: 'npm install',
    runtime: 'npm exec tsx server.ts',
    dev: 'npm run dev',
    lockfile: 'package-lock.json',
  },
  pnpm: {
    dir: path.join(ROOT_DIR, 'Pnpm', 'my-copilot-app'),
    install: 'pnpm install',
    runtime: 'pnpm exec tsx server.ts',
    dev: 'pnpm run dev',
    lockfile: 'pnpm-lock.yaml',
  },
  yarn: {
    dir: path.join(ROOT_DIR, 'Yarn', 'my-copilot-app'),
    install: 'yarn install --non-interactive --network-timeout 600000',
    // Deliberately the page's own commands rather than yarn equivalents it
    // never publishes. See ci/README.md § "Why yarn runs npm commands".
    runtime: 'npx tsx server.ts',
    dev: 'npm run dev',
    lockfile: 'yarn.lock',
  },
};

export const TRACK_NAMES = Object.keys(TRACKS);

/**
 * Both services, on the ports the doc page names.
 *
 * 8200 and 5173 are not arbitrary defaults here — they are what `server.ts`
 * hardcodes and what Vite chooses, and the page's whole subject is that these
 * are two different origins. Overriding them would mean the run stopped
 * testing the thing the page teaches, so there is no env override.
 *
 * Note that Vite ignores the PORT environment variable — the page says so —
 * so moving the app would mean `--port`, not a variable.
 */
export const RUNTIME_PORT = 8200;
export const FRONTEND_PORT = 5173;

export const RUNTIME_URL = `http://127.0.0.1:${RUNTIME_PORT}`;
export const RUNTIME_HEALTH_URL = `${RUNTIME_URL}/api/copilotkit/info`;
export const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
