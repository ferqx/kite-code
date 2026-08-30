import { describe, expect, test } from 'bun:test';
import {
  WEB_DIRECTORY_REQUEST_SCHEMA_,
  type WebDirectoryResponse,
} from '@kite-ai/kite-app-contract';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAccess,
  type RuntimeAccessNotification,
  type RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import {
  createSingleServiceWebObserverFactory,
  createSingleServiceWebObserverLivePort,
} from '../../src/web-observer';

describe('Single-Service Web Observer composition', () => {
  test('queries Directory status and History through in-process owners', async () => {
    const runtime = runtimeWith([], 'waiting');
    const factory = createSingleServiceWebObserverFactory({
      runtime,
      directory: {
        list: () => [
          {
            workspaceId: 'workspace-1',
            displayName: 'Project',
            sessions: [{ sessionId: 'session-1', name: 'Task', updatedAt: 5, lastSequence: 2 }],
          },
        ],
      },
      history: {
        loadSession: async (sessionId) => ({ sessionId, lastSequence: 2, records: [] }),
      },
      serviceInstanceId: 'service-1',
      contractRevision: 'kite-app-web-observer-v1',
    });
    const observer = factory({ tabHandle: 'tab-1', connectionGeneration: 1 });
    const response = await observer.listDirectory({ schema: WEB_DIRECTORY_REQUEST_SCHEMA_ });
    expect(response).toEqual({
      schema: 'kite.app.web.directory-response.v1',
      workspaces: [
        {
          workspaceId: 'workspace-1',
          label: 'Project',
          sessions: [
            {
              sessionId: 'session-1',
              displayName: 'Task',
              updatedAt: 5,
              lastSequence: 2,
              status: 'waiting',
            },
          ],
        },
      ],
    } satisfies WebDirectoryResponse);
  });

  test('subscribes durable-only and never promotes ephemeral stream sequence to History order', async () => {
    const subscriptions: RuntimeSubscription[] = [];
    const notifications: RuntimeAccessNotification[] = [
      {
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'ephemeral',
        sessionId: 'session-1',
        workId: 'work-1',
        turnId: 'turn-1',
        actorId: 'actor-1',
        attemptId: 'attempt-1',
        compositionRevision: 'composition-1',
        streamId: 'stream-1',
        sequence: 999,
        event: { type: 'model.text_delta', requestId: 'request-1', text: 'private-stream-order' },
      },
      durableNotification(3),
    ];
    const runtime = runtimeWith(notifications, 'idle', subscriptions);
    const port = createSingleServiceWebObserverLivePort(runtime);
    const controller = new AbortController();
    const iterator = port
      .subscribe({ sessionId: 'session-1', afterSequence: 2, signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        sessionId: 'session-1',
        sequence: 3,
        event: { type: 'interaction_mode.changed', mode: 'full' },
      },
    });
    expect(subscriptions).toEqual([
      {
        spec: {
          scope: 'session',
          sessionId: 'session-1',
          afterRevision: 2,
          includeEphemeral: false,
        },
        signal: controller.signal,
      },
    ]);
    await iterator.return?.();
  });
});

function runtimeWith(
  notifications: readonly RuntimeAccessNotification[],
  status: 'idle' | 'waiting',
  subscriptions: RuntimeSubscription[] = [],
): RuntimeAccess {
  return {
    command: async (command) => ({
      status: 'applied',
      commandId: command.commandId,
      sessionId: 'session-1',
      revision: 1,
    }),
    query: async (query) => ({
      status: 'ok',
      queryType: query.type,
      session: {
        schema: RUNTIME_PROJECTION_SCHEMA_,
        sessionId: 'session-1',
        revision: 2,
        lifecycle: 'open',
        interactionQueue: { revision: 2, interactions: [] },
        ...(status === 'waiting'
          ? {
              activeWork: {
                workId: 'work-1',
                phase: 'building' as const,
                status: 'waiting' as const,
              },
            }
          : {}),
      },
    }),
    subscribe: (subscription) => {
      subscriptions.push(subscription);
      let index = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const value = notifications[index++];
            return value === undefined ? { done: true, value: undefined } : { done: false, value };
          },
          return: async () => ({ done: true, value: undefined }),
        }),
      };
    },
  };
}

function durableNotification(revision: number): RuntimeAccessNotification {
  return {
    schema: RUNTIME_NOTIFICATION_SCHEMA_,
    durability: 'durable',
    sessionId: 'session-1',
    revision,
    projection: {
      kind: 'work',
      session: {
        schema: RUNTIME_PROJECTION_SCHEMA_,
        sessionId: 'session-1',
        revision,
        lifecycle: 'open',
        interactionQueue: { revision, interactions: [] },
      },
      event: { type: 'interaction_mode.changed', mode: 'full' },
    },
  };
}
