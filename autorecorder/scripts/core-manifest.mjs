#!/usr/bin/env node
/**
 * The "core/ is frozen" rule, as something that runs.
 *
 * CLAUDE.md says core/ holds no framework knowledge and must not be edited per
 * repo. Nothing enforced that, and five core files had drifted between this
 * repo and its siblings before anyone noticed — each copy of the recorder was
 * slightly different, and a fix landed in one never reached the others.
 *
 * This records a SHA-256 per core file in `core/CORE_MANIFEST.json`. A change
 * to core is then an explicit act (`--write`) that shows in the diff, and a
 * port that copies core/ also copies the manifest, so two repos can be
 * compared by comparing two small JSON files.
 *
 *   node scripts/core-manifest.mjs --check   exit 1 if core/ differs from the manifest
 *   node scripts/core-manifest.mjs --write   regenerate the manifest from core/
 *   node scripts/core-manifest.mjs --diff <other-repo-autorecorder-dir>
 *                                            list files that differ from another copy
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RECORDER = resolve(HERE, '..');
const CORE = join(RECORDER, 'core');
const MANIFEST = join(CORE, 'CORE_MANIFEST.json');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name !== 'CORE_MANIFEST.json') out.push(full);
  }
  return out;
}

/** Line endings normalised so a CRLF checkout hashes the same as an LF one. */
function hashFile(file) {
  const text = readFileSync(file).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function manifestOf(coreDir) {
  const entries = walk(coreDir)
    .map((f) => [relative(coreDir, f).replace(/\\/g, '/'), hashFile(f)])
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function compare(expected, actual) {
  const changed = [];
  const missing = [];
  const added = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) missing.push(file);
    else if (actual[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(actual)) if (!(file in expected)) added.push(file);
  return { changed, missing, added, clean: !changed.length && !missing.length && !added.length };
}

function report(label, { changed, missing, added }) {
  for (const f of changed) console.log(`  ~ ${f}`);
  for (const f of missing) console.log(`  - ${f}  (in ${label}, not here)`);
  for (const f of added) console.log(`  + ${f}  (here, not in ${label})`);
}

const args = process.argv.slice(2);
const current = manifestOf(CORE);

if (args.includes('--write')) {
  writeFileSync(MANIFEST, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`✏️  core/CORE_MANIFEST.json written (${Object.keys(current).length} files).`);
  process.exit(0);
}

const diffIdx = args.indexOf('--diff');
if (diffIdx !== -1) {
  const other = resolve(args[diffIdx + 1] ?? '');
  const otherCore = join(other, 'core');
  if (!existsSync(otherCore) || !statSync(otherCore).isDirectory()) {
    console.error(`❌ --diff needs another autorecorder directory; ${other} has no core/.`);
    process.exit(2);
  }
  const result = compare(manifestOf(otherCore), current);
  if (result.clean) {
    console.log(`✅ core/ is identical to ${other}.`);
    process.exit(0);
  }
  console.log(`core/ differs from ${other}:`);
  report(other, result);
  process.exit(1);
}

// Default: --check.
if (!existsSync(MANIFEST)) {
  console.error(`❌ core/CORE_MANIFEST.json does not exist. Run with --write once to create it.`);
  process.exit(1);
}
const expected = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const result = compare(expected, current);
if (result.clean) {
  console.log(`✅ core/ matches CORE_MANIFEST.json (${Object.keys(current).length} files).`);
  process.exit(0);
}
console.error(`❌ core/ has changed since CORE_MANIFEST.json was written:`);
report('manifest', result);
console.error(`\n   If the change is deliberate: node scripts/core-manifest.mjs --write`);
console.error(`   and port it to the other repos' copies (CLAUDE.md).`);
process.exit(1);
