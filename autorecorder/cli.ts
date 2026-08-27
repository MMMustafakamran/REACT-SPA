/**
 * Automated Screen Recording & Demonstration Pipeline
 * Entrypoint & CLI runner
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './config/pages.config';
import { PROJECT } from './config/project.config';
import { checkServicesHealth } from './core/diagnostics';
import { RecordingEngine } from './core/engine';
import { runDoctor } from './core/doctor';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

interface PageResult {
  id: string;
  name: string;
  filename: string;
  success: boolean;
  durationSec: number;
  error?: string;
  warnings: string[];
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

/** Global switches that must never be mistaken for a page id or filter query. */
const GLOBAL_FLAGS = new Set([
  '--force',
  '--list',
  '-l',
  'list',
  '--help',
  '-h',
  '--doctor',
  '--verify-config',
  '--online',
  '--limit',
  '--first',
  '--count',
  '--shard',
]);

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  // Selection args only; `--force` etc. would otherwise fall through to the
  // substring filter below and match zero pages.
  const args = rawArgs.filter((a) => {
    if (GLOBAL_FLAGS.has(a)) return false;
    if (
      a.startsWith('--limit=') ||
      a.startsWith('--first=') ||
      a.startsWith('--count=') ||
      a.startsWith('--shard=')
    ) {
      return false;
    }
    return true;
  });
  const isListMode =
    rawArgs.includes('--list') ||
    rawArgs.includes('-l') ||
    rawArgs.includes('list') ||
    rawArgs.includes('--help') ||
    rawArgs.includes('-h');

  // Adaptation check. Static by default; --online also probes live URLs.
  if (rawArgs.includes('--doctor') || rawArgs.includes('--verify-config')) {
    process.exit(await runDoctor(ROOT, { online: rawArgs.includes('--online') }));
  }

  if (isListMode) {
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
    return;
  }

  // 1. Check for explicit --page=xxx or --page xxx
  let pageArg: string | undefined = args
    .find((a) => a.startsWith('--page='))
    ?.split('=')[1];
  if (!pageArg) {
    const pageIndex = args.indexOf('--page');
    if (pageIndex !== -1 && args[pageIndex + 1]) {
      pageArg = args[pageIndex + 1];
    }
  }

  // 2. Check for direct page flag like --quickstart, -quickstart, --slots, etc.
  if (!pageArg) {
    for (const arg of args) {
      const cleanArg = arg.replace(/^-+/, '').toLowerCase();
      const matchedPage = PAGES.find((p) => p.id.toLowerCase() === cleanArg);
      if (matchedPage) {
        pageArg = matchedPage.id;
        break;
      }
    }
  }

  // 3. Check for positional argument matching a page ID (e.g. `npm run record quickstart`)
  if (!pageArg) {
    for (const arg of args) {
      if (!arg.startsWith('-')) {
        const cleanArg = arg.toLowerCase();
        const matchedPage = PAGES.find((p) => p.id.toLowerCase() === cleanArg);
        if (matchedPage) {
          pageArg = matchedPage.id;
          break;
        }
      }
    }
  }

  // 4. Check for filter flag: --filter=xxx or --filter xxx
  let filterArg: string | undefined = args
    .find((a) => a.startsWith('--filter='))
    ?.split('=')[1];
  if (!filterArg) {
    const filterIndex = args.indexOf('--filter');
    if (filterIndex !== -1 && args[filterIndex + 1]) {
      filterArg = args[filterIndex + 1];
    }
  }

  // 4. Determine pages to record
  const multiPagesArg = rawArgs.find((a) => a.startsWith('--pages=') || a.startsWith('--only='));
  let targetPages = PAGES;

  if (multiPagesArg) {
    const ids = multiPagesArg
      .split('=')[1]
      .split(',')
      .map((s) => s.trim().toLowerCase());
    targetPages = PAGES.filter((p) => ids.includes(p.id.toLowerCase()));
  } else if (pageArg) {
    targetPages = PAGES.filter(
      (p) => p.id.toLowerCase() === pageArg!.toLowerCase(),
    );
  } else if (filterArg) {
    const q = filterArg.toLowerCase();
    targetPages = PAGES.filter(
      (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
    );
  } else if (args.length > 0) {
    const queries = args.map((a) => a.replace(/^-+/, '').toLowerCase());
    targetPages = PAGES.filter((p) =>
      queries.some(
        (q) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      ),
    );
  }

  // 5. Check for limit flag: --limit=N or --first=N
  let limitArg: number | undefined;
  const limitMatch = rawArgs.find(
    (a) => a.startsWith('--limit=') || a.startsWith('--first=') || a.startsWith('--count='),
  );
  if (limitMatch) {
    const num = parseInt(limitMatch.split('=')[1], 10);
    if (!isNaN(num) && num > 0) limitArg = num;
  } else {
    const limitIndex = rawArgs.findIndex(
      (a) => a === '--limit' || a === '--first' || a === '--count',
    );
    if (limitIndex !== -1 && rawArgs[limitIndex + 1]) {
      const num = parseInt(rawArgs[limitIndex + 1], 10);
      if (!isNaN(num) && num > 0) limitArg = num;
    }
  }

  if (limitArg && limitArg > 0) {
    targetPages = targetPages.slice(0, limitArg);
  }

  // 6. Check for shard flag: --shard=K/N (e.g. --shard=1/3, --shard=2/3)
  const shardMatch = rawArgs.find((a) => a.startsWith('--shard='));
  if (shardMatch) {
    const val = shardMatch.split('=')[1] || '';
    const parts = val.split('/');
    if (parts.length === 2) {
      const curr = parseInt(parts[0], 10);
      const total = parseInt(parts[1], 10);
      if (!isNaN(curr) && !isNaN(total) && total > 0 && curr > 0 && curr <= total) {
        const chunkSize = Math.ceil(targetPages.length / total);
        const start = (curr - 1) * chunkSize;
        const end = Math.min(start + chunkSize, targetPages.length);
        targetPages = targetPages.slice(start, end);
        console.log(`\n🧩 [Matrix Sharding]: Worker Shard ${curr}/${total} -> Recording ${targetPages.length} pages (index ${start + 1} to ${end})`);
      }
    }
  }

  if (targetPages.length === 0) {
    if (shardMatch) {
      console.log(
        `\nℹ️ [Matrix Sharding]: No pages assigned to this worker shard. Exiting cleanly.`,
      );
      process.exit(0);
    }
    console.error(`❌ No matching page found for query: ${args.join(' ')}`);
    console.log(`Available page IDs: ${PAGES.map((p) => p.id).join(', ')}`);
    console.log(`Tip: run \`npm run record -- --list\` to view all routes.`);
    process.exit(1);
  }

  await assertServicesUp(rawArgs.includes('--force'));

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
      for (const w of r.warnings) console.log(`        · ${w}`);
    } else {
      console.log(
        `   ❌ [FAIL]  (${r.durationSec}s) ${r.name} -> ${r.filename}`,
      );
      console.log(`        · ${r.error || 'Error captured'}`);
    }
  }
  console.log(`======================================================`);
  console.log(
    `   ${results.length - failedCount} passed` +
      (warnedCount > 0 ? ` (${warnedCount} with notes)` : '') +
      `, ${failedCount} failed`,
  );
  console.log(`📁 Video files saved to: ${join(ROOT, 'autorecorder', 'videos')}\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal recording error:', err);
  process.exit(1);
});
