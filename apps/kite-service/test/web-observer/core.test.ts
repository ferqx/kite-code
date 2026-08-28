import { describe, expect, test } from 'bun:test';
import {
  WEB_DIRECTORY_REQUEST_SCHEMA_,
  WEB_HISTORY_REQUEST_SCHEMA_,
  WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  type WebDirectoryResponse,
  type WebObserverStreamEvent,
  type WebPresentationMessage,
} from '@kite-ai/kite-app-contract';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import {
  createWebObserverCore,
  type WebObserverDirectoryPort,
  type WebObserverHistoryPort,
  type WebObserverHistoryTranscript,
  type WebObserverLiveInput,
  type WebObserverLivePort,
  WebObserverUnavailableError,
} from '../../src/web-observer';

const historyRequest = (sessionId = 'session-1') => ({
  schema: WEB_HISTORY_REQUEST_SCHEMA_,
  sessionId,
  limit: 200,
});

const subscribeRequest = (sessionId = 'session-1', afterSequence?: number) => ({
  schema: WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  sessionId,
  ...(afterSequence === undefined ? {} : { afterSequence }),
});

const directoryRequest = { schema: WEB_DIRECTORY_REQUEST_SCHEMA_ } as const;

function transcript(
  events: readonly RuntimeClientEvent[],
  lastSequence = events.length,
): WebObserverHistoryTranscript {
  return {
    sessionId: 'session-1',
    lastSequence,
    records: events.map((event, index) => ({ sequence: index + 1, events: [event] })),
  };
}

function historyFor(
  load: (sessionId: string) => Promise<WebObserverHistoryTranscript>,
): WebObserverHistoryPort {
  return { loadSession: load };
}

function directoryFor(value: unknown): WebObserverDirectoryPort {
  return { list: () => value as WebDirectoryResponse['workspaces'] };
}

function liveFor(values: readonly WebObserverLiveInput[]): {
  readonly port: WebObserverLivePort;
  readonly returnCount: () => number;
  readonly abortCount: () => number;
} {
  let returned = 0;
  let aborted = 0;
  return {
    port: {
      subscribe: ({ signal }) => {
        signal.addEventListener('abort', () => {
          aborted += 1;
        });
        let index = 0;
        const iterator: AsyncIterator<WebObserverLiveInput> = {
          async next() {
            const value = values[index++];
            return value === undefined ? { done: true, value: undefined } : { done: false, value };
          },
          async return() {
            returned += 1;
            return { done: true, value: undefined };
          },
        };
        return { [Symbol.asyncIterator]: () => iterator };
      },
    },
    returnCount: () => returned,
    abortCount: () => aborted,
  };
}

function input(
  sequence: number,
  event: RuntimeClientEvent,
  sessionId = 'session-1',
): WebObserverLiveInput {
  return { sessionId, sequence, event };
}

async function collect(
  stream: AsyncIterable<WebObserverStreamEvent>,
): Promise<WebObserverStreamEvent[]> {
  const values: WebObserverStreamEvent[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const userEvent: RuntimeClientEvent = {
  type: 'user.message',
  messageId: 'message-1',
  kind: 'task',
  text: 'Read the current session.',
};

const requestedEvent: RuntimeClientEvent = { type: 'model.requested', requestId: 'request-1' };

const textEvent: RuntimeClientEvent = {
  type: 'model.text_delta',
  requestId: 'request-1',
  text: 'The session is read-only.',
};

const respondedEvent: RuntimeClientEvent = {
  type: 'model.responded',
  requestId: 'request-1',
  messageId: 'model-message-1',
  toolCallCount: 0,
  summary: 'The session is read-only.',
};

describe('Service Web Observer core', () => {
  test('keeps Directory DTOs path-free and rejects an owner path field', async () => {
    const validDirectory = [
      {
        workspaceId: 'workspace-1',
        label: 'Workspace',
        sessions: [
          {
            sessionId: 'session-1',
            displayName: 'Observer session',
            updatedAt: 1_700_000_000,
            lastSequence: 1,
            status: 'running' as const,
          },
        ],
      },
    ];
    const live = liveFor([]);
    const core = createWebObserverCore({
      directory: directoryFor(validDirectory),
      history: historyFor(async () => transcript([])),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    const response = await core.listDirectory(directoryRequest);
    expect(response.workspaces[0]).toEqual(validDirectory[0]);
    expect(JSON.stringify(response)).not.toContain('canonicalPath');

    const unsafe = [
      {
        ...validDirectory[0],
        canonicalPath: '/private/workspace',
      },
    ];
    const unsafeCore = createWebObserverCore({
      directory: directoryFor(unsafe),
      history: historyFor(async () => transcript([])),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    await expect(unsafeCore.listDirectory(directoryRequest)).rejects.toThrow();
  });

  test('turns a current-format missing or legacy-only History session into typed unavailable', async () => {
    const live = liveFor([]);
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => {
        throw new Error('/private/legacy.sqlite');
      }),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    let failure: unknown;
    try {
      await core.loadHistory(historyRequest());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebObserverUnavailableError);
    expect((failure as WebObserverUnavailableError).event).toEqual({
      schema: 'kite.app.web.live-event.v1',
      type: 'unavailable',
      sessionId: 'session-1',
      reason: 'history_unavailable',
    });
    expect(String(failure)).not.toContain('legacy.sqlite');
  });

  test('uses one pure reducer for equivalent History and live presentation', async () => {
    const events = [userEvent, requestedEvent, textEvent, respondedEvent] as const;
    const live = liveFor(events.map((event, index) => input(index + 1, event)));
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript(events)),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    const history = await core.loadHistory(historyRequest());
    const subscription = await core.subscribe(subscribeRequest());
    const stream = await collect(core.events(subscription.subscriptionId));
    const liveMessages = stream
      .filter(
        (event): event is Extract<WebObserverStreamEvent, { readonly type: 'message' }> =>
          event.type === 'message',
      )
      .map((event) => event.message);
    const finalLiveMessages = [
      ...new Map(liveMessages.map((message) => [message.messageId, message])).values(),
    ].sort((left, right) => left.sequence - right.sequence) as readonly WebPresentationMessage[];
    expect(finalLiveMessages).toEqual(history.messages as readonly WebPresentationMessage[]);
  });

  test('seeds a live update from query-only History at the exact browser cursor', async () => {
    const prior = [userEvent, requestedEvent, textEvent, respondedEvent] as const;
    const toolQueued: RuntimeClientEvent = {
      type: 'tool.queued',
      toolId: 'tool-after-history',
      presentationGroupId: 'model-message-1',
      toolName: 'read_file',
      presentation: 'exploration',
      arguments: {},
      summary: 'Read the file',
    };
    const live = liveFor([input(5, toolQueued)]);
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript(prior)),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    const subscription = await core.subscribe(subscribeRequest('session-1', 4));
    const stream = await collect(core.events(subscription.subscriptionId));
    const update = stream.find(
      (event): event is Extract<WebObserverStreamEvent, { readonly type: 'message' }> =>
        event.type === 'message',
    );
    expect(update?.message.messageId).toBe('model-request-1');
    expect(update?.message.blocks.map((block) => block.kind)).toEqual(['tool_activity', 'text']);
    expect(update?.message.blocks).toContainEqual({
      kind: 'text',
      text: 'The session is read-only.',
    });
  });

  test('keeps Thinking, tool activity, result, and model text in one canonical model step', async () => {
    const events: readonly RuntimeClientEvent[] = [
      { type: 'model.requested', requestId: 'request-grouped' },
      {
        type: 'reasoning.activity',
        requestId: 'request-grouped',
        state: 'completed',
        segmentId: 'segment-grouped',
        text: 'Inspecting',
      },
      { type: 'model.text_delta', requestId: 'request-grouped', text: 'Finished inspection.' },
      {
        type: 'model.responded',
        requestId: 'request-grouped',
        messageId: 'model-message-grouped',
        toolCallCount: 1,
        summary: 'Finished inspection.',
      },
      {
        type: 'tool.queued',
        toolId: 'tool-grouped',
        presentationGroupId: 'model-message-grouped',
        toolName: 'read_file',
        presentation: 'exploration',
        arguments: {},
        summary: 'Read the file',
      },
      { type: 'tool.started', toolId: 'tool-grouped', summary: 'Reading' },
      {
        type: 'tool.finished',
        toolId: 'tool-grouped',
        toolName: 'read_file',
        presentation: 'exploration',
        summary: 'Read complete',
        result: { ok: true, stdout: 'contents', stderr: '', exitCode: 0 },
      },
    ];
    const live = liveFor(events.map((event, index) => input(index + 1, event)));
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript(events)),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    const history = await core.loadHistory(historyRequest());
    const modelSteps = history.messages.filter((entry) => entry.role === 'assistant');
    expect(modelSteps).toHaveLength(1);
    expect(modelSteps[0]?.messageId).toBe('model-request-grouped');
    expect(modelSteps[0]?.blocks.map((block) => block.kind)).toEqual([
      'thinking',
      'tool_result',
      'text',
    ]);
  });

  test('disconnect releases the observer iterator and has no Runtime command path', async () => {
    const live = liveFor([input(1, userEvent), input(2, textEvent)]);
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript([])),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    await core.subscribe(subscribeRequest());
    await core.disconnect({ schema: 'kite.app.web.disconnect-request.v1' });
    await core.disconnect({ schema: 'kite.app.web.disconnect-request.v1' });
    expect(live.returnCount()).toBe(1);
    expect(live.abortCount()).toBe(1);
  });

  test('emits typed sequence-gap resync and releases the upstream iterator', async () => {
    const live = liveFor([input(1, userEvent), input(3, textEvent)]);
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript([])),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
    });
    const subscription = await core.subscribe(subscribeRequest('session-1', 0));
    const stream = await collect(core.events(subscription.subscriptionId));
    expect(stream.at(-1)).toEqual({
      schema: 'kite.app.web.live-event.v1',
      type: 'resync_required',
      sessionId: 'session-1',
      reason: 'sequence_gap',
      afterSequence: 1,
    });
    expect(live.returnCount()).toBe(1);
  });

  test('bounds queued presentation and emits overflow resync after releasing iterator', async () => {
    const live = liveFor([input(1, userEvent), input(2, textEvent)]);
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript([])),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
      maxQueuedEvents: 1,
    });
    const subscription = await core.subscribe(subscribeRequest('session-1', 0));
    await settleMicrotasks();
    const stream = await collect(core.events(subscription.subscriptionId));
    expect(stream).toEqual([
      {
        schema: 'kite.app.web.live-event.v1',
        type: 'resync_required',
        sessionId: 'session-1',
        reason: 'stream_overflow',
        afterSequence: 2,
      },
    ]);
    expect(live.returnCount()).toBe(1);
  });

  test('keeps a terminal recovery event visible behind bounded deliverable backlog', async () => {
    const live = liveFor([input(1, userEvent), input(2, textEvent, 'wrong-session')]);
    const core = createWebObserverCore({
      directory: directoryFor([]),
      history: historyFor(async () => transcript([])),
      live: live.port,
      gatewayInstanceId: 'gateway-1',
      contractRevision: 'contract-1',
      maxQueuedEvents: 2,
    });
    const subscription = await core.subscribe(subscribeRequest('session-1', 0));
    await settleMicrotasks();
    const stream = await collect(core.events(subscription.subscriptionId));
    expect(stream.map((event) => event.type)).toEqual(['message', 'unavailable']);
    expect(stream.at(-1)).toEqual({
      schema: 'kite.app.web.live-event.v1',
      type: 'unavailable',
      sessionId: 'session-1',
      reason: 'subscription_unavailable',
    });
    expect(live.returnCount()).toBe(1);
    expect(live.abortCount()).toBe(1);
  });
});
