import { type Page } from 'playwright';
import { PROJECT, demoUrlFor, docUrlFor } from '../config/project.config';
import { type IdeTabConfig, type TerminalSessionConfig } from './ide/generator';

export { type IdeTabConfig, type TerminalSessionConfig };

/**
 * What an adaptation writes in `config/pages.config.ts`.
 *
 * Deliberately smaller than PageRecordConfig: URLs and filenames are derived
 * rather than repeated, so no entry can drift onto another framework's docs and
 * the video numbering always matches nav order.
 */
export interface PageDefinition {
  /** CLI id, also the `--<id>` flag. Must be unique. */
  id: string;

  /** Human title for logs and the summary table. */
  name: string;

  /** Video filename stem: `<videoPrefix>-<NN>-<videoName>.webm`. */
  videoName: string;

  /** Appended to `PROJECT.docBaseUrl`. Query strings are fine. */
  docPath: string;

  /** Appended to `PROJECT.frontendUrl`, then `PROJECT.demoSuffix`. */
  route: string;

  /** Repo-relative source file the simulated IDE shows. */
  ideFile: string;

  /** Inclusive highlight range in `ideFile`. Guarded by `npm run doctor`. */
  startLine: number;
  endLine: number;

  /** Extra IDE tabs to switch through, each with its own range. */
  extraTabs?: IdeTabConfig[];

  /** Prompt to send. For multi-turn pages this is the first one. */
  prompt: string;

  /** Ordered prompts for pages driving several turns or tabs. */
  prompts?: string[];

  /** Reading pause after the reply finishes streaming. */
  waitAfterPromptMs?: number;

  /**
   * Terminals to open in the IDE's integrated panel, in order, after the file
   * tabs have been shown.
   *
   * Each one shows its command and then the session file `capture.ts` wrote --
   * the *real* stdout captured when that command was started for this run.
   * Nothing here is written by hand: a missing or empty log fails the
   * recording rather than inventing plausible-looking output.
   */
  terminals?: TerminalSessionConfig[];

  /** Per-page overrides of the recorder's fixed waits. See `RecorderTimeouts`. */
  timeouts?: Partial<RecorderTimeouts>;
}

/** A page definition with everything resolved. What the engine consumes. */
export interface PageRecordConfig extends PageDefinition {
  docUrl: string;
  demoUrl: string;
  filename: string;
  /** 1-based position in the registry, used for the filename index. */
  order: number;
}

/**
 * Resolves declarative page definitions into what the engine runs.
 *
 * Called once by `config/pages.config.ts`; nothing else should build a
 * PageRecordConfig by hand, or the derived-URL guarantee stops holding.
 */
export function definePages(defs: PageDefinition[]): PageRecordConfig[] {
  return defs.map((def, i) => {
    const order = i + 1;
    return {
      ...def,
      order,
      docUrl: docUrlFor(def.docPath),
      demoUrl: demoUrlFor(def.route),
      filename: `${PROJECT.videoPrefix}-${String(order).padStart(2, '0')}-${def.videoName}`,
    };
  });
}

/**
 * How a page handler reports what it saw, so the summary and CI see it too.
 *
 * Before this, a handler that noticed "the weather card never rendered" could
 * only `console.warn` it. The run still printed `[PASS]` with no asterisk, and
 * the CI report carried nothing. `warn` puts the note on the result as `PASS*`;
 * `fail` marks the recording failed once the handler returns, so the clip is
 * still filmed to the end and still saved as evidence.
 */
export interface ActionContext {
  /** The clip is usable but something the doc promises was not observed. */
  warn: (message: string) => void;
  /** The feature under test did not work. The recording finishes, then fails. */
  fail: (message: string) => void;
  /** Resolved timeouts for this page. */
  timeouts: RecorderTimeouts;
}

/**
 * Every fixed wait in the recorder, in one place.
 *
 * These used to be literals scattered through `core/`. Defaults live in
 * `core/timeouts.ts`; a project sets `PROJECT.timeouts` and a page sets
 * `timeouts` to override.
 */
export interface RecorderTimeouts {
  /** Loading the external doc page. */
  docNavMs: number;
  /** Loading the demo route. First hit on a dev route compiles it. */
  demoNavMs: number;
  /** Chat surface visible after the demo route loads. */
  chatReadyMs: number;
  /** A reply *starting* after the prompt is sent. */
  replyStartMs: number;
  /** A reply finishing once it has started. */
  replyStreamMs: number;
}

export type PageActionHandler = (
  page: Page,
  config: PageRecordConfig,
  rootPath: string,
  ctx: ActionContext,
) => Promise<void>;
