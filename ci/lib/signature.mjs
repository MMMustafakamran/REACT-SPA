/**
 * Result signatures: the unit of comparison between runs.
 *
 * Two runs of the same page rarely produce byte-identical output. Error text
 * carries ports, timings, request ids and URLs that move every day, while the
 * *kind* of failure stays put. A signature keeps what is stable -- the verdict,
 * the error class the recorder's diagnostics assigned, and a normalised first
 * line of the message -- and throws the rest away, so "same error as yesterday"
 * is a string equality and not a judgement call.
 *
 * Input is one entry of the recorder's `RECORD_RESULTS.json` (`id`, `success`,
 * `error`, `warnings`, `consoleErrors`), or the flattened `RUN_REPORT.json`
 * `videos[]` row (`status`, `notes`) as a fallback for packages downloaded
 * before the raw file was uploaded.
 */

/** Notes that appear on every run and carry no information. Extended per repo by `expected-results.json#ignoreNotes`. */
const DEFAULT_IGNORE = [
  /Thread count unchanged/i,
];

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2100}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/** Reduce a free-text message to its stable core. */
export function normaliseMessage(text) {
  if (!text) return '';
  let s = String(text).split('\n')[0];
  s = s.replace(EMOJI, '');
  s = s.replace(/^\s*Demo step failed:\s*/i, ''); // recorder boilerplate
  s = s.replace(/\[[^\]]*\]:?\s*/, ''); // drop the leading "[Class]:" tag; it lives in errorClass
  s = s.replace(/https?:\/\/[^\s)"']+/g, '<url>');
  s = s.replace(/\b127\.0\.0\.1:\d+|\blocalhost:\d+/g, '<host>');
  s = s.replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds?|MB|KB)\b/gi, '<n>');
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, '<hex>');
  s = s.replace(/\b\d{2,}\b/g, '<n>');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 160);
}

/** The `[Class]` tag `diagnoseError` prefixes to every failure, or a fallback derived from the text. */
export function classifyError(text) {
  if (!text) return null;
  const s = String(text);
  const tag = s.match(/\[([^\]]{2,60})\]/);
  // "Diagnostic Note" is the recorder's catch-all; sub-classify from the text
  // so an agent that went silent and a selector that vanished do not share a class.
  if (tag && !/^Diagnostic Note$/i.test(tag[1])) return tag[1].replace(/\s*\(\d+\)\s*$/, '').trim();
  if (/never produced a response|no assistant message/i.test(s)) return 'Agent Silent';
  if (/build (failed|error)|Failed to compile|Module not found/i.test(s)) return 'Build Failure';
  if (/chat surface|never rendered|not attached/i.test(s)) return 'Surface Missing';
  if (/Dev server failed to start/i.test(s)) return 'Dev Server Boot';
  if (/Timeout|timed out/i.test(s)) return 'Timeout';
  if (/ECONNREFUSED/i.test(s)) return 'Connection Refused';
  if (/\b(404|Not Found)\b/i.test(s)) return 'Route Not Found';
  if (/\b5\d\d\b/.test(s)) return 'Server Error';
  return tag ? 'Diagnostic Note' : 'Unclassified';
}

/** Normalise one console-error line to `status path` so request ids and hosts do not churn it. */
function consoleKey(line) {
  const m = String(line).match(/status of (\d{3})[^(]*\(([^:)]+)/);
  if (m) return `console ${m[1]} ${m[2]}`;
  return `console ${normaliseMessage(line).slice(0, 80)}`;
}

function isIgnored(note, ignore) {
  return ignore.some((re) => re.test(note));
}

/**
 * Build the signature for one page.
 *
 * @param {object} rec  RECORD_RESULTS entry or RUN_REPORT videos[] row
 * @param {RegExp[]} extraIgnore  repo-level note allowlist
 * @returns {{status:'pass'|'fail', errorClass:string|null, message:string, notes:string[], key:string}}
 */
export function signatureOf(rec, extraIgnore = []) {
  const ignore = [...DEFAULT_IGNORE, ...extraIgnore];

  // Raw (preferred) vs flattened shapes.
  const isRaw = typeof rec.success === 'boolean';
  const failed = isRaw ? !rec.success : rec.status === 'failed';
  const error = isRaw ? rec.error : failed ? (rec.notes ?? []).slice(-1)[0] : undefined;
  const warnings = isRaw ? rec.warnings ?? [] : failed ? (rec.notes ?? []).slice(0, -1) : rec.notes ?? [];

  const notes = new Set();
  for (const w of warnings) {
    if (isIgnored(w, ignore)) continue;
    // Console warnings are summarised as "Browser console: N distinct error(s), first: ..." --
    // the raw list is more stable, so prefer it when present.
    if (/^Browser console:/i.test(w) && isRaw && rec.consoleErrors?.length) continue;
    notes.add(normaliseMessage(w).slice(0, 100));
  }
  for (const c of rec.consoleErrors ?? []) {
    if (isIgnored(c, ignore)) continue;
    notes.add(consoleKey(c));
  }

  const status = failed ? 'fail' : 'pass';
  const errorClass = failed ? classifyError(error) : null;
  const message = failed ? normaliseMessage(error) : '';
  const sortedNotes = [...notes].sort();
  return {
    status,
    errorClass,
    message,
    notes: sortedNotes,
    key: `${status}|${errorClass ?? ''}|${message}`,
  };
}

/** Compile the string patterns stored in expected-results.json into RegExps. */
export function compileIgnore(list = []) {
  return list.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
}

/**
 * Compare a signature against an expectation. Verdict order matters: the first
 * match wins, and it is what the notification says.
 *
 *  - unchanged      same verdict, same class, same notes
 *  - new-error      expected pass, got fail
 *  - resolved       expected fail, got pass
 *  - error-changed  fail both times, different class or message
 *  - notes-changed  same verdict, different non-ignored notes
 */
export function classifyChange(expected, actual) {
  if (!expected) return 'untracked';
  if (expected.status === 'pass' && actual.status === 'fail') return 'new-error';
  if (expected.status === 'fail' && actual.status === 'pass') return 'resolved';
  if (actual.status === 'fail') {
    const classSame = (expected.errorClass ?? '') === (actual.errorClass ?? '');
    // The message is only compared when the expectation pins one; a class-only
    // expectation ("any 404 on this page") tolerates wording changes.
    const msgSame = !expected.message || expected.message === actual.message;
    if (!classSame || !msgSame) return 'error-changed';
  }
  const en = (expected.notes ?? []).join('\n');
  const an = (actual.notes ?? []).join('\n');
  if (en !== an) return 'notes-changed';
  return 'unchanged';
}
