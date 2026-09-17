/**
 * Compares `doc-snapshot/` against the live documentation.
 *
 * A clip of a track is only evidence about a page that still says what it said
 * when the snapshot was taken. Run this before trusting the three scaffolds:
 * once the live doc moves, they may no longer match what is published.
 *
 *   npm run drift         report; exit 2 on gating drift or a new page
 *   npm run drift:sync    rewrite the snapshot to match and log it
 *
 * Dependency-free on purpose: plain `node` on a fresh clone, no install.
 *
 * ── What is checked ────────────────────────────────────────────────────────
 * 1. Every tracked page (`manifest.pages`) is fetched from its `.md` endpoint
 *    and hashed against the snapshot.
 * 2. The site sitemap is read for pages under `docsRoot` that the manifest
 *    does not track. The hash check cannot see a page that did not exist when
 *    the snapshot was taken, so a new one is drift in its own right. Add it to
 *    the snapshot, or list it in `sitemap.knownUnmapped` to acknowledge it.
 *
 * ── Severity ───────────────────────────────────────────────────────────────
 * The quickstart's code blocks are the substance — `server.ts`, `main.tsx`,
 * `App.tsx` are transcribed from them, so a change there means the scaffolds
 * under test are now wrong. A reworded paragraph means nothing of the sort.
 *
 *   HIGH    code fences added/removed, or code content changed, or a 404
 *   MEDIUM  headings/structure changed
 *   LOW     prose only
 *
 * Exit codes: 2 = HIGH/MEDIUM drift or a new upstream page, 1 = a page or the
 * sitemap could not be read (drift unknown), 0 = clean or LOW-only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = path.join(ROOT_DIR, 'doc-snapshot');
const MANIFEST_PATH = path.join(SNAPSHOT_DIR, 'manifest.json');
const PAGES_DIR = path.join(SNAPSHOT_DIR, 'pages');
const CHANGELOG_PATH = path.join(SNAPSHOT_DIR, 'CHANGELOG.md');

const CONCURRENCY = 4;
const TIMEOUT_MS = 10000;
const USER_AGENT = 'CopilotKit-DocDrift-Detector/1.0';
/** Dated entries kept in CHANGELOG.md, matching the sibling repos. */
const CHANGELOG_KEEP = 3;

/** Severities that must be looked at before the scaffolds are trusted. */
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
 * MDX `<Step>` elements: every fence, and every line of prose beside it, is
 * indented eight spaces. A "starts with four spaces" rule reads that prose as
 * code (a reworded sentence becomes HIGH) and never looks inside a flat fence
 * (a changed `port` becomes LOW).
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

/** Classify a change by what part of the page moved. Code first. */
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
 * The changed region. Enough to judge, not a full diff.
 *
 * Compared from both ends rather than by line index, so one inserted line does
 * not report every later line as changed.
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

  return [
    ...removed.slice(0, half).map((l) => `- ${l}`),
    ...(removed.length > half ? [`- ... ${removed.length - half} more removed`] : []),
    ...added.slice(0, half).map((l) => `+ ${l}`),
    ...(added.length > half ? [`+ ... ${added.length - half} more added`] : []),
  ].join('\n');
}

async function checkPage(origin, docPath, meta) {
  const url = `${origin}${docPath}.md`;
  const base = { docPath, file: meta.file, routes: meta.routes ?? [], url, oldHash: meta.sha256?.slice(0, 12) };

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/markdown, text/plain, */*' },
    });

    if (res.status === 404) {
      return { ...base, status: '404', drifted: true, severity: 'HIGH', reason: 'page removed (404)' };
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

/** Every `<loc>` in the sitemap, following a sitemap index to its children. */
async function sitemapUrls(url, depth = 0) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status} (${url})`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);

  if (/<sitemapindex[\s>]/.test(xml) && depth < 2) {
    const children = await Promise.all(locs.map((child) => sitemapUrls(child, depth + 1)));
    return children.flat();
  }
  return locs;
}

const stripSlash = (u) => u.replace(/\/+$/, '');

/**
 * Pages the sitemap lists under `docsRoot` that the manifest does not track.
 *
 * `lastmod` is ignored on purpose: it is the site's build stamp, not a
 * per-page modification time.
 */
async function checkSitemapGaps(manifest) {
  const root = new URL(manifest.docsRoot);
  const rootUrl = stripSlash(`${root.origin}${root.pathname}`);

  let all;
  try {
    all = await sitemapUrls(`${root.origin}/sitemap.xml`);
  } catch (err) {
    return { error: err.message, urlsUnderRoot: 0, newUnmapped: [], missingFromSitemap: [] };
  }

  const upstream = [...new Set(all.map(stripSlash))].filter(
    (u) => u === rootUrl || u.startsWith(`${rootUrl}/`),
  );
  const covered = new Set(Object.keys(manifest.pages).map((p) => stripSlash(`${root.origin}${p}`)));
  const known = new Set((manifest.sitemap?.knownUnmapped ?? []).map(stripSlash));
  const upstreamSet = new Set(upstream);

  return {
    urlsUnderRoot: upstream.length,
    newUnmapped: upstream.filter((u) => !covered.has(u) && !known.has(u)),
    // Tracked but no longer listed. Alone a hint, not a removal -- the per-page
    // 404 check is the other half of that verdict.
    missingFromSitemap: [...covered].filter((u) => !upstreamSet.has(u)),
  };
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
  const origin = new URL(manifest.docsRoot).origin;
  const entries = Object.entries(manifest.pages);

  const [pages, sitemap] = await Promise.all([
    pool(entries, CONCURRENCY, ([docPath, meta]) => checkPage(origin, docPath, meta)),
    checkSitemapGaps(manifest),
  ]);

  const driftedPages = pages.filter((p) => p.drifted);
  const errors = pages.filter((p) => p.error);
  const gatingPages = driftedPages.filter((p) => GATING.has(p.severity));

  return {
    manifest,
    total: pages.length,
    pages,
    driftedPages,
    errors,
    sitemap,
    gating: gatingPages.length > 0 || sitemap.newUnmapped.length > 0,
    gatingPages,
  };
}

function changelogEntry(driftedPages, now) {
  const order = ['HIGH', 'MEDIUM', 'LOW'];
  const sorted = [...driftedPages].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const time = now.toISOString().slice(11, 16);
  const n = sorted.length;
  const lines = [
    `### ${time} UTC — ${n} page${n === 1 ? '' : 's'}, highest severity ${sorted[0].severity.toLowerCase()}`,
    '',
  ];

  for (const p of sorted) {
    const level = p.severity[0] + p.severity.slice(1).toLowerCase();
    const routes = p.routes.length ? ` · route ${p.routes.map((r) => `\`${r}\``).join(', ')}` : '';
    lines.push(`**${level} — \`${p.docPath}\`**`, '', `${p.reason}${routes}`, '');
    if (p.diff) lines.push('````diff', p.diff, '````', '');
  }

  return lines.join('\n');
}

/**
 * Prepends a dated entry and keeps the newest CHANGELOG_KEEP dates. Entries
 * are counted, not aged, so a gap of weeks between changes expires nothing.
 */
async function appendChangelog(driftedPages, now) {
  let text;
  try {
    text = normalizeText(await fs.readFile(CHANGELOG_PATH, 'utf8'));
  } catch {
    text = '# Doc drift changelog\n';
  }

  const firstDate = text.search(/^## \d{4}-\d{2}-\d{2}\s*$/m);
  let header = (firstDate === -1 ? text : text.slice(0, firstDate)).replace(/_No drift recorded yet[^\n]*\n?/, '');
  header = `${header.trimEnd()}\n\n`;
  const body = firstDate === -1 ? '' : text.slice(firstDate);

  const sections = body
    .split(/^(?=## \d{4}-\d{2}-\d{2}\s*$)/m)
    .filter((s) => s.trim())
    .map((s) => ({ date: s.match(/^## (\S+)/)[1], text: s.trimEnd() }));

  const date = now.toISOString().slice(0, 10);
  const entry = changelogEntry(driftedPages, now);
  if (sections[0]?.date === date) {
    sections[0].text = sections[0].text.replace(/^## \S+\s*\n/, `## ${date}\n\n${entry}\n`).trimEnd();
  } else {
    sections.unshift({ date, text: `## ${date}\n\n${entry}`.trimEnd() });
  }

  const kept = sections.slice(0, CHANGELOG_KEEP).map((s) => s.text);
  await fs.writeFile(CHANGELOG_PATH, `${header}${kept.join('\n\n')}\n`, 'utf8');
}

/**
 * Rewrites the snapshot and manifest to match what was just fetched, and logs
 * the change to CHANGELOG.md. A removed (404) page is reported, never deleted:
 * whether it moved is a judgement for the reader.
 */
export async function applyDocUpdates(result) {
  const { manifest } = result;
  const now = new Date();
  const written = result.driftedPages.filter((p) => p.fetched);

  for (const page of written) {
    await fs.writeFile(path.join(PAGES_DIR, page.file), page.fetched, 'utf8');
    const entry = manifest.pages[page.docPath];
    entry.sha256 = sha256(page.fetched);
    entry.bytes = Buffer.byteLength(page.fetched, 'utf8');
    entry.lines = page.fetched.split('\n').length - 1;
    entry.status = 'ok';
  }

  if (!result.sitemap.error) {
    manifest.sitemap = {
      ...manifest.sitemap,
      fetchedAt: now.toISOString(),
      urlsUnderRoot: result.sitemap.urlsUnderRoot,
      knownUnmapped: manifest.sitemap?.knownUnmapped ?? [],
    };
  }
  if (written.length) manifest.syncedAt = now.toISOString();
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (written.length) await appendChangelog(written, now);
  return written.length;
}

function report(result) {
  const { sitemap } = result;

  for (const e of result.errors) console.error(`⚠️  ${e.docPath}: ${e.error}`);

  if (sitemap.error) {
    console.error(`⚠️  Sitemap not read (${sitemap.error}); new upstream pages were NOT checked.`);
  } else {
    console.log(
      `🗺️  Sitemap: ${sitemap.urlsUnderRoot} URL(s) under ${result.manifest.docsRoot}, ` +
        `${sitemap.newUnmapped.length} new, ${sitemap.missingFromSitemap.length} tracked page(s) no longer listed.`,
    );
    for (const u of sitemap.missingFromSitemap) console.log(`   · not in sitemap: ${u}`);
  }

  if (sitemap.newUnmapped.length) {
    console.log('\n🆕 New upstream pages, tracked nowhere in this repo:');
    for (const u of sitemap.newUnmapped) console.log(` • ${u}`);
    console.log(
      '   Add them to doc-snapshot/ (manifest.pages + pages/), or list them in\n' +
        '   sitemap.knownUnmapped in doc-snapshot/manifest.json to acknowledge them.',
    );
  }

  if (!result.driftedPages.length) {
    const compared = result.total - result.errors.length;
    if (result.errors.length) {
      // Pages that could not be read were never compared; do not call them matching.
      console.log(`\n⚠️  Drift unknown for ${result.errors.length} of ${result.total} page(s); the other ${compared} match.`);
    } else {
      console.log(`\n✅ All ${result.total} tracked doc pages match the local snapshot.`);
    }
    return;
  }

  console.log(`\n🚨 Doc drift — ${result.driftedPages.length} of ${result.total} page(s) moved:\n`);
  for (const p of result.driftedPages) {
    console.log(`[${p.severity}] ${p.docPath} · ${p.reason}`);
    console.log(`  ${p.oldHash} → ${p.newHash ?? 'n/a'} · ${p.url}`);
    if (p.diff) console.log(p.diff.replace(/^/gm, '    '));
    console.log('');
  }
  if (result.gatingPages.length) {
    console.log(
      'The scaffolds under Npm/, Pnpm/ and Yarn/ transcribe this page\'s code blocks,\n' +
        'so they may no longer match what is published. Review the diff, then\n' +
        '`npm run drift:sync` and bring the three tracks in line.',
    );
  } else {
    console.log('Prose only. The scaffolds are unaffected; `npm run drift:sync` refreshes the snapshot.');
  }
}

// ── standalone ─────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const autoUpdate = args.includes('--update') || args.includes('--sync') || args.includes('-u');

  console.log('🔍 Checking doc-snapshot/ against the live docs...\n');
  const result = await checkAllDocDrift();
  report(result);

  if (autoUpdate) {
    const n = await applyDocUpdates(result);
    console.log(
      n
        ? `\n✨ doc-snapshot/ updated: ${n} page(s) rewritten, CHANGELOG.md entry added.`
        : '\n✨ No page content to write; manifest sitemap stats refreshed.',
    );
    if (result.sitemap.newUnmapped.length) {
      console.log('   New upstream pages still need adding or acknowledging (see above).');
      process.exit(2);
    }
    process.exit(result.errors.length || result.sitemap.error ? 1 : 0);
  }

  if (result.gating) process.exit(2);
  process.exit(result.errors.length || result.sitemap.error ? 1 : 0);
}
