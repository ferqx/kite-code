import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

async function modelPurposeFixture(title: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-internal-purpose-boundary-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'fixture',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'internal purpose boundary' },
  });
  const owner = (await store.acquireSessionOwner('s', 'purpose-boundary'))!;
  const extensionId = title ? 'builtin.session-title' : 'fixture',
    definitionId = title ? 'builtin.session-title/generate' : 'fixture/parent';
  const base = { expectedStoreId, owner };
  const run = await store.startRun({
    ...base,
    commandId: 'work',
    configuration: { modelId: 'fixed', tools: [{ id: definitionId, version: '1', extensionId }] },
  });
  await store.planExecution({
    ...base,
    executionId: 'parent',
    sessionId: 's',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'parent',
    callId: 'parent',
    kind: 'tool',
    definitionId,
    definitionVersion: '1',
    input: {},
    decisionSource: {},
  });
  await store.markDispatching({
    ...base,
    executionId: 'parent',
    authorization: {
      allowed: true,
      revision: 'parent-policy',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source: {} },
  });
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
  return {
    store,
    db,
    base,
    extensionId,
    async close() {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('internal title models require the exact accepted Model permission and current controls before dispatch', async () => {
  const f = await modelPurposeFixture(true);
  try {
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const refused = async (work: Promise<unknown>, code: string) => {
      let failure: unknown;
      try {
        await work;
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code });
    };
    await refused(
      f.store.ensureOperation({
        ...f.base,
        sessionId: 's',
        extensionId: f.extensionId,
        originCommandId: 'work',
        parentExecutionId: 'parent',
        operationKey: 'forbidden-title-child',
        request: { kind: 'agent', configurationId: 'session-title', input: { content: 'title' } },
        childConfiguration: {
          id: 'session-title',
          version: '1',
          snapshot: { modelId: 'fixed', tools: [] },
        },
        cancellation: 'attached',
      }),
      'internal_model_parent_cannot_create_child',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(await f.store.listSessions()).toHaveLength(1);
    const request = {
      modelId: 'fixed',
      requestId: 'title-model',
      messages: [{ role: 'user', content: 'title' }],
      tools: [],
    };
    const fact = await f.store.ensureInternalModel({
      ...f.base,
      parentExecutionId: 'parent',
      request,
    });
    const authorization = {
      allowed: true,
      revision: 'model-policy',
      definitionVersion: '1',
      inputDigest: await semanticDigest(request),
      controlReads: [{ kind: 'permission.mode' as const, scope: 'user', revision: '0' }],
      snapshot: { namespace: 'fixture.model-permission', version: '1', data: { allowed: true } },
    };
    const watermark = (await f.store.getMetadata()).lastChangeCursor;
    for (const corrupt of [
      { ...authorization, allowed: false },
      { ...authorization, revision: '' },
      { ...authorization, inputDigest: '0'.repeat(64) },
      { ...authorization, definitionVersion: '2' },
      { ...authorization, checkExecutionId: 'unrelated-check' },
      { ...authorization, interactionId: 'unrelated-approval' },
      { ...authorization, grant: { grantId: 'unrelated-grant', revision: '1' } },
    ])
      await refused(
        f.store.dispatchInternalModel({
          ...f.base,
          executionId: fact.execution.id,
          // Deliberately malformed public JSON must be rejected at the Store boundary.
          authorization: corrupt as typeof authorization,
        }),
        'permission_denied',
      );
    await refused(
      f.store.dispatchInternalModel({
        ...f.base,
        executionId: fact.execution.id,
        authorization: {
          ...authorization,
          controlReads: [{ kind: 'permission.mode', scope: 'user', revision: '1' }],
        },
      }),
      'permission_control_changed',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(watermark);
    expect(
      f.db.query('SELECT state,dispatched FROM execution WHERE id=?').get(fact.execution.id),
    ).toEqual({ state: 'planned', dispatched: 0 });
    await f.store.dispatchInternalModel({
      ...f.base,
      executionId: fact.execution.id,
      authorization,
    });
    const saved = f.db
      .query('SELECT dispatch_authorization_json AS authorization FROM execution WHERE id=?')
      .get(fact.execution.id) as { authorization: string };
    expect(JSON.parse(saved.authorization)).toEqual(authorization);
    await f.store.finishInternalModel({
      ...f.base,
      executionId: fact.execution.id,
      status: 'cancelled',
      result: { code: 'test_complete', incomplete: true },
    });
  } finally {
    await f.close();
  }
});

test('an ordinary child whose configuration is named session-title retains the generic lifecycle', async () => {
  const f = await modelPurposeFixture(false);
  try {
    const configuration = {
      id: 'session-title',
      version: '1',
      snapshot: { modelId: 'fixed', tools: [] },
    };
    const input = { content: 'ordinary collaborator' };
    const child = await f.store.ensureOperation({
      ...f.base,
      sessionId: 's',
      extensionId: f.extensionId,
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: 'ordinary-title-shaped-child',
      request: { kind: 'agent', configurationId: configuration.id, input },
      childConfiguration: configuration,
      cancellation: 'attached',
    });
    await f.store.markDispatching({
      ...f.base,
      executionId: child.executionId!,
      authorization: {
        allowed: true,
        revision: 'child-policy',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
      },
      requirements: [],
      freshness: { checked: true, source: {} },
    });
    const activation = await f.store.activateChildRun({
      ...f.base,
      executionId: child.executionId!,
      configuration: configuration.snapshot,
      requirements: [],
      requirementEvaluations: [],
      freshness: { checked: true, source: {} },
    });
    expect(activation.session.id).toBe(child.childSessionId!);
    expect(activation.run.status).toBe('running');
    expect((await f.store.getCommand(child.commandId))!.kind).toBe('operation.agent');
    expect(
      (await f.store.listExecutions('s')).filter((e) => e.childSessionId !== null),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
