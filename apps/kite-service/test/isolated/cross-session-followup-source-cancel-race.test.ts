import { expect, test } from 'bun:test';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import { fundingBudgetForRun } from '@kite-ai/runtime-host/kernel-adapter';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

test('source cancellation before target activation closes an accepted followup without dispatch', async () => {
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
        'Do not continue if the sending Run is cancelled before activation.',
      );
      const queued = Object.values(
        fundingBudgetForRun(parentCoordinator.getState(), parentRunId)?.reservations ?? {},
      ).filter(
        (reservation) => reservation.state === 'queued' && reservation.resourceKind === 'subagent',
      );
      expect(queued).toHaveLength(1);
      const backupId = queued[0]!.reservationId;
      expect(
        fundingBudgetForRun(parentCoordinator.getState(), parentRunId)?.reservations[backupId]
          ?.state,
      ).toBe('queued');
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.readFollowupRoute(childSessionId, accepted.submissionId),
        ),
      ).toBeNull();
      const commandId = 'cancel-followup-source-before-activation';
      const cancellation = owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.commitCancelTurnCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'cancel_turn',
            commandId,
            sessionId: parentSessionId,
            expectedRevision: parentCoordinator.getState().revision,
            turnId: parentRunId,
            runId: parentRunId,
          },
          {
            scopeSessionId: parentSessionId,
            targetSessionId: parentSessionId,
            commandId,
            requestDigest: 'd'.repeat(64),
            committedAt: Date.now(),
          },
        ),
      );
      expect(cancellation.events).toContainEqual(
        expect.objectContaining({ type: 'turn.aborted', cause: 'user' }),
      );
      expect(parentCoordinator.getState().turn.status).toBe('aborted');
      expect(
        fundingBudgetForRun(parentCoordinator.getState(), parentRunId)?.reservations[backupId]
          ?.state,
      ).toBe('released');
      const attemptsBefore = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .filter(({ event }) => event.type === 'model.invocation_attempt_started').length;
      const before = model.getRequestCount();
      const recovery = await orchestrator.recoverPendingFollowups();
      expect(recovery.recoveryRequired).toEqual([]);
      expect(model.getRequestCount()).toBe(before);
      expect(
        owner.storage.sessions
          .loadEventsStrict(childSessionId)
          .filter(({ event }) => event.type === 'model.invocation_attempt_started'),
      ).toHaveLength(attemptsBefore);
      expect(
        owner.runWithSessionExecution(childSessionId, () =>
          raw.readFollowupRoute(childSessionId, accepted.submissionId),
        ),
      ).toBeNull();
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readLastReleasedFollowupForDirectChild(parentSessionId, parentRunId, childSessionId),
        ),
      ).toMatchObject({ submissionId: accepted.submissionId, reason: 'source_cancelled' });
      expect(owner.listUnnotifiedAcceptedFollowupReleases(8)).toEqual([
        { childSessionId, parentSessionId, submissionId: accepted.submissionId },
      ]);
      const notice = owner.runWithSessionExecution(childSessionId, () =>
        raw.acceptAcceptedReleaseNotice(
          childSessionId,
          parentSessionId,
          accepted.submissionId,
          Date.now(),
        ),
      );
      expect(notice.mode).toBe('reply');
      expect(notice.targetRunId).toBeNull();
      expect(owner.listUnnotifiedAcceptedFollowupReleases(8)).toEqual([]);
    },
  );
}, 30_000);
