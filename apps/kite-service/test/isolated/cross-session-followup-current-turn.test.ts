import { expect, test } from 'bun:test';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

async function exerciseCurrentTurn(sourceAutoRevision: boolean): Promise<void> {
  await exerciseChildOrchestration(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    undefined,
    sourceAutoRevision,
    undefined,
    undefined,
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
      const initial = owner.loadCurrentSnapshot(childSessionId);
      expect(initial?.turn.status).toBe('active');
      expect(initial?.childSessionOrigin?.terminal).toBeUndefined();
      const oldRunId = initial?.turn.turnId;
      expect(oldRunId).toBeTruthy();
      if (!oldRunId) throw new Error('The acknowledged child Run is unavailable.');
      expect(initial?.interactionModeRevision).toBe(0);
      expect(parentCoordinator.getState().interactionModeRevision).toBe(sourceAutoRevision ? 1 : 0);
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Resume the active child before its first model.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      model.setResponses([
        {
          response: async () => ({
            message: { content: 'CURRENT_TURN_CHILD_RESULT' },
            usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
          }),
        },
      ]);
      const beforeRequests = model.getRequestCount();
      const recovery = await orchestrator.recoverPending();
      const events = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      const route = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupRoute(childSessionId, accepted.submissionId),
      );
      const release = owner.runWithSessionExecution(childSessionId, () =>
        raw.readCurrentTurnBackupReleaseForTarget(
          childSessionId,
          parentSessionId,
          accepted.submissionId,
        ),
      );
      expect(route?.route).toBe('current_turn');
      expect(route?.targetRunId).toBe(oldRunId);
      expect(release?.targetRunId).toBe(oldRunId);
      expect(events.filter((event) => event.type === 'agent.mail_input_prepared')).toHaveLength(1);
      expect(model.getRequestCount()).toBe(beforeRequests + 1);
      expect(parentCoordinator.session.getLifecycleProjection().currentRun?.runId).toBe(
        parentRunId,
      );
      expect(owner.loadCurrentSnapshot(childSessionId)?.terminalOutcome?.status).toBe('completed');
      expect(recovery.recoveryRequired).toEqual([]);
    },
    true,
  );
}

test(
  'same mode revision routes an active zero Tool child mail into its first Model',
  () => exerciseCurrentTurn(false),
  30_000,
);

test(
  'independent parent and child mode revisions route with their own sealed policy facts',
  () => exerciseCurrentTurn(true),
  30_000,
);

test('an old child final before delivery routes the frozen mail through a new turn', async () => {
  await exerciseChildOrchestration(
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
      const oldRunId = owner.loadCurrentSnapshot(childSessionId)?.turn.turnId;
      if (!oldRunId) throw new Error('The old child Run is unavailable.');
      const { accepted, raw } = await submitRealParentFollowup(
        fixture,
        'Resume after the old child final wins.',
      );
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readOutbox(parentSessionId, accepted.messageId),
        )?.targetRunId,
      ).toBe(oldRunId);
      model.setResponses([{ response: async () => ({ message: { content: 'OLD_CHILD_FINAL' } }) }]);
      expect((await orchestrator.recoverPending()).recoveryRequired).toEqual([]);
      expect(owner.loadCurrentSnapshot(childSessionId)?.terminalOutcome?.status).toBe('completed');
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      model.setResponses([{ response: async () => ({ message: { content: 'NEW_TURN_FINAL' } }) }]);
      expect(
        await orchestrator.executeAcceptedFollowupFirstModel(childSessionId, accepted.submissionId),
      ).toBe(true);
      const route = owner.runWithSessionExecution(childSessionId, () =>
        raw.readFollowupRoute(childSessionId, accepted.submissionId),
      );
      expect(route?.route).toBe('new_turn');
      expect(route?.targetRunId).not.toBe(oldRunId);
      const targetEvents = owner.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(targetEvents.filter((event) => event.type === 'agent.mail_accepted')).toHaveLength(1);
      expect(
        targetEvents.filter((event) => event.type === 'agent.mail_input_prepared'),
      ).toHaveLength(1);
      expect(
        owner.runWithSessionExecution(parentSessionId, () =>
          raw.readFollowupTerminalForSource(parentSessionId, accepted.submissionId),
        )?.disposition,
      ).toBe('completed');
      expect(parentCoordinator.session.getLifecycleProjection().currentRun?.runId).toBe(
        parentRunId,
      );
      expect(model.getRequestCount()).toBe(3);
    },
    true,
  );
}, 30_000);
