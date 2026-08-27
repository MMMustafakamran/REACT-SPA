import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_MAP } from '../actions';
import { PAGES } from '../config/pages.config';
import { PROJECT, REPLACE_ME } from '../config/project.config';
import { SELECTORS } from '../config/selectors.config';
import { type IdeTabConfig } from './ide/generator';

/**
 * The adaptation contract, as something that runs.
 *
 * This exists because prose instructions drift and a plausible-looking config
 * is not a working one. Everything an adaptation can plausibly get wrong is
 * checked here, so "is this port finished?" has one answer: whether this exits
 * zero. A guide can be skimmed; a red check cannot.
 *
 * Static by default so it works with nothing running. `--online` additionally
 * probes the doc and demo URLs and the selector contract against a real page,
 * which is the half that catches a config that is internally consistent but
 * points at the wrong app.
 */

interface Problem {
  scope: string;
  severity: 'error' | 'warning';
  message: string;
}

const MARKER = /\[!code highlight\]|#region\b/;

function checkTab(
  rootDir: string,
  scope: string,
  tab: IdeTabConfig,
  label: string,
  problems: Problem[],
): void {
  const fullPath = join(rootDir, tab.filePath);

  if (!existsSync(fullPath)) {
    problems.push({
      scope,
      severity: 'error',
      message: `${label}: ${tab.filePath} does not exist`,
    });
    return;
  }

  const lines = readFileSync(fullPath, 'utf-8').replace(/\r\n/g, '\n').split('\n');

  if (tab.startLine < 1 || tab.startLine > tab.endLine) {
    problems.push({
      scope,
      severity: 'error',
      message: `${label}: invalid range ${tab.startLine}-${tab.endLine}`,
    });
    return;
  }

  if (tab.endLine > lines.length) {
    problems.push({
      scope,
      severity: 'error',
      message: `${label}: range ${tab.startLine}-${tab.endLine} runs past end of ${tab.filePath} (${lines.length} lines)`,
    });
    return;
  }

  if (!lines.some((l) => MARKER.test(l))) return;

  const covers = lines
    .slice(tab.startLine - 1, tab.endLine)
    .some((l) => MARKER.test(l));

  if (!covers) {
    const at = lines
      .map((l, i) => (MARKER.test(l) ? i + 1 : 0))
      .filter(Boolean)
      .join(', ');
    problems.push({
      scope,
      severity: 'warning',
      message: `${label}: range ${tab.startLine}-${tab.endLine} covers no marked line (markers at ${at}) -- likely drifted`,
    });
  }
}

/** Fields that must be filled in for the adaptation to mean anything. */
function checkProject(problems: Problem[]): void {
  const required: (keyof typeof PROJECT)[] = [
    'framework',
    'frameworkLabel',
    'videoPrefix',
    'docBaseUrl',
    'frontendUrl',
    'backendUrl',
    'frontendStartCmd',
    'backendStartCmd',
  ];

  for (const key of required) {
    const value = String(PROJECT[key] ?? '');
    if (!value || value.includes(REPLACE_ME)) {
      problems.push({
        scope: 'project.config',
        severity: 'error',
        message: `${key} is still ${value ? REPLACE_ME : 'empty'} -- adaptation incomplete`,
      });
    }
  }

  if (!PROJECT.docBaseUrl.includes(PROJECT.framework)) {
    problems.push({
      scope: 'project.config',
      severity: 'warning',
      message: `docBaseUrl does not contain framework slug "${PROJECT.framework}" -- one of them is wrong`,
    });
  }

  for (const [key, url] of [
    ['docBaseUrl', PROJECT.docBaseUrl],
    ['frontendUrl', PROJECT.frontendUrl],
    ['backendUrl', PROJECT.backendUrl],
  ] as const) {
    try {
      new URL(url);
    } catch {
      problems.push({
        scope: 'project.config',
        severity: 'error',
        message: `${key} is not a valid URL: ${url}`,
      });
    }
  }
}

function checkSelectors(problems: Problem[]): void {
  for (const [key, value] of Object.entries(SELECTORS)) {
    if (!value || value.includes(REPLACE_ME)) {
      problems.push({
        scope: 'selectors.config',
        severity: 'error',
        message: `${key} is empty or still ${REPLACE_ME}`,
      });
    }
  }
}

function checkPages(rootDir: string, problems: Problem[]): void {
  if (PAGES.length === 0) {
    problems.push({
      scope: 'pages.config',
      severity: 'error',
      message: 'no pages registered',
    });
    return;
  }

  const ids = new Set<string>();
  const filenames = new Set<string>();

  for (const page of PAGES) {
    const scope = page.id;

    if (ids.has(page.id)) {
      problems.push({ scope, severity: 'error', message: 'duplicate page id' });
    }
    ids.add(page.id);

    if (filenames.has(page.filename)) {
      problems.push({
        scope,
        severity: 'error',
        message: `duplicate output filename "${page.filename}" -- one recording would overwrite the other`,
      });
    }
    filenames.add(page.filename);

    if (!page.docUrl.startsWith(PROJECT.docBaseUrl)) {
      problems.push({
        scope,
        severity: 'error',
        message: 'docUrl escaped docBaseUrl -- points at another framework',
      });
    }

    if (!page.prompt || page.prompt.includes(REPLACE_ME)) {
      problems.push({ scope, severity: 'error', message: 'prompt is empty or a placeholder' });
    }

    if (page.prompts?.length && page.prompts[0] !== page.prompt) {
      problems.push({
        scope,
        severity: 'warning',
        message: 'prompts[0] differs from prompt -- one of them is stale',
      });
    }

    checkTab(
      rootDir,
      scope,
      { filePath: page.ideFile, startLine: page.startLine, endLine: page.endLine },
      'ideFile',
      problems,
    );
    (page.extraTabs ?? []).forEach((tab, i) =>
      checkTab(rootDir, scope, tab, `extraTabs[${i}]`, problems),
    );

    // Terminal sessions. Checked here rather than only at render time so a
    // missing capture costs a second, not a browser launch and two minutes.
    for (const term of page.terminals ?? []) {
      const logPath = join(rootDir, term.logFile);
      if (!existsSync(logPath)) {
        problems.push({
          scope,
          severity: 'error',
          message: `terminal "${term.label}": ${term.logFile} does not exist -- start the service with capture.ts`,
        });
        continue;
      }
      const head = readFileSync(logPath, 'utf-8').slice(0, 400);
      if (!head.startsWith('#cwd ')) {
        problems.push({
          scope,
          severity: 'error',
          message: `terminal "${term.label}": ${term.logFile} has no capture header -- it was not written by capture.ts`,
        });
      }
    }
  }

  // Handlers registered for pages that no longer exist.
  for (const id of Object.keys(ACTION_MAP)) {
    if (!ids.has(id)) {
      problems.push({
        scope: 'actions/index',
        severity: 'warning',
        message: `handler registered for unknown page id "${id}"`,
      });
    }
  }
}

/** Live probes: the half that catches a config pointing at the wrong app. */
async function checkOnline(problems: Problem[]): Promise<void> {
  const get = async (url: string): Promise<number | string> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return res.status;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  for (const page of PAGES) {
    const status = await get(page.demoUrl);
    if (status !== 200) {
      problems.push({
        scope: page.id,
        severity: 'error',
        message: `demo route ${page.demoUrl} -> ${status}`,
      });
    }
  }

  for (const page of PAGES) {
    const status = await get(page.docUrl);
    if (typeof status === 'number' && status >= 400) {
      problems.push({
        scope: page.id,
        severity: 'warning',
        message: `doc page ${page.docUrl} -> ${status} (page may not exist for this framework)`,
      });
    }
  }

  // Selector contract, against the first demo page that loads.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage();
    await p.goto(PAGES[0].demoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(3000);

    // chatInput and chatReady are load-bearing: without them there is nothing to
    // drive. chatSubmit is optional by design -- the recorder presses Enter when
    // it finds no submit control, which is what actually happens on CopilotKit
    // v2, whose send button carries no type, aria-label or text. Reporting that
    // as an error would put the reference implementation permanently in the red
    // and teach everyone to ignore this command.
    for (const key of ['chatInput', 'chatReady'] as const) {
      const count = await p.locator(SELECTORS[key]).count().catch(() => 0);
      if (count === 0) {
        problems.push({
          scope: 'selectors.config',
          severity: 'error',
          message: `${key} matched nothing on ${PAGES[0].demoUrl} -- nothing to drive`,
        });
      }
    }

    const submitCount = await p.locator(SELECTORS.chatSubmit).count().catch(() => 0);
    if (submitCount === 0) {
      problems.push({
        scope: 'selectors.config',
        severity: 'warning',
        message: `chatSubmit matched nothing on ${PAGES[0].demoUrl}; prompts will submit via the Enter key (fine, but the cursor never visibly clicks Send)`,
      });
    }
  } catch (e) {
    problems.push({
      scope: 'selectors.config',
      severity: 'warning',
      message: `could not probe selectors: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

/** @returns Process exit code: 1 if any error was found, else 0. */
export async function runDoctor(
  rootDir: string,
  opts: { online?: boolean } = {},
): Promise<number> {
  const problems: Problem[] = [];

  checkProject(problems);
  checkSelectors(problems);
  checkPages(rootDir, problems);
  if (opts.online) await checkOnline(problems);

  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');

  console.log(`\n=== AUTORECORDER DOCTOR ===`);
  console.log(`  project : ${PROJECT.frameworkLabel} (${PROJECT.framework})`);
  console.log(`  docs    : ${PROJECT.docBaseUrl}`);
  console.log(`  pages   : ${PAGES.length}`);
  console.log(`  mode    : ${opts.online ? 'static + online' : 'static (pass --online for live probes)'}\n`);

  if (problems.length === 0) {
    console.log(`  [ok] Adaptation is complete and consistent.\n`);
    return 0;
  }

  for (const p of problems) {
    console.log(`  ${p.severity === 'error' ? '[x]' : '[!]'} ${p.scope}: ${p.message}`);
  }

  console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s)`);
  console.log(
    errors.length > 0
      ? `  Adaptation is NOT complete. See ADAPT.md.\n`
      : `  No blocking errors; review the warnings above.\n`,
  );

  return errors.length > 0 ? 1 : 0;
}
