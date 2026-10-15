/**
 * PTY System Test — /compact survives session switch
 *
 * Verifies that the /compact slash command reaches the exact active Session
 * and durably records its terminal result after a switch. Regression test for the
 * Ink 7 useInput stale closure bug where slash commands silently fail after
 * the InputLine component remounts via key={activeSessionId}.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedSessionCommandEvents,
  observePersistedSessionEvents,
  observePersistedSessionIds,
  observePersistedUserMessageSession,
  type PersistedTurnEvent,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

describe('TUI PTY System — /compact after session switch', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let sessionIdsBeforeNew: string[] = [];
  let sessionOneEventCount = 0;
  let sessionOneId: string;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();

    // Slash commands stay local; only the explicit session-1 message calls the model.
    server.setResponses([{ message: { content: 'Session 1 response' }, delay: 50 }]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Session 1 — establish a durable Runtime owner, then /compact ──

  step(
    '/compact in session 1 commits a terminal result',
    async () => {
      await submitUserMessage(tui, server, 'Session 1 message', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'Session 1 response', 15000);
      await waitForCondition(
        () => {
          const observation = observePersistedSessionIds(workspace);
          const original = observePersistedUserMessageSession(workspace, 'Session 1 message');
          if (observation.status !== 'ready' || original.status !== 'ready' || !original.value)
            return false;
          sessionOneId = original.value.threadId;
          if (!observation.value.includes(sessionOneId)) return false;
          sessionIdsBeforeNew = observation.value;
          return true;
        },
        'Runtime Store to persist session 1 before /compact',
        20_000,
      );

      const events = await submitCompactAndObserve(sessionOneId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'command.accepted',
          sourceType: 'command.accepted',
          kind: 'context.compress',
          request: expect.objectContaining({ kind: 'context.compress' }),
        }),
      );
      expectCompactFailure(events);
      const sessionEvents = observePersistedSessionEvents(workspace, sessionOneId);
      if (sessionEvents.status !== 'ready') {
        throw new Error('Session 1 durable event observation was lost.');
      }
      sessionOneEventCount = sessionEvents.value.length;
    },
    TIMEOUT,
  );

  // ── Create session 2 via /new ──

  step(
    '/new creates session 2',
    async () => {
      await submitCommand(tui, '/new', undefined, {
        acceptWhen: (viewport) =>
          screenContains(viewport, '❯') &&
          !screenContains(viewport, 'Session 1 message') &&
          !screenContains(viewport, 'Session 1 response'),
        requireAcceptWhen: true,
        semanticReceiptTimeoutMs: 20_000,
      });
    },
    TIMEOUT,
  );

  // ── Session 2 — /compact should STILL produce a response ──
  // This is the regression test: after InputLine remounts (key change),
  // the useInput handler must still invoke the slash command callback.

  step(
    '/compact in session 2 commits an exact-session result (regression)',
    async () => {
      const observed = await submitCompactAndObserveNewSession(sessionIdsBeforeNew);
      expect(sessionIdsBeforeNew).not.toContain(observed.sessionId);
      const events = observed.events;
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'command.accepted',
          sourceType: 'command.accepted',
          kind: 'context.compress',
          request: expect.objectContaining({ kind: 'context.compress' }),
        }),
      );
      expectCompactFailure(events);
      const oldSessionEvents = observePersistedSessionEvents(workspace, sessionOneId);
      if (oldSessionEvents.status !== 'ready') {
        throw new Error('Session 1 durable event observation was lost after /new.');
      }
      expect(oldSessionEvents.value).toHaveLength(sessionOneEventCount);
    },
    TIMEOUT,
  );

  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );

  async function submitCompactAndObserve(sessionId: string): Promise<PersistedTurnEvent[]> {
    let events: PersistedTurnEvent[] | undefined;
    await submitCommand(tui, '/compact', undefined, {
      acceptWhen: () => {
        const observation = observePersistedSessionCommandEvents(workspace, sessionId, '/compact');
        if (observation.status !== 'ready' || !observation.value) return false;
        const terminal = observation.value.find(
          (event) =>
            event.type === 'run.finished' && ['failed', 'completed'].includes(String(event.status)),
        );
        if (!terminal) return false;
        events = observation.value;
        return true;
      },
      requireAcceptWhen: true,
      semanticReceiptTimeoutMs: 30_000,
    });
    if (!events) throw new Error('Durable /compact result observation was lost.');
    return events;
  }

  async function submitCompactAndObserveNewSession(
    excludedSessionIds: readonly string[],
  ): Promise<{ sessionId: string; events: PersistedTurnEvent[] }> {
    let observed: { sessionId: string; events: PersistedTurnEvent[] } | undefined;
    try {
      await submitCommand(tui, '/compact', undefined, {
        acceptWhen: () => {
          const sessions = observePersistedSessionIds(workspace);
          if (sessions.status !== 'ready') return false;
          const next = sessions.value.filter(
            (sessionId) => !excludedSessionIds.includes(sessionId),
          );
          if (next.length !== 1) return false;
          const events = observePersistedSessionEvents(workspace, next[0]!);
          if (events.status !== 'ready') return false;
          if (
            !events.value.some(
              (event) =>
                event.type === 'run.finished' &&
                ['failed', 'completed'].includes(String(event.status)),
            )
          ) {
            return false;
          }
          observed = { sessionId: next[0]!, events: events.value };
          return true;
        },
        requireAcceptWhen: true,
        semanticReceiptTimeoutMs: 10_000,
      });
    } catch (error) {
      const sessions = observePersistedSessionIds(workspace);
      const sessionEvents =
        sessions.status === 'ready'
          ? sessions.value.map((sessionId) => ({
              sessionId,
              commandObservation: observePersistedSessionCommandEvents(
                workspace,
                sessionId,
                '/compact',
              ),
              allEvents: observePersistedSessionEvents(workspace, sessionId),
            }))
          : [];
      throw new Error(
        `New-session /compact did not reach its durable owner. Sessions=${JSON.stringify(
          sessions,
        )}; commandEvents=${JSON.stringify(sessionEvents)}; viewport=${JSON.stringify(
          tui.viewport(),
        )}`,
        { cause: error },
      );
    }
    if (!observed) throw new Error('Durable new-session /compact result observation was lost.');
    return observed;
  }

  function expectCompactFailure(events: PersistedTurnEvent[]): void {
    const accepted = events.find(
      (event) => event.type === 'command.accepted' && event.kind === 'context.compress',
    );
    expect(accepted).toBeDefined();
    const terminal = events.find(
      (event) => event.type === 'run.finished' && event.originCommandId === accepted?.objectId,
    );
    expect(terminal).toMatchObject({
      type: 'run.finished',
      sourceType: 'run.finished',
      status: 'failed',
      reason: 'compression_not_reducible',
    });
    // The old retryable:false boolean is replaced by the actual refused Run
    // reason and an exact zero-new-Provider assertion, not a fabricated event.
    expect(server.getRequestCount()).toBe(1);
  }
});
