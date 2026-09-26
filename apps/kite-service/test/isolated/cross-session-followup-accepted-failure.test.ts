import { expect, test } from 'bun:test';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

test('accepted followup with changed source authority releases its backup before target dispatch', async () => {
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
        parentCoordinator,
        parentSessionId,
        parentRunId,
        childSessionId,
        orchestrator,
        model,
      } = fixture;
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Do not dispatch after source authority changes.',
      );
      owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.control.processEventBatch([
          {
            type: 'interaction_mode.changed',
            mode: 'full',
            source: 'user',
            changedAt: new Date().toISOString(),
          },
        ]),
      );
      const requestsBeforeRecovery = model.getRequestCount();
      expect(parentCoordinator.getState().mode).toBe('full');
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.listPendingFollowupFunding(parentSessionId, 100),
        ),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'accepted' })]));
      const recovery = await orchestrator.recoverPendingFollowups();
      expect(recovery.recoveryRequired).toEqual([]);
      expect(model.getRequestCount()).toBe(requestsBeforeRecovery);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readLastReleasedFollowupForDirectChild(parentSessionId, parentRunId, childSessionId),
        ),
      ).toMatchObject({ submissionId: accepted.submissionId, reason: 'authorization_changed' });
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.readFollowupRoute(childSessionId, accepted.submissionId),
        ),
      ).toBeNull();
    },
  );
}, 30_000);
