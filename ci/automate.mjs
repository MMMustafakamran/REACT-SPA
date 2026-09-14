/**
 * The pipeline entry point, used identically by a developer and by CI.
 *
 * Everything runs inside this one Node process on purpose. Each `run:` step in
 * a GitHub Actions job is its own subshell, so a server started with `&` in one
 * step is reaped before the next step begins. Spawning the services here keeps
 * them alive for as long as the recorder needs them.
 *
 * ── The shape of a run ─────────────────────────────────────────────────────
 *   0. doc drift        gating severity halts here, before anything is spent
 *   1. preflight        env, ports, model credential
 *   2. install          per track
 *   3. capture + serve  runtime :8200 and Vite :5173, through capture.ts
 *   4. health           poll until both answer
 *   5. record           hand off to the autorecorder for that track
 *
 * Steps 2-5 repeat per track (npm, pnpm, yarn). Every track binds the same two
 * ports, so they run strictly one after another and each one's servers are
 * torn down before the next starts.
 *
 * Flags:
 *   --tracks=npm,pnpm     which scaffolds to run (default: all three)
 *   --skip-install        skip dependency installation
 *   --use-lockfile        install the committed lockfiles instead of re-resolving
 *   --ignore-doc-drift    record even if the live docs moved (alias: --force)
 *   --skip-credential-check
 *   --pull                git pull first
 *
 * Anything else is forwarded to the recorder.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkAllDocDrift, renderDriftMarkdown } from './check-doc-drift.mjs';
import {
  FRONTEND_URLS,
  LOGS_DIR,
  RECORDER_DIR,
  ROOT_DIR,
  RUNTIME_HEALTH_URLS,
  TRACKS,
  TRACK_NAMES,
  VIDEOS_DIR,
  isWindows,
} from './lib/config.mjs';
import { loadEnvFiles, trimInheritedCredentials } from './lib/env.mjs';
import { assertModelCredentials, assertPortsFree } from './lib/preflight.mjs';
import { generateReport } from './lib/report.mjs';

const OWN_FLAGS = [
  '--skip-install',
  '--use-lockfile',
  '--ignore-doc-drift',
  '--force',
  '--skip-credential-check',
  '--pull',
];

const args = process.argv.slice(2);
const shouldPull = args.includes('--pull');
const shouldRefresh = !args.includes('--use-lockfile');
const skipInstall = args.includes('--skip-install');
const ignoreDocDrift = args.includes('--ignore-doc-drift') || args.includes('--force');
const skipCredentialCheck = args.includes('--skip-credential-check');

const trackArg = args.find((a) => a.startsWith('--tracks='));
const selectedTracks = trackArg
  ? trackArg
      .slice('--tracks='.length)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  : TRACK_NAMES;

for (const t of selectedTracks) {
  if (!TRACKS[t]) {
    console.error(`Unknown track "${t}". Known tracks: ${TRACK_NAMES.join(', ')}`);
    process.exit(2);
  }
}

// `--force` also means "record anyway" to the recorder, so it is forwarded.
const forwardArgs = args.filter(
  (a) => (!OWN_FLAGS.includes(a) && !a.startsWith('--tracks=')) || a === '--force',
);

console.log('═══════════════════════════════════════════════════════════════');
console.log('  🚀 React SPA — doc verification & recording pipeline');
console.log('═══════════════════════════════════════════════════════════════');

/** Live children, torn down on any exit path. */
let running = [];

function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (isWindows) {
      execSync(`taskkill /pid ${proc.pid} /T /F 2>nul || exit 0`, { stdio: 'ignore' });
    } else {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
    }
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

function stopServices() {
  if (running.length === 0) return;
  console.log('\n🧹 Stopping services...');
  for (const { proc, fd } of running) {
    killTree(proc);
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
  running = [];
}

process.on('SIGINT', () => {
  stopServices();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopServices();
  process.exit(143);
});
process.on('exit', stopServices);

function runSync(command, cwd, description) {
  console.log(`\n▶ [Step] ${description}...`);
  try {
    execSync(command, { cwd, stdio: 'inherit', shell: true });
  } catch (err) {
    console.error(`❌ Failed during: ${description}`);
    throw err;
  }
}

/**
 * Start a service through the recorder's capture wrapper.
 *
 * This is the one place the pipeline is not free to spawn things however it
 * likes. The IDE's terminal panel replays a session file whose header is the
 * running process's own cwd and argv, so a service started any other way
 * leaves no session and the recording fails at the doctor — which is the
 * intended behaviour, not an inconvenience to route around.
 *
 * Piping a server's stdio through Node deadlocks once the OS pipe buffer
 * fills, so the wrapper's own mirrored output goes to a file. The session file
 * capture.ts writes is separate and is what the video uses.
 */
function startService(track, service, command) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const debugLog = path.join(LOGS_DIR, `${track}-${service}.console.log`);
  const fd = fs.openSync(debugLog, 'w');

  const capture = path.join(RECORDER_DIR, 'capture.ts');
  const proc = spawn(`npx tsx "${capture}" ${track}-${service} -- ${command}`, {
    cwd: TRACKS[track].dir,
    stdio: ['ignore', fd, fd],
    shell: true,
    detached: !isWindows,
    env: process.env,
  });

  running.push({ proc, fd });
  return { proc, debugLog };
}

function tailLog(logPath, lines = 25) {
  try {
    return fs.readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log captured)';
  }
}

/**
 * Poll until one of a service's addresses answers.
 *
 * `urls` is a list because a port is not one endpoint: a server bound to
 * `localhost` may hold `::1` and not `127.0.0.1`, or the reverse, depending on
 * how the host's resolver orders the two. Probing one family and calling the
 * service dead is how every CI run here failed while the server was up. See
 * `loopbackUrls` in lib/config.mjs.
 *
 * A response that arrives but is not ok is remembered rather than ignored, so
 * a timeout can say "answered 403 on ::1" instead of leaving a reachable but
 * unhappy server indistinguishable from one that never bound.
 */
async function waitForHealth(urls, name, logPath, timeoutMs = 90000) {
  const start = Date.now();
  const candidates = Array.isArray(urls) ? urls : [urls];
  const lastStatus = new Map();
  process.stdout.write(`⏳ Waiting for ${name} (${candidates.join(' or ')})... `);

  while (Date.now() - start < timeoutMs) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          process.stdout.write(`✅ READY at ${url} (${elapsed}s)\n`);
          return Number(elapsed);
        }
        lastStatus.set(url, `HTTP ${res.status}`);
      } catch (err) {
        lastStatus.set(url, err.cause?.code || err.name || 'unreachable');
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write('.');
  }

  const seen = candidates.map((u) => `${u} -> ${lastStatus.get(u) ?? 'no response'}`).join(', ');
  process.stdout.write('❌ TIMEOUT\n');
  console.error(`   last seen: ${seen}`);
  console.error(`\n──── last lines of ${path.basename(logPath)} ────`);
  console.error(tailLog(logPath));
  console.error('─'.repeat(44) + '\n');
  throw new Error(`Timeout waiting for ${name} (${seen}). See ${logPath}`);
}

/**
 * Install one track's dependencies.
 *
 * By default the lockfile is dropped first, so the manager resolves the newest
 * versions the ranges in package.json already allow. That is the point of these
 * runs: they verify a published page, so they should verify it against the
 * CopilotKit that shipped, not one pinned months ago. `@copilotkit/*` is a
 * caret range, so a release is tested the night it lands and a major still
 * cannot arrive without someone editing the manifest.
 *
 * `--use-lockfile` opts back in, for reproducing an older run or telling a
 * broken page apart from a broken dependency tree.
 */
function installTrack(track) {
  const { dir, install, lockfile } = TRACKS[track];
  if (shouldRefresh) {
    const lockPath = path.join(dir, lockfile);
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath);
      console.log(`   ↻ ${track}: dropped ${lockfile} to resolve the ranges afresh`);
    }
  }
  runSync(install, dir, `Installing ${track} dependencies`);
}

/**
 * Materialise the `.env` the page now tells the reader to create beside
 * `server.ts`.
 *
 * The runtime command carries `--env-file=.env`, so the key has to be in that
 * file — a standalone Node process does not read the ambient environment's
 * `.env`, which is exactly the trap the page added the flag for. The file is
 * gitignored (the page says to ignore it before creating it), so it cannot be
 * committed; it is written here from whatever `OPENAI_API_KEY` preflight
 * already loaded. An existing `.env` is left alone.
 */
function writeTrackEnvFile(track) {
  const { dir } = TRACKS[track];
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) {
    console.log(`   🔑 ${track}: using the .env already beside server.ts`);
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.log(`   ⚠️ ${track}: no OPENAI_API_KEY to write into .env; the runtime will start without one.`);
    return;
  }
  fs.writeFileSync(envPath, `OPENAI_API_KEY=${key}\n`);
  console.log(`   🔑 ${track}: wrote .env beside server.ts for --env-file`);
}

async function runTrack(track, report) {
  const t = TRACKS[track];
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log(`  ▶ TRACK: ${track}`);
  console.log('───────────────────────────────────────────────────────────────');

  // A previous track's servers must be gone before this one binds the ports.
  stopServices();
  assertPortsFree();

  if (!skipInstall) installTrack(track);

  writeTrackEnvFile(track);

  console.log(`\n▶ [Step] Starting Copilot Runtime (${t.runtime})...`);
  const runtime = startService(track, 'runtime', t.runtime);

  console.log(`▶ [Step] Starting the app (${t.dev})...`);
  const dev = startService(track, 'dev', t.dev);

  const health = {
    runtime: await waitForHealth(RUNTIME_HEALTH_URLS, `${track} Copilot Runtime`, runtime.debugLog),
    frontend: await waitForHealth(FRONTEND_URLS, `${track} Vite app`, dev.debugLog),
  };
  report.tracks[track] = { health };

  console.log('\n▶ [Step] Running the autorecorder...');
  const recorderCmd =
    forwardArgs.length > 0 ? `npm run record -- ${forwardArgs.join(' ')}` : 'npm run record';
  // The recorder writes videos/RECORD_RESULTS.json for the run it just did.
  // Three tracks record in turn, so each one's file is moved aside under the
  // track's name before the next overwrites it; the report reads those.
  const resultsFile = path.join(VIDEOS_DIR, 'RECORD_RESULTS.json');
  const trackResultsFile = path.join(VIDEOS_DIR, `RECORD_RESULTS.${track}.json`);
  fs.rmSync(resultsFile, { force: true });
  fs.rmSync(trackResultsFile, { force: true });
  try {
    runSync(
      isWindows ? `set TRACK=${track}&& ${recorderCmd}` : `TRACK=${track} ${recorderCmd}`,
      RECORDER_DIR,
      `Recording the ${track} track`,
    );
  } finally {
    if (fs.existsSync(resultsFile)) fs.renameSync(resultsFile, trackResultsFile);
  }

  report.tracks[track].recorded = true;
  stopServices();
}

async function main() {
  const report = {
    success: false,
    driftResult: null,
    tracks: {},
    error: null,
    args: forwardArgs,
    selectedTracks,
    refreshed: shouldRefresh,
  };

  try {
    // ── 0. Doc drift ───────────────────────────────────────────────────────
    console.log('\n▶ [Step 0] Checking live docs against doc-snapshot/...');
    const drift = await checkAllDocDrift();
    report.driftResult = drift;

    for (const e of drift.errors) {
      console.warn(`   ⚠️  ${e.docPath}: ${e.error}`);
    }

    if (drift.drifted) {
      const markdown = renderDriftMarkdown(drift);
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
      const driftPath = path.join(VIDEOS_DIR, 'DOC_DRIFT.md');
      fs.writeFileSync(driftPath, `${markdown}\n`, 'utf8');

      console.log('');
      console.log(markdown);
      console.log(`\n   (also written to ${path.relative(ROOT_DIR, driftPath)})`);

      if (drift.gating && !ignoreDocDrift) {
        console.log(
          '\n🚨 Halting: the page moved in a way that invalidates what is under test.',
        );
        console.log('👉 Review, then `node ci/check-doc-drift.mjs --update`, then re-run.');
        console.log('👉 To record anyway, pass --ignore-doc-drift.');
        generateReport(report);
        process.exit(2);
      }

      if (drift.gating) {
        console.log('\n⚠️ --ignore-doc-drift given; recording against a stale snapshot.\n');
      }
    } else if (drift.errors.length > 0) {
      console.log(
        `⚠️  Drift unknown: ${drift.errors.length} of ${drift.total} pages could not be read;` +
          ` the other ${drift.total - drift.errors.length} match the local snapshot.`,
      );
    } else {
      console.log(`✅ All ${drift.total} doc pages match the local snapshot.`);
    }

    // ── 1. Preflight ───────────────────────────────────────────────────────
    const envFiles = loadEnvFiles();
    if (envFiles.length > 0) {
      console.log(`\n🔑 [Preflight] Loaded environment from: ${envFiles.join(', ')}`);
    }
    const trimmed = trimInheritedCredentials();
    if (trimmed.length > 0) {
      console.log(
        `🔑 [Preflight] Trimmed surrounding whitespace from: ${trimmed.join(', ')}` +
          ' — worth fixing at the source, a stored secret is keeping a stray newline.',
      );
    }
    assertPortsFree();
    if (!skipCredentialCheck) await assertModelCredentials();

    if (shouldPull) runSync('git pull', ROOT_DIR, 'Updating repository (git pull)');

    if (!skipInstall) runSync('npm install', RECORDER_DIR, 'Installing autorecorder dependencies');

    // ── 2-5. Per track ─────────────────────────────────────────────────────
    for (const track of selectedTracks) {
      await runTrack(track, report);
    }

    report.success = true;
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  🎉 Completed. Tracks recorded: ${selectedTracks.join(', ')}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
  } catch (err) {
    report.error = err.message || String(err);
    console.error('\n❌ Pipeline failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    generateReport(report);
    stopServices();
  }
}

main();
