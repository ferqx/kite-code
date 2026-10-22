import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime, type ModelInputSnapshot } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';
import { authorizationReviewContextSession } from '../../../src/storage/sqlite/authorization-review';
import type { SqliteOperations } from '../../../src/storage/sqlite/operations';

// Frozen profiles were produced by the genuine pre-migration Runtime, not by the
// new producer. They retain old child runs, private provider continuation and
// inline / artifact Model bodies, so read compatibility remains independently tested.
function unpack(shape: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-legacy-authorization-')));
  const files = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(`./fixtures/legacy-authorization-review-${shape}.json.gz`, import.meta.url),
      ),
    ).toString(),
  ) as Record<string, string>;
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(bytes, 'base64'), { mode: 0o600 });
    if (name.includes('/blobs/')) chmodSync(path, 0o400);
  }
  return { root, profile: { dataRoot: join(root, 'data'), profile: 'owned' } };
}
const marker = 'PRIVATE_ENCRYPTED_REVIEW_CONTINUATION';
for (const shape of ['inline', 'artifact-private', 'artifact-semantic'])
  test(`legacy ${shape} review child history strips private continuation on cold inspection without replay`, async () => {
    const { root, profile } = unpack(shape);
    const saved = JSON.parse(readFileSync(join(root, 'snapshots.json'), 'utf8')) as {
      inspected: ModelInputSnapshot[];
      expectedStoreId: string;
    };
    const store = await openSqliteStore({ ...profile, mode: 'readonly' });
    const noModel = createFixedModel([]);
    let runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: noModel,
      permissions: {
        async authorize() {
          throw new Error('Historical read may not authorize');
        },
      },
    });
    try {
      const before = (await store.getMetadata()).lastChangeCursor;
      for (const expected of saved.inspected) {
        const scope = {
          expectedStoreId: saved.expectedStoreId,
          sessionId: expected.sessionId,
          executionId: expected.executionId,
          subjectId: 'owner',
        };
        const actual = await runtime.readModelInput(scope);
        expect(actual.request).toEqual(expected.request);
        expect(actual.bodyHash).toBe(expected.bodyHash);
        expect(actual.bodyBytes).toBe(expected.bodyBytes);
        expect(JSON.stringify(actual)).not.toContain(marker);
        expect(JSON.stringify(await runtime.listMessages(scope.sessionId))).not.toContain(marker);
        expect(JSON.stringify((await runtime.getView(scope.sessionId)).runs)).not.toContain(marker);
        expect(JSON.stringify(await runtime.getRun(expected.runId!))).not.toContain(marker);
      }
      expect((await store.getMetadata()).lastChangeCursor).toBe(before);
      expect(noModel.requests).toHaveLength(0);
      if (shape === 'artifact-private') {
        await runtime.close();
        const backup = await createProfileBackup({
          profile,
          destinationRoot: join(root, 'backup'),
        });
        const restored = await restoreProfileBackup({
          profile,
          expectedStoreId: saved.expectedStoreId,
          backup,
          intent: 'replace_with_selected_backup',
        });
        expect(restored.storeId).not.toBe(saved.expectedStoreId);
        const restoredStore = await openSqliteStore({ ...profile, mode: 'readonly' });
        runtime = createRuntime({
          store: restoredStore,
          artifacts: createArtifactStore({ profile, store: restoredStore }),
          model: noModel,
          permissions: {
            async authorize() {
              throw new Error('Historical read may not authorize');
            },
          },
        });
        for (const expected of saved.inspected) {
          const actual = await runtime.readModelInput({
            expectedStoreId: restored.storeId,
            sessionId: expected.sessionId,
            executionId: expected.executionId,
            subjectId: 'owner',
          });
          expect(actual.request).toEqual(expected.request);
          expect(actual.bodyHash).toBe(expected.bodyHash);
          expect(JSON.stringify(actual)).not.toContain(marker);
        }
        expect(noModel.requests).toHaveLength(0);
      }
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const mutation of [
  'extra_review_run',
  'extra_review_message',
  'extra_review_command',
  'review_selector',
  'extra_review_part',
  'review_part_content',
  'review_descendant',
  'unknown_reviewer',
  'cancel_target',
] as const)
  test(`legacy child review proof refuses ${mutation} history drift without replay`, async () => {
    const { root, profile } = unpack('guarded');
    const saved = JSON.parse(readFileSync(join(root, 'proof.json'), 'utf8'));
    const store = await openSqliteStore({ ...profile, mode: 'readonly' });
    const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    const proof = {
      expectedStoreId: saved.base.expectedStoreId,
      targetExecutionId: saved.target.id,
      reviewExecutionId: saved.carrier.id,
      policyRevision: 'p1',
      request: { task: 'guarded' },
      requireApproval: true,
      reviewer: { id: 'reviewer', version: '1', modelId: 'review-model' },
    };
    const child = saved.carrier.childSessionId;
    // The legacy context exemption is narrower than its decision fact: extra
    // messages / parts / descendants must remove the guarded action exemption.
    const contextDb = {
      row(sql: string, ...args: (string | number | bigint | null)[]) {
        const statement = db.query(sql);
        (
          statement as typeof statement & { safeIntegers(value: boolean): typeof statement }
        ).safeIntegers(true);
        return statement.get(...args);
      },
      rows(sql: string, ...args: (string | number | bigint | null)[]) {
        const statement = db.query(sql);
        (
          statement as typeof statement & { safeIntegers(value: boolean): typeof statement }
        ).safeIntegers(true);
        return statement.all(...args);
      },
      metadata() {
        return { storeId: saved.base.expectedStoreId };
      },
    } as unknown as SqliteOperations;
    const context = () =>
      authorizationReviewContextSession(
        contextDb,
        contextDb.row('SELECT * FROM execution WHERE id=?', saved.carrier.id)!,
      );

    const clone = (table: string, id: string, changes: Record<string, unknown>) => {
      const row = {
        ...(db.query(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown>),
        ...changes,
      };
      const keys = Object.keys(row);
      db.query(
        `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      ).run(...(keys.map((k) => row[k]) as never[]));
    };
    try {
      expect((await store.getAuthorizationReview(proof)).decision).toBe('approve_once');
      expect(context()).toBe(child);
      if (mutation === 'extra_review_run') {
        const run = (await store.getView(child)).runs[0]!;
        clone('command', run.originCommandId, { id: 'extra-review-origin', seq: 999 });
        clone('run', run.id, { id: 'extra-review-run', origin_command_id: 'extra-review-origin' });
      }
      if (mutation === 'extra_review_message') {
        const message = db
          .query('SELECT id FROM message WHERE session_id=? ORDER BY seq LIMIT 1')
          .get(child) as { id: string };
        clone('message', message.id, { id: 'extra-review-message', seq: 999 });
      }
      if (mutation === 'extra_review_command')
        clone('command', `child-create-${saved.carrier.id}`, {
          id: 'extra-review-command',
          seq: 999,
        });
      if (mutation === 'review_selector')
        db.run("UPDATE session SET context_selection_id='extra-review-selector' WHERE id=?", [
          child,
        ]);
      if (mutation === 'extra_review_part')
        db.run(
          'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) SELECT message_id,1,kind,content_version,revision,json FROM message_part WHERE message_id=(SELECT id FROM message WHERE session_id=? ORDER BY seq LIMIT 1)',
          [child],
        );
      if (mutation === 'review_part_content')
        db.run(
          "UPDATE message_part SET json='{}',revision=revision+1 WHERE message_id IN (SELECT id FROM message WHERE session_id=?)",
          [child],
        );
      if (mutation === 'review_descendant')
        clone('session', child, { id: 'extra-review-descendant', parent_id: child });
      if (mutation === 'unknown_reviewer')
        db.run("UPDATE execution SET state='outcome_unknown' WHERE id=?", [saved.carrier.id]);
      if (mutation === 'cancel_target')
        db.run('UPDATE execution SET cancel_requested=1 WHERE id=?', [saved.target.id]);
      let refused = false;
      try {
        refused = (await store.getAuthorizationReview(proof)).decision !== 'approve_once';
      } catch {
        refused = true;
      }
      if (
        [
          'extra_review_message',
          'extra_review_command',
          'review_selector',
          'extra_review_part',
          'review_part_content',
          'review_descendant',
        ].includes(mutation)
      )
        expect(context()).toBeNull();
      else expect(refused).toBe(true);
      expect((await store.getExecution(saved.target.id))!.authorization!.dispatched).toBe(false);
    } finally {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const shape of ['artifact-private', 'artifact-semantic'])
  test(`legacy ${shape} read refuses a corrupt original body receipt`, async () => {
    const { root, profile } = unpack(shape);
    const saved = JSON.parse(readFileSync(join(root, 'snapshots.json'), 'utf8'));
    const store = await openSqliteStore({ ...profile, mode: 'readonly' });
    const noModel = createFixedModel([]);
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: noModel,
      permissions: {
        async authorize() {
          throw new Error('Historical read may not authorize');
        },
      },
    });
    const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    try {
      const expected = saved.inspected[0];
      const execution = (await store.getExecution(expected.executionId))!;
      db.run('UPDATE execution SET result_json=? WHERE id=?', [
        canonicalJson({
          ...(execution.result as Record<string, Json>),
          modelInputBodyHash: '0'.repeat(64),
        }),
        execution.id,
      ]);
      let error: unknown;
      try {
        await runtime.readModelInput({
          expectedStoreId: saved.expectedStoreId,
          sessionId: expected.sessionId,
          executionId: expected.executionId,
          subjectId: 'owner',
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'model_body_receipt_invalid' });
      expect(noModel.requests).toHaveLength(0);
    } finally {
      db.close();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('legacy review creation is permanently read-only and cannot create another child', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-legacy-producer-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'owned',
      subjectId: 'owner',
    });
    const owner = (await store.acquireSessionOwner('s', 'legacy-fixture'))!;
    const before = await store.getMetadata();
    const sessions = await store.listSessions();
    let error: unknown;
    try {
      await store.ensureAuthorizationReview({
        expectedStoreId,
        owner,
        targetExecutionId: 'unavailable-target',
        policyRevision: 'p1',
        request: { task: 'cannot create legacy review' },
        reviewer: { id: 'reviewer', version: '1', modelId: 'review-model' },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'authorization_review_legacy_read_only' });
    expect(await store.getMetadata()).toEqual(before);
    expect(await store.listSessions()).toEqual(sessions);
    expect(await store.listExecutions('s')).toEqual([]);
    expect((await store.getView('s')).runs).toEqual([]);
    expect(await store.listMessages('s')).toEqual([]);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('historical internal agents cannot create or activate new execution, while cancellation remains available', async () => {
  const { root, profile } = unpack('guarded');
  const saved = JSON.parse(readFileSync(join(root, 'proof.json'), 'utf8'));
  const store = await openSqliteStore(profile);
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
  try {
    const historicalRoot = (await store.getSession(saved.base.sessionId))!;
    await store.recoverSession({
      expectedStoreId: saved.base.expectedStoreId,
      commandId: 'retire-historical-owner',
      sessionId: saved.base.sessionId,
      subjectId: saved.base.subjectId,
      expectedOwnerGeneration: historicalRoot.ownerGeneration,
      decision: 'interrupt',
    });
    const owner = (await store.acquireSessionOwner(
      saved.base.sessionId,
      'compatibility-boundary',
    ))!;
    db.run('UPDATE session SET stop_boundary=0');
    db.run('UPDATE command SET cancelled=0,cancel_requested_at=NULL');
    db.run('UPDATE run SET cancel_requested=0,cancel_requested_at=NULL');
    db.run('UPDATE execution SET cancel_requested=0,cancel_requested_at=NULL');
    db.run("UPDATE execution SET state='planned',dispatched=0 WHERE id=?", [saved.target.id]);
    expect(owner).not.toBeNull();
    db.run('UPDATE execution SET owner_generation=?', [BigInt(owner.generation)]);
    // Make the genuine frozen record eligible for its old dispatch/activation paths.
    // No legacy producer is used to construct a new Session, Run or Model.
    db.run("UPDATE execution SET state='planned',dispatched=0 WHERE id=?", [saved.carrier.id]);
    const childSessionId = saved.carrier.childSessionId as string;
    const childRun = (await store.getView(childSessionId)).runs[0]!;
    db.run("UPDATE run SET status='running',is_active=1 WHERE id=?", [childRun.id]);
    const model = (await store.listExecutions(childSessionId)).find((e) => e.kind === 'model')!;
    db.run("UPDATE execution SET state='planned',dispatched=0 WHERE id=?", [model.id]);
    const base = { expectedStoreId: saved.base.expectedStoreId as string, owner };
    const before = (await store.getMetadata()).lastChangeCursor;
    const counts = () =>
      db
        .query(
          'SELECT (SELECT count(*) FROM session) AS sessions,(SELECT count(*) FROM run) AS runs,(SELECT count(*) FROM message) AS messages,(SELECT count(*) FROM execution) AS executions',
        )
        .get();
    const originalCounts = counts();
    const refused = async (
      work: Promise<unknown>,
      code = 'historical_internal_agent_read_only',
    ) => {
      let failure: unknown;
      try {
        await work;
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code });
    };
    const payload = saved.carrier.childConfiguration.snapshot.authorizationReview;
    await refused(
      store.ensureAuthorizationReview({
        ...base,
        targetExecutionId: saved.target.id,
        policyRevision: payload.policyRevision,
        request: payload.request,
        reviewer: payload.reviewer,
      }),
      'authorization_review_legacy_read_only',
    );
    await refused(
      store.markDispatching({
        ...base,
        executionId: saved.carrier.id,
        authorization: {
          allowed: true,
          revision: 'test',
          definitionVersion: '1',
          inputDigest: await semanticDigest(saved.carrier.input),
        },
        requirements: [],
        freshness: { checked: true, source: saved.carrier.decisionSource },
      }),
    );
    db.run("UPDATE execution SET state='dispatching',dispatched=1 WHERE id=?", [saved.carrier.id]);
    await refused(
      store.activateChildRun({
        ...base,
        executionId: saved.carrier.id,
        configuration: saved.carrier.childConfiguration.snapshot,
        requirements: [],
        requirementEvaluations: [],
        freshness: { checked: true, source: saved.carrier.decisionSource },
      }),
    );
    await refused(
      store.planExecution({
        ...base,
        executionId: 'forbidden-new-model',
        sessionId: childSessionId,
        runId: childRun.id,
        originCommandId: childRun.originCommandId,
        stepId: 'forbidden-new-model',
        callId: 'forbidden-new-model',
        kind: 'model',
        definitionId: model.definitionId,
        definitionVersion: '1',
        input: {
          modelId: model.definitionId,
          requestId: 'forbidden-new-model',
          messages: [],
          tools: [],
        },
        decisionSource: model.decisionSource,
      }),
    );
    await refused(
      store.markDispatching({
        ...base,
        executionId: model.id,
        authorization: {
          allowed: true,
          revision: 'test',
          definitionVersion: '1',
          inputDigest: await semanticDigest(model.input),
        },
        requirements: [],
        freshness: { checked: true, source: model.decisionSource },
      }),
    );
    db.run("UPDATE execution SET state='running',dispatched=1 WHERE id=?", [model.id]);
    await refused(
      store.persistModelPartial({ ...base, executionId: model.id, content: 'forbidden late text' }),
    );
    await refused(
      store.finishExecution({
        ...base,
        executionId: model.id,
        status: 'succeeded',
        result: { content: 'forbidden late text', finishReason: 'stop', toolCalls: [] },
      }),
    );
    expect(counts()).toEqual(originalCounts);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    await store.finishExecution({
      ...base,
      executionId: model.id,
      status: 'cancelled',
      result: { code: 'historical_work_cancelled', incomplete: true },
    });
    expect((await store.getExecution(model.id))!.status).toBe('cancelled');
    expect(counts()).toEqual(originalCounts);

    const check = await store.ensureAuthorizationCheck({
      ...base,
      targetExecutionId: saved.target.id,
      policyRevision: payload.policyRevision,
      request: payload.request,
      checker: { ...payload.reviewer, id: 'current-checker' },
    });
    expect(check.created).toBe(true);
    expect(check.execution).toMatchObject({ kind: 'model', runId: null, childSessionId: null });
    await refused(
      store.markDispatching({
        ...base,
        executionId: check.execution.id,
        authorization: {
          allowed: true,
          revision: payload.policyRevision,
          definitionVersion: '1',
          inputDigest: await semanticDigest(check.execution.input),
        },
        requirements: [],
        freshness: { checked: true, source: check.source },
      }),
      'invalid_runless_execution',
    );
    await store.finishAuthorizationCheck({
      ...base,
      executionId: check.execution.id,
      status: 'cancelled',
      result: { code: 'test_complete', incomplete: true },
    });
  } finally {
    db.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
          authorization: corrupt,
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
