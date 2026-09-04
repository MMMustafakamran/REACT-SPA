import { PROJECT } from '../config/project.config';
import { type PageRecordConfig, type RecorderTimeouts } from './types';

/**
 * Defaults for every fixed wait in the recorder.
 *
 * Kept deliberately tight. A page that never answers is the failure this suite
 * exists to catch, and a generous ceiling everywhere would blunt it; a page
 * that is legitimately slow says so in its own `timeouts`.
 */
export const DEFAULT_TIMEOUTS: RecorderTimeouts = {
  docNavMs: 25_000,
  demoNavMs: 45_000,
  chatReadyMs: 15_000,
  replyStartMs: 30_000,
  replyStreamMs: 45_000,
};

/** Project overrides applied to the defaults. */
export const TIMEOUTS: RecorderTimeouts = { ...DEFAULT_TIMEOUTS, ...(PROJECT.timeouts ?? {}) };

/** Page overrides applied on top of the project's. */
export function timeoutsFor(config?: Pick<PageRecordConfig, 'timeouts'>): RecorderTimeouts {
  return { ...TIMEOUTS, ...(config?.timeouts ?? {}) };
}
