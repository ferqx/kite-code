import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

test('an unsealed permission check stays in the Model directory and the same cursor window after prepare', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-check-directory-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await store.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 's' });
    await store.acceptCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'original task' },
    });
    const owner = (await store.acquireSessionOwner('s', 'host'))!;
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'work',
      configuration: {
        modelId: 'ordinary',
        tools: [{ id: 'fixture.effect', version: '1', extensionId: 'fixture' }],
      },
    });
    const source = {
      kind: 'model_decision',
      sources: [{ id: 'fixture:plan', digest: 'v1', content: 'actual plan' }],
    };
    const plan = {
      expectedStoreId,
      owner,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      definitionVersion: '1',
      decisionSource: source,
    };
    await store.planExecution({
      ...plan,
      executionId: 'target',
      stepId: 'target',
      callId: 'target',
      kind: 'tool',
      definitionId: 'fixture.effect',
      input: { value: 'exact' },
    });
    const check = await store.ensureAuthorizationCheck({
      expectedStoreId,
      owner,
      targetExecutionId: 'target',
      policyRevision: 'p1',
      request: { task: 'exact effect' },
      checker: { id: 'checker', version: '1', modelId: 'check-model' },
    });
    // A subsequent ordinary model must not cause pagination to skip the still-unsealed check.
    await store.planExecution({
      ...plan,
      executionId: 'later-model',
      stepId: 'later',
      callId: 'later',
      kind: 'model',
      definitionId: 'ordinary',
      input: { modelId: 'ordinary', requestId: 'later-model', messages: [], tools: [] },
    });
    const before = await store.listModelInputs({ ...scope, limit: 1 });
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({
      executionId: check.execution.id,
      runId: null,
      status: 'planned',
      confirmation: 'unconfirmed',
    });
    for (const read of [store.getModelInputSnapshot, store.getModelOutputSnapshot]) {
      let rejected: unknown;
      try {
        await read({ ...scope, executionId: check.execution.id });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toMatchObject({ code: 'model_input_unavailable' });
    }
    await store.prepareAuthorizationCheck({
      expectedStoreId,
      owner,
      executionId: check.execution.id,
      input: {
        modelId: 'check-model',
        requestId: check.execution.id,
        messages: [
          {
            role: 'user',
            content: canonicalJson(check.input),
            sourceIds: [check.commandId, check.execution.id],
          },
        ],
        tools: [],
      },
    });
    const after = await store.listModelInputs({ ...scope, upperSeq: before.upperSeq, limit: 1 });
    expect(after.items).toEqual(before.items);
    const next = await store.listModelInputs({
      ...scope,
      upperSeq: before.upperSeq,
      afterSeq: before.nextAfterSeq!,
      limit: 1,
    });
    expect(next.items.map((item) => item.executionId)).toEqual(['later-model']);
    expect(
      (await store.getModelInputSnapshot({ ...scope, executionId: check.execution.id }))
        .authorizationCheck,
    ).toEqual({ sourceIds: [check.commandId, check.execution.id] });
    expect((await store.getView('s')).runs).toHaveLength(1);
    expect((await store.listExecutions('s')).every((item) => item.childSessionId === null)).toBe(
      true,
    );
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
