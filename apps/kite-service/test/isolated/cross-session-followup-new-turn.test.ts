import { expect, test } from 'bun:test';
import { classifyFailure } from '../../src/bootstrap/runtime/failures';
import { failedTerminalOutcome } from '../../src/bootstrap/runtime/terminal-outcome';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

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
          transaction.crossSessionAgentMailMutation?.kind === 'activate_followup_funding'
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
      const fundingBeforeSettlement = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupFundingForTarget(childSessionId, parentSessionId, accepted.submissionId),
      );
      const route = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupRoute(childSessionId, accepted.submissionId),
      );
      const child = coordinators.get(childSessionId);
      if (!fundingBeforeSettlement || !route || !child)
        throw new Error('Fixture followup is not funded.');
      expect(child.getState().turn.status).toBe('active');
      expect(
        child.getState().modelInvocations[fundingBeforeSettlement.modelInvocationId]?.attempts,
      ).toBe(0);
      const failure = classifyFailure('user_input_cancelled', 'User cancelled before dispatch.');
      owner.runWithSessionExecution(childSessionId, () =>
        child.control.processEventBatch([
          {
            type: 'resource_budget.released',
            reservationId: fundingBeforeSettlement.targetModelReservationId,
            proof: 'local_pre_dispatch_failure',
          },
          { type: 'task.failed', taskId: route.taskId, reason: 'User cancelled before dispatch.' },
          {
            type: 'turn.aborted',
            turnId: route.targetRunId,
            reason: failure.message,
            cause: 'user',
          },
          {
            type: 'run.error',
            turnId: route.targetRunId,
            message: failure.message,
            recoverable: false,
            failure,
            outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'known' }),
          },
        ]),
      );
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

test('committed first Model attempt keeps uncertain followup fail closed without reply', async () => {
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
      const recovery = await orchestrator.recoverPendingFollowups();
      expect(recovery.recoveryRequired).toContainEqual(
        expect.objectContaining({ submissionId: accepted.submissionId }),
      );
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toBeNull();
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.listPendingTerminalReplies(childSessionId, 8),
        ),
      ).toEqual([]);
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
              message: { content: 'FOLLOWUP_CHILD_RESULT' },
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
      expect(model.getRequestCount()).toBe(3);
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
      expect(model.getRequestCount()).toBe(3);
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
