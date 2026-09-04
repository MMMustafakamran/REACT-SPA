import { type Page } from 'playwright';

/**
 * The small irregularities that make a take read as a person at a desk.
 *
 * Everything here draws from ONE seeded generator, reseeded per take from the
 * page id. Two things follow from that, and both matter:
 *
 * - takes differ from each other: the Quickstart clip does not pause, type and
 *   scroll in exactly the rhythm of the Slots clip, which is the first thing
 *   a viewer notices about automation;
 * - the same take is identical night after night, so two recordings of the
 *   same page can still be compared frame for frame. Plain Math.random would
 *   give the first and lose the second.
 */

let state = 0x9e3779b9;

/** mulberry32: small, fast, good enough for pacing. */
function next(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Reseeds from a string. Call once at the start of every take. */
export function seedTake(id: string): void {
  let h = 2166136261;
  for (const ch of id) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  state = h | 0;
  // Discard the first few draws: consecutive seeds otherwise start close.
  next();
  next();
  next();
}

/** Uniform in [0, 1). */
export const rand = (): number => next();

/** Uniform in [lo, hi). */
export const between = (lo: number, hi: number): number => lo + (hi - lo) * next();

/** True with probability p. */
export const chance = (p: number): boolean => next() < p;

/** `ms` varied by ±spread (default ±25%). Never below a quarter of `ms`. */
export function jitter(ms: number, spread = 0.25): number {
  return Math.max(ms * 0.25, ms * (1 + (next() * 2 - 1) * spread));
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A reading or thinking pause. Every fixed `sleep(1500)` in a take used to be
 * exactly 1500ms in every clip; this is the same beat with a person's
 * variance on it.
 */
export function pause(ms: number, spread = 0.25): Promise<void> {
  return sleep(jitter(ms, spread));
}

export interface TypeRhythm {
  /** Mean per-character delay. Ordinary typing sits around 60-90ms. */
  charDelayMs?: number;
  /** How far each keystroke strays from the mean, 0-1. */
  jitter?: number;
  /** Chance, per space, of pausing as if thinking. */
  thinkChance?: number;
}

/**
 * The delay to leave *after* typing `ch`, given a person's rhythm.
 *
 * Shared by the Notepad, the chat composer and the terminal preamble, so all
 * three type like the same person: jittered keystrokes, a longer beat after
 * punctuation and line breaks, and the occasional mid-sentence pause.
 */
export function keystrokeDelay(ch: string, opts: TypeRhythm = {}): number {
  const { charDelayMs = 62, jitter: spread = 0.55, thinkChance = 0.07 } = opts;
  let delay = charDelayMs * (1 + (next() * 2 - 1) * spread);
  if (ch === ' ' && next() < thinkChance) delay += 240 + next() * 420;
  if ('.,:—-?!'.includes(ch)) delay += 120 + next() * 170;
  if (ch === '\n') delay += 300 + next() * 260;
  return Math.max(18, delay);
}

/**
 * Types into whatever has focus, one key at a time, at a human rhythm.
 *
 * Replaces `page.keyboard.type(text, { delay: 35 })`, which is 35ms between
 * every key with no variation — the most machine-like thing a chat clip can
 * show, and it was in every one.
 */
export async function humanType(page: Page, text: string, opts: TypeRhythm = {}): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(keystrokeDelay(ch, opts));
  }
}
