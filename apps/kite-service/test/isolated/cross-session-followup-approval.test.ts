import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { completedTerminalOutcome, decideUnplannedCompletion } from '@kite-ai/agent-kernel';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { submitRealParentFollowup } from './cross-session-followup-pipeline-fixture';

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error('Timed out waiting for child Tool approval.');
}

test('completed parent Run can approve a Tool in an independent child followup turn', async () => {
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
      const approvalProxy = orchestrator.approvalProxy;
      if (!approvalProxy) throw new Error('Child approval proxy is unavailable.');
      orchestrator.bindParentApprovalWake((event) => {
        parentCoordinator.control.processEventBatch([event]);
      });
      const { accepted } = await submitRealParentFollowup(
        fixture,
        'Run the requested shell command, then report the result.',
      );
      expect(
        await orchestrator.receiveAcceptedFollowup(childSessionId, accepted.submissionId),
      ).toBe(true);
      parentCoordinator.control.processEventBatch([
        {
          type: 'task.started',
          taskId: 'parent-followup-task',
          userGoal: 'Delegate followup.',
          turnId: parentRunId,
        },
      ]);
      expect(decideUnplannedCompletion(parentCoordinator.getState())).toMatchObject({
        status: 'accepted',
      });
      expect(parentCoordinator.getState().activeTaskId).toBeTruthy();
      owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.control.processEventBatch([
          {
            type: 'run.completed',
            turnId: parentRunId,
            output: 'Followup accepted.',
            outcome: completedTerminalOutcome(),
          },
          { type: 'turn.completed', turnId: parentRunId },
        ]),
      );
      expect(parentCoordinator.getState().turn.status).toBe('completed');
      model.setResponses([
        {
          response: async () => ({
            message: {
              tool_calls: [
                {
                  id: 'followup-approved-shell',
                  name: 'shell_execute',
                  args: { command: 'echo hello > /outside-workspace/output' },
                },
              ],
            },
            toolContinuation: 'required' as const,
          }),
        },
        {
          response: async () => ({
            message: { content: 'FOLLOWUP_APPROVAL_COMPLETE' },
            expectedRequest: { toolResults: [{ toolCallId: 'followup-approved-shell' }] },
          }),
        },
      ]);
      const executing = orchestrator.executeAcceptedFollowupFirstModel(
        childSessionId,
        accepted.submissionId,
      );
      await until(() => owner.listPendingChildApprovalProxies(parentSessionId, 10).length === 1);
      const proxy = owner.listPendingChildApprovalProxies(parentSessionId, 10)[0]!;
      const parentState = parentCoordinator.getState();
      const interactions = approvalProxy.list(parentState);
      expect(interactions).toHaveLength(1);
      const interaction = interactions[0]!;
      expect(interaction).toMatchObject({
        kind: 'approval',
        owner: { kind: 'subagent_tool', toolCallId: 'followup-approved-shell' },
      });
      const child = owner.loadCurrentSnapshot(childSessionId);
      if (!child?.activeFollowupTurn) throw new Error('Followup Turn is unavailable.');
      expect(child?.activeFollowupTurn?.submissionId).toBe(accepted.submissionId);
      expect(child?.pendingApprovals.size).toBe(1);
      expect(proxy.grantDigest).toBe(child.activeFollowupTurn.grantDigest);
      const receipt = approvalProxy.decide({
        parentState,
        interaction,
        decision: 'approve_once',
        evidence: {
          scopeSessionId: parentSessionId,
          targetSessionId: parentSessionId,
          commandId: 'approve-followup-shell',
          requestDigest: createHash('sha256').update('approve-followup-shell').digest('hex'),
          committedAt: Date.now(),
        },
      });
      expect(receipt.commandId).toBe('approve-followup-shell');
      approvalProxy.publishDecided(proxy.proxyInteractionId);
      approvalProxy.activateDecision(proxy.proxyInteractionId);
      expect(await executing).toBe(true);
      expect(owner.loadCurrentSnapshot(childSessionId)?.turn.status).toBe('completed');
      expect(
        owner.storage.sessions.loadEventsStrict(childSessionId).map(({ event }) => event.type),
      ).toContain('approval.granted');
      expect(approvalProxy.list(parentCoordinator.getState())).toEqual([]);
      expect(owner.readChildApprovalProxy(parentSessionId, proxy.proxyInteractionId)).toMatchObject(
        {
          status: 'applied',
          decision: 'approve_once',
        },
      );
    },
    false,
    undefined,
    undefined,
    undefined,
    false,
    120_000,
    false,
    true,
  );
}, 30_000);
