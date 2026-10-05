import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

async function rejected(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string } | undefined)?.code).toBe(code);
}
test('explicit recovery cancels proven unstarted work, preserves cross-Store uncertainty and rolls back atomically', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-recovery-settlement-');
  chmodSync(dataRoot, 0o700);
  let store = await openSqliteStore({ dataRoot, profile: 'test' });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///fixture',
      name: 'w',
    });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 's',
      subjectId: 'user',
    });
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'fixture' },
    });
    const owner = (await store.acquireSessionOwner('s', 'prior'))!;
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'work',
      configuration: {},
    });
    for (const kind of ['model', 'tool'] as const)
      await store.planExecution({
        expectedStoreId,
        owner,
        executionId: kind,
        sessionId: 's',
        runId: run.id,
        kind,
        originCommandId: 'work',
        stepId: kind,
        callId: kind,
        definitionId: kind,
        definitionVersion: '1',
        input: {},
        decisionSource: { kind: 'fixed' },
      });
    for (const id of ['local-job', 'old-job', 'preparing']) {
      await store.acceptCommand({
        expectedStoreId,
        commandId: id,
        sessionId: 's',
        subjectId: 'user',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'run',
          definitionVersion: '1',
          input: {},
        },
      });
      await store.planAction({
        expectedStoreId,
        owner,
        commandId: id,
        executionId: id,
        extensionId: 'fixture',
        definitionId: 'fixture/run',
        definitionVersion: '1',
        input: {},
        decisionSource: {
          kind: 'action_decision',
          commandId: id,
          extensionId: 'fixture',
          actionId: 'run',
          definitionVersion: '1',
          preparedDigest: await semanticDigest({}),
        },
      });
    }
    await store.applyExtensionAction({
      expectedStoreId,
      owner,
      executionId: 'preparing',
      extensionId: 'fixture',
      status: 'failed',
      preparingNextAttempt: true,
      result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
    });
    db.run("UPDATE execution SET origin_store_id='old-store' WHERE id='old-job'");
    await store.close();
    store = await openSqliteStore({ dataRoot, profile: 'test' });
    const input = {
      expectedStoreId,
      commandId: 'recover',
      sessionId: 's',
      subjectId: 'user',
      expectedOwnerGeneration: owner.generation,
      decision: 'interrupt' as const,
    };
    db.exec(
      "CREATE TRIGGER fail_recovery BEFORE INSERT ON change_event WHEN NEW.type='session.recovered' BEGIN SELECT RAISE(ABORT,'recovery commit fault'); END",
    );
    let failure: unknown;
    try {
      await store.recoverSession(input);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain('recovery commit fault');
    expect((await store.getSession('s'))?.ownerGeneration).toBe(owner.generation);
    expect((await store.getExecution('tool'))?.status).toBe('planned');
    expect((await store.getRun(run.id))?.isActive).toBe(true);
    expect(await store.getCommand('recover')).toBeNull();
    db.exec('DROP TRIGGER fail_recovery');
    db.run("UPDATE execution SET result_revision=9223372036854775807 WHERE id='tool'");
    const beforeOverflow = await store.getView('s');
    const pendingBeforeOverflow = await store.getCommand('preparing');
    await rejected(store.recoverSession(input), 'sequence_exhausted');
    expect(await store.getView('s')).toEqual(beforeOverflow);
    expect(await store.getCommand('preparing')).toEqual(pendingBeforeOverflow);
    expect(await store.getCommand('recover')).toBeNull();
    expect(
      db
        .query(
          "SELECT typeof(result_revision) AS storage_type,CAST(result_revision AS TEXT) AS revision FROM execution WHERE id='tool'",
        )
        .get(),
    ).toEqual({ storage_type: 'integer', revision: '9223372036854775807' });
    db.run("UPDATE execution SET result_revision=0 WHERE id='tool'");
    const report = await store.recoverSession(input);
    expect(report.cancelledExecutionIds).toEqual(['local-job', 'tool']);
    expect(report.unknownExecutionIds).toEqual(['old-job']);
    expect(report.settledExecutionIds).toEqual(['model']);
    const recoveredRun = await store.getRun(run.id);
    expect(recoveredRun?.finishedAt).not.toBeNull();
    expect(Number.isFinite(recoveredRun?.finishedAt)).toBe(true);
    expect(recoveredRun!.finishedAt!).toBeGreaterThanOrEqual(recoveredRun!.createdAt);
    expect((await store.getCommand('preparing'))?.status).toBe('needs_review');
    expect((await store.getCommand('preparing'))?.receipt).toMatchObject({
      preparingNextAttempt: false,
    });
    expect(
      db.query('SELECT owner_generation,origin_store_id FROM execution WHERE id=?').get('old-job'),
    ).toEqual({ owner_generation: Number(owner.generation), origin_store_id: 'old-store' });
    expect(await store.recoverSession(input)).toEqual(report);
    await rejected(
      store.recoverSession({ ...input, expectedStoreId: 'wrong' }),
      'store_identity_mismatch',
    );
    await rejected(store.recoverSession({ ...input, sessionId: 'other' }), 'command_conflict');
    await rejected(store.acquireSessionOwner('s', 'new'), 'recovery_required');
  } finally {
    db.close();
    await store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
