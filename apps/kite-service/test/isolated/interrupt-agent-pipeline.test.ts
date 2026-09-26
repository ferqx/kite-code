import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exerciseChildOrchestration } from './child-session-orchestrator-integration-fixture';
import { issueInterruptFromParent } from './interrupt-agent-pipeline-fixture';

test('full-policy parent interrupt Tool persists an exact active child stop receipt and target cleanup', async () => {
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
    async (fixture, releaseChildResponse) => {
      const issued = await issueInterruptFromParent(fixture, fixture.childSessionId);
      expect(issued.commandId).toEqual(expect.any(String));
      const intent = fixture.owner.runWithSessionExecution(fixture.parentSessionId, () =>
        fixture.owner.storage.crossSessionQueueMail.readInterruptIntent(
          fixture.parentSessionId,
          issued.commandId!,
        ),
      );
      expect(intent).toMatchObject({
        targetSessionId: fixture.childSessionId,
        targetTaskId: issued.targetTaskId,
        status: 'pending',
      });
      expect(intent?.targetRunId).toEqual(expect.any(String));
      const scheduled = fixture.orchestrator.schedulePendingInterruptRecovery(
        fixture.childSessionId,
      );
      releaseChildResponse();
      const settled = await scheduled.completion;
      expect(settled.recoveryRequired).toEqual([]);
      const final = fixture.owner.runWithSessionExecution(fixture.parentSessionId, () =>
        fixture.owner.storage.crossSessionQueueMail.readInterruptIntent(
          fixture.parentSessionId,
          issued.commandId!,
        ),
      );
      expect(final?.status).toBe('settled');
      expect(
        fixture.owner.storage.runs?.get(fixture.childSessionId, intent!.targetRunId!)?.status,
      ).toBe('cancelled');
      const replay = await fixture.orchestrator.schedulePendingInterruptRecovery(
        fixture.childSessionId,
      ).completion;
      expect(replay).toMatchObject({ processed: 0, recoveryRequired: [] });
    },
  );
}, 30000);

test('full-policy parent interrupt stops an accepted revision-zero queued child before Run creation', async () => {
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
    async (fixture) => {
      const before = fixture.owner.loadCurrentSnapshot(fixture.childSessionId);
      expect(before?.revision).toBe(0);
      expect(fixture.owner.storage.runs?.getActive(fixture.childSessionId)).toBeNull();
      expect(
        fixture.owner.runWithSessionExecution(fixture.parentSessionId, () =>
          fixture.owner.storage.crossSessionQueueMail.readInterruptTarget(
            fixture.parentSessionId,
            fixture.childSessionId,
          ),
        ),
      ).toMatchObject({ status: 'queued' });
      const issued = await issueInterruptFromParent(fixture, fixture.childSessionId);
      expect(issued.commandId).toEqual(expect.any(String));
      const intent = fixture.owner.runWithSessionExecution(fixture.parentSessionId, () =>
        fixture.owner.storage.crossSessionQueueMail.readInterruptIntent(
          fixture.parentSessionId,
          issued.commandId!,
        ),
      );
      expect(intent).toMatchObject({
        status: 'pending',
        targetRunId: null,
        targetOwnerGeneration: null,
        targetRevision: 0,
        queuedIntentEventId: expect.any(String),
      });
      const settled = await fixture.orchestrator.schedulePendingInterruptRecovery(
        fixture.childSessionId,
      ).completion;
      expect(settled.recoveryRequired).toEqual([]);
      const final = fixture.owner.runWithSessionExecution(fixture.parentSessionId, () =>
        fixture.owner.storage.crossSessionQueueMail.readInterruptIntent(
          fixture.parentSessionId,
          issued.commandId!,
        ),
      );
      expect(final?.status).toBe('settled');
      expect(fixture.owner.storage.runs?.getActive(fixture.childSessionId)).toBeNull();
      expect(fixture.owner.loadCurrentSnapshot(fixture.childSessionId)?.revision).toBe(0);
    },
  );
}, 30000);

test('full-policy interrupt of an idle completed child returns without a false stop receipt', async () => {
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
      const before = fixture.owner.storage.sessions
        .loadEventsStrict(fixture.parentSessionId)
        .filter(({ event }) => event.type === 'background_execution.stop_requested').length;
      const issued = await issueInterruptFromParent(fixture, fixture.childSessionId);
      expect(issued.commandId).toBeNull();
      expect(issued.targetTaskId).toBeNull();
      expect(
        fixture.owner.storage.sessions
          .loadEventsStrict(fixture.parentSessionId)
          .filter(({ event }) => event.type === 'background_execution.stop_requested'),
      ).toHaveLength(before);
      expect(
        fixture.owner.loadCurrentSnapshot(fixture.childSessionId)?.childSessionOrigin?.terminal,
      ).toMatchObject({ status: 'completed' });
    },
  );
}, 30000);

if (process.env.KITE_INTERRUPT_SIGKILL_SEED === '1')
  test('interrupt queued SIGKILL seed', async () => {
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
      async (fixture) => {
        const issued = await issueInterruptFromParent(fixture, fixture.childSessionId);
        if (!issued.commandId) throw new Error('Queued interrupt source receipt is absent.');
        const row = fixture.owner.runWithSessionExecution(fixture.parentSessionId, () =>
          fixture.owner.storage.crossSessionQueueMail.readInterruptIntent(
            fixture.parentSessionId,
            issued.commandId!,
          ),
        );
        if (row?.status !== 'pending' || row.targetRunId !== null)
          throw new Error('Queued interrupt crash marker lacks exact pending receipt.');
        const home = process.env.KITE_D3_SIGKILL_HOME;
        if (!home) throw new Error('Synthetic SIGKILL home is absent.');
        writeFileSync(join(home, 'interrupt-receipt.marker'), 'queued-receipt');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
        throw new Error('Queued interrupt seed was not SIGKILLed.');
      },
      undefined,
      false,
      10_000,
    );
  }, 30000);
