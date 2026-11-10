import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  fixturePermissions,
  privateDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore, preflightSqliteStore } from '../../../src/sqlite';

// Genuine format-1 profiles retain their original private review bodies. The
// current same-major implementation still rejects their old schema/checksums.
function unpack(shape: string) {
  const root = temporaryDirectory('kite-old-format-authorization-');
  const files = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(`./fixtures/legacy-authorization-review-${shape}.json.gz`, import.meta.url),
      ),
    ).toString(),
  ) as Record<string, string>;
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(root, name);
    privateDirectory(dirname(path));
    writeFileSync(path, Buffer.from(bytes, 'base64'), { mode: 0o600 });
    fixturePermissions(path, name.includes('/blobs/') ? 0o400 : 0o600);
  }
  return { root, files, profile: { dataRoot: join(root, 'data'), profile: 'owned' } };
}
for (const shape of ['inline', 'artifact-private', 'artifact-semantic', 'guarded'])
  test(`same-major legacy ${shape} review history is rejected without conversion or rewriting saved results`, async () => {
    const f = unpack(shape);
    try {
      const originals = new Map(
        Object.keys(f.files).map((name) => [name, readFileSync(join(f.root, name))]),
      );
      await expect(preflightSqliteStore(f.profile)).rejects.toMatchObject({
        code: 'store_incompatible',
      });
      const legacy = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'), {
        readonly: true,
      });
      try {
        expect(
          JSON.parse(
            readFileSync(join(f.profile.dataRoot, f.profile.profile, 'profile.json'), 'utf8'),
          ).formatMajor,
        ).toBe(1);
        expect(legacy.query('SELECT format_major FROM storage_meta').get()).toEqual({
          format_major: 1,
        });
        const baseline = readFileSync(
          new URL('../../../src/storage/migrations/0001-baseline.sql', import.meta.url),
        );
        expect(
          legacy
            .query<{ checksum: string }, []>(
              "SELECT checksum FROM schema_migration WHERE id='0001-baseline'",
            )
            .get()!.checksum,
        ).not.toBe(createHash('sha256').update(baseline).digest('hex'));
      } finally {
        legacy.close(true);
      }

      for (const mode of ['readonly', 'readwrite'] as const)
        await expect(openSqliteStore({ ...f.profile, mode })).rejects.toMatchObject({
          code: 'store_incompatible',
        });
      for (const [name, bytes] of originals)
        expect(readFileSync(join(f.root, name))).toEqual(bytes);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
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
