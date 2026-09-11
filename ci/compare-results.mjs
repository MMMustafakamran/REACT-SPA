#!/usr/bin/env node
/**
 * Compare a run's per-page results against the reviewed baseline.
 *
 * The baseline is `autorecorder/expected-results.json`: one entry per
 * `<track>:<page id>` (npm, pnpm and yarn record the same pages, so each
 * track is compared on its own) holding the verdict a human signed off on
 * (pass, or fail with a named error class) and why. This script reads every
 * results file a run produced -- `RECORD_RESULTS.<track>.json` from each
 * track, falling back to `RUN_REPORT.<track>.json` for older packages --
 * reduces each page to a signature, and classifies it:
 *
 *   unchanged       what the baseline says; nothing to look at
 *   new-error       a page that used to pass now fails            -> notify
 *   resolved        a page that used to fail now passes           -> notify
 *   error-changed   still failing, but a different failure        -> notify
 *   notes-changed   same verdict, different warnings/console      -> notify (soft)
 *   untracked       the run recorded a page the baseline lacks    -> notify
 *   not-run         baseline page missing from this run           -> info on a
 *                   partial run, notify on a full one
 *
 * Exit 0 when every recorded page is unchanged (auto-approve), 3 otherwise.
 * `RESULT_DIFF.json` and `RESULT_DIFF.md` land next to the inputs either way.
 *
 * Usage:
 *   node ci/compare-results.mjs                       # autorecorder/videos/
 *   node ci/compare-results.mjs --dir all-recordings  # a downloaded package
 *   node ci/compare-results.mjs --seed                # write a baseline from this run
 *   node ci/compare-results.mjs --accept              # fold this run's changes into the baseline
 *   node ci/compare-results.mjs --accept=untracked,notes-changed   # only those kinds
 *   node ci/compare-results.mjs --full                # treat not-run as a change
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, VIDEOS_DIR, PROJECT_SLUG } from './lib/config.mjs';
import { signatureOf, classifyChange, compileIgnore } from './lib/signature.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return dflt;
};

const DIR = path.resolve(opt('dir', VIDEOS_DIR));
const EXPECTED_FILE = path.resolve(opt('expected', path.join(ROOT_DIR, 'autorecorder', 'expected-results.json')));
const NOTIFY_LEVELS = new Set(['new-error', 'resolved', 'error-changed', 'untracked']);
const SOFT_LEVELS = new Set(['notes-changed']);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * The track a results file belongs to: the row's own `track` field when the
 * report stamped one, else the `RECORD_RESULTS.<track>.json` /
 * `RUN_REPORT.<track>.json` file name, else nothing.
 */
function trackOf(row, file) {
  if (row?.track) return String(row.track);
  const m = file.match(/^(?:RECORD_RESULTS|RUN_REPORT)\.([^.]+)\.json$/);
  return m ? m[1] : null;
}

/** `<track>:<id>` when a track is known, so npm/pnpm/yarn runs of one page stay separate. */
function keyOf(row, file) {
  const track = trackOf(row, file);
  return track ? `${track}:${row.id}` : row.id;
}

/** Union every track's page records. Raw results win over flattened ones for the same key. */
function collectRecords(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const raw = files.filter((f) => /^RECORD_RESULTS.*\.json$/.test(f));
  const flat = files.filter((f) => /^RUN_REPORT.*\.json$/.test(f));
  const byId = new Map();
  const sources = [];
  let partial = false;

  for (const f of raw) {
    const run = readJson(path.join(dir, f));
    sources.push(f);
    if ((run.args ?? []).some((a) => /^--(pages|limit)=/.test(a))) partial = true;
    for (const r of run.results ?? []) byId.set(keyOf(r, f), { ...r, source: f });
  }
  for (const f of flat) {
    const rep = readJson(path.join(dir, f));
    sources.push(f);
    if (typeof rep.args === 'string' && /--(pages|limit)=/.test(rep.args)) partial = true;
    for (const v of rep.videos ?? []) {
      if (!v.id) continue; // no id: older reports, cannot be compared
      const key = keyOf(v, f);
      if (byId.has(key)) continue;
      byId.set(key, { ...v, source: f });
    }
  }
  return { records: byId, sources, partial };
}

function loadExpected() {
  if (!fs.existsSync(EXPECTED_FILE)) {
    return { schema: 1, project: PROJECT_SLUG, updatedAt: null, ignoreNotes: [], pages: {} };
  }
  const e = readJson(EXPECTED_FILE);
  e.pages ??= {};
  e.ignoreNotes ??= [];
  return e;
}

function saveExpected(e) {
  e.updatedAt = new Date().toISOString().slice(0, 10);
  const sorted = Object.fromEntries(Object.entries(e.pages).sort(([a], [b]) => a.localeCompare(b)));
  e.pages = sorted;
  fs.writeFileSync(EXPECTED_FILE, JSON.stringify(e, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function toExpectation(sig, reason) {
  const entry = { status: sig.status, reason };
  if (sig.status === 'fail') {
    entry.errorClass = sig.errorClass;
    entry.message = sig.message;
  }
  if (sig.notes.length) entry.notes = sig.notes;
  return entry;
}

function main() {
  const expected = loadExpected();
  const ignore = compileIgnore(expected.ignoreNotes);
  const { records, sources, partial } = collectRecords(DIR);

  if (records.size === 0) {
    console.error(`No RECORD_RESULTS*.json or RUN_REPORT*.json with page ids under ${DIR}`);
    process.exit(1);
  }

  if (flag('seed')) {
    for (const [id, rec] of records) {
      const sig = signatureOf(rec, ignore);
      expected.pages[id] = toExpectation(sig, `seeded from ${rec.source} on ${new Date().toISOString().slice(0, 10)}; not yet reviewed`);
    }
    saveExpected(expected);
    console.log(`Seeded ${records.size} page(s) into ${path.relative(ROOT_DIR, EXPECTED_FILE)}. Review the reasons before trusting it.`);
    return;
  }

  const rows = [];
  for (const [id, rec] of records) {
    const actual = signatureOf(rec, ignore);
    const exp = expected.pages[id];
    const change = classifyChange(exp, actual);
    rows.push({
      id,
      name: rec.name ?? id,
      filename: rec.filename ?? '',
      change,
      expected: exp ?? null,
      actual,
      source: rec.source,
    });
  }
  for (const id of Object.keys(expected.pages)) {
    if (!records.has(id)) rows.push({ id, name: id, filename: '', change: 'not-run', expected: expected.pages[id], actual: null, source: null });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const counts = {};
  for (const r of rows) counts[r.change] = (counts[r.change] ?? 0) + 1;

  // A page run never carries CLI flows and a CLI run never carries pages, so
  // "not-run" only counts within the family this run actually covers.
  const ranCli = [...records.keys()].some((id) => id.startsWith('cli:'));
  const ranPages = [...records.keys()].some((id) => !id.startsWith('cli:'));
  const notRunRows = rows.filter((r) => r.change === 'not-run' && (r.id.startsWith('cli:') ? ranCli : ranPages));
  const notRunCounts = flag('full') || !partial ? notRunRows.length : 0;
  const hard = rows.filter((r) => NOTIFY_LEVELS.has(r.change)).length + notRunCounts;
  const soft = rows.filter((r) => SOFT_LEVELS.has(r.change)).length;
  const verdict = hard > 0 ? 'changed' : soft > 0 ? 'changed-soft' : 'unchanged';

  const diff = {
    project: PROJECT_SLUG,
    timestamp: new Date().toISOString(),
    baseline: { file: path.relative(ROOT_DIR, EXPECTED_FILE), updatedAt: expected.updatedAt, pages: Object.keys(expected.pages).length },
    sources,
    partial,
    verdict,
    counts,
    pages: rows,
  };

  fs.writeFileSync(path.join(DIR, 'RESULT_DIFF.json'), JSON.stringify(diff, null, 2) + '\n');
  const md = renderMarkdown(diff);
  fs.writeFileSync(path.join(DIR, 'RESULT_DIFF.md'), md);
  console.log(md);

  // --accept takes everything; --accept=untracked,notes-changed takes only
  // those kinds, so an environmental failure (a dead model key, say) is not
  // folded into the baseline alongside the pages it did not affect.
  const acceptKinds = opt('accept', null);
  if (flag('accept') || acceptKinds) {
    const only = acceptKinds ? new Set(acceptKinds.split(',').map((s) => s.trim())) : null;
    let n = 0;
    for (const r of rows) {
      if (r.change === 'unchanged' || r.change === 'not-run') continue;
      if (only && !only.has(r.change)) continue;
      // Keep the reviewed reason on an existing entry; only new entries get the stock one.
      const prior = expected.pages[r.id]?.reason;
      const stamp = `accepted from run on ${diff.timestamp.slice(0, 10)} (${r.change})`;
      expected.pages[r.id] = toExpectation(r.actual, prior ? `${prior} | ${stamp}` : stamp);
      n++;
    }
    saveExpected(expected);
    console.log(`\nAccepted ${n} change(s) into ${path.relative(ROOT_DIR, EXPECTED_FILE)}.`);
    return;
  }

  process.exitCode = verdict === 'unchanged' ? 0 : 3;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ICON = {
  unchanged: '✅',
  'new-error': '🔴',
  resolved: '🟢',
  'error-changed': '🟠',
  'notes-changed': '🟡',
  untracked: '🆕',
  'not-run': '⏭️',
};

function describe(sig) {
  if (!sig) return '';
  // Baseline entries omit `notes` when there were none; actual signatures always carry the array.
  const notes = sig.notes ?? [];
  if (sig.status === 'pass') return notes.length ? `pass, notes: ${notes.join('; ')}` : 'pass';
  return `fail [${sig.errorClass}] ${sig.message}`.trim();
}

function renderMarkdown(diff) {
  const L = [];
  const head = diff.verdict === 'unchanged' ? '✅ **UNCHANGED** — matches the reviewed baseline, safe to publish'
    : diff.verdict === 'changed-soft' ? '🟡 **NOTES CHANGED** — verdicts match, warnings differ'
    : '🔴 **CHANGED** — needs review';
  L.push(`# 🔁 Result comparison — ${diff.project}`, '', `- **Verdict:** ${head}`);
  L.push(`- **Baseline:** \`${diff.baseline.file}\` (${diff.baseline.pages} pages, updated ${diff.baseline.updatedAt ?? 'never'})`);
  L.push(`- **Run:** ${diff.partial ? 'partial' : 'full'}, from ${diff.sources.join(', ')}`);
  L.push(`- **Counts:** ${Object.entries(diff.counts).map(([k, v]) => `${ICON[k]} ${k} ${v}`).join(' · ')}`, '');

  const changed = diff.pages.filter((p) => p.change !== 'unchanged' && p.change !== 'not-run');
  if (changed.length) {
    L.push('## What changed', '', '| Page | Change | Expected | Actual |', '|---|---|---|---|');
    for (const p of changed) {
      L.push(`| \`${p.id}\` | ${ICON[p.change]} ${p.change} | ${describe(p.expected).replace(/\|/g, '\\|')} | ${describe(p.actual).replace(/\|/g, '\\|')} |`);
    }
    L.push('');
  }
  const notRun = diff.pages.filter((p) => p.change === 'not-run');
  if (notRun.length) L.push(`## Not in this run`, '', notRun.map((p) => `\`${p.id}\``).join(', '), '');
  const same = diff.pages.filter((p) => p.change === 'unchanged');
  if (same.length) L.push(`## Unchanged (${same.length})`, '', same.map((p) => `\`${p.id}\` ${p.actual.status}`).join(' · '), '');
  L.push('---', 'To fold reviewed changes into the baseline: `node ci/compare-results.mjs --accept` (edit the `reason` fields afterwards).', '');
  return L.join('\n');
}

main();
