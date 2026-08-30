/**
 * Compares `doc-snapshot/` against the live documentation.
 *
 * This is step 0 of every run, and on a schedule it is the step that decides
 * whether the rest happens at all. A recording is only useful as evidence
 * about a page that still says what it said when the snapshot was taken; once
 * the live doc moves, an unattended run would publish clips of a demo that no
 * longer matches it, and nobody is watching to notice.
 *
 * ── Severity, and why it gates ─────────────────────────────────────────────
 * Not every change is worth stopping for. This repo's tracked pages are a
 * quickstart and a status note, and the quickstart's code blocks are the
 * substance — `server.ts`, `main.tsx`, `App.tsx` are transcribed from them, so
 * a change there means the scaffolds under test are now wrong. A reworded
 * paragraph means nothing of the sort.
 *
 *   HIGH    code fences added/removed, or code content changed, or a 404
 *   MEDIUM  headings/structure changed
 *   LOW     prose only
 *
 * HIGH and MEDIUM halt the run and are reported for a human. LOW is announced
 * and recorded through, because a nightly that dies on a comma teaches everyone
 * to ignore it.
 *
 * Run standalone:
 *   node ci/check-doc-drift.mjs              # report, exit 2 on gating drift
 *   node ci/check-doc-drift.mjs --update     # rewrite the snapshot to match
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_DIR } from './lib/config.mjs';

const MANIFEST_PATH = path.join(SNAPSHOT_DIR, 'manifest.json');
const PAGES_DIR = path.join(SNAPSHOT_DIR, 'pages');

const CONCURRENCY = 4;
const TIMEOUT_MS = 10000;

/** Severities that stop a run. LOW is reported and recorded through. */
const GATING = new Set(['HIGH', 'MEDIUM']);

function normalizeText(raw) {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function sha256(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

/**
 * Every fenced code block on the page, dedented to its own fence indentation.
 *
 * A scanner rather than a line filter, because this page nests its code inside
 * MDX `<Step>` elements: every fence, and every line of PROSE beside it, is
 * indented eight spaces. The rule this replaces was "a line starting with four
 * spaces, or with a fence marker, is code", which on this page:
 *
 *   - read the page's indented prose as code, so rewording one sentence inside
 *     a <Step> was classified HIGH "code block content changed" — halting the
 *     nightly and filing a drift issue over a comma; and
 *   - never looked *inside* a fence, whose contents are not themselves indented
 *     on any page that does not nest, so a changed `port` or `runtimeUrl` on a
 *     flat page was classified LOW "prose phrasing updated" and recorded
 *     through — the exact failure the severity gate exists to prevent.
 *
 * Lines are dedented by the opening fence's own indentation rather than
 * trimmed, so re-nesting the whole block is not drift while a change to the
 * code's own relative indentation still is.
 */
function codeBlocks(text) {
  const blocks = [];
  let open = null;
  let current = [];

  for (const line of text.split('\n')) {
    const m = line.match(/^(\s*)(`{3,}|~{3,})/);

    if (!open) {
      if (m) {
        open = { marker: m[2][0], indent: m[1].length };
        current = [line.slice(open.indent)];
      }
      continue;
    }

    current.push(line.slice(open.indent));
    // A closing fence is the same marker character, indented no deeper than the
    // opener. Anything deeper is content — a fence inside a fenced block.
    if (m && m[2][0] === open.marker && m[1].length <= open.indent) {
      blocks.push(current.join('\n'));
      open = null;
      current = [];
    }
  }

  // An unterminated fence still carries content worth comparing.
  if (open) blocks.push(current.join('\n'));

  return blocks;
}

/** Headings at any nesting depth. `        ### Create your React app` counts. */
function headings(text) {
  return text
    .split('\n')
    .filter((l) => /^\s*#{1,6}\s/.test(l))
    .map((l) => l.trim())
    .join('\n');
}

/**
 * Classify a change by what part of the page moved.
 *
 * Code first, because that is what the scaffolds are transcribed from.
 */
function categorize(oldText, newText) {
  const oldBlocks = codeBlocks(oldText);
  const newBlocks = codeBlocks(newText);

  if (oldBlocks.length !== newBlocks.length) {
    return {
      level: 'HIGH',
      reason: `code block count changed (${oldBlocks.length} to ${newBlocks.length})`,
    };
  }

  const changed = oldBlocks.filter((b, i) => b !== newBlocks[i]).length;
  if (changed > 0) {
    return {
      level: 'HIGH',
      reason: `code block content changed (${changed} of ${oldBlocks.length})`,
    };
  }

  if (headings(oldText) !== headings(newText)) {
    return { level: 'MEDIUM', reason: 'headings / structure changed' };
  }

  return { level: 'LOW', reason: 'prose phrasing updated' };
}

/**
 * The changed region, for the notification. Enough to judge, not a full diff.
 *
 * Compared from both ends rather than by line index. Index-aligned comparison
 * made a single inserted line report every subsequent line as changed, so the
 * sample shown in the drift issue described a rewritten page whenever one
 * sentence had been added.
 */
function sampleDiff(oldText, newText, max = 12) {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const half = Math.max(1, Math.floor(max / 2));

  const out = [
    ...removed.slice(0, half).map((l) => `- ${l}`),
    ...(removed.length > half ? [`- ... ${removed.length - half} more removed`] : []),
    ...added.slice(0, half).map((l) => `+ ${l}`),
    ...(added.length > half ? [`+ ... ${added.length - half} more added`] : []),
  ];

  return out.join('\n');
}

async function checkPage(docPath, meta) {
  const url = `https://docs.copilotkit.ai${docPath}.md`;
  const base = {
    docPath,
    file: meta.file,
    url,
    oldHash: meta.sha256?.slice(0, 12),
  };

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'CopilotKit-DocDrift-Detector/1.0',
        Accept: 'text/markdown, text/plain, */*',
      },
    });

    if (res.status === 404) {
      return { ...base, status: '404', drifted: true, severity: 'HIGH', reason: 'page removed' };
    }

    if (!res.ok) {
      // Not drift. An unreachable docs site is a failed check, and a failed
      // check must not be reported as "the docs changed".
      return { ...base, status: String(res.status), drifted: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/markdown') && !contentType.includes('text/plain')) {
      // The app shell, not the page source. Treating this as content would
      // destroy the baseline and report every page as rewritten next run.
      return {
        ...base,
        status: 'invalid-content-type',
        drifted: false,
        error: `expected markdown, received ${contentType || 'nothing'}`,
      };
    }

    const fetched = normalizeText(await res.text());
    if (sha256(fetched) === meta.sha256) {
      return { ...base, status: 'ok', drifted: false };
    }

    const local = normalizeText(await fs.readFile(path.join(PAGES_DIR, meta.file), 'utf8'));
    const { level, reason } = categorize(local, fetched);

    return {
      ...base,
      status: 'drifted',
      drifted: true,
      severity: level,
      reason,
      newHash: sha256(fetched).slice(0, 12),
      diff: sampleDiff(local, fetched),
      fetched,
    };
  } catch (err) {
    return { ...base, status: 'error', drifted: false, error: err.message || String(err) };
  }
}

/** Fixed-size worker pool over a shared cursor. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

export async function checkAllDocDrift() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  const entries = Object.entries(manifest.pages);

  const pages = await pool(entries, CONCURRENCY, ([docPath, meta]) => checkPage(docPath, meta));

  const driftedPages = pages.filter((p) => p.drifted);
  const errors = pages.filter((p) => p.error);
  const gating = driftedPages.filter((p) => GATING.has(p.severity));

  return {
    total: pages.length,
    pages,
    driftedPages,
    errors,
    drifted: driftedPages.length > 0,
    /** Only this halts a run. LOW drift is announced and recorded through. */
    gating: gating.length > 0,
    gatingPages: gating,
    highestSeverity: driftedPages.length
      ? ['HIGH', 'MEDIUM', 'LOW'].find((s) => driftedPages.some((p) => p.severity === s))
      : null,
  };
}

/** Rewrites the snapshot and manifest to match what was just fetched. */
export async function applyDocUpdates(driftedPages) {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));

  for (const page of driftedPages) {
    if (!page.fetched) continue;
    await fs.writeFile(path.join(PAGES_DIR, page.file), page.fetched, 'utf8');
    const entry = manifest.pages[page.docPath];
    if (!entry) continue;
    entry.sha256 = sha256(page.fetched);
    entry.bytes = Buffer.byteLength(page.fetched, 'utf8');
    entry.lines = page.fetched.split('\n').length - 1;
  }

  manifest.syncedAt = new Date().toISOString();
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Markdown for the GitHub step summary and the drift issue.
 *
 * Written to a file rather than stdout so the workflow can hand the same text
 * to both without re-deriving it.
 */
export function renderDriftMarkdown(result) {
  const lines = [`### 📄 Doc drift — ${result.driftedPages.length} of ${result.total} pages moved`, ''];

  for (const p of result.driftedPages) {
    lines.push(`**${p.severity} — \`${p.docPath}\`** · ${p.reason}`);
    lines.push('');
    lines.push(`\`${p.oldHash}\` → \`${p.newHash ?? 'n/a'}\` · [live page](${p.url})`);
    if (p.diff) {
      lines.push('', '```diff', p.diff, '```');
    }
    lines.push('');
  }

  if (result.gating) {
    lines.push(
      '> Recording was **halted**. The scaffolds under test transcribe this page\'s',
      "> code blocks, so a change here means they no longer match what's published.",
      '> Review the diff, update `doc-snapshot/` (`node ci/check-doc-drift.mjs --update`),',
      '> and re-run.',
    );
  } else {
    lines.push('> Prose-only. The run continued; the snapshot is still stale and worth updating.');
  }

  return lines.join('\n');
}

// ── standalone ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-doc-drift.mjs')) {
  const args = process.argv.slice(2);
  const autoUpdate = args.includes('--update') || args.includes('--sync') || args.includes('-u');

  const result = await checkAllDocDrift();

  for (const e of result.errors) {
    console.error(`⚠️  ${e.docPath}: ${e.error}`);
  }

  if (!result.drifted) {
    // Pages that could not be read did not "match" -- they were never compared.
    // Counting them as matching is the one wrong answer here: it reports a
    // silently unverified page as verified.
    const compared = result.total - result.errors.length;
    if (result.errors.length > 0) {
      console.log(
        `⚠️  Drift unknown: ${result.errors.length} of ${result.total} pages could not be read.` +
          ` The other ${compared} match the local snapshot.`,
      );
      process.exit(1);
    }
    console.log(`✅ All ${result.total} doc pages match the local snapshot.`);
    process.exit(0);
  }

  console.log(renderDriftMarkdown(result));

  if (autoUpdate) {
    await applyDocUpdates(result.driftedPages);
    console.log('\n✨ doc-snapshot/ now matches the live docs.');
    process.exit(0);
  }

  // 2 = gating drift, 1 = at least one page could not be read (drift unknown
  // for it), 0 = drift that does not gate. Gating wins: it is the stronger
  // reason to stop, and the caller acts on it identically either way.
  if (result.gating) process.exit(2);
  process.exit(result.errors.length ? 1 : 0);
}
