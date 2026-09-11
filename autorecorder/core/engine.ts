import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { executePageAction } from '../actions';
import { diagnoseError } from './diagnostics';
import { SELECTORS } from '../config/selectors.config';
import { captureConsole, type ConsoleEntry } from './console-capture';
import { generateIdeHtml, type IdeTabConfig, type TerminalSessionConfig } from './ide/generator';
import { humanClick, humanGlide, humanScrollDown, restCursorSomewhere, sleep } from './overlays/cursor';
import { pause, seedTake } from './overlays/human';
import { clickTaskbarApp, ensureOverlays, waitForHydration } from './overlays/taskbar';
import { timeoutsFor } from './timeouts';
import { type ActionContext, type PageRecordConfig, type RecorderTimeouts } from './types';

/**
 * Smoothly and visibly scrolls the simulated VS Code .code-viewport down to the target startLine.
 *
 * `viewIdx` targets one specific tab's viewport by id. A selector list such as
 * `.editor-body-view:not([style*="display: none"]) .code-viewport, .code-viewport`
 * does NOT work here: querySelector resolves a selector list in document order,
 * not list order, so it returns tab 0's (hidden) viewport whenever a later tab
 * is active -- which silently scrolled the wrong pane on every extra tab.
 */
async function humanScrollCodeViewport(
  page: Page,
  startLine: number,
  viewIdx: number,
): Promise<void> {
  if (startLine <= 14) {
    await sleep(300);
    return;
  }

  // Calculate target scrollTop: each line is 22px in height
  // Center the highlighted range in the editor pane
  const targetScrollTop = Math.max(0, (startLine - 8) * 22);

  await page.evaluate(async ({ targetY, idx }) => {
    const viewport = document.querySelector(
      `#ide-view-${idx} .code-viewport`,
    ) as HTMLElement | null;
    if (!viewport) return;

    const startY = viewport.scrollTop;
    const distance = targetY - startY;
    if (Math.abs(distance) < 15) return;

    const steps = 32;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Smooth cubic ease-in-out
      const progress =
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      viewport.scrollTop = startY + distance * progress;
      await new Promise((r) => setTimeout(r, 20));
    }
  }, { targetY: targetScrollTop, idx: viewIdx });

  await sleep(350);
}

/**
 * A short fade as a simulated window comes up.
 *
 * The IDE used to appear in a single frame, which is how a navigation looks
 * and not how an app switch does. 180ms is under a real window animation and
 * over one frame.
 */
function withWindowFade(html: string): string {
  const style =
    '<style>@keyframes __arWinIn{from{opacity:0;transform:scale(.992)}to{opacity:1;transform:none}}' +
    'body{animation:__arWinIn .18s ease-out both}</style>';
  return html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : style + html;
}

/**
 * Virtual path the simulated IDE is served from, on the frontend's own origin.
 * Intercepted by Playwright and fulfilled from memory -- it never reaches the dev server.
 */
const IDE_ROUTE_PATH = '/__autorecord_ide__';

/** Result of one page recording, with hard failures separated from cosmetic notes. */
export interface RecordResult {
  success: boolean;
  filename: string;
  error?: string;
  warnings: string[];
  /** Browser console errors seen during the take, deduplicated. */
  consoleErrors?: string[];
}

/**
 * One line per distinct console error, for the result and the summary.
 *
 * An error boundary logs the same failure a dozen times over; twelve copies
 * in the summary read as noise rather than as the finding.
 */
function distinctErrors(entries: ConsoleEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (e.level !== 'error' || seen.has(e.text)) continue;
    seen.add(e.text);
    out.push(e.source ? `${e.text} (${e.source})` : e.text);
  }
  return out;
}

export class RecordingEngine {
  private readonly videosDir: string;
  private readonly rootDir: string;
  private readonly tempVideoDir: string;
  /**
   * One Chromium for the whole run. Every take used to launch and tear down
   * its own browser, which cost about five seconds per page off camera; the
   * context (and with it the video) is still fresh per take, so the clips are
   * unchanged. `shutdown()` closes it once the suite is done.
   */
  private browser?: Browser;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.videosDir = join(rootDir, 'autorecorder', 'videos');
    this.tempVideoDir = join(this.videosDir, '.temp_chunks');
    if (!existsSync(this.videosDir)) {
      mkdirSync(this.videosDir, { recursive: true });
    }
    if (!existsSync(this.tempVideoDir)) {
      mkdirSync(this.tempVideoDir, { recursive: true });
    }
  }

  /**
   * Launches the browser and opens a video-recording page.
   */
  private async openStage(warmUrl?: string): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: false,
        args: [
          '--start-maximized',
          '--force-dark-mode',
          '--background-color=#1e1e1e',
        ],
      });
    }
    const browser = this.browser;

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      colorScheme: 'dark',
      recordVideo: {
        dir: this.tempVideoDir,
        size: { width: 1920, height: 1080 },
      },
    });

    // Playwright starts recording the moment a page is created, so however long
    // the first navigation takes is dead footage at the head of every video.
    // Warming the doc URL in a throwaway page of the same context primes DNS,
    // TLS and the HTTP cache, which measured 1717ms -> 843ms on the real page.
    if (warmUrl) {
      const warmup = await context.newPage();
      await warmup
        .goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        .catch(() => {});
      const warmupVideo = warmup.video();
      await warmup.close().catch(() => {});
      await warmupVideo?.delete().catch(() => {});
    }

    const page = await context.newPage();

    // about:blank computes to rgba(0,0,0,0) and paints pure black regardless of
    // --background-color, so the residual lead-in reads as a black screen.
    // Paint it VS Code grey instead, so the head of the video looks deliberate.
    await page
      .evaluate(() => {
        document.documentElement.style.background = '#1e1e1e';
        if (document.body) document.body.style.background = '#1e1e1e';
      })
      .catch(() => {});

    return { browser, context, page };
  }

  /**
   * Saves the recorded video and tears the browser down.
   *
   * Returns the filename actually written, which is what the summary reports.
   */
  private async closeStage(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    baseFilename: string,
    announceSuccess: boolean,
  ): Promise<string> {
    const video = page.video();
    await page.close().catch(() => {});
    await context.close().catch(() => {});

    let savedFilename = '';
    if (video) {
      savedFilename = `${baseFilename}.webm`;
      const finalWebm = join(this.videosDir, savedFilename);
      try {
        if (existsSync(finalWebm)) unlinkSync(finalWebm);
        await video.saveAs(finalWebm);
        await video.delete().catch(() => {});
        if (announceSuccess) {
          console.log(`\n🎥 [RECORDING SUCCESSFUL]: ${finalWebm}\n`);
        }
      } catch (err) {
        console.warn(`Video save note: ${err}`);
      }
    }

    // The browser stays up for the next take; see `shutdown()`.
    void browser;

    // Playwright's raw chunk lands here before saveAs moves it out. Nothing
    // should survive the run; left alone it accumulated one stray .webm per
    // recording, gitignored and invisible.
    try {
      rmSync(this.tempVideoDir, { recursive: true, force: true });
    } catch {}

    return savedFilename;
  }

  /** Closes the shared browser. Call once, after the last take. */
  async shutdown(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => {});
  }

  /**
   * Step 1 of every take: the doc page, read at human pace, then a taskbar
   * click to whatever comes next.
   *
   * @returns null on success, else a note for `warnings`. The doc site is
   *   external and not the thing under test, so a bad fetch degrades the intro
   *   rather than invalidating the recording.
   */
  private async showDocPage(
    page: Page,
    docUrl: string,
    nextApp: 'vscode' | 'chrome',
    timeouts: RecorderTimeouts,
  ): Promise<string | null> {
    console.log(`\n📖 Step 1: Navigating to Official Doc (${docUrl})...`);
    try {
      await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: timeouts.docNavMs });

      // Fast check for doc header / content readiness
      await page
        .waitForSelector(SELECTORS.docContentReady, { state: 'visible', timeout: 5000 })
        .catch(() => {});

      // Overlays go on immediately so the taskbar is present from the first
      // frame. They survive hydration on their own now -- ensureOverlays
      // installs a MutationObserver that re-attaches them if React deletes
      // them while reconciling <html>.
      await ensureOverlays(page, 'chrome');

      // Scrolling is the part that must wait: a hydration remount snaps the
      // page back to the top mid-scroll. Start the wait now and let the intro
      // play over it rather than stalling on a frozen frame.
      const hydration = waitForHydration(page);

      // Crisp pause so viewer registers the doc title, then glide straight into reading
      await sleep(500);
      await humanGlide(page, 960, 380, 16);

      if (!(await hydration)) {
        console.warn(`   ⚠️ Doc page hydration not observed within 8s; scrolling anyway.`);
      }

      // Smooth scrolling down doc page (~75% depth to reveal first code block without overscroll).
      console.log(`   Smooth scrolling down doc page...`);
      await humanScrollDown(page, 1600, 3200);

      // Find the visible code block on screen and glide cursor over it
      const visibleCodePos = (await page.evaluate(`
        (function() {
          var pres = document.querySelectorAll('${SELECTORS.docCodeBlock}');
          for (var i = 0; i < pres.length; i++) {
            var r = pres[i].getBoundingClientRect();
            if (r.height > 60 && r.top >= 120 && r.top <= window.innerHeight - 200) {
              return {
                x: r.left + Math.min(r.width / 2, 400),
                y: r.top + Math.min(r.height / 3, 70),
              };
            }
          }
          return null;
        })()
      `)) as { x: number; y: number } | null;

      if (visibleCodePos) {
        await humanGlide(page, visibleCodePos.x, visibleCodePos.y, 20);
      } else {
        await humanGlide(page, 650, 450, 18);
      }

      // Reading pause on the doc code snippet
      await pause(2000);

      console.log(`   🖱️ Switching to ${nextApp} via Windows 11 Taskbar...`);
      await clickTaskbarApp(page, nextApp);
      return null;
    } catch (e) {
      const note = `Doc page (${docUrl}): ${diagnoseError(e, 'doc-page')}`;
      console.warn(`⚠️ Doc navigation notice -- ${note}`);
      await sleep(600);
      return note;
    }
  }

  /**
   * Step 2: the simulated IDE, one tab per file, each scrolled to and rested on
   * its highlighted range.
   *
   * Served from `origin` via an intercepted route and navigated to, rather
   * than document.write()-ed into the doc page. document.write leaves the
   * document's URL as the doc URL, so the doc page is only ever one renderer
   * hiccup away from resurfacing -- and because the IDE HTML wipes the doc's
   * <link> tags, when it does come back it comes back unstyled. A real
   * navigation destroys that document outright. It also makes the IDE -> demo
   * hop a SAME-ORIGIN navigation, so there is no cross-origin process swap. The
   * response is fulfilled from memory, and the IDE paints #1e1e1e -- matching
   * the browser's --background-color launch arg, so there is no white flash.
   *
   * Throws on failure: the IDE view is generated from local files, so a
   * failure here is a real defect in this repo, never a flaky-network excuse.
   */
  private async showIde(
    page: Page,
    tabs: IdeTabConfig[],
    origin: string,
    opts: { dwellMs: number; clickTabs: boolean; terminals?: TerminalSessionConfig[] },
  ): Promise<void> {
    const [first, ...extra] = tabs;
    const ideHtml = await generateIdeHtml(
      this.rootDir,
      first.filePath,
      first.startLine,
      first.endLine,
      extra,
      0,
      opts.terminals ?? [],
    );
    const ideUrl = new URL(IDE_ROUTE_PATH, origin).toString();
    await page.route(ideUrl, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: withWindowFade(ideHtml) }),
    );
    await page.goto(ideUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await ensureOverlays(page, 'vscode');
    await sleep(300);

    for (let idx = 0; idx < tabs.length; idx++) {
      if (idx > 0) {
        console.log(`   🖱️ Switching tab to ${basename(tabs[idx].filePath)} in VS Code...`);
        const tabLocator = page.locator(`#ide-tab-${idx}`);
        const tBox = opts.clickTabs && (await tabLocator.isVisible().catch(() => false))
          ? await tabLocator.boundingBox()
          : null;
        if (tBox) {
          await humanGlide(page, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, 18);
          await humanClick(page);
        } else {
          await page.evaluate(`window.switchIdeTab && window.switchIdeTab(${idx})`);
        }
        await sleep(idx > 0 && !opts.clickTabs ? 500 : 300);
      }

      // Scroll & highlight -- scoped to the tab that is now active.
      await humanScrollCodeViewport(page, tabs[idx].startLine, idx);
      const line = page.locator(`#ide-view-${idx} .code-line.highlighted`).first();
      const box = (await line.isVisible({ timeout: 2000 }).catch(() => false))
        ? await line.boundingBox()
        : null;
      if (box) {
        await humanGlide(page, box.x + Math.min(box.width / 2, 420), box.y + Math.min(box.height / 2, 30), 18);
      } else {
        await humanGlide(page, 520, 360, 18);
      }
      await pause(opts.dwellMs);
    }

    // ----------------------------------------------------
    // STEP 2b: THE INTEGRATED TERMINAL
    // ----------------------------------------------------
    // Opened inside the IDE rather than as a third taskbar window: the
    // panel is part of the document already on screen, so there is no
    // second navigation, no new overlay lifecycle, and no third icon to
    // fit into a taskbar whose two tiles are positioned by fixed offsets.
    //
    // Nothing is typed or animated here. `generateIdeHtml` has already
    // read each session file that `capture.ts` wrote while the service was
    // running -- prompt, command and output together -- and thrown if one
    // was missing or headerless. What the panel shows is the state those
    // terminals were actually left in, so the recorder's only job is to
    // reveal it and move between sessions.
    const terminals = opts.terminals ?? [];
    for (let tIdx = 0; tIdx < terminals.length; tIdx++) {
      console.log(`   ⌨️  Terminal ${tIdx + 1}/${terminals.length}: ${terminals[tIdx].label}`);

      if (tIdx === 0) {
        await page.evaluate('window.ideShowTerminal()');
        await pause(900);
      } else {
        // Click the session in the panel's right-hand list, the way a
        // person switches between two running dev servers.
        const sessionTab = page.locator(`#term-tab-${tIdx}`);
        const sBox = await sessionTab.boundingBox().catch(() => null);
        if (sBox) {
          await humanGlide(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2, 16);
          await humanClick(page);
        } else {
          await page.evaluate(`window.ideSwitchTerminal(${tIdx})`);
        }
        await pause(700);
      }

      // Rest the cursor in the output so the eye lands there, then hold
      // long enough for the banner to be read.
      const outLocator = page.locator(`#term-body-${tIdx} .term-line-out`).first();
      const oBox = await outLocator.boundingBox().catch(() => null);
      if (oBox) {
        await humanGlide(page, oBox.x + Math.min(oBox.width / 2, 380), oBox.y + 8, 16);
      }
      await pause(2600);
    }

    // Bounded, because unbounded it can hang the whole run. `unroute` waits for
    // in-flight handlers of the route it removes, and after some doc pages one
    // never settles: seen 4/4 on the Learning page, whose Loom embed is the one
    // thing it has that the others don't. The IDE window is finished with by
    // now either way, and a leftover handler on a URL nothing else requests is
    // harmless.
    await Promise.race([page.unroute(ideUrl).catch(() => {}), sleep(3000)]);
  }

  async recordPage(config: PageRecordConfig): Promise<RecordResult> {
    console.log(`\n======================================================`);
    console.log(`🎬 RECORDING: ${config.name} (${config.id})`);
    console.log(`======================================================`);

    seedTake(config.id);
    restCursorSomewhere();

    const timeouts = timeoutsFor(config);
    let recordSuccess = false;
    let recordError: string | undefined;
    let finalSavedFilename = '';
    const warnings: string[] = [];

    /** A step that renders the thing under test failed -- the video is not usable. */
    const fail = (message: string): void => {
      if (!recordError) recordError = message;
    };

    // What the page handler reports. `fail` does not throw: the take runs to
    // the end so the clip still shows the failure, and the verdict is applied
    // once the handler returns.
    const actionFailures: string[] = [];
    const ctx: ActionContext = {
      warn: (message) => {
        warnings.push(message);
        console.log(`   ⚠️  ${message}`);
      },
      fail: (message) => {
        actionFailures.push(message);
        console.error(`   ❌ ${message}`);
      },
      timeouts,
    };

    const { browser, context, page } = await this.openStage(config.docUrl);

    // Console errors, page errors and failed backend requests, kept rather than
    // printed and forgotten. They go on the result so the summary and the CI
    // report can show them next to the clip they belong to. Started at the
    // demo step, not here: the doc site's own console is not under test, and
    // it logs a dozen hydration errors of its own on every load.
    let console_: ReturnType<typeof captureConsole> | undefined;

    // Attach global dialog handler so unexpected alerts don't stall recordings
    page.on('dialog', async (dialog) => {
      console.log(`   [Dialog Event] "${dialog.message()}"`);
      await sleep(400);
      try {
        await dialog.accept();
      } catch {}
    });

    try {
      // ----------------------------------------------------
      // STEP 1: OFFICIAL DOC PAGE & HUMAN READING SCROLL
      // ----------------------------------------------------
      const docNote = await this.showDocPage(page, config.docUrl, 'vscode', timeouts);
      if (docNote) warnings.push(docNote);

      // ----------------------------------------------------
      // STEP 2: SHOW PROJECT CODE IN VS CODE IDE WITH SNIPPET SELECTION
      // ----------------------------------------------------
      const hasExtraTabs = Boolean(config.extraTabs && config.extraTabs.length > 0);
      console.log(
        `\n💻 Step 2: Displaying Project Code in VS Code IDE (${config.ideFile}: lines ${config.startLine}-${config.endLine})...`,
      );
      try {
        await this.showIde(
          page,
          [
            { filePath: config.ideFile, startLine: config.startLine, endLine: config.endLine },
            ...(config.extraTabs ?? []),
          ],
          config.demoUrl,
          { dwellMs: hasExtraTabs ? 1500 : 1800, clickTabs: true, terminals: config.terminals },
        );

        console.log(`   🖱️ Switching back to Chrome via Windows 11 Taskbar...`);
        await clickTaskbarApp(page, 'chrome');
      } catch (e) {
        const msg = `IDE view failed: ${diagnoseError(e, 'ide-simulation')}`;
        fail(msg);
        console.error(`❌ ${msg}`);
        await sleep(600);
      }

      // ----------------------------------------------------
      // STEP 3: FRONTEND DEMO PAGE & TAILORED ACTION EXECUTION
      // ----------------------------------------------------
      console.log(`\n🚀 Step 3: Opening Demo (${config.demoUrl})...`);
      console_ = captureConsole(page);
      try {
        // Belt-and-braces: paint the outgoing document dark so that even a slow
        // demo compile holds on a dark frame rather than anything bright.
        await page.evaluate(`
          (function() {
            document.body.style.backgroundColor = '#0f172a';
            document.body.style.transition = 'none';
          })()
        `).catch(() => {});

        const response = await page.goto(config.demoUrl, {
          waitUntil: 'domcontentloaded',
          timeout: timeouts.demoNavMs,
        });

        // A 404/500 used to sail through as a PASS -- the route simply did not exist.
        const status = response?.status() ?? 0;
        if (status >= 400) {
          throw new Error(
            `Demo route returned HTTP ${status} (${config.demoUrl})`,
          );
        }

        // The framework may delete the overlays when it hydrates -- but the
        // guard inside ensureOverlays re-attaches them. No wait here: nothing
        // scrolls this page, and if hydration has already finished the probe
        // would never fire and just burn its timeout.
        await ensureOverlays(page, 'chrome');

        // Wait for page body and chat element readiness
        console.log(`   ⏳ Waiting for Next.js compilation & React hydration to settle...`);
        await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});

        // A dev server that refuses its own chunks for the host the page was
        // opened on (127.0.0.1 instead of localhost, typically) paints the
        // server render and never hydrates; the take then spends minutes
        // retyping into a composer that cannot submit. The failures are on
        // the console the moment the page loads, so say so now rather than
        // "agent never responded" later.
        const blocked = console_?.entries.find(
          (e) =>
            /\/_next\/static\/.*(403|ERR_ABORTED)/.test(e.text) ||
            /Blocked cross-origin/i.test(e.text) ||
            /Blocked request\. This host .* is not allowed/i.test(e.text),
        );
        if (blocked) {
          throw new Error(
            `Dev server refused its own assets (${blocked.text.slice(0, 120)}). ` +
              `The page will never hydrate. Open the frontend on the host the dev server lists as Local -- ` +
              `usually http://localhost:<port>, not 127.0.0.1 -- or allow the host in its config.`,
          );
        }
        // No .catch() here: if the demo never renders an interactive surface there
        // is nothing to record, and that must fail rather than warn.
        await page.waitForSelector(SELECTORS.chatReady, {
          state: 'visible',
          timeout: timeouts.chatReadyMs,
        });
        await sleep(1000);

        // Dispatch specific demo actions
        await executePageAction(page, config, this.rootDir, ctx);

        if (actionFailures.length > 0) {
          throw new Error(actionFailures.join('; '));
        }

        console.log(`✅ Demo execution completed for ${config.id}.`);
        await pause(1500);
      } catch (e) {
        const msg = `Demo step failed: ${diagnoseError(e, config.demoUrl)}`;
        fail(msg);
        console.error(`\n❌ [Demo Failure on ${config.id}]:\n${msg}\n`);
        await sleep(1000);
      }

      recordSuccess = !recordError;
    } catch (err: any) {
      recordError = err?.message || String(err);
      recordSuccess = false;
      console.error(`❌ Recording error for ${config.id}:`, recordError);
    } finally {
      console_?.stop();
      finalSavedFilename = await this.closeStage(
        browser,
        context,
        page,
        config.filename ?? config.id,
        recordSuccess,
      );
    }

    const consoleErrors = distinctErrors(console_?.entries ?? []);
    if (consoleErrors.length > 0) {
      warnings.push(
        `Browser console: ${consoleErrors.length} distinct error(s), first: ${consoleErrors[0]}`,
      );
    }

    return {
      success: recordSuccess,
      filename: finalSavedFilename,
      error: recordError,
      warnings,
      consoleErrors,
    };
  }
}
