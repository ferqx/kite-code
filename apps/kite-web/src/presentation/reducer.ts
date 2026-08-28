import type {
  WebDirectoryResponse,
  WebHistoryResponse,
  WebObserverStreamEvent,
  WebPresentationMessage,
  WebSessionSummary,
  WebWorkspaceSummary,
} from '@kite-ai/kite-app-contract/web';

export type WebConnectionState =
  | { readonly status: 'loading' }
  | { readonly status: 'connected' }
  | { readonly status: 'reconnecting' }
  | { readonly status: 'disconnected' }
  | { readonly status: 'resync_required'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface WebPresentationState {
  readonly generation: number;
  readonly workspaces: readonly WebWorkspaceSummary[];
  readonly selectedSessionId: string | null;
  readonly messages: readonly WebPresentationMessage[];
  readonly historyCursor: number | null;
  readonly observedLastSequence: number | null;
  readonly liveSequence: number | null;
  readonly historyResetRequired: boolean;
  readonly connection: WebConnectionState;
}

export type WebPresentationAction =
  | { readonly type: 'transport_connected'; readonly generation: number }
  | {
      readonly type: 'directory_loaded';
      readonly directory: WebDirectoryResponse;
      readonly generation?: number;
    }
  | { readonly type: 'select_session'; readonly sessionId: string }
  | {
      readonly type: 'history_loaded';
      readonly history: WebHistoryResponse;
      readonly reset?: boolean;
      readonly generation?: number;
    }
  | {
      readonly type: 'live_event';
      readonly event: WebObserverStreamEvent;
      readonly generation?: number;
    }
  | {
      readonly type: 'connection';
      readonly connection: WebConnectionState;
      readonly generation?: number;
    }
  | { readonly type: 'disconnect' };

export const initialWebPresentationState: WebPresentationState = Object.freeze({
  generation: 0,
  workspaces: [],
  selectedSessionId: null,
  messages: [],
  historyCursor: null,
  observedLastSequence: null,
  liveSequence: null,
  historyResetRequired: false,
  connection: { status: 'loading' as const },
});

function orderedMessages(
  current: readonly WebPresentationMessage[],
  incoming: readonly WebPresentationMessage[],
): readonly WebPresentationMessage[] {
  const byId = new Map(current.map((message) => [message.messageId, message]));
  for (const message of incoming) {
    const prior = byId.get(message.messageId);
    if (!prior || message.sequence > prior.sequence) byId.set(message.messageId, message);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
  );
}

export function webPresentationReducer(
  state: WebPresentationState,
  action: WebPresentationAction,
): WebPresentationState {
  switch (action.type) {
    case 'transport_connected': {
      if (action.generation < state.generation) return state;
      if (action.generation === state.generation) {
        return { ...state, connection: { status: 'connected' } };
      }
      return {
        ...state,
        generation: action.generation,
        messages: [],
        historyCursor: null,
        observedLastSequence: null,
        liveSequence: null,
        historyResetRequired: false,
        connection: { status: 'connected' },
      };
    }
    case 'directory_loaded':
      if (!matchesGeneration(state, action.generation)) return state;
      return {
        ...state,
        workspaces: action.directory.workspaces,
        selectedSessionId: selectedIdForDirectory(state.selectedSessionId, action.directory),
      };
    case 'select_session':
      return {
        ...state,
        selectedSessionId: action.sessionId,
        messages: [],
        historyCursor: null,
        observedLastSequence: null,
        liveSequence: null,
        historyResetRequired: false,
        connection: { status: 'loading' },
      };
    case 'history_loaded': {
      if (!matchesGeneration(state, action.generation)) return state;
      if (action.history.sessionId !== state.selectedSessionId) return state;
      const reset = action.reset === true;
      return {
        ...state,
        messages: orderedMessages(reset ? [] : state.messages, action.history.messages),
        historyCursor: action.history.nextCursor ?? null,
        observedLastSequence: action.history.observedLastSequence,
        liveSequence: reset
          ? action.history.observedLastSequence
          : Math.max(state.liveSequence ?? 0, action.history.observedLastSequence),
        historyResetRequired: false,
        connection: { status: 'connected' },
      };
    }
    case 'live_event': {
      if (!matchesGeneration(state, action.generation)) return state;
      if (action.event.sessionId !== state.selectedSessionId) return state;
      if (action.event.type === 'unavailable') {
        return {
          ...state,
          historyResetRequired: true,
          connection: { status: 'unavailable', reason: action.event.reason },
        };
      }
      if (action.event.type === 'resync_required') {
        return {
          ...state,
          historyResetRequired: true,
          connection: { status: 'resync_required', reason: action.event.reason },
        };
      }
      if (
        state.connection.status === 'resync_required' ||
        state.connection.status === 'unavailable' ||
        state.connection.status === 'disconnected'
      ) {
        return state;
      }
      const expected = state.liveSequence === null ? action.event.sequence : state.liveSequence + 1;
      if (action.event.sequence > expected) {
        return {
          ...state,
          historyResetRequired: true,
          connection: { status: 'resync_required', reason: 'sequence_gap' },
        };
      }
      if (state.liveSequence !== null && action.event.sequence <= state.liveSequence) return state;
      return {
        ...state,
        messages: orderedMessages(state.messages, [action.event.message]),
        liveSequence: action.event.sequence,
        connection: { status: 'connected' },
      };
    }
    case 'connection':
      return matchesGeneration(state, action.generation)
        ? { ...state, connection: action.connection }
        : state;
    case 'disconnect':
      return {
        ...state,
        connection: { status: 'disconnected' },
        liveSequence: null,
        historyResetRequired: false,
      };
  }
}

export function selectedSession(state: WebPresentationState): WebSessionSummary | undefined {
  return state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.sessionId === state.selectedSessionId);
}

function matchesGeneration(state: WebPresentationState, generation: number | undefined): boolean {
  return generation === undefined || generation === state.generation;
}

function selectedIdForDirectory(
  selectedSessionId: string | null,
  directory: WebDirectoryResponse,
): string | null {
  const sessions = directory.workspaces.flatMap((workspace) => workspace.sessions);
  if (sessions.some((session) => session.sessionId === selectedSessionId)) return selectedSessionId;
  return sessions[0]?.sessionId ?? null;
}
