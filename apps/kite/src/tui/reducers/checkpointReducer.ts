// ── Checkpoint 操作 ──

import type { TuiState } from '../types';
import type { Action } from './actions';

export function checkpointReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case 'EXECUTE_REWIND':
      return {
        ...state,
        showRewind: false,
        checkpoints: [],
      };
    case 'SET_CHECKPOINTS':
      return { ...state, checkpoints: action.checkpoints };
    default:
      return null;
  }
}
