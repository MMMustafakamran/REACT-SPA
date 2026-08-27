/**
 * Load the repo's .env into process.env.
 *
 * The runtime reads `OPENAI_API_KEY` from its own environment — the doc page
 * says to export it in the terminal running `server.ts` — so the pipeline has
 * to hold it before it spawns anything.
 *
 * Precedence: already in process.env > repo-root .env. In CI nothing is
 * loaded from files; the workflow exports real values and those win because
 * they are already set.
 *
 * Deliberately minimal: enough .env syntax for this repo's file, no dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.mjs';

function parseEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }

  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** @returns the files that actually contributed a value. */
export function loadEnvFiles() {
  const loaded = [];
  const candidate = path.join(ROOT_DIR, '.env');

  const parsed = parseEnvFile(candidate);
  let used = false;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      used = true;
    }
  }
  if (used) loaded.push(path.relative(ROOT_DIR, candidate));

  return loaded;
}

/**
 * Strip stray whitespace from credentials.
 *
 * A secret store that keeps a trailing newline produces an Authorization
 * header that fails in a way that looks like a wrong key.
 */
export function trimInheritedCredentials() {
  const trimmed = [];
  for (const key of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== value.trim()) {
      process.env[key] = value.trim();
      trimmed.push(key);
    }
  }
  return trimmed;
}
