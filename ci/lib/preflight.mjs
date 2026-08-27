/**
 * Checks that run before anything expensive starts.
 *
 * Each one exists because it actually cost a run in this repo:
 *  - a uvicorn from a sibling repo was found holding `0.0.0.0:8200` while the
 *    runtime held `::`; `localhost` reached the runtime and `127.0.0.1` reached
 *    uvicorn, which answered `{"detail":"Not Found"}` and looked exactly like a
 *    broken runtime
 *  - two recordings failed with the agent never answering, and both runtime
 *    logs held a ConnectTimeoutError against api.openai.com — a credential and
 *    reachability check up front turns twenty wasted minutes into ten seconds
 */
import { execSync } from 'node:child_process';
import { FRONTEND_PORT, RUNTIME_PORT, isWindows } from './config.mjs';

/** PIDs currently listening on a port. Empty when the port is free. */
export function listenersOnPort(port) {
  try {
    if (isWindows) {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = out
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && /^\d+$/.test(pid) && pid !== '0');
      return [...new Set(pids)];
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(out.split(/\r?\n/).filter(Boolean))];
  } catch {
    // Non-zero exit from netstat/lsof means "nothing matched".
    return [];
  }
}

/**
 * Refuse to start on top of an already-bound port.
 *
 * Windows will happily let a second process bind a port another is already
 * listening on, and requests then land on whichever accepts first. A stale
 * server carrying old environment variables is indistinguishable from the new
 * one, so this fails loudly rather than guessing.
 *
 * There is no `--allow-port-reuse` here, unlike the sibling repos. Reusing a
 * running server would mean the terminal panel replays a session file from
 * some earlier process while the video shows a different one answering — the
 * one thing this repo's recorder promises not to do.
 */
export function assertPortsFree() {
  const conflicts = [];
  for (const [name, port] of [
    ['runtime', RUNTIME_PORT],
    ['frontend', FRONTEND_PORT],
  ]) {
    const pids = listenersOnPort(port);
    if (pids.length > 0) conflicts.push({ name, port, pids });
  }

  if (conflicts.length === 0) return;

  console.error('\n🔍 [Preflight] Ports already in use:');
  for (const c of conflicts) {
    console.error(`   [x] ${c.name} port ${c.port} held by PID(s): ${c.pids.join(', ')}`);
  }
  console.error(
    '\n❌ Refusing to start a second server on a busy port — a stale process may hold\n' +
      '   outdated environment variables and answer requests instead of the new one,\n' +
      '   and the recorded terminal session would not be the process being filmed.\n' +
      '   Stop the listed PIDs and re-run.\n',
  );
  throw new Error(`Port(s) in use: ${conflicts.map((c) => `${c.name}:${c.port}`).join(', ')}`);
}

/**
 * Confirm a usable model credential before recording anything.
 *
 * Cheap here, expensive later: without it the run reaches the demo step and
 * fails there, having spent an install and two server boots on it.
 */
export async function assertModelCredentials() {
  const key = process.env.OPENAI_API_KEY;

  if (!key || key.trim() === '' || key.trim() === 'sk-...') {
    throw new Error(
      'OPENAI_API_KEY is missing or still the placeholder ("sk-...").\n' +
        'The doc page has you export it in the terminal running server.ts; the\n' +
        'pipeline passes it to that process, so it has to be set here first.',
    );
  }

  process.stdout.write('⏳ [Preflight] Verifying model credentials... ');
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) {
      process.stdout.write('❌\n');
      throw new Error(`OPENAI_API_KEY rejected by OpenAI (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      // Rate limits and transient 5xx are not a reason to block a run.
      process.stdout.write(`⚠️ inconclusive (HTTP ${res.status}); continuing.\n`);
      return;
    }
    process.stdout.write('✅ valid\n');
  } catch (err) {
    if (err instanceof Error && /rejected by OpenAI/.test(err.message)) throw err;
    // Worth saying rather than swallowing: this is the exact failure mode that
    // produced the two "agent never answered" recordings.
    process.stdout.write('⚠️ could not reach api.openai.com; the demo step may time out.\n');
  }
}
