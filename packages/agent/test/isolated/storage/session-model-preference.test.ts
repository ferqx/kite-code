import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

test('route preference is scoped, successful ordinary model only and readonly after reopening', async () => {
  const root = temporaryDirectory('kite-route-preference-'),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const id = (await store.getMetadata()).storeId,
      scope = { expectedStoreId: id, sessionId: 's', subjectId: 'owner' };
    let selected = 'one';
    runtime = createRuntime({
      store,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'test' };
        },
      },
      resolveRunConfiguration: async () => ({
        modelId: selected,
        snapshot: { modelId: selected },
        model: {
          async *stream() {
            yield { type: 'text_delta', text: 'done' };
            yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
      }),
    });
    await runtime.createWorkspace({
      expectedStoreId: id,
      id: 'w',
      name: 'w',
      rootUri: 'file:///fixture',
    });
    await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 'test' });
    expect(await store.readLatestBusinessModelPreference(scope)).toBeNull();
    for (const c of ['first', 'latest']) {
      selected = c;
      await runtime.submitCommand({
        ...scope,
        commandId: c,
        request: { kind: 'run.start', content: 'task' },
      });
      await runtime.waitForCommand(c);
    }
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const hint = await store.readLatestBusinessModelPreference(scope);
    expect(hint?.modelId).toBe('latest');
    expect(Object.keys(hint!).sort()).toEqual(['executionId', 'modelId', 'runId']);
    expect(
      await store.readLatestBusinessModelPreference({ ...scope, subjectId: 'foreign' }),
    ).toBeNull();
    const db = new Database(join(profile.dataRoot, 'test', 'core.db'));
    try {
      db.run(
        "UPDATE execution SET decision_source_json=json_set(decision_source_json,'$.compressionId','summary') WHERE id=?",
        [hint!.executionId],
      );
      expect((await store.readLatestBusinessModelPreference(scope))?.modelId).toBe('first');
      db.run(
        "UPDATE execution SET decision_source_json=json_remove(decision_source_json,'$.compressionId'),state='failed' WHERE id=?",
        [hint!.executionId],
      );
      expect((await store.readLatestBusinessModelPreference(scope))?.modelId).toBe('first');
      db.run(
        "UPDATE execution SET state='succeeded',decision_source_json=json_set(decision_source_json,'$.imageWindow.kind','observation') WHERE id=?",
        [hint!.executionId],
      );
      expect((await store.readLatestBusinessModelPreference(scope))?.modelId).toBe('first');
      db.run(
        "UPDATE execution SET decision_source_json=json_remove(decision_source_json,'$.imageWindow'),origin_store_id='restored' WHERE id=?",
        [hint!.executionId],
      );
      expect((await store.readLatestBusinessModelPreference(scope))?.modelId).toBe('first');
      db.run("UPDATE run SET origin_store_id='restored' WHERE id=?", [hint!.runId]);
      db.run("UPDATE command SET origin_store_id='restored' WHERE id='latest'");
      expect(await store.readLatestBusinessModelPreference(scope)).toEqual(hint);
    } finally {
      db.close();
    }
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    await runtime.close();
    runtime = undefined;
    cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    expect(await cold.readLatestBusinessModelPreference(scope)).toEqual(hint);
    expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await cold?.close();
    if (runtime) await runtime.close();
    else await store.close();
    removeTemporaryDirectory(root);
  }
});
