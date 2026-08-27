import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { executePageAction } from '../actions';
import { diagnoseError } from './diagnostics';
import { SELECTORS } from '../config/selectors.config';
import { generateIdeHtml } from './ide/generator';
import { humanClick, humanGlide, humanScrollDown, setGlobalCursorPos, sleep } from './overlays/cursor';
import { clickTaskbarApp, ensureOverlays, waitForHydration } from './overlays/taskbar';
import { type PageRecordConfig } from './types';

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
 * Virtual path the simulated IDE is served from, on the frontend's own origin.
 * Intercepted by Playwright and fulfilled from memory -- it never reaches Next.js.
 */
const IDE_ROUTE_PATH = '/__autorecord_ide__';

/** Result of one page recording, with hard failures separated from cosmetic notes. */
export interface RecordResult {
  success: boolean;
  filename: string;
  error?: string;
  warnings: string[];
}

export class RecordingEngine {
  private readonly videosDir: string;
  private readonly rootDir: string;
  private readonly tempVideoDir: string;

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

  async recordPage(config: PageRecordConfig): Promise<RecordResult> {
    console.log(`\n======================================================`);
    console.log(`🎬 RECORDING: ${config.name} (${config.id})`);
    console.log(`======================================================`);

    setGlobalCursorPos(960, 540);

    let recordSuccess = false;
    let recordError: string | undefined;
    let finalSavedFilename = '';
    const warnings: string[] = [];

    /** A step that renders the thing under test failed -- the video is not usable. */
    const fail = (message: string): void => {
      if (!recordError) recordError = message;
    };

    const browser = await chromium.launch({
      headless: false,
      args: [
        '--start-maximized',
        '--force-dark-mode',
        '--background-color=#1e1e1e',
      ],
    });

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
    const warmup = await context.newPage();
    await warmup
      .goto(config.docUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
      .catch(() => {});
    const warmupVideo = warmup.video();
    await warmup.close().catch(() => {});
    await warmupVideo?.delete().catch(() => {});

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

    // Attach informational console & request listeners (error detection disabled)
    page.on('pageerror', (err) => {
      const msg = err.message || '';
      if (
        msg.includes('reo.dev') ||
        msg.includes('removeChild') ||
        msg.includes('Minified React error') ||
        msg.includes('Hydration failed') ||
        msg.includes("server rendered text didn't match")
      ) {
        return;
      }
      console.warn(
        `   ⚠️ [Browser Page Error]: ${msg}\n   ${diagnoseError(err, 'browser-runtime')}`,
      );
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        if (
          !txt.includes('favicon.ico') &&
          !txt.includes('reo.dev') &&
          !txt.includes('analytics') &&
          !txt.includes('Failed to load resource') &&
          !txt.includes('404 (Not Found)') &&
          !txt.includes('webpack-hmr') &&
          !txt.includes('.map') &&
          !txt.includes('Hydration failed') &&
          !txt.includes("server rendered text didn't match")
        ) {
          console.warn(`   ⚠️ [Browser Console Error]: ${txt}`);
        }
      }
    });

    page.on('requestfailed', (req) => {
      const url = req.url();
      if (
        (url.includes('/api/copilotkit') || url.includes(':8000')) &&
        !url.includes('favicon.ico') &&
        !url.includes('.map')
      ) {
        console.warn(
          `   ⚠️ [Network Request Notice]: ${req.method()} ${url} (${req.failure()?.errorText || 'Failed'})`,
        );
      }
    });

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
      console.log(`\n📖 Step 1: Navigating to Official Doc (${config.docUrl})...`);
      try {
        await page.goto(config.docUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        });

        // Fast check for doc header / content readiness
        await page
          .waitForSelector(SELECTORS.docContentReady, {
            state: 'visible',
            timeout: 5000,
          })
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

        // Move mouse into reading position
        await humanGlide(page, 960, 380, 16);

        if (!(await hydration)) {
          console.warn(
            `   ⚠️ Doc page hydration not observed within 8s; scrolling anyway.`,
          );
        }

        // Smooth scrolling down doc page (~75% depth to reveal first code block without overscroll).
        // Raised from 1100 now that humanScrollDown drives a single scroller and no
        // longer double-counts each tick.
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
        await sleep(2000);

        // Switch to VS Code via Windows 11 Taskbar
        console.log(`   🖱️ Switching to VS Code via Windows 11 Taskbar...`);
        await clickTaskbarApp(page, 'vscode');
      } catch (e) {
        // The doc site is external and not the thing under test, so a bad fetch
        // degrades the intro rather than invalidating the recording.
        const note = `Doc page (${config.docUrl}): ${diagnoseError(e, 'doc-page')}`;
        warnings.push(note);
        console.warn(`⚠️ Doc navigation notice -- ${note}`);
        await sleep(600);
      }

      // ----------------------------------------------------
      // STEP 2: SHOW PROJECT CODE IN VS CODE IDE WITH SNIPPET SELECTION
      // ----------------------------------------------------
      const hasExtraTabs = config.extraTabs && config.extraTabs.length > 0;
      console.log(
        `\n💻 Step 2: Displaying Project Code in VS Code IDE (${config.ideFile}: lines ${config.startLine}-${config.endLine})...`,
      );
      try {
        const ideHtml = await generateIdeHtml(
          this.rootDir,
          config.ideFile,
          config.startLine,
          config.endLine,
          config.extraTabs ?? [],
          0,
          config.terminals ?? [],
        );
        // Serve the IDE from the frontend's own origin and navigate to it, rather
        // than document.write()-ing it into the doc page.
        //
        // document.write leaves the document's URL as the doc URL, so the doc page
        // is only ever one renderer hiccup away from resurfacing -- and because the
        // IDE HTML wipes the doc's <link> tags, when it does come back it comes back
        // unstyled. A real navigation destroys that document outright.
        //
        // It also makes Step 2 -> Step 3 a SAME-ORIGIN navigation, so there is no
        // cross-origin process swap between the IDE and the demo. The response is
        // fulfilled from memory, and the IDE paints #1e1e1e -- which matches the
        // browser's --background-color launch arg, so there is still no white flash.
        const ideUrl = new URL(IDE_ROUTE_PATH, config.demoUrl).toString();
        await page.route(ideUrl, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: ideHtml,
          }),
        );
        await page.goto(ideUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await ensureOverlays(page, 'vscode');
        await sleep(300);

        // Highlight primary file snippet
        await humanScrollCodeViewport(page, config.startLine, 0);
        const codeLocator = page.locator('#ide-view-0 .code-line.highlighted').first();
        if (await codeLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
          const box = await codeLocator.boundingBox();
          if (box) {
            await humanGlide(
              page,
              box.x + Math.min(box.width / 2, 420),
              box.y + Math.min(box.height / 2, 30),
              18,
            );
          }
        } else {
          await humanGlide(page, 520, 360, 18);
        }
        await sleep(hasExtraTabs ? 1500 : 1800);

        // If extra tabs exist, smoothly switch through each extra tab
        if (hasExtraTabs && config.extraTabs) {
          for (let tabIdx = 0; tabIdx < config.extraTabs.length; tabIdx++) {
            const extra = config.extraTabs[tabIdx];
            const targetDomIdx = tabIdx + 1;
            console.log(
              `   🖱️ Switching tab to ${basename(extra.filePath)} in VS Code...`,
            );
            const tabLocator = page.locator(`#ide-tab-${targetDomIdx}`);
            if (await tabLocator.isVisible().catch(() => false)) {
              const tBox = await tabLocator.boundingBox();
              if (tBox) {
                await humanGlide(
                  page,
                  tBox.x + tBox.width / 2,
                  tBox.y + tBox.height / 2,
                  18,
                );
                await humanClick(page);
              } else {
                await page.evaluate(`window.switchIdeTab(${targetDomIdx})`);
              }
            } else {
              await page.evaluate(`window.switchIdeTab(${targetDomIdx})`);
            }
            await sleep(300);

            // Scroll & Highlight extra tab code -- scoped to the tab that is now active
            await humanScrollCodeViewport(page, extra.startLine, targetDomIdx);
            const extraCodeLocator = page
              .locator(`#ide-view-${targetDomIdx} .code-line.highlighted`)
              .first();
            if (await extraCodeLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
              const box = await extraCodeLocator.boundingBox();
              if (box) {
                await humanGlide(
                  page,
                  box.x + Math.min(box.width / 2, 420),
                  box.y + Math.min(box.height / 2, 30),
                  18,
                );
              }
            } else {
              await humanGlide(page, 520, 360, 18);
            }
            await sleep(1800);
          }
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
        const terminalCount = config.terminals?.length ?? 0;
        for (let tIdx = 0; tIdx < terminalCount; tIdx++) {
          console.log(
            `   ⌨️  Terminal ${tIdx + 1}/${terminalCount}: ${config.terminals![tIdx].label}`,
          );

          if (tIdx === 0) {
            await page.evaluate('window.ideShowTerminal()');
            await sleep(900);
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
            await sleep(700);
          }

          // Rest the cursor in the output so the eye lands there, then hold
          // long enough for the banner to be read.
          const outLocator = page.locator(`#term-body-${tIdx} .term-line-out`).first();
          const oBox = await outLocator.boundingBox().catch(() => null);
          if (oBox) {
            await humanGlide(page, oBox.x + Math.min(oBox.width / 2, 380), oBox.y + 8, 16);
          }
          await sleep(2600);
        }

        // Switch back to Chrome via Windows 11 Taskbar
        console.log(`   🖱️ Switching back to Chrome via Windows 11 Taskbar...`);
        await clickTaskbarApp(page, 'chrome');
      } catch (e) {
        // The IDE view is generated from local files, so a failure here is a real
        // defect in this repo -- never a flaky-network excuse.
        const msg = `IDE view failed: ${diagnoseError(e, 'ide-simulation')}`;
        fail(msg);
        console.error(`❌ ${msg}`);
        await sleep(600);
      }

      // ----------------------------------------------------
      // STEP 3: FRONTEND DEMO PAGE & TAILORED ACTION EXECUTION
      // ----------------------------------------------------
      console.log(`\n🚀 Step 3: Opening Demo (${config.demoUrl})...`);
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
          timeout: 45000,
        });

        // A 404/500 used to sail through as a PASS -- the route simply did not exist.
        const status = response?.status() ?? 0;
        if (status >= 400) {
          throw new Error(
            `Demo route returned HTTP ${status} (${config.demoUrl})`,
          );
        }

        // Our demo pages are App Router too, so React will delete the overlays
        // when it hydrates -- but the guard inside ensureOverlays re-attaches
        // them. No wait here: nothing scrolls this page, and if hydration has
        // already finished the probe would never fire and just burn its timeout.
        await ensureOverlays(page, 'chrome');

        // Wait for page body and chat element readiness
        console.log(`   ⏳ Waiting for Next.js compilation & React hydration to settle...`);
        await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
        // No .catch() here: if the demo never renders an interactive surface there
        // is nothing to record, and that must fail rather than warn.
        await page.waitForSelector(SELECTORS.chatReady, {
          state: 'visible',
          timeout: 15000,
        });
        await sleep(1000);

        // Dispatch specific demo actions
        await executePageAction(page, config, this.rootDir);

        console.log(`✅ Demo execution completed for ${config.id}.`);
        await sleep(1500);
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
      const video = page.video();
      await page.close().catch(() => {});
      await context.close().catch(() => {});

      if (video) {
        const baseFilename = config.filename ?? config.id;
        finalSavedFilename = `${baseFilename}.webm`;

        const finalWebm = join(this.videosDir, finalSavedFilename);
        try {
          if (existsSync(finalWebm)) unlinkSync(finalWebm);
          await video.saveAs(finalWebm);
          await video.delete().catch(() => {});

          if (recordSuccess) {
            console.log(`\n🎥 [RECORDING SUCCESSFUL]: ${finalWebm}\n`);
          }
        } catch (err) {
          console.warn(`Video save note: ${err}`);
        }
      }

      await browser.close().catch(() => {});

      // Playwright's raw chunk lands here before saveAs moves it out. Nothing
      // should survive the run; left alone it accumulated one stray .webm per
      // recording, gitignored and invisible.
      try {
        rmSync(this.tempVideoDir, { recursive: true, force: true });
      } catch {}
    }

    return {
      success: recordSuccess,
      filename: finalSavedFilename,
      error: recordError,
      warnings,
    };
  }
}
