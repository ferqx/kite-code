import { expect, test } from 'bun:test';
import { fundingBudgetForRun } from '@kite-ai/runtime-host/kernel-adapter';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

test('followup deadline after first Model preparation prevents Provider dispatch and settles the backup', async () => {
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
        parentCoordinator,
        parentSessionId,
        parentRunId,
        childSessionId,
        orchestrator,
        model,
      } = fixture;
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Do not dispatch the prepared Model after the original deadline.',
        true,
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      const admission = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupAdmissionForTarget(childSessionId, parentSessionId, accepted.submissionId),
      );
      if (!admission) throw new Error('Accepted followup has no immutable deadline.');
      const { deadlineAt, backupReservationId } = JSON.parse(admission.admission.canonicalJson) as {
        deadlineAt: number;
        backupReservationId: string;
      };
      expect(Number.isSafeInteger(deadlineAt)).toBe(true);
      expect(
        fundingBudgetForRun(parentCoordinator.getState(), parentRunId)?.reservations[
          backupReservationId
        ]?.state,
      ).toBe('queued');
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.readFollowupRoute(childSessionId, accepted.submissionId),
        ),
      ).toBeNull();
      const transactions = services.transactions as { commit: typeof services.transactions.commit };
      const originalCommit = transactions.commit;
      const originalNow = Date.now;
      let prepared = false;
      const before = model.getRequestCount();
      transactions.commit = (acknowledgement, transaction, requiredLease) => {
        const result = originalCommit(acknowledgement, transaction, requiredLease);
        if (
          !prepared &&
          transaction.sessionId === childSessionId &&
          transaction.events.some((event) => event.type === 'model.invocation_prepared')
        ) {
          prepared = true;
          Date.now = () => deadlineAt + 1;
        }
        return result;
      };
      try {
        await orchestrator
          .executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId)
          .catch(() => false);
        expect(prepared).toBe(true);
        const recovery = await orchestrator.recoverPendingFollowups();
        expect(recovery.recoveryRequired).toEqual([]);
      } finally {
        transactions.commit = originalCommit;
        Date.now = originalNow;
      }
      const childEvents = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(childEvents.some((event) => event.type === 'model.invocation_prepared')).toBe(true);
      expect(
        childEvents.filter((event) => event.type === 'model.invocation_attempt_started'),
      ).toHaveLength(1);
      expect(model.getRequestCount()).toBe(before);
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.readFollowupRoute(childSessionId, accepted.submissionId),
        ),
      ).toBeNull();
      expect(
        fundingBudgetForRun(parentCoordinator.getState(), parentRunId)?.reservations[
          backupReservationId
        ]?.state,
      ).toBe('released');
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readLastReleasedFollowupForDirectChild(parentSessionId, parentRunId, childSessionId),
        ),
      ).toMatchObject({ submissionId: accepted.submissionId, reason: 'expired' });
    },
  );
}, 30_000);
