import { type Page } from 'playwright';

/**
 * Browser console errors, captured for the run log and the issue note.
 *
 * This started life as a replica of Chrome's DevTools console drawn over the
 * page, so a console-only failure could be seen on video. That was the wrong
 * instrument. These recordings argue "here is a person using this app and here
 * is what happened", and a panel no human could have summoned quietly converts
 * that into a presentation -- the one thing the format cannot afford.
 *
 * The capture was always the useful half, and it is invisible: it runs in Node
 * via `page.on('console')`, never touches the page, and gives the run log and
 * the Notepad note the exact error text. A tester reads the console and writes
 * down what it said; this is the same thing, minus the theatre.
 *
 * Node-side rather than a hook injected into the page, because an injected hook
 * is wiped by the next navigation and these errors arrive after one.
 */

export interface ConsoleEntry {
  level: 'error' | 'warning' | 'info';
  text: string;
  /** Where it came from, as DevTools shows it. */
  source?: string;
}

export interface ConsoleCapture {
  /** Everything captured so far, in arrival order. */
  entries: ConsoleEntry[];
  /** Detach the listeners. Safe to call more than once. */
  stop: () => void;
}

// React's minified hydration-mismatch codes (418, 423, 425) are the same
// "Hydration failed" noise in production builds; a dev route shows the text.
const IGNORED =
  /favicon\.ico|reo\.dev|analytics|webpack-hmr|\.map\b|Hydration failed|server rendered text|Minified React error #4(18|23|25)\b|Download the React DevTools/i;

function shorten(text: string, max = 260): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Starts recording console errors and failed requests for later display.
 *
 * Call this before the action that provokes the error -- typically the first
 * line of the handler, before `sendPrompt`.
 */
export function captureConsole(page: Page): ConsoleCapture {
  const entries: ConsoleEntry[] = [];

  const onConsole = (msg: { type: () => string; text: () => string; location: () => { url?: string; lineNumber?: number } }) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (IGNORED.test(text)) return;

    const loc = msg.location?.() ?? {};
    const file = loc.url ? loc.url.split('/').pop() : undefined;
    entries.push({
      level: type === 'error' ? 'error' : 'warning',
      text: shorten(text),
      source: file && loc.lineNumber != null ? `${file}:${loc.lineNumber}` : file,
    });
  };

  const onPageError = (err: Error) => {
    if (IGNORED.test(err.message)) return;
    entries.push({ level: 'error', text: shorten(err.message), source: 'Uncaught' });
  };

  const onRequestFailed = (req: { url: () => string; method: () => string; failure: () => { errorText: string } | null }) => {
    const url = req.url();
    if (IGNORED.test(url)) return;
    entries.push({
      level: 'error',
      text: `${req.method()} ${shorten(url, 120)} ${req.failure()?.errorText ?? 'net::ERR_FAILED'}`,
      source: 'network',
    });
  };

  page.on('console', onConsole as never);
  page.on('pageerror', onPageError as never);
  page.on('requestfailed', onRequestFailed as never);

  let stopped = false;
  return {
    entries,
    stop: () => {
      if (stopped) return;
      stopped = true;
      page.off('console', onConsole as never);
      page.off('pageerror', onPageError as never);
      page.off('requestfailed', onRequestFailed as never);
    },
  };
}

/**
 * Anything captured whose text matches `pattern`, newest first, deduplicated.
 *
 * A React error boundary can log the same failure a dozen times over; a console
 * pane replaying all twelve reads as noise rather than as the finding, so the
 * caller gets one row per distinct message.
 */
export function findEntries(
  capture: ConsoleCapture,
  pattern: RegExp,
  limit = 4,
): ConsoleEntry[] {
  const seen = new Set<string>();
  const out: ConsoleEntry[] = [];
  for (const entry of capture.entries) {
    if (!pattern.test(entry.text)) continue;
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
