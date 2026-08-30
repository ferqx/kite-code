import { describe, expect, test } from 'bun:test';
import {
  WEB_BOOTSTRAP_REQUEST_SCHEMA_,
  WEB_BOOTSTRAP_RESPONSE_SCHEMA_,
  WEB_DIRECTORY_REQUEST_SCHEMA_,
  WEB_DIRECTORY_RESPONSE_SCHEMA_,
  WEB_DISCONNECT_REQUEST_SCHEMA_,
  WEB_DISCONNECT_RESPONSE_SCHEMA_,
  WEB_HISTORY_REQUEST_SCHEMA_,
  WEB_HISTORY_RESPONSE_SCHEMA_,
  WEB_LIVE_EVENT_SCHEMA_,
  WEB_STREAM_EVENT_SCHEMA_,
  WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
  WEB_TAB_CREATE_REQUEST_SCHEMA_,
  WEB_TAB_CREATE_RESPONSE_SCHEMA_,
  WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
  WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_,
  type WebDirectoryResponse,
  type WebHistoryResponse,
  type WebLiveEvent,
  type WebObserverStreamEvent,
  webBootstrapRequestCodec,
  webBootstrapResponseCodec,
  webDirectoryRequestCodec,
  webDirectoryResponseCodec,
  webDisconnectRequestCodec,
  webDisconnectResponseCodec,
  webHistoryRequestCodec,
  webHistoryResponseCodec,
  webLiveEventCodec,
  webObserverStreamEventCodec,
  webSubscribeRequestCodec,
  webSubscribeResponseCodec,
  webTabCreateRequestCodec,
  webTabCreateResponseCodec,
  webUnsubscribeRequestCodec,
  webUnsubscribeResponseCodec,
} from '../src';

const message = {
  messageId: 'message-1',
  sequence: 4,
  role: 'assistant' as const,
  blocks: [
    { kind: 'thinking' as const, text: 'Inspecting the current projection.', complete: true },
    { kind: 'text' as const, text: 'The read-only view is ready.' },
    {
      kind: 'tool_activity' as const,
      toolId: 'tool-1',
      label: 'Read file',
      status: 'running' as const,
      summary: 'Reading a bounded projection.',
    },
    {
      kind: 'tool_result' as const,
      toolId: 'tool-1',
      label: 'Read file',
      ok: true,
      stdout: 'safe output',
      stderr: '',
      exitCode: 0,
    },
    { kind: 'status' as const, status: 'completed' as const, text: 'Completed.' },
  ],
};

const session = {
  sessionId: 'session-1',
  displayName: 'Read-only session',
  updatedAt: 1_700_000_000,
  lastSequence: 4,
  status: 'running' as const,
};

const directory: WebDirectoryResponse = {
  schema: WEB_DIRECTORY_RESPONSE_SCHEMA_,
  workspaces: [
    {
      workspaceId: 'workspace-1',
      label: 'Kite project',
      sessions: [session],
    },
  ],
};

const history: WebHistoryResponse = {
  schema: WEB_HISTORY_RESPONSE_SCHEMA_,
  sessionId: session.sessionId,
  messages: [message],
  nextCursor: 4,
  hasMore: true,
  observedLastSequence: 8,
};

describe('Kite Web Observer contract', () => {
  test('publishes independent exact schemas and round-trips every Observer DTO', () => {
    expect(webBootstrapRequestCodec.schema).toBe(WEB_BOOTSTRAP_REQUEST_SCHEMA_);
    expect(webBootstrapResponseCodec.schema).toBe(WEB_BOOTSTRAP_RESPONSE_SCHEMA_);
    expect(webTabCreateRequestCodec.schema).toBe(WEB_TAB_CREATE_REQUEST_SCHEMA_);
    expect(webTabCreateResponseCodec.schema).toBe(WEB_TAB_CREATE_RESPONSE_SCHEMA_);
    expect(webDirectoryRequestCodec.schema).toBe(WEB_DIRECTORY_REQUEST_SCHEMA_);
    expect(webDirectoryResponseCodec.schema).toBe(WEB_DIRECTORY_RESPONSE_SCHEMA_);
    expect(webHistoryRequestCodec.schema).toBe(WEB_HISTORY_REQUEST_SCHEMA_);
    expect(webHistoryResponseCodec.schema).toBe(WEB_HISTORY_RESPONSE_SCHEMA_);
    expect(webLiveEventCodec.schema).toBe(WEB_LIVE_EVENT_SCHEMA_);
    expect(webObserverStreamEventCodec.schema).toBe(WEB_STREAM_EVENT_SCHEMA_);
    expect(webSubscribeRequestCodec.schema).toBe(WEB_SUBSCRIBE_REQUEST_SCHEMA_);
    expect(webSubscribeResponseCodec.schema).toBe(WEB_SUBSCRIBE_RESPONSE_SCHEMA_);
    expect(webUnsubscribeRequestCodec.schema).toBe(WEB_UNSUBSCRIBE_REQUEST_SCHEMA_);
    expect(webUnsubscribeResponseCodec.schema).toBe(WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_);
    expect(webDisconnectRequestCodec.schema).toBe(WEB_DISCONNECT_REQUEST_SCHEMA_);
    expect(webDisconnectResponseCodec.schema).toBe(WEB_DISCONNECT_RESPONSE_SCHEMA_);

    const bootstrapRequest = { schema: WEB_BOOTSTRAP_REQUEST_SCHEMA_ } as const;
    expect(
      webBootstrapRequestCodec.decode(webBootstrapRequestCodec.encode(bootstrapRequest)),
    ).toEqual(bootstrapRequest);
    const bootstrapResponse = {
      schema: WEB_BOOTSTRAP_RESPONSE_SCHEMA_,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'kite-app-contract-v1',
    } as const;
    expect(
      webBootstrapResponseCodec.decode(webBootstrapResponseCodec.encode(bootstrapResponse)),
    ).toEqual(bootstrapResponse);

    const tabRequest = { schema: WEB_TAB_CREATE_REQUEST_SCHEMA_ } as const;
    expect(webTabCreateRequestCodec.decode(webTabCreateRequestCodec.encode(tabRequest))).toEqual(
      tabRequest,
    );
    const tabResponse = {
      schema: WEB_TAB_CREATE_RESPONSE_SCHEMA_,
      tabHandle: 'tab-1',
      connectionGeneration: 1,
    } as const;
    expect(webTabCreateResponseCodec.decode(webTabCreateResponseCodec.encode(tabResponse))).toEqual(
      tabResponse,
    );

    const directoryRequest = { schema: WEB_DIRECTORY_REQUEST_SCHEMA_ } as const;
    expect(
      webDirectoryRequestCodec.decode(webDirectoryRequestCodec.encode(directoryRequest)),
    ).toEqual(directoryRequest);
    expect(webDirectoryResponseCodec.decode(webDirectoryResponseCodec.encode(directory))).toEqual(
      directory,
    );

    const historyRequest = {
      schema: WEB_HISTORY_REQUEST_SCHEMA_,
      sessionId: session.sessionId,
      cursor: 2,
      limit: 50,
    } as const;
    expect(webHistoryRequestCodec.decode(webHistoryRequestCodec.encode(historyRequest))).toEqual(
      historyRequest,
    );
    expect(webHistoryResponseCodec.decode(webHistoryResponseCodec.encode(history))).toEqual(
      history,
    );

    const live: WebLiveEvent = {
      schema: WEB_LIVE_EVENT_SCHEMA_,
      type: 'message',
      sessionId: session.sessionId,
      sequence: message.sequence,
      message,
    };
    expect(webLiveEventCodec.decode(webLiveEventCodec.encode(live))).toEqual(live);
    const unavailable: WebObserverStreamEvent = {
      schema: WEB_STREAM_EVENT_SCHEMA_,
      type: 'unavailable',
      sessionId: session.sessionId,
      reason: 'worker_unavailable',
    };
    const resync: WebObserverStreamEvent = {
      schema: WEB_STREAM_EVENT_SCHEMA_,
      type: 'resync_required',
      sessionId: session.sessionId,
      reason: 'sequence_gap',
      afterSequence: 4,
    };
    expect(
      webObserverStreamEventCodec.decode(webObserverStreamEventCodec.encode(unavailable)),
    ).toEqual(unavailable);
    expect(webObserverStreamEventCodec.decode(webObserverStreamEventCodec.encode(resync))).toEqual(
      resync,
    );

    const subscribeRequest = {
      schema: WEB_SUBSCRIBE_REQUEST_SCHEMA_,
      sessionId: session.sessionId,
      afterSequence: 4,
    } as const;
    expect(
      webSubscribeRequestCodec.decode(webSubscribeRequestCodec.encode(subscribeRequest)),
    ).toEqual(subscribeRequest);
    const subscribeResponse = {
      schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId: 'subscription-1',
      sessionId: session.sessionId,
      liveSequence: 4,
    } as const;
    expect(
      webSubscribeResponseCodec.decode(webSubscribeResponseCodec.encode(subscribeResponse)),
    ).toEqual(subscribeResponse);

    const unsubscribeRequest = {
      schema: WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
      subscriptionId: 'subscription-1',
    } as const;
    expect(
      webUnsubscribeRequestCodec.decode(webUnsubscribeRequestCodec.encode(unsubscribeRequest)),
    ).toEqual(unsubscribeRequest);
    const unsubscribeResponse = {
      schema: WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_,
      subscriptionId: 'subscription-1',
      unsubscribed: true,
    } as const;
    expect(
      webUnsubscribeResponseCodec.decode(webUnsubscribeResponseCodec.encode(unsubscribeResponse)),
    ).toEqual(unsubscribeResponse);

    const disconnectRequest = { schema: WEB_DISCONNECT_REQUEST_SCHEMA_ } as const;
    expect(
      webDisconnectRequestCodec.decode(webDisconnectRequestCodec.encode(disconnectRequest)),
    ).toEqual(disconnectRequest);
    const disconnectResponse = {
      schema: WEB_DISCONNECT_RESPONSE_SCHEMA_,
      disconnected: true,
    } as const;
    expect(
      webDisconnectResponseCodec.decode(webDisconnectResponseCodec.encode(disconnectResponse)),
    ).toEqual(disconnectResponse);
  });

  test('supports process and non-process tool results without inventing an exit code', () => {
    const nonProcessHistory: WebHistoryResponse = {
      ...history,
      messages: [
        {
          ...message,
          blocks: [
            {
              kind: 'tool_result',
              toolId: 'read-1',
              label: 'Read file',
              ok: true,
              stdout: 'file contents',
              stderr: '',
            },
          ],
        },
      ],
    };
    expect(webHistoryResponseCodec.decode(nonProcessHistory)).toEqual(nonProcessHistory);
    expect(webHistoryResponseCodec.decode(history)).toEqual(history);
    expect(() =>
      webHistoryResponseCodec.decode({
        ...nonProcessHistory,
        messages: [
          {
            ...message,
            blocks: [
              {
                kind: 'tool_result',
                toolId: 'shell-1',
                label: 'Shell',
                ok: false,
                stdout: '',
                stderr: 'failed',
                exitCode: '1',
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  test('uses one closed Session status instead of a duplicate running flag', () => {
    expect(webDirectoryResponseCodec.decode(directory)).toEqual(directory);
    expect(() =>
      webDirectoryResponseCodec.decode({
        ...directory,
        workspaces: [
          {
            ...directory.workspaces[0],
            sessions: [{ ...session, running: true }],
          },
        ],
      }),
    ).toThrow();
  });

  test('rejects mutation-shaped fields and authority-bearing fields at every Web seam', () => {
    expect(() =>
      webBootstrapRequestCodec.decode({
        schema: WEB_BOOTSTRAP_REQUEST_SCHEMA_,
        prompt: 'run this',
      }),
    ).toThrow();
    expect(() =>
      webTabCreateRequestCodec.decode({
        schema: WEB_TAB_CREATE_REQUEST_SCHEMA_,
        createSession: true,
      }),
    ).toThrow();
    expect(() =>
      webSubscribeRequestCodec.decode({
        schema: WEB_SUBSCRIBE_REQUEST_SCHEMA_,
        sessionId: session.sessionId,
        controller: true,
      }),
    ).toThrow();
    expect(() =>
      webDisconnectRequestCodec.decode({
        schema: WEB_DISCONNECT_REQUEST_SCHEMA_,
        cancel: true,
      }),
    ).toThrow();
    expect(() =>
      webDirectoryResponseCodec.decode({
        ...directory,
        workspaces: [
          {
            ...directory.workspaces[0],
            canonicalPath: '/private/workspace',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      webTabCreateResponseCodec.decode({
        schema: WEB_TAB_CREATE_RESPONSE_SCHEMA_,
        tabHandle: 'tab-1',
        connectionGeneration: 1,
        token: 'secret',
      }),
    ).toThrow();
    expect(() =>
      webHistoryResponseCodec.decode({
        ...history,
        path: '/private/store.sqlite',
      }),
    ).toThrow();
    expect(() =>
      webLiveEventCodec.decode({
        ...webLiveEventCodec.encode({
          schema: WEB_LIVE_EVENT_SCHEMA_,
          type: 'message',
          sessionId: session.sessionId,
          sequence: message.sequence,
          message,
        }),
        rawRuntimeEvent: { type: 'tool.finished' },
      }),
    ).toThrow();
    expect(() =>
      webObserverStreamEventCodec.decode({
        schema: WEB_STREAM_EVENT_SCHEMA_,
        type: 'resync_required',
        sessionId: session.sessionId,
        reason: 'sequence_gap',
        command: 'cancel',
      }),
    ).toThrow();
  });

  test('rejects malformed presentation blocks, sequence mismatch and unsafe text', () => {
    expect(() =>
      webHistoryResponseCodec.decode({
        ...history,
        messages: [
          {
            ...message,
            blocks: [{ kind: 'text', text: 'unsafe', path: '/private/file' }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      webHistoryResponseCodec.decode({
        ...history,
        messages: [
          {
            ...message,
            blocks: [{ kind: 'text', text: 'unsafe', token: 'secret' }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      webHistoryResponseCodec.decode({
        ...history,
        messages: [
          {
            ...message,
            blocks: [{ kind: 'error', code: 'runtime', text: 'detail', raw: {} }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      webHistoryResponseCodec.decode({
        ...history,
        messages: [
          {
            ...message,
            blocks: [{ kind: 'text', text: 'forbidden\u001b[2J' }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      webLiveEventCodec.decode({
        schema: WEB_LIVE_EVENT_SCHEMA_,
        type: 'message',
        sessionId: session.sessionId,
        sequence: 5,
        message,
      }),
    ).toThrow();
    expect(() =>
      webHistoryResponseCodec.decode({
        ...history,
        hasMore: false,
      }),
    ).toThrow();
  });
});
