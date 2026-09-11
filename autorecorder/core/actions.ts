import { type Page } from 'playwright';
import { SELECTORS } from '../config/selectors.config';
import { fatalConsoleError } from './console-capture';
import { dismissAlertOverlay, installAlertOverlay } from './overlays/alert-dialog';
import { beat, humanClick, humanGlide, idleNudge, sleep } from './overlays/cursor';
import { chance, humanType, pause } from './overlays/human';
import { TIMEOUTS } from './timeouts';
import {
  type ActionContext,
  type DemoCheck,
  type DemoGlideTarget,
  type PageActionHandler,
  type PageRecordConfig,
} from './types';


/**
 * The agent never answered.
 *
 * Its own error type so a caller can tell silence apart from every other
 * demo-step failure (a 404, a chat surface that never renders). One page's
 * silence is a break; on a page whose documented defect *is* the silence it is
 * the whole finding, and a handler may want to catch exactly this and nothing
 * else.
 */
export class AgentSilentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSilentError';
  }
}

/** What `waitForAgentResponseCompletion` observed, for handlers that check. */
export interface ReplyObservation {
  /** Milliseconds from the call until the first reply text appeared. */
  startedAfterMs: number;
  /** Length of the reply text when it was last read. */
  chars: number;
  /**
   * The stream cap expired while text was still changing.
   *
   * The reply on screen may be incomplete, and the "stable for 1.6s" rule was
   * never satisfied. A handler should surface this rather than treat the
   * reply as finished.
   */
  streamTimedOut: boolean;
}

export interface ReplyWaitOptions {
  /**
   * How long to wait for a reply to *start*. The default suits a plain chat
   * turn and is deliberately tight, because a page that never answers is the
   * failure this suite exists to catch. Raise it for an agent that is
   * legitimately slow rather than broken.
   */
  startTimeoutMs?: number;
  /** How long to allow the reply to stream once it has started. */
  streamTimeoutMs?: number;
}

/**
 * Assistant messages as CopilotKit's own prebuilt components render them.
 *
 * Pages that replace the message view via a slot render none of these classes,
 * so they must pass their own selector -- see the `slots` level-3 handler.
 */
export const DEFAULT_ASSISTANT_MESSAGE_SELECTOR = SELECTORS.assistantMessage;

/**
 * Returns the current count of assistant message elements in the DOM
 */
export async function getAssistantMessageCount(
  page: Page,
  messageSelector: string = DEFAULT_ASSISTANT_MESSAGE_SELECTOR,
): Promise<number> {
  return page
    .evaluate((sel) => document.querySelectorAll(sel).length, messageSelector)
    .catch(() => 0);
}

/**
 * Actively waits until:
 * 1. An assistant response message appears with text content.
 * 2. Streaming finishes (text content stops changing for 1.6+ seconds).
 * 3. Glides the mouse over the response and waits postWaitMs (default 4000ms) for reading.
 */
export async function waitForAgentResponseCompletion(
  page: Page,
  postWaitMs = 4000,
  initialMessageCount?: number,
  messageSelector: string = DEFAULT_ASSISTANT_MESSAGE_SELECTOR,
  opts: ReplyWaitOptions = {},
): Promise<ReplyObservation> {
  const startTimeoutMs = opts.startTimeoutMs ?? TIMEOUTS.replyStartMs;
  const streamTimeoutMs = opts.streamTimeoutMs ?? TIMEOUTS.replyStreamMs;
  console.log(`   ⏳ Actively detecting AI agent response start & streaming progress...`);

  // Step 1: Wait until a new assistant message starts receiving content
  let hasStarted = false;
  const startTime = Date.now();
  const baseCount = initialMessageCount ?? 0;
  const observed: ReplyObservation = { startedAfterMs: 0, chars: 0, streamTimedOut: false };

  while (Date.now() - startTime < startTimeoutMs) {
    const status = await page
      .evaluate(({ bCount, sel }) => {
        const msgs = document.querySelectorAll(sel);
        if (msgs.length === 0) return { started: false, len: 0 };
        // If initialMessageCount was given, ensure we are looking at a new message
        if (bCount > 0 && msgs.length <= bCount) {
          return { started: false, len: 0 };
        }
        // Scan back for the newest message that actually has text. Some pages
        // render an empty trailing node after the real reply -- reading the last
        // match blindly then sees "" forever and reports that the agent never
        // answered while the answer is on screen.
        let txt = '';
        for (let i = msgs.length - 1; i >= 0; i--) {
          const t = (msgs[i].textContent || '').trim();
          if (t) { txt = t; break; }
        }
        return { started: txt.length > 2, len: txt.length };
      }, { bCount: baseCount, sel: messageSelector })
      .catch(() => ({ started: false, len: 0 }));

    if (status.started) {
      hasStarted = true;
      observed.startedAfterMs = Date.now() - startTime;
      observed.chars = status.len;
      break;
    }

    // The run has already told us the reply is not coming: the CopilotKit
    // client logged that the agent run failed, or the request itself did.
    // Sitting out the rest of the start window (30-90s per page, three to
    // seven pages in a row on a bad morning) only delays the same verdict.
    const fatal = fatalConsoleError(page);
    if (fatal) {
      throw new AgentSilentError(
        `Agent run failed before any reply text appeared (${Math.round((Date.now() - startTime) / 1000)}s in): ${fatal}`,
      );
    }
    await sleep(300);
  }

  // Step 2: Stream completion detection — poll until text length stabilizes
  if (hasStarted) {
    console.log(`   🌊 AI agent is streaming response tokens...`);
    let previousText = '';
    let stableCount = 0;
    let settled = false;
    let polls = 0;
    const streamStart = Date.now();

    while (Date.now() - streamStart < streamTimeoutMs) {
      // A reader's hand is not still for twenty seconds. Every second or so,
      // a small drift — biased downward, following the text as it arrives.
      if (++polls % 3 === 0 && chance(0.7)) {
        await idleNudge(page, 4);
      }
      const currentText = await page
        .evaluate((sel) => {
          const msgs = document.querySelectorAll(sel);
          if (msgs.length === 0) return '';
          for (let i = msgs.length - 1; i >= 0; i--) {
            const t = (msgs[i].textContent || '').trim();
            if (t) return `${msgs.length}:${t}`;
          }
          return '';
        }, messageSelector)
        .catch(() => '');

      // The count is part of the compared value, so a new message arriving
      // restarts the stability window instead of looking like "no change".
      if (currentText.length > 0 && currentText === previousText) {
        stableCount++;
        // If text is stable for 4 consecutive checks (1.6s), streaming has finished
        if (stableCount >= 4) {
          observed.chars = currentText.length;
          settled = true;
          console.log(
            `   ✅ AI agent response completed (${currentText.length} characters).`,
          );
          break;
        }
      } else {
        stableCount = 0;
        previousText = currentText;
      }
      await sleep(400);
    }

    // The cap ran out with text still changing. That used to fall through
    // silently and count as complete; now the caller is told.
    if (!settled) {
      observed.streamTimedOut = true;
      observed.chars = previousText.length;
      console.warn(
        `   ⚠️ Reply was still streaming after ${Math.round(streamTimeoutMs / 1000)}s; the take continues with it possibly unfinished.`,
      );
    }
  } else {
    // An agent that never answers is the failure this suite exists to catch.
    // Warning here and continuing is what let broken pages report [PASS].
    throw new AgentSilentError(
      `Agent never produced a response within ${Math.round(startTimeoutMs / 1000)}s -- no assistant message ever ` +
        'received content. Check the backend and the browser console output above.',
    );
  }

  // Step 3: Glide cursor smoothly to the finished response message
  const assistantLocator = page.locator(messageSelector).last();

  if (await assistantLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
    const abBox = await assistantLocator.boundingBox();
    if (abBox) {
      console.log(
        `   🎯 Focusing cursor on response at (${Math.round(abBox.x)}, ${Math.round(abBox.y)})`,
      );
      await humanGlide(
        page,
        abBox.x + Math.min(abBox.width / 2, 220),
        abBox.y + Math.min(abBox.height / 2, 60),
        20,
      );
    }
  } else {
    await humanGlide(page, 960, 500, 20);
  }

  // Step 4: Reading pause after response completes
  console.log(`   📖 Reading completed response (pausing ${postWaitMs / 1000}s)...`);
  await pause(postWaitMs, 0.2);
  return observed;
}

/** Default chat input across the CopilotKit prebuilt surfaces. */
const DEFAULT_INPUT_SELECTOR = SELECTORS.chatInput;

/** Default submit control; falls back to the Enter key when absent. */
const DEFAULT_SUBMIT_SELECTOR = SELECTORS.chatSubmit;

export interface SendPromptOptions {
  /** Override when a page hand-rolls its own input (headless UI, programmatic control). */
  inputSelector?: string;
  /** Override when submitting means clicking something other than a send button. */
  submitSelector?: string;
  /** Select-all + delete before typing, for inputs that arrive pre-populated. */
  clearFirst?: boolean;
  /** How long to wait for the input to appear. */
  timeoutMs?: number;
  /** Override when the page renders messages through a custom slot. */
  messageSelector?: string;
  /** Whether submitting is expected to clear the input field (defaults to true). */
  expectInputToEmpty?: boolean;
}

/**
 * Types a prompt into a demo page's chat input and submits it, the way a person
 * would -- glide, click, key-by-key typing, then the send button.
 *
 * Extracted because twelve action handlers had carried their own near-identical
 * copy of this, and only one of them had the swallowed-submit retry. Everything
 * routed through here now gets it.
 *
 * @returns The assistant message count observed *before* submitting. Pass it to
 *   waitForAgentResponseCompletion so multi-turn pages do not mistake the
 *   previous turn's reply for this one's.
 */
export async function sendPrompt(
  page: Page,
  prompt: string,
  options: SendPromptOptions = {},
): Promise<number> {
  const {
    inputSelector = DEFAULT_INPUT_SELECTOR,
    submitSelector = DEFAULT_SUBMIT_SELECTOR,
    clearFirst = false,
    timeoutMs = 15000,
    messageSelector = DEFAULT_ASSISTANT_MESSAGE_SELECTOR,
    expectInputToEmpty = true,
  } = options;

  const inputLocator = page.locator(inputSelector).first();
  await inputLocator.waitFor({ state: 'visible', timeout: timeoutMs });
  await sleep(300);

  const initialMsgCount = await getAssistantMessageCount(page, messageSelector);

  const inputBox = await inputLocator.boundingBox();
  if (inputBox) {
    await humanGlide(page, inputBox.x + 80, inputBox.y + inputBox.height / 2, 18);
    await humanClick(page);
  } else {
    await inputLocator.click();
  }
  await sleep(200);

  if (clearFirst) {
    await inputLocator.fill('').catch(async () => {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
    });
  }

  const submitBtn = page.locator(submitSelector).first();

  // Type, submit, and confirm it actually went -- up to three attempts.
  //
  // In dev the demo route compiles on first request, so the chat can paint and
  // accept keystrokes seconds before React hydrates. Typing into that window
  // fills the textarea natively, hydration then resets it to React's empty
  // state, and the Enter that follows submits nothing. The recording looked
  // perfect and the page failed 30s later with "agent never responded".
  //
  // So: wait for the composer to prove it is live (v2 keeps the send button
  // disabled until its state holds the text), then verify the box emptied.
  let sent = false;
  for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
    if (attempt > 1) {
      console.log(`   ↻ Prompt did not submit -- retyping (attempt ${attempt}/3)...`);
      // fill('') clears the control itself. Ctrl+A / Backspace used to do
      // this, and on a page whose composer had lost focus Ctrl+A selected
      // the whole document -- a white highlight sweeping the sidebar, on
      // camera, in the middle of a take.
      await inputLocator.click();
      await inputLocator.fill('').catch(() => {});
    }

    // A person's rhythm on the first attempt. A retry is the recorder
    // recovering from a swallowed submit, and is typed quickly rather than
    // performed a second time.
    if (attempt === 1) {
      await humanType(page, prompt, { charDelayMs: 58 });
    } else {
      await page.keyboard.type(prompt, { delay: 12 });
    }
    await pause(300);

    // React owns the value once hydrated; if it wiped what we typed, put it back.
    const typedVal = await inputLocator.inputValue().catch(() => prompt);
    if (!typedVal.trim() && prompt) {
      await inputLocator.fill(prompt);
      await sleep(250);
    }

    // A send button that is still disabled means React has not caught up.
    const enabled = await submitBtn
      .isEnabled({ timeout: 4000 })
      .catch(() => false);
    if (!enabled) {
      const stillVisible = await submitBtn.isVisible().catch(() => false);
      if (stillVisible) {
        await page
          .waitForFunction(
            (sel) => {
              try {
                const b = document.querySelector(sel) as HTMLButtonElement | null;
                return !!b && !b.disabled;
              } catch {
                return true;
              }
            },
            submitSelector,
            { timeout: 5000 },
          )
          .catch(() => {});
      }
    }

    if (await submitBtn.isEnabled({ timeout: 1500 }).catch(() => false)) {
      const btnBox = await submitBtn.boundingBox();
      if (btnBox) {
        await humanGlide(page, btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2, 16);
        await humanClick(page);
      } else {
        await submitBtn.click();
      }
    } else {
      await page.keyboard.press('Enter');
    }

    if (!expectInputToEmpty) {
      sent = true;
      break;
    }

    // Submitting clears the composer. Anything left in it was swallowed.
    const composerEmptied = () =>
      page
        .waitForFunction(
          (sel) => {
            try {
              const el = document.querySelector(sel) as
                | (HTMLElement & { value?: string })
                | null;
              if (!el) return true;
              const v = el.value ?? el.textContent ?? '';
              return v.trim().length === 0;
            } catch {
              return true;
            }
          },
          inputSelector,
          { timeout: 3500 },
        )
        .then(() => true)
        .catch(() => false);

    sent = await composerEmptied();

    // One keyboard fallback before giving up on this attempt -- a click that
    // landed a pixel off is far likelier than a genuinely dead composer.
    if (!sent) {
      await page.keyboard.press('Enter');
      sent = await composerEmptied();
    }
  }

  if (!sent) {
    throw new Error(
      'Prompt never submitted -- the composer still holds the text after three ' +
        'attempts. Check selectors.config.ts (chatInput / chatSubmit) against this page.',
    );
  }

  return initialMsgCount;
}

/**
 * Prompts declared for a page, in order. Falls back to the single `prompt`
 * field for pages that only send one.
 */
export function promptsFor(config: PageRecordConfig): string[] {
  return config.prompts?.length ? config.prompts : [config.prompt];
}

/**
 * Rests the cursor on an element the page rendered: centre of its box, with a
 * beat after. Returns false, without moving, when nothing matches -- the
 * caller decides whether that is a finding.
 */
export async function glideToElement(
  page: Page,
  selector: string,
  opts: { timeoutMs?: number; beatMs?: number; offset?: { x: number; y: number }; last?: boolean; label?: string } = {},
): Promise<boolean> {
  const all = page.locator(selector);
  const el = opts.last ? all.last() : all.first();
  if (!(await el.isVisible({ timeout: opts.timeoutMs ?? 4000 }).catch(() => false))) return false;
  const box = await el.boundingBox();
  if (!box) return false;
  const x = opts.offset ? box.x + opts.offset.x : box.x + Math.min(box.width / 2, 250);
  const y = opts.offset ? box.y + opts.offset.y : box.y + box.height / 2;
  if (opts.label) console.log(`   🎯 ${opts.label} at (${Math.round(box.x)}, ${Math.round(box.y)})`);
  await humanGlide(page, x, y, 22);
  await beat(opts.beatMs ?? 1500);
  return true;
}

async function glideAlong(page: Page, targets: DemoGlideTarget[]): Promise<void> {
  for (const t of targets) {
    if (typeof t === 'string') {
      await glideToElement(page, t);
    } else if ('selector' in t) {
      await glideToElement(page, t.selector, { beatMs: t.beatMs, offset: t.offset });
    } else {
      await humanGlide(page, t.x, t.y, 22);
      await beat(t.beatMs ?? 1500);
    }
  }
}

async function runCheck(page: Page, check: DemoCheck, ctx: ActionContext): Promise<void> {
  const all = page.locator(check.selector);
  const el = check.last ? all.last() : all.first();
  const timeout = check.timeoutMs ?? 2000;
  const visible = await el.isVisible({ timeout }).catch(() => false);
  let pass: boolean;
  let text = '';
  let found = 0;
  const wanted = check.contains === undefined ? [] : Array.isArray(check.contains) ? check.contains : [check.contains];
  if (check.absent) {
    pass = !visible;
  } else if (check.enabled !== undefined) {
    const enabled = await el.isEnabled({ timeout: 1000 }).catch(() => false);
    pass = enabled === check.enabled;
  } else if (wanted.length > 0) {
    text = (await el.innerText().catch(() => '')).trim();
    const lower = text.toLowerCase();
    found = wanted.filter((w) => lower.includes(w.toLowerCase())).length;
    pass = found === wanted.length;
  } else {
    pass = visible;
  }
  if (pass) {
    if (check.ok) console.log(`   ✅ ${check.ok}`);
    return;
  }
  const message = check.message
    .replace('{found}', String(found))
    .replace('{total}', String(wanted.length))
    .replace('{text}', text ? JSON.stringify(text.slice(0, 80)) : '(empty)');
  if (check.severity === 'fail') ctx.fail(message);
  else ctx.warn(message);
}

/**
 * The take most pages need: prompt, watch the reply, rest the cursor on what
 * rendered, judge it. Everything page-specific comes from `config.demo`; a
 * page with no `demo` block is a plain chat turn.
 */
export const runStandardAction: PageActionHandler = async (
  page: Page,
  config: PageRecordConfig,
  _rootPath,
  ctx,
) => {
  const demo = config.demo ?? {};
  console.log(`   🔍 Detecting demo page & chat component rendering...`);

  if (demo.before?.length) await glideAlong(page, demo.before);
  if (demo.alert) await installAlertOverlay(page);

  const initialMsgCount = await sendPrompt(page, config.prompt, { timeoutMs: demo.sendTimeoutMs ?? 15000 });

  if (demo.alert) {
    const shown = await dismissAlertOverlay(page);
    if (shown) console.log(`   Browser alert captured and dismissed.`);
    else ctx.warn(demo.alert.missing);
  }

  let rendered = true;
  if (demo.render) {
    const all = page.locator(demo.render.selector);
    const el = demo.render.last ? all.last() : all.first();
    rendered = await el
      .waitFor({ state: 'visible', timeout: demo.render.timeoutMs ?? 20000 })
      .then(() => true)
      .catch(() => false);
    if (rendered) {
      await glideToElement(page, demo.render.selector, { last: demo.render.last, beatMs: demo.render.beatMs ?? 2000, label: 'Rendered' });
    } else if (demo.render.required) {
      ctx.fail(demo.render.required);
    }
  }

  let sinceMsgCount = initialMsgCount;
  if (demo.click && rendered) {
    const btn = page.locator(demo.click.selector).first();
    const box = (await btn.isVisible({ timeout: 4000 }).catch(() => false)) ? await btn.boundingBox() : null;
    if (box) {
      await humanGlide(page, box.x + box.width / 2, box.y + box.height / 2, 20);
      await sleep(600);
      await humanClick(page);
      console.log(`   ✓ Clicked ${demo.click.selector}`);
      await beat(demo.click.beatMs ?? 800);
      sinceMsgCount = Math.max(sinceMsgCount, await getAssistantMessageCount(page));
    } else {
      ctx.fail(demo.click.missing);
    }
  }

  if (demo.glideTo?.length) await glideAlong(page, demo.glideTo);

  const reply = await waitForAgentResponseCompletion(
    page,
    config.waitAfterPromptMs ?? 4000,
    sinceMsgCount,
    DEFAULT_ASSISTANT_MESSAGE_SELECTOR,
    { startTimeoutMs: ctx.timeouts.replyStartMs, streamTimeoutMs: ctx.timeouts.replyStreamMs },
  ).catch((e) => {
    // A page whose render step already failed has its defect; the silence is a consequence, not a second one.
    if (!rendered && demo.render?.required) return { startedAfterMs: 0, chars: 0, streamTimedOut: false };
    throw e;
  });
  if (reply.streamTimedOut) {
    ctx.warn(`Reply still streaming after ${Math.round(ctx.timeouts.replyStreamMs / 1000)}s; the clip may end mid-answer.`);
  }

  for (const check of demo.checks ?? []) await runCheck(page, check, ctx);
};
