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
      expect(target.resourceBudget.reconciledUsage.counters.toolInvocations).toBe(14);
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
      model.setResponses([
        { response: async () => ({ message: { content: 'UNREACHABLE_AFTER_LOST_ACK' } }) },
      ]);
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
      await orchestrator.recoverPendingFollowups();
      expect(model.getRequestCount()).toBe(requestsBeforeRecovery);
      expect(owner.loadCurrentSnapshot(childSessionId)?.terminalOutcome?.status).toBe('unknown');
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        ),
      ).toMatchObject({ disposition: 'unknown' });
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.listPendingTerminalReplies(childSessionId, 8),
        ),
      ).toEqual([]);
    },
  );
}, 30_000);
