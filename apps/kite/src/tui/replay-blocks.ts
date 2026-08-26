import type { SessionData } from '#app/session-types';
import { createInitialState } from './initialState';
import { handleClientEventAction } from './reducers/handleClientEvent';
import type { InterruptState, OutputBlock, TuiState } from './types';

/**
 * Safe replay only consumes RuntimeClientEvent. State-history interactions are
 * display-only: the restored State snapshot may require a recovery fork, but
 * no old interaction is reinstalled as a live settlement target.
 */
export function sessionDataToUI(data: SessionData): {
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
  interactionMode: TuiState['interactionMode'];
  pendingToolCalls: TuiState['pendingToolCalls'];
  recoveredPendingInteraction: boolean;
} {
  let state = createInitialState();
  for (const event of data.runtimeEvents) state = handleClientEventAction(state, event);
  state = {
    ...state,
    interactionMode: data.interactionMode,
    // Any historical safe interaction is intentionally non-settleable on
    // restore. The Session owner decides whether a fresh interaction is made.
    interrupt: null,
    pendingApprovals: new Map(),
    activeApprovalId: null,
  };
  return {
    blocks: state.turns.flatMap((turn) => turn.blocks),
    interrupt: null,
    interactionMode: state.interactionMode,
    pendingToolCalls: state.pendingToolCalls,
    recoveredPendingInteraction: data.interrupt !== null,
  };
}
