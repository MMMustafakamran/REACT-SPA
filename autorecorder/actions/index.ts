/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ADAPT THIS DIRECTORY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What the recorder *does* on each demo page once it is open.
 *
 * The registry lives here rather than in `core/` on purpose: adding or removing
 * a page must never mean editing frozen code. A page with no entry falls back
 * to `runStandardAction` — type the prompt, submit, wait for the reply — which
 * is right for most pages. Write a handler only when a page needs more than
 * that: switching tabs, clicking an approval button, opening a panel.
 *
 * Handlers should build on the helpers in `core/actions.ts`:
 *
 *   sendPrompt(page, prompt, opts)          types and submits, returns the
 *                                           assistant-message count from before
 *                                           submitting
 *   waitForAgentResponseCompletion(...)     waits for the reply to finish, and
 *                                           throws if none ever arrives
 *   promptsFor(config)                      the page's prompts[] , or [prompt]
 *
 * Pass that returned count into waitForAgentResponseCompletion on multi-turn
 * pages, or the previous turn's reply is mistaken for this one's.
 *
 * The fourth argument, `ctx`, is how a handler reports what it saw:
 *
 *   ctx.warn('Language panel still reads "english"')   -> [PASS*] with the note
 *   ctx.fail('Approve button never rendered')           -> [FAIL], clip still saved
 *
 * A `console.log` reaches nobody: the summary and the CI report only see what
 * goes through `ctx`.
 */

import { type ActionContext, type PageActionHandler, type PageRecordConfig } from '../core/types';
import { runStandardAction } from '../core/actions';
import { type Page } from 'playwright';

/**
 * Keys are page ids from `config/pages.config.ts`. Doctor flags any orphans.
 *
 * Empty, and correctly so. The one page here drives CopilotKit's own
 * `<CopilotChat />` with a single prompt, which is exactly what
 * `runStandardAction` does. The reference repo's sixteen handlers were deleted
 * rather than kept "in case" — every one of them addressed a demo route that
 * does not exist in a single-page app, and the doctor reports a handler for an
 * unknown page id as a warning.
 *
 * Write one here if a future page needs more than type-submit-wait: switching
 * IDE tabs mid-take, clicking an approval control, opening a panel.
 */
export const ACTION_MAP: Record<string, PageActionHandler> = {};

export async function executePageAction(
  page: Page,
  config: PageRecordConfig,
  rootPath: string,
  ctx: ActionContext,
): Promise<void> {
  const handler = ACTION_MAP[config.id] ?? runStandardAction;
  await handler(page, config, rootPath, ctx);
}
