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
import { closeNotepad, openNotepad, typeInNotepad } from '../core/overlays/notepad';
import { formatVersionNote, readCopilotKitVersions } from '../core/versions';
import { type Page } from 'playwright';

/**
 * The standard take, then the versions it ran on, written down on camera.
 *
 * PROJECT_GOAL rule 4 asks every finding to pin installed against declared.
 * The IDE step shows the declared side by opening `package.json`; this is the
 * installed side, read out of the track's `node_modules` at record time by
 * `core/versions.ts` — so the number on screen is what the demo just used, not
 * what someone typed into a slide months ago.
 *
 * It goes in Notepad rather than onto the demo page. A banner rendered into
 * the route would be a third channel duplicating the note and the narration,
 * and it would take vertical space from the chat that is the thing being
 * demonstrated. The tester opens Notepad while the reply is still on screen
 * behind it, which is also how a defect gets written up here.
 */
const runQuickstart: PageActionHandler = async (page, config, rootPath, ctx) => {
  await runStandardAction(page, config, rootPath, ctx);

  const note = formatVersionNote();
  if (!note) {
    ctx.warn('No @copilotkit/* dependency found in the scaffold — version note skipped.');
    return;
  }

  // Declared but absent from node_modules: the clip would otherwise show a
  // version for a package that never loaded. Say so in the summary too.
  for (const v of readCopilotKitVersions()) {
    if (v.installed === null) {
      ctx.warn(`${v.name} is declared ${v.declared} but is not installed in this track.`);
    }
  }

  await openNotepad(page, 'versions.txt');
  // Faster than the prose rhythm the defect notes use: this is a person
  // transcribing numbers off a screen, not composing a sentence.
  await typeInNotepad(page, note, { charDelayMs: 34 });
  await closeNotepad(page, 3200);
};

/**
 * Keys are page ids from `config/pages.config.ts`. Doctor flags any orphans.
 *
 * One entry. The page drives CopilotKit's own `<CopilotChat />` with a single
 * prompt — `runStandardAction`'s whole job — and the handler exists only to
 * add the versions note after it. The reference repo's sixteen handlers were
 * deleted rather than kept "in case": every one of them addressed a demo route
 * that does not exist in a single-page app, and the doctor reports a handler
 * for an unknown page id as a warning.
 *
 * Write one here if a future page needs more than type-submit-wait: switching
 * IDE tabs mid-take, clicking an approval control, opening a panel.
 */
export const ACTION_MAP: Record<string, PageActionHandler> = {
  quickstart: runQuickstart,
};

export async function executePageAction(
  page: Page,
  config: PageRecordConfig,
  rootPath: string,
  ctx: ActionContext,
): Promise<void> {
  const handler = ACTION_MAP[config.id] ?? runStandardAction;
  await handler(page, config, rootPath, ctx);
}
