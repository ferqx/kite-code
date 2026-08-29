import {
  WEB_DIRECTORY_RESPONSE_SCHEMA_,
  WEB_HISTORY_RESPONSE_SCHEMA_,
  WEB_LIVE_EVENT_SCHEMA_,
} from '@kite-ai/kite-app-contract/web';
import { describe, expect, test } from 'vitest';
import { initialWebPresentationState, webPresentationReducer } from '@/presentation/reducer';

const message = {
  messageId: 'message-1',
  sequence: 1,
  role: 'assistant' as const,
  blocks: [{ kind: 'text' as const, text: 'same projection' }],
};

describe('Web presentation reducer', () => {
  test('folds History and live through the same message identity path', () => {
    const withDirectory = webPresentationReducer(initialWebPresentationState, {
      type: 'directory_loaded',
      directory: {
        schema: WEB_DIRECTORY_RESPONSE_SCHEMA_,
        workspaces: [
          {
            workspaceId: 'workspace-1',
            label: 'Workspace',
            sessions: [
              {
                sessionId: 'session-1',
                displayName: 'Session',
                updatedAt: 1,
                lastSequence: 1,
                status: 'running',
              },
            ],
          },
        ],
      },
    });
    const fromHistory = webPresentationReducer(withDirectory, {
      type: 'history_loaded',
      history: {
        schema: WEB_HISTORY_RESPONSE_SCHEMA_,
        sessionId: 'session-1',
        messages: [message],
        hasMore: false,
        observedLastSequence: 1,
      },
    });
    const fromLive = webPresentationReducer(fromHistory, {
      type: 'live_event',
      event: {
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'message',
        sessionId: 'session-1',
        sequence: 1,
        message,
      },
    });
    expect(fromLive.messages).toEqual([message]);
  });

  test('marks a live sequence gap for explicit resync', () => {
    const state = {
      ...initialWebPresentationState,
      selectedSessionId: 'session-1',
      liveSequence: 2,
    };
    const result = webPresentationReducer(state, {
      type: 'live_event',
      event: {
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'message',
        sessionId: 'session-1',
        sequence: 4,
        message: { ...message, sequence: 4 },
      },
    });
    expect(result.connection).toEqual({ status: 'resync_required', reason: 'sequence_gap' });
    expect(result.messages).toEqual([]);
  });

  test('disconnect changes only Observer connection state', () => {
    const result = webPresentationReducer(
      { ...initialWebPresentationState, messages: [message], liveSequence: 1 },
      { type: 'disconnect' },
    );
    expect(result.messages).toEqual([message]);
    expect(result.connection).toEqual({ status: 'disconnected' });
  });

  test('stops folding a terminal generation until bounded History resync replaces it', () => {
    const terminal = webPresentationReducer(
      {
        ...initialWebPresentationState,
        selectedSessionId: 'session-1',
        messages: [message],
        liveSequence: 1,
        connection: { status: 'connected' },
      },
      {
        type: 'live_event',
        event: {
          schema: WEB_LIVE_EVENT_SCHEMA_,
          type: 'resync_required',
          sessionId: 'session-1',
          reason: 'stream_overflow',
          afterSequence: 1,
        },
      },
    );
    const stale = webPresentationReducer(terminal, {
      type: 'live_event',
      event: {
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'message',
        sessionId: 'session-1',
        sequence: 2,
        message: { ...message, sequence: 2, blocks: [{ kind: 'text', text: 'stale' }] },
      },
    });
    expect(stale).toBe(terminal);

    const resynced = webPresentationReducer(stale, {
      type: 'history_loaded',
      reset: true,
      history: {
        schema: WEB_HISTORY_RESPONSE_SCHEMA_,
        sessionId: 'session-1',
        messages: [{ ...message, sequence: 2, blocks: [{ kind: 'text', text: 'fresh' }] }],
        hasMore: false,
        observedLastSequence: 2,
      },
    });
    expect(resynced.connection).toEqual({ status: 'connected' });
    expect(resynced.messages[0]?.blocks).toEqual([{ kind: 'text', text: 'fresh' }]);
  });

  test('ignores live data from an older transport generation', () => {
    const state = {
      ...initialWebPresentationState,
      generation: 2,
      selectedSessionId: 'session-1',
      liveSequence: 3,
      connection: { status: 'connected' as const },
    };
    const result = webPresentationReducer(state, {
      type: 'live_event',
      generation: 1,
      event: {
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'message',
        sessionId: 'session-1',
        sequence: 4,
        message: { ...message, sequence: 4 },
      },
    });
    expect(result).toBe(state);
  });

  test('requires bounded History replacement after terminal unavailable stream', () => {
    const state = {
      ...initialWebPresentationState,
      generation: 1,
      selectedSessionId: 'session-1',
      messages: [message],
      liveSequence: 1,
      connection: { status: 'connected' as const },
    };
    const unavailable = webPresentationReducer(state, {
      type: 'live_event',
      generation: 1,
      event: {
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'unavailable',
        sessionId: 'session-1',
        reason: 'gateway_draining',
      },
    });
    expect(unavailable.historyResetRequired).toBe(true);
    const reset = webPresentationReducer(unavailable, {
      type: 'history_loaded',
      generation: 1,
      reset: true,
      history: {
        schema: WEB_HISTORY_RESPONSE_SCHEMA_,
        sessionId: 'session-1',
        messages: [message],
        hasMore: false,
        observedLastSequence: 1,
      },
    });
    expect(reset.historyResetRequired).toBe(false);
    expect(reset.connection).toEqual({ status: 'connected' });
  });

  test('tracks loading, empty, and content History states for the selected Session', () => {
    const directory = webPresentationReducer(initialWebPresentationState, {
      type: 'directory_loaded',
      directory: {
        schema: WEB_DIRECTORY_RESPONSE_SCHEMA_,
        workspaces: [
          {
            workspaceId: 'workspace-1',
            label: 'Workspace',
            sessions: [
              {
                sessionId: 'session-1',
                displayName: 'Session',
                updatedAt: 1,
                lastSequence: 0,
                status: 'completed',
              },
            ],
          },
        ],
      },
    });
    expect(directory.selectedSessionId).toBe('session-1');
    expect(directory.historyState).toBe('loading');

    const empty = webPresentationReducer(directory, {
      type: 'history_loaded',
      history: {
        schema: WEB_HISTORY_RESPONSE_SCHEMA_,
        sessionId: 'session-1',
        messages: [],
        hasMore: false,
        observedLastSequence: 0,
      },
    });
    expect(empty.historyState).toBe('empty');

    const content = webPresentationReducer(empty, {
      type: 'history_loaded',
      history: {
        schema: WEB_HISTORY_RESPONSE_SCHEMA_,
        sessionId: 'session-1',
        messages: [message],
        hasMore: false,
        observedLastSequence: 1,
      },
    });
    expect(content.historyState).toBe('content');
    expect(content.messages).toEqual([message]);
  });

  test('retains the last History snapshot when live updates become unavailable', () => {
    const state = {
      ...initialWebPresentationState,
      generation: 1,
      selectedSessionId: 'session-1',
      messages: [message],
      historyState: 'content' as const,
      liveSequence: 1,
      connection: { status: 'connected' as const },
    };
    const unavailable = webPresentationReducer(state, {
      type: 'live_event',
      generation: 1,
      event: {
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'unavailable',
        sessionId: 'session-1',
        reason: 'gateway_draining',
      },
    });
    expect(unavailable.historyState).toBe('content');
    expect(unavailable.messages).toEqual([message]);
    expect(unavailable.historyResetRequired).toBe(true);
  });

  test('exposes retry as a new bounded History request and ignores stale failures', () => {
    const state = {
      ...initialWebPresentationState,
      generation: 3,
      selectedSessionId: 'session-1',
      historyState: 'error' as const,
      historyReason: 'protocol_error',
      connection: { status: 'unavailable' as const, reason: 'protocol_error' },
    };
    const retrying = webPresentationReducer(state, {
      type: 'history_retry',
      generation: 3,
    });
    expect(retrying.historyState).toBe('loading');
    expect(retrying.historyReloadToken).toBe(1);

    const stale = webPresentationReducer(retrying, {
      type: 'history_failed',
      generation: 2,
      status: 'error',
      reason: 'protocol_error',
    });
    expect(stale).toBe(retrying);
  });

  test('stops automatic resync without discarding the last History snapshot', () => {
    const state = {
      ...initialWebPresentationState,
      generation: 4,
      selectedSessionId: 'session-1',
      messages: [message],
      historyState: 'content' as const,
      historyResetRequired: true,
      connection: { status: 'resync_required' as const, reason: 'sequence_gap' },
    };
    const stopped = webPresentationReducer(state, {
      type: 'resync_stopped',
      generation: 4,
      reason: 'resync_retry_limit',
    });
    expect(stopped.historyResetRequired).toBe(false);
    expect(stopped.messages).toEqual([message]);
    expect(stopped.connection).toEqual({
      status: 'unavailable',
      reason: 'resync_retry_limit',
    });
  });
});
