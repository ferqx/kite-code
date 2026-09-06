import { mergeMessages } from './merge-messages';
import type {
  WebCheckpointSummary,
  WebDirectorySnapshot,
  WebHistorySnapshot,
  WebPresentationMessage,
  WebSessionSummary,
  WebWorkspaceSummary,
} from './types';

export type WebConnectionState =
  | { readonly status: 'loading' }
  | { readonly status: 'connected' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type WebHistoryState = 'idle' | 'loading' | 'content' | 'empty' | 'unavailable' | 'error';

export interface WebPresentationState {
  readonly generation: number;
  readonly workspaces: readonly WebWorkspaceSummary[];
  readonly selectedSessionId: string | null;
  readonly routeSessionSnapshot: WebSessionSummary | null;
  readonly messages: readonly WebPresentationMessage[];
  readonly checkpoints: readonly WebCheckpointSummary[];
  readonly observedLastSequence: number | null;
  readonly historyState: WebHistoryState;
  readonly historyReason: string | null;
  readonly historyReloadToken: number;
  readonly checkpointState: 'idle' | 'loading' | 'loaded' | 'unavailable';
  readonly connection: WebConnectionState;
}

export type WebPresentationAction =
  | { readonly type: 'transport_connected'; readonly generation: number }
  | {
      readonly type: 'directory_loaded';
      readonly directory: WebDirectorySnapshot;
      readonly generation?: number;
    }
  | {
      readonly type: 'workspace_sessions_loading';
      readonly workspaceId: string;
      readonly generation?: number;
    }
  | {
      readonly type: 'workspace_sessions_loaded';
      readonly workspaceId: string;
      readonly sessions: readonly WebSessionSummary[];
      readonly generation?: number;
    }
  | {
      readonly type: 'workspace_sessions_failed';
      readonly workspaceId: string;
      readonly generation?: number;
    }
  | { readonly type: 'select_session'; readonly sessionId: string | null }
  | {
      readonly type: 'route_session_loaded';
      readonly session: WebSessionSummary;
      readonly generation?: number;
    }
  | {
      readonly type: 'history_loading';
      readonly generation?: number;
      readonly requestToken?: number;
    }
  | {
      readonly type: 'history_loaded';
      readonly history: WebHistorySnapshot;
      readonly generation?: number;
    }
  | {
      readonly type: 'history_increment_loaded';
      readonly history: WebHistorySnapshot;
      readonly generation?: number;
    }
  | {
      readonly type: 'checkpoints_loaded';
      readonly sessionId: string;
      readonly checkpoints: readonly WebCheckpointSummary[];
      readonly generation?: number;
    }
  | {
      readonly type: 'checkpoints_failed';
      readonly sessionId: string;
      readonly generation?: number;
    }
  | {
      readonly type: 'session_refreshed';
      readonly session: WebSessionSummary;
      readonly generation?: number;
    }
  | {
      readonly type: 'history_failed';
      readonly status: Extract<WebHistoryState, 'unavailable' | 'error'>;
      readonly reason: string;
      readonly generation?: number;
    }
  | { readonly type: 'history_retry'; readonly generation?: number }
  | {
      readonly type: 'connection';
      readonly connection: WebConnectionState;
      readonly generation?: number;
    };

export const initialWebPresentationState: WebPresentationState = Object.freeze({
  generation: 0,
  workspaces: [],
  selectedSessionId: null,
  routeSessionSnapshot: null,
  messages: [],
  checkpoints: [],
  observedLastSequence: null,
  historyState: 'idle',
  historyReason: null,
  historyReloadToken: 0,
  checkpointState: 'idle',
  connection: { status: 'loading' as const },
});

export function webPresentationReducer(
  state: WebPresentationState,
  action: WebPresentationAction,
): WebPresentationState {
  switch (action.type) {
    case 'transport_connected':
      return action.generation < state.generation
        ? state
        : { ...state, generation: action.generation, connection: { status: 'connected' } };
    case 'directory_loaded': {
      if (!matchesGeneration(state, action.generation)) return state;
      const selectedSessionId = state.selectedSessionId;
      const directorySession = action.directory.workspaces
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.sessionId === selectedSessionId);
      return {
        ...state,
        workspaces: action.directory.workspaces,
        selectedSessionId,
        routeSessionSnapshot: directorySession ? null : state.routeSessionSnapshot,
      };
    }
    case 'workspace_sessions_loading':
      return matchesGeneration(state, action.generation)
        ? updateWorkspace(state, action.workspaceId, (workspace) => ({
            ...workspace,
            sessionState: 'loading',
          }))
        : state;
    case 'workspace_sessions_loaded':
      return matchesGeneration(state, action.generation)
        ? updateWorkspace(state, action.workspaceId, (workspace) => ({
            ...workspace,
            sessions: action.sessions,
            sessionState: 'loaded',
          }))
        : state;
    case 'workspace_sessions_failed':
      return matchesGeneration(state, action.generation)
        ? updateWorkspace(state, action.workspaceId, (workspace) => ({
            ...workspace,
            sessionState: 'unavailable',
          }))
        : state;
    case 'select_session':
      if (action.sessionId === state.selectedSessionId) return state;
      return {
        ...state,
        selectedSessionId: action.sessionId,
        routeSessionSnapshot: null,
        messages: [],
        checkpoints: [],
        observedLastSequence: null,
        historyState: action.sessionId ? 'loading' : 'idle',
        historyReason: null,
        checkpointState: action.sessionId ? 'loading' : 'idle',
      };
    case 'route_session_loaded':
      return matchesGeneration(state, action.generation) &&
        action.session.sessionId === state.selectedSessionId
        ? { ...state, routeSessionSnapshot: action.session }
        : state;
    case 'history_loading':
      return matchesGeneration(state, action.generation)
        ? {
            ...state,
            historyState: 'loading',
            historyReason: null,
            historyReloadToken: action.requestToken ?? state.historyReloadToken,
          }
        : state;
    case 'history_loaded':
      if (
        !matchesGeneration(state, action.generation) ||
        action.history.sessionId !== state.selectedSessionId
      ) {
        return state;
      }
      return {
        ...state,
        messages: action.history.messages,
        observedLastSequence: action.history.observedLastSequence,
        historyState: action.history.messages.length > 0 ? 'content' : 'empty',
        historyReason: null,
        connection: { status: 'connected' },
      };
    case 'history_increment_loaded':
      if (
        !matchesGeneration(state, action.generation) ||
        action.history.sessionId !== state.selectedSessionId
      ) {
        return state;
      }
      return {
        ...state,
        messages: mergeMessages(state.messages, action.history.messages),
        observedLastSequence: action.history.observedLastSequence,
        connection: { status: 'connected' },
      };
    case 'checkpoints_loaded':
      return matchesGeneration(state, action.generation) &&
        action.sessionId === state.selectedSessionId
        ? { ...state, checkpoints: action.checkpoints, checkpointState: 'loaded' }
        : state;
    case 'checkpoints_failed':
      return matchesGeneration(state, action.generation) &&
        action.sessionId === state.selectedSessionId
        ? { ...state, checkpointState: 'unavailable' }
        : state;
    case 'session_refreshed':
      return matchesGeneration(state, action.generation)
        ? {
            ...state,
            workspaces: state.workspaces.map((workspace) => ({
              ...workspace,
              sessions: workspace.sessions.map((session) =>
                session.sessionId === action.session.sessionId ? action.session : session,
              ),
            })),
            routeSessionSnapshot:
              action.session.sessionId === state.selectedSessionId
                ? action.session
                : state.routeSessionSnapshot,
          }
        : state;
    case 'history_failed':
      return matchesGeneration(state, action.generation)
        ? { ...state, historyState: action.status, historyReason: action.reason }
        : state;
    case 'history_retry':
      return matchesGeneration(state, action.generation)
        ? {
            ...state,
            historyReloadToken: state.historyReloadToken + 1,
            historyState: 'loading',
            historyReason: null,
          }
        : state;
    case 'connection':
      return matchesGeneration(state, action.generation)
        ? { ...state, connection: action.connection }
        : state;
  }
}

function updateWorkspace(
  state: WebPresentationState,
  workspaceId: string,
  update: (workspace: WebWorkspaceSummary) => WebWorkspaceSummary,
): WebPresentationState {
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.workspaceId === workspaceId ? update(workspace) : workspace,
    ),
  };
}

export function selectedSession(state: WebPresentationState): WebSessionSummary | undefined {
  return (
    state.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.sessionId === state.selectedSessionId) ??
    (state.routeSessionSnapshot?.sessionId === state.selectedSessionId
      ? state.routeSessionSnapshot
      : undefined)
  );
}

function matchesGeneration(state: WebPresentationState, generation: number | undefined): boolean {
  return generation === undefined || generation === state.generation;
}
