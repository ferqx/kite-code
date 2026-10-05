import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { acquireProfileAccess, resolveProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'kite-unified-store-'));
  chmodSync(dataRoot, 0o700);
  roots.push(dataRoot);
  return { dataRoot, profile: 'test' };
}
async function setup() {
  const options = fixture();
  const store = await openSqliteStore(options);
  stores.push(store);
  const meta = await store.getMetadata();
  const expectedStoreId = meta.storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///disposable',
    name: 'test',
  });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'test',
    subjectId: 'user',
  });
  return { store, options, expectedStoreId };
}
async function rejects(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error('Expected rejection');
  } catch (error) {
    expect((error as { code: string }).code).toBe(code);
  }
}
describe('real unified SQLite Store', () => {
  test('core tables plus bounded host mutation journal, guarded writes, same command retry, readonly restart preserves results', async () => {
    const { store, options, expectedStoreId } = await setup();
    await rejects(
      store.acceptCommand({
        expectedStoreId: 'wrong',
        commandId: 'bad',
        sessionId: 's',
        subjectId: 'user',
        request: { kind: 'run.start', content: 'work' },
      }),
      'store_identity_mismatch',
    );
    expect(await store.getCommand('bad')).toBeNull();
    const request = {
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start' as const, content: 'work' },
    };
    const command = await store.acceptCommand(request);
    expect((await store.acceptCommand(request)).seq).toBe(command.seq);
    const owner = (await store.acquireSessionOwner('s', 'instance'))!;
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'work',
      configuration: {},
    });
    const input = { value: 1 };
    const execution = await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'execution',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: 'step',
      callId: 'call',
      kind: 'tool',
      definitionId: 'count',
      definitionVersion: '1',
      input,
      decisionSource: { request: 'fixed' },
    });
    await rejects(
      store.finishExecution({
        expectedStoreId,
        owner,
        executionId: execution.id,
        status: 'succeeded',
        result: { count: 99 },
      }),
      'execution_not_dispatched',
    );
    await store.markDispatching({
      expectedStoreId,
      owner,
      executionId: execution.id,
      authorization: {
        allowed: true,
        revision: '0',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
      },
      requirements: [],
      freshness: { checked: true, source: { request: 'fixed' } },
    });
    await store.finishExecution({
      expectedStoreId,
      owner,
      executionId: execution.id,
      status: 'succeeded',
      result: { count: 1 },
    });
    await store.finishRun({
      expectedStoreId,
      owner,
      runId: run.id,
      status: 'completed',
      requirements: [],
    });
    expect(await store.releaseSessionOwner(owner)).toBe(true);
    await store.close();
    const reader = await openSqliteStore({ ...options, mode: 'readonly' });
    stores.push(reader);
    expect((await reader.getExecution('execution'))?.result).toEqual({ count: 1 });
    expect((await reader.getRun(run.id))?.status).toBe('completed');
    await rejects(reader.acquireSessionOwner('s', 'reader'), 'read_only');
    const db = new Database(join(options.dataRoot, options.profile, 'core.db'), { readonly: true });
    try {
      // Closed baseline: permission grants and the host mutation journal share this Store.
      // Check names, including SQLite's AUTOINCREMENT helper, rather than a stale table count.
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        'blob',
        'blob_ref',
        'change_event',
        'command',
        'context_snapshot',
        'execution',
        'execution_output',
        'extension_record',
        'host_mutation',
        'interaction',
        'message',
        'message_part',
        'permission_grant',
        'permission_grant_change',
        'run',
        'schema_migration',
        'session',
        'sqlite_sequence',
        'storage_meta',
        'workspace',
      ]);
    } finally {
      db.close(true);
    }
  });
  test('cancel before Run and cancel before dispatch are durable and exact', async () => {
    const { store, expectedStoreId } = await setup();
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'first',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'first' },
    });
    const owner = (await store.acquireSessionOwner('s', 'instance'))!;
    await store.cancelCommand({
      expectedStoreId,
      commandId: 'cancel1',
      sessionId: 's',
      targetCommandId: 'first',
      subjectId: 'user',
    });
    await rejects(
      store.startRun({ expectedStoreId, owner, commandId: 'first', configuration: {} }),
      'cancelled_before_dispatch',
    );
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'second',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'second' },
    });
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'second',
      configuration: {},
    });
    await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'e',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'second',
      stepId: 'step',
      callId: 'call',
      kind: 'tool',
      definitionId: 'count',
      definitionVersion: '1',
      input: {},
      decisionSource: {},
    });
    await store.cancelCommand({
      expectedStoreId,
      commandId: 'cancel2',
      sessionId: 's',
      targetCommandId: 'second',
      subjectId: 'user',
    });
    await rejects(
      store.markDispatching({
        expectedStoreId,
        owner,
        executionId: 'e',
        authorization: {
          allowed: true,
          revision: '0',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [],
        freshness: { checked: true, source: {} },
      }),
      'cancelled_before_dispatch',
    );
    expect((await store.getExecution('e'))?.status).toBe('planned');
  });
  test('exclusive maintenance blocks open before profile creation and unfinished journal blocks new Store', async () => {
    const options = fixture();
    const exclusive = acquireProfileAccess(options, 'exclusive');
    try {
      await expect(openSqliteStore(options)).rejects.toThrow('Lock is busy');
    } finally {
      exclusive.lock.release();
    }
    const paths = resolveProfile(options);
    writeFileSync(join(paths.coordinationPath, 'restore-journal.json'), '{}');
    await expect(openSqliteStore(options)).rejects.toThrow('restore_reconciliation_required');
  });
  test('future format is untouched by rejected open', async () => {
    const options = fixture();
    const profile = join(options.dataRoot, options.profile);
    mkdirSync(profile, { mode: 0o700 });
    const path = join(profile, 'core.db');
    const db = new Database(path);
    db.exec(
      'CREATE TABLE storage_meta(singleton INTEGER PRIMARY KEY,format_major INTEGER); INSERT INTO storage_meta VALUES(1,99)',
    );
    db.close();
    chmodSync(path, 0o600);
    await expect(openSqliteStore(options)).rejects.toMatchObject({ code: 'store_incompatible' });
    const reader = new Database(path, { readonly: true });
    expect(reader.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    reader.close();
  });
  test('real second process cannot bypass owner or external maintenance lock', async () => {
    const { store, options } = await setup();
    const owner = (await store.acquireSessionOwner('s', 'parent'))!;
    const spawn = () =>
      Bun.spawn([process.execPath, new URL('./open-child.ts', import.meta.url).pathname], {
        env: { ...process.env, TEST_DATA_ROOT: options.dataRoot, TEST_SESSION: 's' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    const child = spawn();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text()).owner).toBeNull();
    expect(await store.releaseSessionOwner(owner)).toBe(true);
    expect(await store.releaseSessionOwner(owner)).toBe(true);
    await store.close();
    const exclusive = acquireProfileAccess(options, 'exclusive');
    try {
      const blocked = spawn();
      expect(await blocked.exited).toBe(2);
      expect(JSON.parse(await new Response(blocked.stdout).text()).code).toBe('owner_busy');
    } finally {
      exclusive.lock.release();
    }
  });
  test('sequence above Number precision stays lossless and exhaustion rolls back', async () => {
    const { store, options, expectedStoreId } = await setup();
    const db = new Database(join(options.dataRoot, options.profile, 'core.db'));
    db.run("UPDATE session SET next_seq=9007199254740993 WHERE id='s'");
    db.close();
    const command = await store.acceptCommand({
      expectedStoreId,
      commandId: 'large',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'large' },
    });
    expect(command.seq).toBe('9007199254740994');
    const mutate = new Database(join(options.dataRoot, options.profile, 'core.db'));
    mutate.run("UPDATE session SET next_seq=9223372036854775807 WHERE id='s'");
    mutate.close();
    await rejects(
      store.acceptCommand({
        expectedStoreId,
        commandId: 'overflow',
        sessionId: 's',
        subjectId: 'user',
        request: { kind: 'run.start', content: 'overflow' },
      }),
      'sequence_exhausted',
    );
    expect(await store.getCommand('overflow')).toBeNull();
  });
  test('concurrent first open converges on one baseline Store', async () => {
    const options = fixture();
    const opened = await Promise.all([openSqliteStore(options), openSqliteStore(options)]);
    stores.push(...opened);
    expect((await opened[0]!.getMetadata()).storeId).toBe((await opened[1]!.getMetadata()).storeId);
  });
  test('workspace queries use bounded stable keysets', async () => {
    const { store, expectedStoreId } = await setup();
    await store.createWorkspace({ expectedStoreId, id: 'z', rootUri: 'file:///z', name: 'last' });
    expect(await store.getWorkspace('w')).toEqual({
      id: 'w',
      rootUri: 'file:///disposable',
      name: 'test',
    });
    expect(await store.getWorkspace('missing')).toBeNull();
    expect((await store.listWorkspaces({ limit: 1 })).map((workspace) => workspace.id)).toEqual([
      'w',
    ]);
    expect(
      (await store.listWorkspaces({ afterId: 'w', limit: 1 })).map((workspace) => workspace.id),
    ).toEqual(['z']);
  });
});
