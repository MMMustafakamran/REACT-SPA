/**
 * Automated Screen Recording & Demonstration Pipeline
 * Entrypoint & CLI runner
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PAGES } from './config/pages.config';
import { PROJECT } from './config/project.config';
import { checkServicesHealth } from './core/diagnostics';
import { RecordingEngine } from './core/engine';
import { runDoctor } from './core/doctor';
import { parseShard, selectPages } from './core/select';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const VIDEOS_DIR = join(__dirname, 'videos');

/**
 * Per-run results, next to the videos.
 *
 * Page recordings had no record of their own, so the CI report listed every
 * `.webm` in the folder and marked them all "Recorded" — a run of one page
 * reported five, four of them days old. This is what the report reads instead.
 */
export const RESULTS_FILE = 'RECORD_RESULTS.json';

export interface PageResult {
  id: string;
  name: string;
  filename: string;
  success: boolean;
  durationSec: number;
  error?: string;
  warnings: string[];
  consoleErrors?: string[];
}

export interface RunResults {
  timestamp: string;
  args: string[];
  passed: number;
  failed: number;
  results: PageResult[];
}

/**
 * Both services must be up before any browser launches. Recording against a
 * dead backend produces a full-length video of a broken page, so this aborts
 * by default; `--force` records anyway when that is deliberately what you want.
 */
async function assertServicesUp(force: boolean): Promise<void> {
  const health = await checkServicesHealth();
  if (health.frontendOk && health.backendOk) return;

  console.error(`\n🔍 [Pre-flight Service Diagnostics]`);
  if (!health.backendOk) {
    console.error(
      `   [x] Agent backend ${PROJECT.backendUrl} unreachable: ${health.backendError}`,
    );
    console.error(`       Fix: ${PROJECT.backendStartCmd}`);
  }
  if (!health.frontendOk) {
    console.error(
      `   [x] Frontend ${PROJECT.frontendUrl} unreachable: ${health.frontendError}`,
    );
    console.error(`       Fix: ${PROJECT.frontendStartCmd}`);
  }

  if (force) {
    console.warn(`\n   ⚠️ --force given; recording anyway. Expect unusable video.\n`);
    return;
  }

  console.error(`\n❌ Aborting before launching a browser. Pass --force to override.\n`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`
🎬 npm run record -- [selection] [options]

Selection (default: every page, in nav order)
  --<page-id>, <page-id>     one page, e.g. --quickstart
  --page=<id>                same thing, explicit form
  --pages=<id,id>            exactly these pages (--only= is an alias)
  --filter=<text>            pages whose id or name contains the text
  <word> [<word> ...]        same as --filter, for each word
  --limit=<n>                first n of the selection (--first=, --count=)
  --shard=<k>/<n>            slice k of n, for matrix workers

Options
  --list, -l                 print every registered page and exit
  --doctor                   validate the configuration; exits 1 on error
  --doctor --online          also probe every doc/demo URL and the selectors
  --force                    record even if the pre-flight health check fails
  --help, -h                 this text

Results go to videos/${RESULTS_FILE}; the process exits 1 if any page failed.
`);
}

function printList(): void {
  console.log(`\n📋 REGISTERED RECORDING ROUTES (${PAGES.length} total):\n`);
  for (let i = 0; i < PAGES.length; i++) {
    const p = PAGES[i];
    console.log(`  ${String(i + 1).padStart(2, ' ')}. [${p.id}] ${p.name}`);
    console.log(`      Command: npm run record -- --${p.id}`);
    console.log(`      Doc:     ${p.docUrl}`);
    console.log(`      Demo:    ${p.demoUrl}`);
    console.log(`      File:    ${p.ideFile} (lines ${p.startLine}-${p.endLine})`);
  }
  console.log('');
}

/** The switches this command knows. Anything else is a page id or a search word. */
const OPTIONS = {
  force: { type: 'boolean', default: false },
  list: { type: 'boolean', short: 'l', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  doctor: { type: 'boolean', default: false },
  'verify-config': { type: 'boolean', default: false },
  online: { type: 'boolean', default: false },
  page: { type: 'string' },
  pages: { type: 'string' },
  only: { type: 'string' },
  filter: { type: 'string' },
  limit: { type: 'string' },
  first: { type: 'string' },
  count: { type: 'string' },
  shard: { type: 'string' },
} as const;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // `strict: false` so `--quickstart` is accepted without being declared: it
  // arrives as an unknown boolean, and unknown booleans are page ids or search
  // words. Everything the command actually acts on is declared above, so a
  // typo in a real switch cannot fall through and become a page search.
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  // Adaptation check. Static by default; --online also probes live URLs.
  if (values.doctor || values['verify-config']) {
    process.exit(await runDoctor(ROOT, { online: Boolean(values.online) }));
  }

  if (values.list || positionals.includes('list')) {
    printList();
    return;
  }

  const known = new Set(Object.keys(OPTIONS));
  const words = [
    ...Object.entries(values)
      .filter(([k, v]) => !known.has(k) && v === true)
      .map(([k]) => k),
    ...positionals.filter((p) => p !== 'list'),
  ].map((w) => w.replace(/^-+/, ''));

  const byId = (w: string): boolean => PAGES.some((p) => p.id.toLowerCase() === w.toLowerCase());
  const pageWord = words.find(byId);
  const queries = words.filter((w) => !byId(w));

  const limitRaw = values.limit ?? values.first ?? values.count;
  const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : undefined;
  const shard = parseShard(values.shard ? String(values.shard) : undefined);
  if (values.shard && !shard) {
    console.error(`❌ --shard expects K/N, got "${values.shard}"`);
    process.exit(1);
  }

  const idList = values.pages ?? values.only;
  const { pages: targetPages, shard: applied } = selectPages(PAGES, {
    ids: idList ? String(idList).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    page: values.page ? String(values.page) : pageWord,
    filter: values.filter ? String(values.filter) : undefined,
    queries,
    limit: limit && Number.isFinite(limit) ? limit : undefined,
    shard,
  });

  if (applied) {
    console.log(
      `\n🧩 [Matrix Sharding]: Worker Shard ${applied.index}/${applied.total} -> Recording ${targetPages.length} pages (index ${applied.from + 1} to ${applied.to})`,
    );
  }

  if (targetPages.length === 0) {
    // A shard with nothing to do is normal when there are fewer pages than
    // workers; failing it would fail the matrix for no reason.
    if (applied) {
      console.log(`\nℹ️ [Matrix Sharding]: No pages assigned to this worker shard. Exiting cleanly.`);
      process.exit(0);
    }
    console.error(`❌ No matching page found for: ${rawArgs.join(' ') || '(nothing)'}`);
    console.log(`Available page IDs: ${PAGES.map((p) => p.id).join(', ')}`);
    console.log(`Tip: run \`npm run record -- --list\` to view all routes.`);
    process.exit(1);
  }

  await assertServicesUp(Boolean(values.force));

  console.log(`\n======================================================`);
  console.log(
    `🎬 STARTING AUTOMATED RECORDING FOR ${targetPages.length} PAGE(S)`,
  );
  console.log(`======================================================\n`);

  const engine = new RecordingEngine(ROOT);
  const results: PageResult[] = [];
  const suiteStartTime = Date.now();

  for (const pageConfig of targetPages) {
    const pageStartTime = Date.now();
    const res = await engine.recordPage(pageConfig);
    const durationSec = Number(((Date.now() - pageStartTime) / 1000).toFixed(1));

    results.push({
      id: pageConfig.id,
      name: pageConfig.name,
      filename: res.filename,
      success: res.success,
      durationSec,
      error: res.error,
      warnings: res.warnings,
      consoleErrors: res.consoleErrors,
    });
  }

  const totalDuration = ((Date.now() - suiteStartTime) / 1000).toFixed(1);
  const failedCount = results.filter((r) => !r.success).length;
  const warnedCount = results.filter((r) => r.success && r.warnings.length > 0).length;

  console.log(`\n======================================================`);
  console.log(`📊 RECORDING SUITE SUMMARY (Total: ${totalDuration}s)`);
  console.log(`======================================================`);
  for (const r of results) {
    if (r.success) {
      const badge = r.warnings.length > 0 ? '⚠️  [PASS*]' : '✅ [PASS] ';
      console.log(`   ${badge} (${r.durationSec}s) ${r.name} -> ${r.filename}`);
    } else {
      console.log(
        `   ❌ [FAIL]  (${r.durationSec}s) ${r.name} -> ${r.filename || '(no video)'}`,
      );
      console.log(`        · ${r.error || 'Error captured'}`);
    }
    for (const w of r.warnings) console.log(`        · ${w}`);
  }
  console.log(`======================================================`);
  console.log(
    `   ${results.length - failedCount} passed` +
      (warnedCount > 0 ? ` (${warnedCount} with notes)` : '') +
      `, ${failedCount} failed`,
  );

  const run: RunResults = {
    timestamp: new Date().toISOString(),
    args: rawArgs,
    passed: results.length - failedCount,
    failed: failedCount,
    results,
  };
  mkdirSync(VIDEOS_DIR, { recursive: true });
  writeFileSync(join(VIDEOS_DIR, RESULTS_FILE), JSON.stringify(run, null, 2), 'utf-8');
  console.log(`📁 Video files saved to: ${VIDEOS_DIR}`);
  console.log(`📄 Results: ${join(VIDEOS_DIR, RESULTS_FILE)}\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal recording error:', err);
  process.exit(1);
});
