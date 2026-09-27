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
