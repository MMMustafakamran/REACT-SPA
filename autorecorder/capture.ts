/**
 * Runs a service and records the terminal session the recorder replays.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The IDE's terminal panel has to show a *real* terminal, not a reconstruction
 * of one. An earlier version typed a command string out of `pages.config.ts`
 * and then printed a captured log underneath it, which meant the most visible
 * line on screen — the command itself — was the one piece of the frame nobody
 * had verified against reality. If someone edited the config, the video showed
 * a command that was never run.
 *
 * So nothing about the session is authored here either. This wrapper spawns
 * whatever you put after `--`, and writes a session file whose header is the
 * process's own resolved argv and working directory. The recorder renders that
 * header as the prompt line. The only way to change what the video shows is to
 * run a different command.
 *
 * ── Use ────────────────────────────────────────────────────────────────────
 *   npx tsx capture.ts npm-runtime -- npm exec tsx server.ts
 *   npx tsx capture.ts npm-dev     -- npm run dev
 *
 * The first argument names the session file (`videos/logs/<name>.log`). Output
 * is mirrored to this terminal as it arrives, so the wrapper is invisible in
 * use: you still watch your dev server exactly as you would have.
 *
 * Ctrl-C stops the child and this process together, leaving the file complete.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LOGS_DIR = join(__dirname, 'videos', 'logs');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');

if (sep === -1 || sep === 0 || sep === argv.length - 1) {
  console.error('usage: tsx capture.ts <session-name> -- <command> [args...]');
  console.error('   eg: tsx capture.ts npm-dev -- npm run dev');
  process.exit(2);
}

const sessionName = argv.slice(0, sep).join('-');
const command = argv.slice(sep + 1);

/**
 * The header the recorder reads.
 *
 * `cwd` is the process's actual working directory and `cmd` its actual argv —
 * both taken from the running process, never from a config file. Prefixed with
 * `#` so a human tailing the log sees a comment rather than noise.
 */
const cwd = process.cwd();
const header = [`#cwd ${cwd}`, `#cmd ${command.join(' ')}`, ''].join('\n');

mkdirSync(LOGS_DIR, { recursive: true });
const logPath = join(LOGS_DIR, `${sessionName}.log`);
const log = createWriteStream(logPath, { flags: 'w' });
log.write(header);

console.log(`[capture] ${command.join(' ')}`);
console.log(`[capture] session -> ${logPath}\n`);

// `shell: true` because the commands being captured are package-manager
// invocations (`npm run dev`), which on Windows are .cmd shims that cannot be
// spawned directly.
const child = spawn(command[0], command.slice(1), {
  cwd,
  shell: true,
  stdio: ['inherit', 'pipe', 'pipe'],
});

const mirror = (chunk: Buffer, to: NodeJS.WriteStream) => {
  to.write(chunk);
  log.write(chunk);
};

child.stdout?.on('data', (c: Buffer) => mirror(c, process.stdout));
child.stderr?.on('data', (c: Buffer) => mirror(c, process.stderr));

const stop = () => {
  child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

child.on('exit', (code) => {
  log.end();
  process.exit(code ?? 0);
});
