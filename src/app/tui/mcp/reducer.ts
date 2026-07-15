import type { McpMutationAction, McpOverlayState, McpRouteKind } from './types';

export type McpOverlayAction =
  | { type: 'move'; delta: number; count: number }
  | { type: 'open'; route: McpRouteKind; serverId: string }
  | { type: 'back' }
  | { type: 'show_list' }
  | { type: 'start_search' }
  | { type: 'append_search'; value: string }
  | { type: 'backspace_search' }
  | { type: 'finish_search' }
  | { type: 'cancel_search' }
  | { type: 'set_pending_decision'; decision?: 'approved' | 'rejected' }
  | { type: 'confirm_mutation'; serverId: string; mutation: McpMutationAction }
  | { type: 'clamp'; count: number };

export const initialMcpOverlayState: McpOverlayState = {
  route: { kind: 'list' },
  selectedIndex: 0,
  search: '',
  searchActive: false,
};

export function mcpOverlayReducer(
  state: McpOverlayState,
  action: McpOverlayAction,
): McpOverlayState {
  switch (action.type) {
    case 'move':
      return {
        ...state,
        selectedIndex: clamp(state.selectedIndex + action.delta, action.count),
        pendingDecision: undefined,
      };
    case 'open':
      return {
        ...state,
        route: { kind: action.route, serverId: action.serverId },
        pendingDecision: undefined,
        pendingMutation: undefined,
      };
    case 'confirm_mutation':
      return {
        ...state,
        route: { kind: 'confirm', serverId: action.serverId },
        pendingDecision: undefined,
        pendingMutation: action.mutation,
      };
    case 'back':
      if (state.route.kind === 'list') return state;
      if (state.route.kind === 'detail' || state.route.kind === 'add') {
        return {
          ...state,
          route: { kind: 'list' },
          pendingDecision: undefined,
          pendingMutation: undefined,
        };
      }
      return {
        ...state,
        route: { kind: 'detail', serverId: state.route.serverId },
        pendingDecision: undefined,
        pendingMutation: undefined,
      };
    case 'show_list':
      return {
        ...state,
        route: { kind: 'list' },
        pendingDecision: undefined,
        pendingMutation: undefined,
      };
    case 'start_search':
      return { ...state, searchActive: true, pendingDecision: undefined };
    case 'append_search':
      return { ...state, search: state.search + action.value, selectedIndex: 0 };
    case 'backspace_search':
      return { ...state, search: state.search.slice(0, -1), selectedIndex: 0 };
    case 'finish_search':
      return { ...state, searchActive: false };
    case 'cancel_search':
      return { ...state, searchActive: false, search: '', selectedIndex: 0 };
    case 'set_pending_decision':
      return { ...state, pendingDecision: action.decision };
    case 'clamp':
      return { ...state, selectedIndex: clamp(state.selectedIndex, action.count) };
  }
}

function clamp(index: number, count: number): number {
  return count === 0 ? 0 : Math.max(0, Math.min(count - 1, index));
}
