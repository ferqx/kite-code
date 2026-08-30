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

export type WebHistoryState = 'idle' | 'loading' | 'content' | 'empty' | 'unavailable' | 'error';

export interface WebPresentationState {
  readonly generation: number;
  readonly workspaces: readonly WebWorkspaceSummary[];
  readonly selectedSessionId: string | null;
  readonly messages: readonly WebPresentationMessage[];
  readonly historyCursor: number | null;
  readonly observedLastSequence: number | null;
  readonly liveSequence: number | null;
  readonly historyResetRequired: boolean;
  readonly historyState: WebHistoryState;
  readonly historyReason: string | null;
  readonly historyReloadToken: number;
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
      readonly type: 'history_loading';
      readonly generation?: number;
      readonly requestToken?: number;
    }
  | {
      readonly type: 'history_loaded';
      readonly history: WebHistoryResponse;
      readonly reset?: boolean;
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
      readonly type: 'live_event';
      readonly event: WebObserverStreamEvent;
      readonly generation?: number;
    }
  | {
      readonly type: 'connection';
      readonly connection: WebConnectionState;
      readonly generation?: number;
    }
  | { readonly type: 'resync_stopped'; readonly generation: number; readonly reason: string }
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
  historyState: 'idle',
  historyReason: null,
  historyReloadToken: 0,
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
        historyState: state.selectedSessionId === null ? 'idle' : 'loading',
        historyReason: null,
        connection: { status: 'connected' },
      };
    }
    case 'directory_loaded': {
      if (!matchesGeneration(state, action.generation)) return state;
      const nextSelectedSessionId = selectedIdForDirectory(
        state.selectedSessionId,
        action.directory,
      );
      if (nextSelectedSessionId === state.selectedSessionId) {
        return { ...state, workspaces: action.directory.workspaces };
      }
      return {
        ...state,
        workspaces: action.directory.workspaces,
        selectedSessionId: nextSelectedSessionId,
        messages: [],
        historyCursor: null,
        observedLastSequence: null,
        liveSequence: null,
        historyResetRequired: false,
        historyState: nextSelectedSessionId === null ? 'idle' : 'loading',
        historyReason: null,
        connection: nextSelectedSessionId === null ? state.connection : { status: 'loading' },
      };
    }
    case 'select_session':
      return {
        ...state,
        selectedSessionId: action.sessionId,
        messages: [],
        historyCursor: null,
        observedLastSequence: null,
        liveSequence: null,
        historyResetRequired: false,
        historyState: 'loading',
        historyReason: null,
        connection: { status: 'loading' },
      };
    case 'history_loading': {
      if (!matchesGeneration(state, action.generation)) return state;
      return {
        ...state,
        messages: [],
        historyCursor: null,
        observedLastSequence: null,
        liveSequence: null,
        historyResetRequired: false,
        historyState: 'loading',
        historyReason: null,
        historyReloadToken: action.requestToken ?? state.historyReloadToken,
      };
    }
    case 'history_loaded': {
      if (!matchesGeneration(state, action.generation)) return state;
      if (action.history.sessionId !== state.selectedSessionId) return state;
      const reset = action.reset === true;
      const messages = orderedMessages(reset ? [] : state.messages, action.history.messages);
      return {
        ...state,
        messages,
        historyCursor: action.history.nextCursor ?? null,
        observedLastSequence: action.history.observedLastSequence,
        liveSequence: reset
          ? action.history.observedLastSequence
          : Math.max(state.liveSequence ?? 0, action.history.observedLastSequence),
        historyResetRequired: false,
        historyState: messages.length > 0 ? 'content' : 'empty',
        historyReason: null,
        connection: { status: 'connected' },
      };
    }
    case 'history_failed':
      return matchesGeneration(state, action.generation)
        ? {
            ...state,
            messages: [],
            historyCursor: null,
            observedLastSequence: null,
            liveSequence: null,
            historyState: action.status,
            historyReason: action.reason,
          }
        : state;
    case 'history_retry':
      return matchesGeneration(state, action.generation)
        ? {
            ...state,
            messages: [],
            historyCursor: null,
            observedLastSequence: null,
            liveSequence: null,
            historyResetRequired: false,
            historyState: 'loading',
            historyReason: null,
            historyReloadToken: state.historyReloadToken + 1,
            connection: { status: 'loading' },
          }
        : state;
    case 'live_event': {
      if (!matchesGeneration(state, action.generation)) return state;
      if (action.event.sessionId !== state.selectedSessionId) return state;
      if (action.event.type === 'unavailable') {
        return {
          ...state,
          historyResetRequired: true,
          historyState: state.messages.length > 0 ? 'content' : 'unavailable',
          historyReason: action.event.reason,
          connection: { status: 'unavailable', reason: action.event.reason },
        };
      }
      if (action.event.type === 'resync_required') {
        return {
          ...state,
          historyResetRequired: true,
          historyState: state.messages.length > 0 ? 'content' : 'unavailable',
          historyReason: action.event.reason,
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
          historyState: state.messages.length > 0 ? 'content' : 'unavailable',
          historyReason: 'sequence_gap',
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
    case 'resync_stopped':
      return matchesGeneration(state, action.generation)
        ? {
            ...state,
            historyResetRequired: false,
            connection: { status: 'unavailable', reason: action.reason },
          }
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
