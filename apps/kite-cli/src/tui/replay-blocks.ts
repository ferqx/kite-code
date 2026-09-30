import type { SessionData } from '#kite-cli/session-types';
import { createInitialState } from './initialState';
import { reduceEvent } from './reducers';
import type { InterruptState, OutputBlock, TuiState } from './types';

/**
 * Safe replay only consumes AcceptedPresentationEnvelope values. State-history interactions are
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
  // History replay is an explicit projection mode. It is the only mode that
  // may consume durable terminals before a live Runtime authority exists.
  let state: TuiState = { ...createInitialState(), presentationMode: 'history' };
  for (const event of data.runtimeEvents) {
    // Replay returns the reducer's block sequence. Its intermediate Timeline
    // is never rendered; building it for every event rehashes the entire past.
    state = reduceEvent(state, { type: 'ACCEPT_PRESENTATION_ENVELOPE', event });
  }
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
