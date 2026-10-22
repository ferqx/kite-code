import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';

type ExecutionRow = {
  id: string;
  run_id: string;
  intent_json: string;
  owner_generation: number;
  state: string;
  dispatched: number;
};

// Executed in a separate process so the cold Store contains a real, settled checker,
// while the original business Run genuinely loses its owner without cancellation.
async function seed(root: string, failed: boolean) {
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'business',
    model: {
      async *stream() {
        yield {
          type: 'tool_call' as const,
          id: 'call',
          name: 'effect',
          arguments: '{"value":"exact"}',
        };
        yield { ...finish, reason: 'tool_calls' as const };
      },
    },
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'permission-check',
      model: {
        async *stream(input) {
          if (input.tools.length) throw Error('review_tools_present');
          if (failed) throw Error('explicit_review_provider_failure');
          yield {
            type: 'text_delta' as const,
            text: '{"decision":"ask_user","reason":"Confirm exact cold operation"}',
          };
          yield finish;
        },
      },
    },
    permissions: {
      async authorize(candidate) {
        return candidate.definitionId === 'effect'
          ? {
              allowed: false,
              revision: 'p1',
              check: { request: { definitionId: 'effect', input: { value: 'exact' } } },
            }
          : { allowed: true, revision: 'trusted' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'effect',
            version: '1',
            description: 'Owned effect',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
            async execute() {
              throw Error('effect_must_not_dispatch');
            },
          },
        ],
      },
    ],
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'check ownership',
  });
  await runtime.submitCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'One exact effect' },
  });
  const end = Date.now() + 5000;
  while (
    !(await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
      .interactions.length
  ) {
    if (Date.now() > end) throw Error('check_fixture_timeout');
    await Bun.sleep(5);
  }
  writeFileSync(join(root, 'ready.tmp'), expectedStoreId);
  renameSync(join(root, 'ready.tmp'), join(root, 'ready'));
  await new Promise<void>(() => {});
}

async function fixture(failed: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resume-review-owner-')));
  const imports = ['runtime', 'sqlite', 'artifacts'].map((name) =>
    fileURLToPath(new URL(`../../../src/${name}.ts`, import.meta.url)),
  );
  const script = join(root, 'seed.ts');
  writeFileSync(
    script,
    `import {join} from 'node:path';import {writeFileSync,renameSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {createRuntime} from ${JSON.stringify(imports[0])};import {openSqliteStore} from ${JSON.stringify(imports[1])};import {createArtifactStore} from ${JSON.stringify(imports[2])};await (${seed.toString()})(${JSON.stringify(root)},${failed});`,
  );
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  let childSettled = false;
  void child.exited.then(() => {
    childSettled = true;
  });
  const deadline = Date.now() + 5000;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let db: Database | undefined;
  try {
    while (!existsSync(join(root, 'ready'))) {
      if (childSettled || Date.now() > deadline) {
        if (!childSettled) child.kill('SIGKILL');
        await child.exited;
        throw Error(await new Response(child.stderr).text());
      }
      await Bun.sleep(5);
    }
    if (!childSettled) child.kill('SIGKILL');
    await child.exited;
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    store = await openSqliteStore(profile);
    db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    const ownedStore = store,
      ownedDB = db;
    const expectedStoreId = readFileSync(join(root, 'ready'), 'utf8');
    const target = db
      .query("SELECT * FROM execution WHERE adapter_id='effect'")
      .get() as ExecutionRow;
    const carrier = db
      .query(
        "SELECT * FROM execution WHERE parent_execution_id=? AND kind='model' AND run_id IS NULL",
      )
      .get(target.id) as ExecutionRow;
    const model = carrier;
    const payload = (
      (await store.getCommand((await store.getExecution(carrier.id))!.originCommandId))!
        .request as {
        input: {
          policyRevision: string;
          request: Json;
          requireApproval: boolean;
          checker: { id: string; version: string; modelId: string };
        };
      }
    ).input;
    const proof = () =>
      ownedStore.getAuthorizationCheck({
        expectedStoreId,
        targetExecutionId: target.id,
        checkExecutionId: carrier.id,
        policyRevision: payload.policyRevision,
        request: payload.request,
        requireApproval: payload.requireApproval,
        checker: payload.checker,
      });
    const original = {
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'resume',
      runId: target.run_id,
      expectedOwnerGeneration: String(target.owner_generation),
    };
    const state = await store.verifyRunResume(original);
    const begun = await store.beginRunResume({
      ...original,
      instanceId: 'cold',
      checkpoint: state.checkpoint!,
    });
    const commit = () =>
      ownedStore.commitRunResume({
        expectedStoreId,
        lease: begun.lease!,
        checkpoint: state.checkpoint!,
        expectedConfiguration: state.run.configuration,
      });
    return {
      store,
      expectedStoreId,
      db,
      target,
      carrier,
      model,
      proof,
      commit,
      lease: begun.lease!,
      async close() {
        ownedDB.close();
        await ownedStore.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const diagnostic: Record<string, unknown> = { root, failed, failure: String(error) };
    try {
      if (existsSync(join(root, 'ready'))) {
        const bytes = readFileSync(join(root, 'ready'));
        diagnostic.ready = { base64: bytes.toString('base64'), utf8: bytes.toString('utf8') };
      }
      if (db)
        diagnostic.metadata = db.query('SELECT store_id FROM storage_meta WHERE singleton=1').get();
    } catch (observationError) {
      diagnostic.observationError = String(observationError);
    }
    try {
      if (!childSettled) child.kill('SIGKILL');
      diagnostic.childExitCode = await child.exited;
      diagnostic.childSignalCode = child.signalCode;
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      db?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await store?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      writeFileSync(
        join(root, 'failure.json'),
        JSON.stringify({ ...diagnostic, cleanupErrors: cleanupErrors.map(String) }),
      );
    } catch (receiptError) {
      cleanupErrors.push(receiptError);
    }
    console.error('check_owner_fixture_failed', root);
    if (cleanupErrors.length)
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Review ownership fixture cleanup failed',
      );
    throw error;
  }
}

for (const failed of [false, true])
  test(`cold resume transfers only settled ${failed ? 'failed/unavailable' : 'ask_user'} permission-check ownership without rewriting proof`, async () => {
    const f = await fixture(failed);
    try {
      expect(f.target.state).toBe('planned');
      expect(f.target.dispatched).toBe(0);
      expect(f.carrier.state).toBe(failed ? 'failed' : 'succeeded');
      expect(f.model.state).toBe(failed ? 'failed' : 'succeeded');
      expect((await f.proof()).decision).toBe(failed ? 'unavailable' : 'ask_user');
      const unchanged = () => ({
        executions: f.db
          .query<Record<string, unknown>, []>('SELECT * FROM execution ORDER BY id')
          .all()
          .map(({ owner_generation: _generation, ...row }) => row),
        commands: f.db.query("SELECT * FROM command WHERE id<>'resume' ORDER BY id").all(),
        runs: f.db.query('SELECT * FROM run ORDER BY id').all(),
        artifacts: f.db.query('SELECT * FROM blob_ref ORDER BY id').all(),
      });
      const before = unchanged();
      await f.commit();
      expect(unchanged()).toEqual(before);
      expect(
        f.db
          .query('SELECT id,owner_generation FROM execution WHERE id IN (?,?) ORDER BY id')
          .all(f.target.id, f.carrier.id),
      ).toEqual(
        [f.target.id, f.carrier.id]
          .sort()
          .map((id) => ({ id, owner_generation: Number(f.lease.generation) })),
      );
      expect(f.lease.generation).not.toBe(String(f.target.owner_generation));
      expect((await f.proof()).decision).toBe(failed ? 'unavailable' : 'ask_user');
      const card = (
        await f.store.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions[0]!;
      expect(card.state).toBe('pending');
      expect((await f.store.getExecution(f.target.id))!.authorization).toMatchObject({
        dispatched: false,
        human: { accepted: false },
      });
    } finally {
      await f.close();
    }
  }, 10000);

test('explicit stale permission-check Model generation rejects the entire commit without partial target/carrier adoption', async () => {
  const f = await fixture(false);
  try {
    // Fault injection is intentionally confined to the independent permission-check identity.
    f.db.query('UPDATE execution SET owner_generation=999 WHERE id=?').run(f.model.id);
    const snapshot = () => ({
      executions: f.db
        .query<Record<string, unknown>, []>('SELECT * FROM execution ORDER BY id')
        .all(),
      commands: f.db.query('SELECT * FROM command ORDER BY id').all(),
      sessions: f.db.query('SELECT * FROM session ORDER BY id').all(),
      runs: f.db.query('SELECT * FROM run ORDER BY id').all(),
      artifacts: f.db.query('SELECT * FROM blob_ref ORDER BY id').all(),
      events: f.db.query('SELECT * FROM change_event ORDER BY cursor').all(),
    });
    const before = snapshot();
    const error = await f.commit().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'authorization_check_unverifiable' });
    expect(snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
}, 10000);
