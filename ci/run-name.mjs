#!/usr/bin/env node
/**
 * Print the name for this run's artifact folder, e.g.
 *
 *   React-SPA-28Aug2026-0612UTC
 *
 * A downloaded artifact should say what it is and when it ran without needing
 * the Actions run page next to it. A commit SHA does neither.
 *
 * Computed once per workflow (in the `drift` job) and passed to the matrix,
 * so every artifact from one run carries the same stamp.
 *
 * GitHub rejects artifact names containing " : < > | * ? \r \n / \, so this
 * sticks to letters, digits and hyphens.
 */
import { PROJECT_SLUG } from './lib/config.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const now = new Date();
const day = String(now.getUTCDate()).padStart(2, '0');
const month = MONTHS[now.getUTCMonth()];
const year = now.getUTCFullYear();
const hh = String(now.getUTCHours()).padStart(2, '0');
const mm = String(now.getUTCMinutes()).padStart(2, '0');

console.log(`${PROJECT_SLUG}-${day}${month}${year}-${hh}${mm}UTC`);
