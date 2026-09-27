import { expect, test } from 'bun:test';
import type { RuntimeState } from '../../src/bootstrap/runtime/state-runtime';
import { childTerminalResult } from '../../src/bootstrap/runtime/subagent/child-session-orchestrator';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';

test('child terminal result preserves successful output and reports only bounded failure reasons', () => {
  const state = (
    reasonCode: 'completed' | 'model_retry_exhausted' | 'provider_unavailable' | 'unknown',
    outcomeStatus: 'completed' | 'aborted' | 'unknown',
  ) =>
    ({
      terminalOutcome: { status: outcomeStatus, reasonCode },
      tools: { calls: { 'child-tool': {} } },
      resourceBudget: { status: 'active', startedAt: new Date(Date.now() - 100).toISOString() },
      turn: { status: reasonCode === 'completed' ? 'completed' : 'aborted', abortCause: 'error' },
    }) as unknown as RuntimeState;

  expect(childTerminalResult(state('completed', 'completed'), 'Child answer.')).toMatchObject({
    ok: true,
    summary: 'Child answer.',
    terminalStatus: 'completed',
    toolCallCount: 1,
  });
  for (const [reasonCode, outcomeStatus, terminalStatus] of [
    ['model_retry_exhausted', 'unknown', 'interrupted'],
    ['provider_unavailable', 'aborted', 'failed'],
    ['unknown', 'unknown', 'interrupted'],
  ] as const) {
    const result = childTerminalResult(state(reasonCode, outcomeStatus), 'PRIVATE_PROVIDER_BODY');
    expect(result).toMatchObject({
      ok: false,
      error: reasonCode,
      summary: `Child Session ${terminalStatus}: ${reasonCode}.`,
      terminalStatus,
      toolCallCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_BODY');
  }
});

test(
  'direct child orchestrator uses real Store and Host authority through terminal import',
  () => exerciseChildOrchestration(false),
  30_000,
);

test(
  'real child Provider retries wake task_wait and settle a classified failure for the parent',
  () =>
    exerciseChildOrchestration(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      undefined,
      false,
      async ({ orchestrator }, releaseChildResponse) => {
        const waiting = orchestrator.taskControl!.waitTasks(
          ['orchestrator-child-invocation'],
          15_000,
        );
        releaseChildResponse();
        expect(await waiting).toMatchObject({
          ok: true,
          status: 'running',
          reason: 'model_retry',
          tasks: [{ status: 'running', retry: { attempt: 1, maxAttempts: 5 } }],
        });
      },
      undefined,
      undefined,
      false,
      120_000,
      true,
    ),
  30_000,
);

test(
  'fresh orchestrator recovers an accepted intent once and second sweep is idempotent',
  () => exerciseChildOrchestration(true),
  30_000,
);

test(
  'expired revision zero child lease is fenced before its first dispatch and parent claim settles',
  () =>
    exerciseChildOrchestration(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      undefined,
      false,
      undefined,
      async ({ owner, orchestrator, model, parentSessionId, childSessionId, acceptedChild }) => {
        model.setResponses([
          { response: async () => ({ message: { content: 'ORCHESTRATED_CHILD_RESULT' } }) },
        ]);
        await Bun.sleep(220);
        expect(owner.loadCurrentSnapshot(childSessionId)?.revision).toBe(0);
        expect(() => owner.runWithSessionExecution(childSessionId, () => undefined)).toThrow();
        if (!acceptedChild) throw new Error('Accepted child fixture was missing.');
        await orchestrator.onAccepted(acceptedChild);
        expect(model.getRequestCount()).toBe(1);
        expect(
          owner.loadCurrentSnapshot(childSessionId)?.childSessionOrigin?.terminal,
        ).toMatchObject({
          status: 'completed',
          cleanupConfirmed: true,
        });
        expect(
          owner.storage.sessions
            .loadEventsStrict(parentSessionId)
            .filter(({ event }) => event.type === 'subagent.child_terminal_imported'),
        ).toHaveLength(1);
      },
      undefined,
      false,
      120_000,
      false,
      false,
      true,
    ),
  30_000,
);

test(
  'cancelled parent recovers a released, never-dispatched child without releasing twice',
  () =>
    exerciseChildOrchestration(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      undefined,
      false,
      undefined,
      async ({
        owner,
        parentCoordinator,
        parentSessionId,
        parentRunId,
        childSessionId,
        model,
        orchestrator,
      }) => {
        const intent = owner.readChildSessionIntent(childSessionId);
        if (!intent) throw new Error('Accepted child intent was missing.');
        owner.runWithSessionExecution(parentSessionId, () =>
          parentCoordinator.control.processEventBatch([
            {
              type: 'resource_budget.released',
              reservationId: intent.delegatedReservationId,
            },
            {
              type: 'turn.aborted',
              turnId: parentRunId,
              reason: 'Cancelled by user.',
              cause: 'user',
            },
          ]),
        );
        const run = owner.storage.runs!.get(parentSessionId, parentRunId);
        expect(run?.status).toBe('cancelled');
        owner.runWithSessionExecution(parentSessionId, () =>
          parentCoordinator.control.processEventBatch([
            { type: 'turn.started', turnId: 'orchestrator-next-turn' },
          ]),
        );
        expect(owner.loadCurrentSnapshot(parentSessionId)?.turn.turnId).toBe(
          'orchestrator-next-turn',
        );
        const result = await orchestrator.recoverPending();
        expect(result).toMatchObject({ processed: 1, recoveryRequired: [] });
        expect(owner.readChildSessionIntent(childSessionId)?.failureReceiptDigest).toBeTruthy();
        expect(owner.readChildSessionIntent(childSessionId)?.dispatchAckEventId).toBeNull();
        expect(owner.loadCurrentSnapshot(childSessionId)?.revision).toBe(0);
        expect(
          owner
            .loadCurrentSnapshot(parentSessionId)
            ?.transcript.messages.some(
              (message) => message.kind === 'user' && message.content.includes('<subagent_result'),
            ),
        ).toBe(false);
        expect(owner.storage.runs!.get(parentSessionId, parentRunId)?.status).toBe('cancelled');
        const events = owner.storage.sessions
          .loadEventsStrict(parentSessionId)
          .map(({ event }) => event);
        expect(events.filter((event) => event.type === 'resource_budget.released')).toHaveLength(1);
        expect(
          events.filter((event) => event.type === 'subagent.child_pre_dispatch_cancelled'),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.type === 'subagent.background_result_persisted'),
        ).toHaveLength(1);
        expect(await orchestrator.recoverPending()).toMatchObject({ processed: 0 });
        expect(model.getRequestCount()).toBe(0);
      },
    ),
  30_000,
);

test(
  'activated and acknowledged child resumes its first model once through the real Store and Host',
  () =>
    exerciseChildOrchestration(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      undefined,
      false,
      undefined,
      undefined,
      async ({ owner, orchestrator, model, parentSessionId, childSessionId }) => {
        model.setResponses([
          {
            response: async () => ({ message: { content: 'ORCHESTRATED_CHILD_RESULT' } }),
          },
        ]);
        expect(await orchestrator.recoverPending()).toMatchObject({
          processed: 1,
          recoveryRequired: [],
        });
        expect(model.getRequestCount()).toBe(1);
        expect(
          owner.loadCurrentSnapshot(childSessionId)?.childSessionOrigin?.terminal,
        ).toMatchObject({
          status: 'completed',
          cleanupConfirmed: true,
        });
        expect(
          owner.storage.sessions
            .loadEventsStrict(parentSessionId)
            .filter(({ event }) => event.type === 'subagent.child_terminal_imported'),
        ).toHaveLength(1);
        expect(await orchestrator.recoverPending()).toMatchObject({ processed: 0 });
      },
      true,
    ),
  30_000,
);

test(
  'recovery completion reports a child work queue failure without dispatching Provider',
  () => exerciseChildOrchestration(true, false, false, false, false, false, false, true),
  30_000,
);

test(
  'fenced child attempt seals unknown and settles the parent claim without replaying Provider',
  () => exerciseChildOrchestration(false, true),
  30_000,
);

test(
  'durable stop after an external attempt settles unknown without Provider replay',
  () => exerciseChildOrchestration(false, true, false, false, false, false, true),
  30_000,
);

test(
  'parent cancellation stops one child and settles its required claim',
  () => exerciseChildOrchestration(false, false, true),
  30_000,
);

test(
  'task_cancel stops the exact locally owned child and returns its settled status',
  () => exerciseChildOrchestration(false, false, false, true),
  30_000,
);

test(
  'durable pre-dispatch stop settles the parent claim without creating a child Session',
  () => exerciseChildOrchestration(false, false, false, false, true),
  30_000,
);

test(
  'durable stop after ACK seals a clean cancellation without Provider dispatch',
  () => exerciseChildOrchestration(false, false, false, false, false, true),
  30_000,
);
