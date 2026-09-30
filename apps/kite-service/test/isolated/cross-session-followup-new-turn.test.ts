import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFailure } from '../../src/bootstrap/runtime/failures';
import { failedTerminalOutcome } from '../../src/bootstrap/runtime/terminal-outcome';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

test('independent followup completes a Tool loop after both Model reservations are archived', async () => {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    async (fixture) => {
      const { owner, model, orchestrator, childSessionId, parentSessionId, workspace } = fixture;
      writeFileSync(join(workspace, 'followup-input.txt'), 'FULL_FOLLOWUP_INPUT');
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Read and finish the followup.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const before = model.getRequestCount();
      model.setResponses([
        {
          response: async () => ({
            message: {
              tool_calls: [
                { id: 'followup-read', name: 'read_file', args: { path: 'followup-input.txt' } },
              ],
            },
            toolContinuation: 'required' as const,
            usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
          }),
        },
        {
          response: async () => ({
            message: { content: 'FOLLOWUP_TOOL_LOOP_COMPLETED' },
            expectedRequest: { toolResults: [{ toolCallId: 'followup-read' }] },
            usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
          }),
        },
      ]);
      expect(
        await orchestrator.executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId),
      ).toBe(true);
      const state = owner.loadCurrentSnapshot(childSessionId);
      if (!state) throw new Error('Completed followup snapshot is unavailable.');
      expect(state.turn.status).toBe('completed');
      expect(state.transcript.final).toBe('FOLLOWUP_TOOL_LOOP_COMPLETED');
      expect(state.tools.calls['followup-read']?.status).toBe('succeeded');
      const receipts = owner.storage.completedResourceReservations?.listForRun?.({
        sessionId: childSessionId,
        runId: state.turn.turnId,
        atRevision: state.revision,
        resourceKind: 'model',
      });
      expect(receipts).toHaveLength(2);
      expect(receipts?.every((receipt) => receipt.state === 'reconciled')).toBe(true);
      expect(model.getRequestCount()).toBe(before + 2);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'completed' });
      expect((await orchestrator.recoverPendingFollowups()).recoveryRequired).toEqual([]);
      expect(model.getRequestCount()).toBe(before + 2);
    },
  );
}, 30_000);

test('failed first followup Model before dispatch releases funding and replies with failed status', async () => {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    async (fixture) => {
      const { owner, services, parentSessionId, childSessionId, orchestrator, model } = fixture;
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Fail before the child followup Model dispatch.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const requestsBefore = model.getRequestCount();
      const transactions = services.transactions as {
        commit: typeof services.transactions.commit;
      };
      const originalCommit = transactions.commit;
      transactions.commit = (acknowledgement, transaction, requiredLease) => {
        if (
          transaction.sessionId === childSessionId &&
          transaction.events.some((event) => event.type === 'model.invocation_attempt_started')
        )
          throw new Error('Fixture rejected the pre-dispatch attempt commit.');
        return originalCommit(acknowledgement, transaction, requiredLease);
      };
      try {
        expect(
          await orchestrator.executeAcceptedFollowupFirstModel(
            childSessionId,
            accepted.submissionId,
          ),
        ).toBe(false);
      } finally {
        transactions.commit = originalCommit;
      }
      expect(model.getRequestCount()).toBe(requestsBefore);
      const childEvents = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      const route = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupRoute(childSessionId, accepted.submissionId),
      );
      expect(
        childEvents.filter(
          (event) =>
            event.type === 'model.invocation_attempt_started' &&
            event.invocationId === route?.invocationId,
        ),
      ).toHaveLength(0);
      expect(childEvents).toContainEqual(
        expect.objectContaining({ type: 'agent.followup_turn_settled', status: 'failed' }),
      );
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'pre_dispatch_released' });
      const replies = owner.runWithSessionExecution(childSessionId, () =>
        raw.listPendingTerminalReplies(childSessionId, 8),
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ mode: 'reply', sourceTaskId: expect.any(String) });
    },
  );
}, 30_000);

test('user-cancelled followup before dispatch releases funding and replies with cancelled status', async () => {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    async (fixture) => {
      const {
        owner,
        services,
        coordinators,
        parentSessionId,
        childSessionId,
        orchestrator,
        model,
      } = fixture;
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Cancel the child followup before its first Model dispatch.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const requestsBefore = model.getRequestCount();
      const transactions = services.transactions as {
        commit: typeof services.transactions.commit;
      };
      const originalCommit = transactions.commit;
      const controller = new AbortController();
      let activated = false;
      transactions.commit = (acknowledgement, transaction, requiredLease) => {
        const result = originalCommit(acknowledgement, transaction, requiredLease);
        if (
          !activated &&
          transaction.crossSessionAgentMailMutation?.kind === 'activate_independent_followup_turn'
        ) {
          activated = true;
          controller.abort();
        }
        return result;
      };
      try {
        await orchestrator
          .executeAcceptedFollowupFirstModel(
            childSessionId,
            accepted.submissionId,
            controller.signal,
          )
          .catch(() => false);
      } finally {
        transactions.commit = originalCommit;
      }
      expect(activated).toBe(true);
      expect(model.getRequestCount()).toBe(requestsBefore);
      const child = coordinators.get(childSessionId);
      const followup = child?.getState().activeFollowupTurn;
      if (!child || !followup) throw new Error('Fixture followup turn was not started.');
      expect(child.getState().turn.status).toBe('active');
      const route = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupRoute(childSessionId, accepted.submissionId),
      );
      expect(route?.route).toBe('new_turn');
      expect(child.getState().modelInvocations[route!.invocationId]?.attempts).toBe(0);
      const failure = classifyFailure('user_input_cancelled', 'User cancelled before dispatch.');
      owner.runWithSessionExecution(childSessionId, () =>
        child.control.processEventBatch([
          {
            type: 'task.failed',
            taskId: followup.taskId,
            reason: 'User cancelled before dispatch.',
          },
          {
            type: 'turn.aborted',
            turnId: followup.targetRunId,
            reason: failure.message,
            cause: 'user',
          },
          {
            type: 'run.error',
            turnId: followup.targetRunId,
            message: failure.message,
            recoverable: false,
            failure,
            outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'known' }),
          },
        ]),
      );
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          child.session.commitChildFollowupTurnSettlement({
            type: 'agent.followup_turn_settled',
            sourceSessionId: parentSessionId,
            submissionId: accepted.submissionId,
            targetRunId: followup.targetRunId,
            taskId: followup.taskId,
            status: 'cancelled',
          }),
        ),
      ).toHaveLength(1);
      expect(
        orchestrator.settleTerminalFollowupFunding(childSessionId, accepted.submissionId),
      ).toBe(true);
      const childEvents = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(childEvents).toContainEqual(
        expect.objectContaining({ type: 'agent.followup_turn_settled', status: 'cancelled' }),
      );
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'pre_dispatch_released' });
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.listPendingTerminalReplies(childSessionId, 8),
        ),
      ).toHaveLength(1);
    },
  );
}, 30_000);

test('committed first Model attempt settles unknown without replay and replies once', async () => {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    async (fixture) => {
      const { owner, services, parentSessionId, childSessionId, orchestrator, model } = fixture;
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Treat uncertain Provider usage as unknown.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const transactions = services.transactions as {
        commit: typeof services.transactions.commit;
      };
      const originalCommit = transactions.commit;
      let attempted = false;
      transactions.commit = (acknowledgement, transaction, requiredLease) => {
        const result = originalCommit(acknowledgement, transaction, requiredLease);
        if (
          !attempted &&
          transaction.sessionId === childSessionId &&
          transaction.events.some((event) => event.type === 'model.invocation_attempt_started')
        ) {
          attempted = true;
          throw new Error('Fixture lost certainty after the attempt commit.');
        }
        return result;
      };
      try {
        await orchestrator
          .executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId)
          .catch(() => false);
      } finally {
        transactions.commit = originalCommit;
      }
      expect(attempted).toBe(true);
      const requestsBeforeRecovery = model.getRequestCount();
      const recovery = await orchestrator.recoverPendingFollowups();
      expect(recovery.recoveryRequired).toEqual([]);
      expect(model.getRequestCount()).toBe(requestsBeforeRecovery);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'unknown' });
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.listPendingTerminalReplies(childSessionId, 8),
        ),
      ).toEqual([
        expect.objectContaining({ mode: 'reply', sourceEffectAttemptId: accepted.submissionId }),
      ]);
    },
  );
}, 30_000);

test('failed followup recovers after target terminal Event commits before source ACK', async () => {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    async (fixture) => {
      const { owner, services, parentSessionId, childSessionId, orchestrator } = fixture;
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Recover a failed child followup terminal ACK.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const transactions = services.transactions as {
        commit: typeof services.transactions.commit;
      };
      const originalCommit = transactions.commit;
      let terminalCommitted = false;
      transactions.commit = (acknowledgement, transaction, requiredLease) => {
        if (
          transaction.sessionId === childSessionId &&
          transaction.events.some((event) => event.type === 'model.invocation_attempt_started')
        )
          throw new Error('Fixture rejected the pre-dispatch attempt commit.');
        const result = originalCommit(acknowledgement, transaction, requiredLease);
        if (
          !terminalCommitted &&
          transaction.sessionId === childSessionId &&
          transaction.events.some(
            (event) => event.type === 'agent.followup_turn_settled' && event.status === 'failed',
          )
        ) {
          terminalCommitted = true;
          throw new Error('Fixture stopped after target terminal Event commit.');
        }
        return result;
      };
      try {
        await orchestrator
          .executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId)
          .catch(() => false);
      } finally {
        transactions.commit = originalCommit;
      }
      expect(terminalCommitted).toBe(true);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toBeNull();
      expect(
        orchestrator.settleTerminalFollowupFunding(childSessionId, accepted.submissionId),
      ).toBe(true);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'pre_dispatch_released' });
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.listPendingTerminalReplies(childSessionId, 8),
        ),
      ).toHaveLength(1);
    },
  );
}, 30_000);

async function exerciseRealFollowup(
  stopAfterRunStart: boolean,
  sourceAutoRevision = false,
  targetDrift: 'mode' | 'catalog' | null = null,
): Promise<void> {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    async ({
      owner,
      services,
      coordinators,
      parentCoordinator,
      parentSessionId,
      parentRunId,
      childSessionId,
      orchestrator,
      workspace,
      model,
      bridgeInput,
      modelRuntimeFactory,
      builtinToolCatalog,
      capabilities,
      childNotifications,
    }) => {
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          owner.storage.crossSessionQueueMail.readChildTerminalCheckpoint(childSessionId),
        ),
      ).not.toBeNull();
      if (sourceAutoRevision) {
        expect(parentCoordinator.getState()).toMatchObject({
          mode: 'auto',
          interactionModeRevision: 1,
        });
        expect(owner.loadCurrentSnapshot(childSessionId)).toMatchObject({
          mode: 'auto',
          interactionModeRevision: 0,
        });
      }
      expect(parentCoordinator.session.getLifecycleProjection().currentRun?.runId).toBe(
        parentRunId,
      );
      const { accepted, raw } = await submitRealParentFollowup(
        {
          owner,
          services,
          coordinators,
          parentCoordinator,
          parentSessionId,
          parentRunId,
          childSessionId,
          orchestrator,
          workspace,
          model,
          bridgeInput,
          modelRuntimeFactory,
          builtinToolCatalog,
          capabilities,
          childNotifications,
        },
        'Resume the completed child.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const targetEventsAfterReceive = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(
        targetEventsAfterReceive.filter((event) => event.type === 'agent.mail_accepted'),
      ).toHaveLength(1);
      if (stopAfterRunStart) {
        const previousCheckpoint = owner.runWithSessionExecution(childSessionId, () =>
          raw.readChildTerminalCheckpoint(childSessionId),
        );
        const previousModelRequests = model.getRequestCount();
        const previousPrepared = targetEventsAfterReceive.filter(
          (event) => event.type === 'model.invocation_prepared',
        ).length;
        expect(orchestrator.startAcceptedFollowup(childSessionId, accepted.submissionId)).toBe(
          true,
        );
        const startedState = owner.loadCurrentSnapshot(childSessionId);
        expect(startedState?.activeFollowupTurn?.submissionId).toBe(accepted.submissionId);
        expect(startedState?.turn.status).toBe('active');
        expect(
          await orchestrator.resumePreparedFollowupFirstModel(
            childSessionId,
            accepted.submissionId,
          ),
        ).toBe(false);
        expect(
          orchestrator.settleTerminalFollowupFunding(childSessionId, accepted.submissionId),
        ).toBe(false);
        expect(
          owner.storage.sessions
            .loadEventsStrict(childSessionId)
            .filter(({ event }) => event.type === 'model.invocation_prepared'),
        ).toHaveLength(previousPrepared);
        expect(
          owner.runWithSessionExecution(childSessionId, () =>
            raw.readChildTerminalCheckpoint(childSessionId),
          )?.ref,
        ).toEqual(previousCheckpoint?.ref);
        expect(
          owner.runWithSessionExecution(childSessionId, () =>
            raw.readFollowupFundingForTarget(
              childSessionId,
              parentSessionId,
              accepted.submissionId!,
            ),
          ),
        ).toBeNull();
        expect(model.getRequestCount()).toBe(previousModelRequests);
        return;
      }
      if (targetDrift) {
        expect(orchestrator.startAcceptedFollowup(childSessionId, accepted.submissionId)).toBe(
          true,
        );
        const childCoordinator = coordinators.get(childSessionId);
        if (!childCoordinator) throw new Error('Active followup target coordinator is missing.');
        owner.runWithSessionExecution(childSessionId, () =>
          childCoordinator.control.processEventBatch(
            targetDrift === 'mode'
              ? [
                  {
                    type: 'interaction_mode.changed',
                    mode: 'full',
                    source: 'user',
                    changedAt: new Date().toISOString(),
                  },
                ]
              : [
                  {
                    type: 'capability.bindings_issued',
                    catalogRevision: `sha256:${'f'.repeat(64)}`,
                    bindings: [],
                    disclosures: [],
                    loadedCapabilities: [],
                  },
                ],
          ),
        );
        if (targetDrift === 'mode')
          expect(owner.loadCurrentSnapshot(childSessionId)?.mode).toBe('full');
        else
          expect(owner.loadCurrentSnapshot(childSessionId)?.capabilities.catalogRevision).toBe(
            `sha256:${'f'.repeat(64)}`,
          );
        expect(
          await orchestrator
            .executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId)
            .catch(() => false),
        ).toBe(false);
        expect(
          owner.runWithSessionExecution(childSessionId, () =>
            raw.readFollowupFundingForTarget(
              childSessionId,
              parentSessionId,
              accepted.submissionId!,
            ),
          ),
        ).toBeNull();
        expect(model.getRequestCount()).toBe(2);
        return;
      }
      let followupResponseServed = false;
      model.setResponses([
        {
          response: async () => {
            followupResponseServed = true;
            return {
              message: { content_chunks: ['FOLLOWUP_CHILD_', 'RESULT'] },
              usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
            };
          },
        },
      ]);
      const executed = await orchestrator
        .executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId)
        .catch((error) => {
          const sourceState = parentCoordinator.getState();
          const targetState = owner.loadCurrentSnapshot(childSessionId);
          const admission = owner.runWithSessionExecution(childSessionId, () =>
            owner.storage.crossSessionQueueMail.readFollowupAdmissionForTarget(
              childSessionId,
              parentSessionId,
              accepted.submissionId!,
            ),
          );
          const payload = admission ? JSON.parse(admission.admission.canonicalJson) : null;
          const causes = [] as string[];
          let current: unknown = error;
          while (current && causes.length < 5) {
            causes.push(String(current));
            current = (current as { cause?: unknown }).cause;
          }
          throw new Error(
            JSON.stringify({
              causes,
              proofInputs: {
                preparedTool: Boolean(payload?.preparedTool),
                context: true,
                storedCall: Boolean(
                  payload?.preparedTool?.toolCallId &&
                    sourceState.tools.calls[payload.preparedTool.toolCallId],
                ),
                pipeline: Boolean(modelRuntimeFactory(workspace).toolPipelineComposition),
              },
              sourcePolicy: {
                mode: sourceState.mode,
                interactionModeRevision: sourceState.interactionModeRevision,
                capabilityDigest: sourceState.capabilities.catalogRevision,
              },
              targetPolicy: targetState
                ? {
                    mode: targetState.mode,
                    interactionModeRevision: targetState.interactionModeRevision,
                    capabilityDigest: targetState.capabilities.catalogRevision,
                  }
                : null,
              sourceEvents: owner.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-10)
                .map(({ event }) => event.type),
              targetEvents: owner.storage.sessions
                .loadEventsStrict(childSessionId)
                .slice(-10)
                .map(({ event }) => event.type),
              targetFailures: owner.storage.sessions
                .loadEventsStrict(childSessionId)
                .map(({ event }) => event)
                .filter(
                  (event) =>
                    event.type === 'run.error' || event.type === 'model.invocation_interrupted',
                ),
              modelRequests: model.getRequestCount(),
              followupResponseServed,
            }),
          );
        });
      expect(executed).toBe(true);
      expect(
        childNotifications
          .filter((notification) => notification.durability === 'ephemeral')
          .map((notification) =>
            notification.event.type === 'model.text_delta' ? notification.event.text : '',
          )
          .join(''),
      ).toContain('FOLLOWUP_CHILD_RESULT');
      expect(
        childNotifications.some(
          (notification) =>
            notification.durability === 'durable' &&
            notification.projection.event?.type === 'model.responded',
        ),
      ).toBe(true);
      const route = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupRoute(childSessionId, accepted.submissionId),
      );
      expect(route?.route).toBe('new_turn');
      const targetState = owner.loadCurrentSnapshot(childSessionId);
      expect(targetState?.terminalOutcome?.status).toBe('completed');
      expect(targetState?.turn.status).toBe('completed');
      expect(parentCoordinator.session.getLifecycleProjection().currentRun?.runId).toBe(
        parentRunId,
      );
      if (!process.env.KITE_D3_SIGKILL_MOCK_URL) expect(model.getRequestCount()).toBe(3);
      const targetEvents = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(targetEvents.filter((event) => event.type === 'agent.mail_accepted')).toHaveLength(1);
      expect(
        targetEvents.filter((event) => event.type === 'agent.mail_input_prepared'),
      ).toHaveLength(1);
      expect(
        targetEvents.filter((event) => event.type === 'model.invocation_attempt_started'),
      ).toHaveLength(2);
      expect(
        targetEvents.filter((event) => event.type === 'agent.followup_turn_settled'),
      ).toHaveLength(1);
      expect(JSON.stringify(targetEvents)).not.toContain('Resume the completed child.');
      const checkpoint = owner.runWithSessionExecution(childSessionId, () =>
        raw.readChildTerminalCheckpoint(childSessionId),
      );
      expect(checkpoint).not.toBeNull();
      expect(checkpoint && JSON.parse(checkpoint.canonicalJson).terminalRunId).toBe(
        targetState?.turn.turnId,
      );
      const sourceTerminal = owner.runWithSessionExecution(parentSessionId, () =>
        raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId!),
      );
      expect(sourceTerminal?.disposition).toBe('completed');
      expect(
        await orchestrator.executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId),
      ).toBe(false);
      if (!process.env.KITE_D3_SIGKILL_MOCK_URL) expect(model.getRequestCount()).toBe(3);
    },
    sourceAutoRevision,
  );
}

test(
  'completed child permits a real parent Model Surface for a followup Tool attempt',
  () => exerciseRealFollowup(false),
  30_000,
);

test(
  'fresh followup Run cannot settle from the old completed Model before preparation',
  () => exerciseRealFollowup(true),
  30_000,
);

test(
  'source auto revision 1 funds child auto revision 0 with an independent fresh grant',
  () => exerciseRealFollowup(false, true),
  30_000,
);

test(
  'target mode drift after its fresh grant blocks source replacement and Provider dispatch',
  () => exerciseRealFollowup(false, true, 'mode'),
  30_000,
);

test(
  'target catalog drift after its fresh grant blocks source replacement and Provider dispatch',
  () => exerciseRealFollowup(false, true, 'catalog'),
  30_000,
);
