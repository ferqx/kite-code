import type { InterruptState } from './types';

/** Decide whether clearing an interrupt should resolve the pending graph interrupt as cancel.
 *  Normal UI resolutions clear state.interrupt too, but they have already submitted a concrete
 *  answer/approval action and must not be followed by a synthetic cancel. */
export function shouldCancelClearedInterrupt(
  previous: InterruptState | null,
  current: InterruptState | null,
  clearedByResolution: boolean,
): boolean {
  return !!previous && !current && !clearedByResolution;
}
