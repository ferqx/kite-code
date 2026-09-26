import { describe, expect, test } from 'bun:test';
import type { RuntimeHistoryClient as RuntimeHistoryReader } from '@kite-ai/runtime-client';
import type { RuntimeHistorySessionTranscript } from '@kite-ai/runtime-contract';
import { createTuiHistoryFacade } from '../../src/runtime-client/tui-history-facade';

describe('TUI history presentation envelopes', () => {
  test('reads a child only through the parent-scoped History method', async () => {
    const transcript = {
      session: {
        sessionId: 'child-history',
        displayName: 'Child',
        needsSmartName: false,
        updatedAt: 1,
        lastSequence: 0,
      },
      records: [],
      events: [],
      interactionMode: 'auto',
      recovery: 'normal',
    } satisfies RuntimeHistorySessionTranscript;
    const calls: string[] = [];
    const history: RuntimeHistoryReader = {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: async () => {
        throw new Error('Ordinary child History must remain closed.');
      },
      loadChildSession: async (parentSessionId, childSessionId) => {
        calls.push(`${parentSessionId}:${childSessionId}`);
        return transcript;
      },
    };
    const reader = createTuiHistoryFacade(history);
    expect((await reader.loadPersistedChildSession('root-history', 'child-history')).threadId).toBe(
      'child-history',
    );
    expect(calls).toEqual(['root-history:child-history']);
    await expect(reader.loadPersistedChildSession('root-history', 'wrong-child')).rejects.toThrow(
      'identity changed',
    );
  });
  test('preserves deterministic durable revision and source identity', async () => {
    const event = {
      type: 'run.terminal',
      runId: 'run-history-1',
      status: 'completed',
      summary: 'done',
    } as const;
    const transcript = {
      session: {
        sessionId: 'session-history',
        displayName: 'History',
        needsSmartName: false,
        updatedAt: 1,
        lastSequence: 12,
      },
      records: [{ sequence: 12, events: [event], identity: { runId: 'run-history-1' } }],
      events: [event],
      interactionMode: 'accept_edits',
      recovery: 'normal',
    } satisfies RuntimeHistorySessionTranscript;
    const history: RuntimeHistoryReader = {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 12 }),
      loadSession: async () => transcript,
    };

    const result = await createTuiHistoryFacade(history).loadPersistedSession('session-history');

    expect(result?.runtimeEvents).toEqual([
      {
        sessionId: 'session-history',
        connectionGeneration: 1,
        durability: 'durable',
        revision: 12,
        runId: 'run-history-1',
        event,
      },
    ]);
  });

  test('uses grouped source sequence when the flattened history list is duplicated', async () => {
    const event = {
      type: 'unavailable',
      reason: 'redacted',
    } as const;
    const transcript = {
      session: {
        sessionId: 'session-history',
        displayName: 'History',
        needsSmartName: false,
        updatedAt: 1,
        lastSequence: 4,
      },
      records: [{ sequence: 4, events: [event] }],
      events: [event, event],
      interactionMode: 'accept_edits',
      recovery: 'normal',
    } satisfies RuntimeHistorySessionTranscript;
    const history: RuntimeHistoryReader = {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 4 }),
      loadSession: async () => transcript,
    };

    const result = await createTuiHistoryFacade(history).loadPersistedSession('session-history');

    expect(result?.runtimeEvents).toHaveLength(1);
    expect(result?.runtimeEvents[0]?.revision).toBe(4);
  });
});
