import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

test('independent followup completes more than twelve role-authorized Tool rounds', async () => {
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
      const { owner, parentSessionId, childSessionId, orchestrator, model, workspace } = fixture;
      writeFileSync(join(workspace, 'followup-input.txt'), 'FOLLOWUP_READ_CONTENT');
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Read the workspace input in fourteen separate steps, then summarize it.',
      );
      const sourceAtAdmission = owner.loadCurrentSnapshot(parentSessionId);
      if (sourceAtAdmission?.resourceBudget.status !== 'active')
        throw new Error('Source funding budget is unavailable.');
      const backup = Object.values(sourceAtAdmission.resourceBudget.reservations).find(
        (reservation) => reservation.invocationId === accepted.submissionId,
      );
      expect(backup?.executableUpperBound.durationOnlyChildRun).toBe(true);
      expect(Object.values(backup!.executableUpperBound.counters)).toEqual(Array(6).fill(0));
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      model.setResponses([
        ...Array.from({ length: 14 }, (_, index) => ({
          response: async () => ({
            message: {
              tool_calls: [
                {
                  id: `followup-read-${index + 1}`,
                  name: 'read_file',
                  args: { path: 'followup-input.txt' },
                },
              ],
            },
            toolContinuation: 'required' as const,
            ...(index === 0
              ? {}
              : { expectedRequest: { toolResults: [{ toolCallId: `followup-read-${index}` }] } }),
          }),
        })),
        {
          response: async () => ({
            message: { content: 'FOURTEEN_READS_COMPLETE' },
            expectedRequest: { toolResults: [{ toolCallId: 'followup-read-14' }] },
          }),
        },
      ]);
      const executed = await orchestrator.executeAcceptedFollowupFirstModel(
        childSessionId,
        accepted.submissionId,
      );
      if (!executed) {
        const snapshot = owner.loadCurrentSnapshot(childSessionId);
        const details = {
          turn: snapshot?.turn.status,
          outcome: snapshot?.terminalOutcome?.status,
          modelRequests: model.getRequestCount(),
          events: owner.storage.sessions
            .loadEventsStrict(childSessionId)
            .slice(-20)
            .map(({ event }) => event.type),
          tools: snapshot
            ? Object.values(snapshot.tools.calls).map((tool) => ({
                status: tool.status,
                name: tool.name,
              }))
            : [],
          usage:
            snapshot?.resourceBudget.status === 'active'
              ? snapshot.resourceBudget.reconciledUsage.counters
              : null,
        };
        model.setResponses([]);
        throw new Error(JSON.stringify(details));
      }
      const target = owner.loadCurrentSnapshot(childSessionId);
      expect(target?.turn.status).toBe('completed');
      expect(target?.terminalOutcome?.status).toBe('completed');
      expect(target?.resourceBudget.status).toBe('active');
      if (target?.resourceBudget.status !== 'active') throw new Error('Missing child budget.');
      expect(
        Date.parse(target.resourceBudget.deadlineAt) - Date.parse(target.resourceBudget.startedAt),
      ).toBe(30 * 60_000);
      expect(target.resourceBudget.budget.unboundedToolInvocations).toBe(true);
      expect(target.resourceBudget.budget.durationOnlyChildRun).toBe(true);
      expect(target.resourceBudget.reconciledUsage.counters.modelRequests).toBeGreaterThan(12);
      expect(target.resourceBudget.reconciledUsage.counters.toolInvocations).toBe(14);
      const settledSource = owner.loadCurrentSnapshot(parentSessionId);
      if (settledSource?.resourceBudget.status !== 'active')
        throw new Error('Settled source budget is unavailable.');
      const settledBackup = settledSource.resourceBudget.reservations[backup!.reservationId];
      expect(settledBackup?.state).toBe('reconciled');
      expect(Object.values(settledBackup!.actual!.counters)).toEqual(Array(6).fill(0));
      expect(settledBackup?.actual?.gauges.activeSubagents).toBe(0);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'completed' });
      expect(
        owner.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'agent.followup_independent_settled'),
      ).toHaveLength(1);
      for (let ordinal = 2; ordinal <= 4; ordinal++) {
        const next = await submitRealParentFollowup(
          fixture,
          `Continue in independent Run ${ordinal}.`,
          false,
          `followup-tool-${ordinal}`,
        );
        expect(
          await orchestrator.receiveAcceptedFollowup(childSessionId, next.accepted.submissionId),
        ).toBe(true);
        model.setResponses([
          { response: async () => ({ message: { content: `RUN_${ordinal}_COMPLETE` } }) },
        ]);
        expect(
          await orchestrator.executeAcceptedFollowupFirstModel(
            childSessionId,
            next.accepted.submissionId,
          ),
        ).toBe(true);
      }
      expect(
        owner.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'agent.followup_independent_settled'),
      ).toHaveLength(4);
    },
  );
}, 30_000);

test('independent followup starts from durable child state when the terminal checkpoint is absent', async () => {
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
      const { owner, childSessionId, parentSessionId, orchestrator, model, bridgeInput } = fixture;
      const database = new Database(bridgeInput.checkpointPath);
      try {
        database
          .query(`UPDATE agent_nodes SET status='context_unavailable',
          latest_checkpoint_artifact_id=NULL,latest_checkpoint_integrity_identifier=NULL,
          latest_checkpoint_byte_length=NULL WHERE session_id=? AND agent_id=session_id`)
          .run(childSessionId);
      } finally {
        database.close();
      }
      const target = owner.runWithSessionExecution(parentSessionId, () =>
        owner.storage.crossSessionQueueMail.readFollowupTarget(parentSessionId, childSessionId),
      );
      expect(target?.checkpointReady).toBe(true);
      const { accepted } = await submitRealParentFollowup(
        fixture,
        'Continue from the durable transcript.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      model.setResponses([{ response: async () => ({ message: { content: 'CONTINUED' } }) }]);
      expect(
        await orchestrator.executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId),
      ).toBe(true);
      const continued = owner.loadCurrentSnapshot(childSessionId);
      expect(continued?.activeFollowupTurn).toBeUndefined();
      expect(continued?.turn.status).toBe('completed');
      expect(continued?.transcript.final).toBe('CONTINUED');
    },
  );
}, 30_000);

test('uncertain independent followup Model attempt settles unknown without replay', async () => {
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
        'Do not repeat an uncertain Model attempt.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const transactions = services.transactions as { commit: typeof services.transactions.commit };
      const originalCommit = transactions.commit;
      let lostAck = false;
      transactions.commit = (acknowledgement, transaction, requiredLease) => {
        const result = originalCommit(acknowledgement, transaction, requiredLease);
        if (
          !lostAck &&
          transaction.sessionId === childSessionId &&
          transaction.events.some((event) => event.type === 'model.invocation_attempt_started')
        ) {
          lostAck = true;
          throw new Error('Committed Model attempt ACK was lost.');
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
      expect(lostAck).toBe(true);
      const requestsBeforeRecovery = model.getRequestCount();
      const recovery = await orchestrator.recoverPendingFollowups();
      expect(recovery.recoveryRequired).toEqual([]);
      expect(model.getRequestCount()).toBe(requestsBeforeRecovery);
      expect(owner.loadCurrentSnapshot(childSessionId)?.terminalOutcome?.status).toBe('unknown');
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'unknown' });
      const sourceAfterUnknown = owner.loadCurrentSnapshot(parentSessionId);
      if (sourceAfterUnknown?.resourceBudget.status !== 'active')
        throw new Error('Unknown source funding budget is unavailable.');
      const unknownBackup = Object.values(sourceAfterUnknown.resourceBudget.reservations).find(
        (reservation) => reservation.invocationId === accepted.submissionId,
      );
      expect(unknownBackup?.state).toBe('reconciled');
      expect(unknownBackup?.actual?.gauges.activeSubagents).toBe(0);
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.listPendingTerminalReplies(childSessionId, 8),
        ),
      ).toEqual([
        expect.objectContaining({ mode: 'reply', sourceEffectAttemptId: accepted.submissionId }),
      ]);
      const next = await submitRealParentFollowup(
        fixture,
        'Inspect the unknown previous result, then continue in a new Run.',
        false,
        'followup-tool-after-unknown',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, next.accepted.submissionId),
      ).toBe(true);
      model.setResponses([
        {
          response: async ({ messages }: { messages: readonly unknown[] }) => {
            expect(JSON.stringify(messages)).toContain('unknown external-call result');
            return { message: { content: 'OBSERVED_UNKNOWN_AND_CONTINUED' } };
          },
        },
      ]);
      expect(
        await orchestrator.executeAcceptedFollowupFirstModel(
          childSessionId,
          next.accepted.submissionId,
        ),
      ).toBe(true);
      expect(owner.loadCurrentSnapshot(childSessionId)?.transcript.final).toBe(
        'OBSERVED_UNKNOWN_AND_CONTINUED',
      );
    },
  );
}, 30_000);
