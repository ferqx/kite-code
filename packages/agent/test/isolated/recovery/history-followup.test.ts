import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

for (const mode of [
  'cancelled',
  'unknown',
  'unknown_missing_model',
  'completion_decision',
] as const)
  test(`explicit interrupt ${mode} history preserves the original boundary once and rolls back with recovery`, async () => {
    const dataRoot = mkdtempSync('/private/tmp/kite-recovery-history-');
    let store = await openSqliteStore({ dataRoot, profile: 'owned' });
    const db = new Database(join(dataRoot, 'owned/core.db'));
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: `file://${dataRoot}`,
        name: 'w',
      });
      await store.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 's',
        subjectId: 'owner',
      });
      await store.acceptCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Original' },
      });
      const owner = (await store.acquireSessionOwner('s', 'old'))!;
      const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId: 'work',
        configuration: {},
      });
      const modelInput = { messages: [], modelId: 'fixed' };
      await store.planExecution({
        expectedStoreId,
        owner,
        executionId: 'original-model',
        sessionId: 's',
        runId: run.id,
        originCommandId: 'work',
        stepId: 'step',
        callId: 'model',
        kind: 'model',
        definitionId: 'fixed',
        definitionVersion: '1',
        input: modelInput,
        decisionSource: { kind: 'fixed' },
      });
      await store.markDispatching({
        expectedStoreId,
        owner,
        executionId: 'original-model',
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest(modelInput),
        },
        requirements: [],
        freshness: { checked: true, source: { kind: 'fixed' } },
      });
      const toolCalls = [
        { id: 'original-call', name: 'fixture.effect', arguments: '{"original":true}' },
      ];
      await store.finishExecution({
        expectedStoreId,
        owner,
        executionId: 'original-model',
        status: 'succeeded',
        result: { content: '', toolCalls, finishReason: 'tool_calls' },
        message: { role: 'assistant', content: '', toolCalls, sourceIds: ['original-model'] },
      });
      const source: Json =
        mode === 'completion_decision'
          ? { kind: 'completion_decision' }
          : {
              kind: 'model_decision',
              modelExecutionId:
                mode === 'unknown_missing_model' ? 'unregistered-original-model' : 'original-model',
            };
      await store.planExecution({
        expectedStoreId,
        owner,
        executionId: 'original-tool',
        sessionId: 's',
        runId: run.id,
        originCommandId: 'work',
        stepId: 'step',
        callId: 'original-call',
        kind: 'tool',
        definitionId: 'fixture.effect',
        definitionVersion: '1',
        input: { original: true },
        decisionSource: source,
      });
      if (mode.startsWith('unknown'))
        await store.markDispatching({
          expectedStoreId,
          owner,
          executionId: 'original-tool',
          authorization: {
            allowed: true,
            revision: '1',
            definitionVersion: '1',
            inputDigest: await semanticDigest({ original: true }),
          },
          requirements: [],
          freshness: { checked: true, source },
        });
      await store.close();
      store = await openSqliteStore({ dataRoot, profile: 'owned' });
      const recovery = {
        expectedStoreId,
        commandId: 'interrupt',
        sessionId: 's',
        subjectId: 'owner',
        expectedOwnerGeneration: owner.generation,
        decision: 'interrupt' as const,
      };
      const observations = await store.readRecoveryToolHistory(recovery);
      if (mode === 'cancelled') {
        const proofs = observations.map(({ executionId, bindingDigest }) => ({
          executionId,
          bindingDigest,
        }));
        db.run("UPDATE execution SET result_revision=1 WHERE id='original-tool'");
        let drift: unknown;
        try {
          await store.recoverSession({ ...recovery, toolHistoryProofs: proofs });
        } catch (error) {
          drift = error;
        }
        expect((drift as { code?: string }).code).toBe('recovery_tool_history_changed');
        expect(await store.getCommand('interrupt')).toBeNull();
        expect(
          (await store.listMessages('s')).filter((message) => message.role === 'tool'),
        ).toHaveLength(0);
        db.run("UPDATE execution SET result_revision=0 WHERE id='original-tool'");
      } else expect(observations).toEqual([]);
      const before = (await store.getMetadata()).lastChangeCursor;
      db.exec(
        "CREATE TRIGGER fail_history_recovery BEFORE INSERT ON change_event WHEN NEW.type='session.recovered' BEGIN SELECT RAISE(ABORT,'history rollback'); END",
      );
      let fault: unknown;
      try {
        await store.recoverSession(recovery);
      } catch (error) {
        fault = error;
      }
      expect(String(fault)).toContain('history rollback');
      expect((await store.getMetadata()).lastChangeCursor).toBe(before);
      expect((await store.getExecution('original-tool'))?.status).toBe(
        mode.startsWith('unknown') ? 'dispatching' : 'planned',
      );
      expect(
        (await store.listMessages('s')).filter((message) => message.role === 'tool'),
      ).toHaveLength(0);
      db.exec('DROP TRIGGER fail_history_recovery');
      const report = await store.recoverSession(recovery);
      expect(report.unknownExecutionIds).toEqual(
        mode.startsWith('unknown') ? ['original-tool'] : [],
      );
      expect(report.cancelledExecutionIds).toEqual(
        mode.startsWith('unknown') ? [] : ['original-tool'],
      );
      const messages = await store.listMessages('s');
      const terminal = messages.filter((message) => message.role === 'tool');
      if (mode.startsWith('unknown')) {
        expect(terminal).toHaveLength(0);
      } else if (mode === 'completion_decision') {
        expect(terminal).toHaveLength(0);
        const lowTrust = messages.find((message) => message.sourceIds?.includes('original-tool'))!;
        expect(lowTrust.role).toBe('user');
        expect(lowTrust.toolCallId).toBeUndefined();
        expect(lowTrust.content).toContain('<execution_result trust="untrusted"');
      } else {
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          sessionId: 's',
          runId: run.id,
          toolCallId: 'original-call',
          sourceIds: ['original-tool'],
        });
        expect(terminal[0]!.content).toContain('recovery_cancelled_unstarted');
      }
      const committed = (await store.getMetadata()).lastChangeCursor;
      expect(await store.recoverSession(recovery)).toEqual(report);
      expect((await store.getMetadata()).lastChangeCursor).toBe(committed);
      expect(await store.listMessages('s')).toEqual(messages);
      if (mode.startsWith('unknown')) {
        let blocked: unknown;
        try {
          await store.acquireSessionOwner('s', 'next');
        } catch (error) {
          blocked = error;
        }
        expect((blocked as { code?: string }).code).toBe('recovery_required');
        expect((await store.getExecution('original-tool'))?.status).toBe('outcome_unknown');
        let modelCalls = 0,
          permissionCalls = 0;
        const runtime = createRuntime({
          store,
          model: {
            stream() {
              modelCalls++;
              throw Error('unknown must not reach Provider');
            },
          },
          permissions: {
            async authorize() {
              permissionCalls++;
              return { allowed: true, revision: '1' };
            },
          },
        });
        try {
          await runtime.submitCommand({
            expectedStoreId,
            commandId: 'next',
            sessionId: 's',
            subjectId: 'owner',
            request: { kind: 'run.start', content: 'New explicit input cannot replay unknown' },
          });
          let error: unknown;
          try {
            await runtime.waitForCommand('next', { timeoutMs: 1000 });
          } catch (caught) {
            error = caught;
          }
          expect((error as { code?: string }).code).toBe('recovery_required');
          expect(modelCalls).toBe(0);
          expect(permissionCalls).toBe(0);
          expect((await store.getCommand('next'))?.status).toBe('accepted');
          expect(
            (await store.listExecutions('s')).filter(
              (execution) => execution.originCommandId === 'next',
            ),
          ).toEqual([]);
          expect((await store.getExecution('original-tool'))?.status).toBe('outcome_unknown');
        } finally {
          await runtime.close();
        }
      }
    } finally {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

test('runless Action Job and its ordinary Tool do not fabricate assistant tool-call history', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-recovery-runless-history-');
  let store = await openSqliteStore({ dataRoot, profile: 'owned' });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${dataRoot}`,
      name: 'w',
    });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 's',
      subjectId: 'owner',
    });
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'action',
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'work',
        definitionVersion: '1',
        input: {},
      },
    });
    const owner = (await store.acquireSessionOwner('s', 'old'))!;
    const source = {
      kind: 'action_decision',
      commandId: 'action',
      extensionId: 'fixture',
      actionId: 'work',
      definitionVersion: '1',
      preparedDigest: await semanticDigest({}),
    };
    await store.planAction({
      expectedStoreId,
      owner,
      commandId: 'action',
      executionId: 'action-job',
      extensionId: 'fixture',
      definitionId: 'fixture/work',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await store.markDispatching({
      expectedStoreId,
      owner,
      executionId: 'action-job',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    const ref = await store.ensureOperation({
      expectedStoreId,
      owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'action',
      parentExecutionId: 'action-job',
      operationKey: 'child',
      request: { kind: 'tool', definitionId: 'fixture/tool', definitionVersion: '1', input: {} },
    });
    await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'runless-tool',
      sessionId: 's',
      runId: null,
      originCommandId: ref.commandId,
      parentExecutionId: 'action-job',
      stepId: 'step',
      callId: ref.commandId,
      kind: 'tool',
      definitionId: 'fixture/tool',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'model-work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Unstarted Model' },
    });
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'model-work',
      configuration: {},
    });
    await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'planned-model',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'model-work',
      stepId: 'model-step',
      callId: 'planned-model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: { kind: 'fixed' },
    });
    await store.close();
    store = await openSqliteStore({ dataRoot, profile: 'owned' });
    const input = {
      expectedStoreId,
      commandId: 'interrupt',
      sessionId: 's',
      subjectId: 'owner',
      expectedOwnerGeneration: owner.generation,
      decision: 'interrupt' as const,
    };
    expect(await store.readRecoveryToolHistory(input)).toEqual([]);
    const report = await store.recoverSession(input);
    expect(report.unknownExecutionIds).toEqual(['action-job']);
    expect(report.cancelledExecutionIds).toEqual(['runless-tool']);
    expect(report.settledExecutionIds).toEqual(['planned-model']);
    expect((await store.listMessages('s')).map((message) => message.role)).toEqual(['user']);
    expect((await store.getExecution('runless-tool'))?.runId).toBeNull();
  } finally {
    await store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
