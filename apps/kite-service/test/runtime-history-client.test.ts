import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import { createKiteRuntimeStorageOwner } from '../src/bootstrap';
import type { RuntimeEvent } from '../src/bootstrap/runtime/state-runtime';
import {
  createKiteRuntimeHistoryClient,
  createKiteRuntimeObserverHistoryClient,
} from '../src/runtime-client/history-adapter';

describe('Kite Runtime History Client adapter', () => {
  test('keeps persisted list/load behind the Service RuntimeClient history seam', () => {
    const adapter = readFileSync(
      join(import.meta.dir, '../src/runtime-client/history-adapter.ts'),
      'utf8',
    );
    expect(adapter).toContain('createKiteRuntimeHistoryClient');
    expect(adapter).not.toContain('target.listPersistedSessions(');
    expect(adapter).not.toContain('target.loadPersistedSession(');
  });

  test('projects only fixed client-safe session and event DTOs', async () => {
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [
          {
            sessionId: 'session-1',
            name: '',
            updatedAt: 42,
            lastSequence: 1,
          },
        ],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: [
          {
            sessionId: 'session-1',
            sequence: 1,
            eventId: 'event-1',
            createdAt: 42,
            event: {
              type: 'user.message_appended',
              messageId: 'message-1',
              content: 'hello',
            } as RuntimeEvent,
          },
        ],
        hasMore: false,
        observedLastSequence: 1,
      }),
      close: () => undefined,
    };
    const history = createKiteRuntimeHistoryClient(logs);

    expect(await history.listSessions({ limit: 10 })).toEqual({
      entries: [
        {
          sessionId: 'session-1',
          displayName: 'hello',
          needsSmartName: false,
          updatedAt: 42,
          lastSequence: 1,
        },
      ],
      hasMore: false,
    });
    expect(
      await history.listEvents({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 10,
      }),
    ).toMatchObject({
      entries: [
        {
          type: 'user.message_appended',
          summary: 'hello',
          detail: {
            kind: 'message',
            fields: { content: 'hello', message_id: 'message-1' },
          },
        },
      ],
      hasMore: false,
      observedLastSequence: 1,
    });
  });

  test('searches the first durable user message when the smart display name is truncated', async () => {
    const eventQueries: string[][] = [];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [
          {
            sessionId: 'session-search',
            name: 'restart persistence target ide',
            updatedAt: 42,
            lastSequence: 1,
          },
        ],
        hasMore: false,
      }),
      listEvents: (request) => {
        eventQueries.push([...(request.eventTypes ?? [])]);
        return {
          entries: [
            {
              sessionId: 'session-search',
              sequence: 1,
              eventId: 'event-search',
              createdAt: 42,
              event: {
                type: 'user.message_appended',
                messageId: 'message-search',
                content: 'restart persistence target identity',
              } as RuntimeEvent,
            },
          ],
          hasMore: false,
          observedLastSequence: 1,
        };
      },
      close: () => undefined,
    };

    await expect(
      createKiteRuntimeHistoryClient(logs).listSessions({
        limit: 10,
        query: 'restart persistence target identity',
      }),
    ).resolves.toMatchObject({
      entries: [{ sessionId: 'session-search' }],
      hasMore: false,
    });
    expect(eventQueries).toEqual([['user.message_appended']]);
  });

  test('reads every durable page and replays a model completion through the live event vocabulary', async () => {
    const records = Array.from({ length: 401 }, (_, index) => ({
      sessionId: 'long-session',
      sequence: index + 1,
      eventId: `event-${index + 1}`,
      createdAt: index + 1,
      event:
        index === 0
          ? ({
              type: 'model.responded',
              invocationId: 'invocation-1',
              messageId: 'message-1',
              reasoningText: 'durable reasoning',
              text: 'durable answer',
              toolCalls: [],
            } as RuntimeEvent)
          : ({
              type: 'user.message_appended',
              messageId: `message-${index + 1}`,
              content: `message ${index + 1}`,
            } as RuntimeEvent),
    }));
    const calls: number[] = [];
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => ({
        entries: [
          {
            sessionId: 'long-session',
            name: 'Long history',
            updatedAt: 10,
            lastSequence: records.length,
            model: { provider: 'provider', name: 'model' },
          },
        ],
        hasMore: false,
      }),
      listEvents: (request) => {
        calls.push(request.afterSequence ?? 0);
        const entries = records.filter((entry) => entry.sequence > (request.afterSequence ?? 0));
        const page = entries.slice(0, request.limit);
        const last = page.at(-1);
        return {
          entries: page,
          hasMore: entries.length > page.length,
          ...(entries.length > page.length && last ? { nextCursor: last.sequence } : {}),
          observedLastSequence: records.length,
        };
      },
      close: () => undefined,
    };

    const transcript = await createKiteRuntimeHistoryClient(logs).loadSession!('long-session');

    expect(calls).toEqual([0, 200, 400]);
    expect(transcript.session).toMatchObject({
      sessionId: 'long-session',
      model: { provider: 'provider', name: 'model' },
    });
    expect(transcript.events).toHaveLength(403);
    expect(transcript.events.slice(0, 3)).toEqual([
      {
        type: 'reasoning.activity',
        requestId: 'invocation-1',
        state: 'completed',
        segmentId: 'history-reasoning-ofjb0x',
        text: 'durable reasoning',
      },
      { type: 'model.text_delta', requestId: 'invocation-1', text: 'durable answer' },
      {
        type: 'model.responded',
        requestId: 'invocation-1',
        messageId: 'message-1',
        toolCallCount: 0,
        summary: 'durable answer',
      },
    ]);
  });

  test('lists known compatibility sessions and imports only the selected session before replay', async () => {
    let imported = false;
    let importCalls = 0;
    const source = (): RuntimeLogQueryPort<RuntimeEvent> => ({
      listSessions: () => ({
        entries: imported
          ? [
              {
                sessionId: 'legacy-session',
                name: '',
                updatedAt: 20,
                lastSequence: 1,
              },
            ]
          : [],
        hasMore: false,
      }),
      listEvents: () => ({
        entries: imported
          ? [
              {
                sessionId: 'legacy-session',
                sequence: 1,
                eventId: 'legacy-event-1',
                createdAt: 20,
                event: {
                  type: 'user.message_appended',
                  messageId: 'legacy-message-1',
                  content: 'legacy prompt',
                } as RuntimeEvent,
              },
            ]
          : [],
        hasMore: false,
        observedLastSequence: imported ? 1 : 0,
      }),
      close: () => undefined,
    });
    const history = createKiteRuntimeHistoryClient(source, {
      listSessions: () => [
        {
          threadId: 'legacy-session',
          name: 'Legacy session',
          updatedAt: 20,
          needsSmartName: false,
        },
      ],
      importSession: (sessionId) => {
        importCalls += 1;
        expect(sessionId).toBe('legacy-session');
        imported = true;
        return { status: 'imported' };
      },
    });

    await expect(history.listSessions({ limit: 10, query: 'legacy' })).resolves.toEqual({
      entries: [
        {
          sessionId: 'legacy-session',
          displayName: 'Legacy session',
          needsSmartName: false,
          updatedAt: 20,
          lastSequence: 0,
        },
      ],
      hasMore: false,
    });
    expect(imported).toBe(false);

    const transcript = await history.loadSession('legacy-session');
    expect(importCalls).toBe(1);
    expect(transcript.session).toMatchObject({
      sessionId: 'legacy-session',
      displayName: 'legacy prompt',
      needsSmartName: false,
      lastSequence: 1,
    });
    expect(transcript.events).toEqual([
      {
        type: 'user.message',
        messageId: 'legacy-message-1',
        kind: 'task',
        text: 'legacy prompt',
      },
    ]);
  });

  test('keeps observer History current-format and never invokes compatibility import', async () => {
    let listCalls = 0;
    let eventCalls = 0;
    const logs: RuntimeLogQueryPort<RuntimeEvent> = {
      listSessions: () => {
        listCalls += 1;
        return { entries: [], hasMore: false };
      },
      listEvents: () => {
        eventCalls += 1;
        return {
          entries: [],
          hasMore: false,
          observedLastSequence: 0,
        };
      },
      close: () => undefined,
    };

    const history = createKiteRuntimeObserverHistoryClient(logs);

    await expect(history.listSessions({ limit: 10 })).resolves.toEqual({
      entries: [],
      hasMore: false,
    });
    await expect(history.loadSession('legacy-only')).rejects.toThrow(
      'Runtime session was not found: legacy-only',
    );
    expect(listCalls).toBeGreaterThan(0);
    expect(eventCalls).toBe(0);
  });

  test('forwards receipt-bearing deletion input through the App storage owner proxy', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'kite-history-delete-'));
    const checkpointPath = join(directory, 'runtime.sqlite');
    const owner = createKiteRuntimeStorageOwner(checkpointPath);
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'delete-session',
        commandId: 'delete-command',
        requestDigest: 'a'.repeat(64),
        targetSessionId: 'delete-session',
        committedAt: 1,
      },
      0,
    );
    try {
      owner.storage.sessions.saveSnapshot(
        'delete-session',
        createInitialAgentState({
          threadId: 'delete-session',
          userId: 'tui',
          workspace: '/workspace',
          projectId: 'project-1',
          canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
          recoveryIdentityKey: 'b'.repeat(64),
          turnId: 'turn-1',
        }),
      );
      owner.storage.sessions.deleteSession('delete-session', {
        expectedRevision: 0,
        commandReceipt: receipt,
      });
      expect(
        owner.storage.commandReceipts.lookup({
          scopeSessionId: 'delete-session',
          commandId: 'delete-command',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
      expect(owner.storage.sessions.loadSnapshot('delete-session')).toBeNull();
    } finally {
      owner.storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
