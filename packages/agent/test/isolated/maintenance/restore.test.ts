import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import {
  createProfileBackup,
  inspectProfileRestore,
  reconcileProfileRestore,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { runProfileRestore } from '../../../src/maintenance/restore';
import { acquireProfileAccess, selectProfile } from '../../../src/platform/profile';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import {
  configBytes,
  nodeAssets,
  preferenceBytes,
  seedAssets,
  seedRecoveryAsset,
  seedTuiAsset,
  tuiText,
  workflowBytes,
} from './assets-fixture';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 0, outputTokens: 0 },
};
async function fails(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code ?? (error as Error)?.message).toBe(code);
}
async function fixture(seed = false) {
  const directory = mkdtempSync('/private/tmp/kite-restore-'),
    profile = { dataRoot: join(directory, 'data'), profile: 'test' },
    store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: 'file:///fixture',
    name: 'w',
  });
  await store.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'backup title',
  });
  if (seed) {
    await store.acceptCommand({
      expectedStoreId: storeId,
      sessionId: 's',
      commandId: 'old-work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'original pending work' },
    });
    const owner = (await store.acquireSessionOwner('s', 'original'))!;
    const run = await store.startRun({
      expectedStoreId: storeId,
      owner,
      commandId: 'old-work',
      configuration: {
        modelId: 'fixed',
        tools: [{ id: 'fixture/tool', version: '1', extensionId: 'fixture' }],
      },
    });
    await store.planExecution({
      expectedStoreId: storeId,
      owner,
      executionId: 'old-plan',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'old-work',
      stepId: 'step',
      callId: 'call',
      kind: 'tool',
      definitionId: 'fixture/tool',
      definitionVersion: '1',
      input: {},
      decisionSource: { kind: 'model_decision', modelExecutionId: 'original-model' },
    });
    await store.acceptCommand({
      expectedStoreId: storeId,
      sessionId: 's',
      commandId: 'old-pending',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'accepted old' },
    });
  }
  await store.close();
  const selected = selectProfile(profile);
  await seedAssets(directory, profile, storeId);
  const backup = await createProfileBackup({
    profile,
    destinationRoot: join(directory, 'backups'),
  });
  const db = new Database(selected.databasePath);
  db.run("UPDATE session SET title='later current title'");
  db.close(true);
  writeFileSync(join(selected.profilePath, 'config.jsonc'), 'later current configuration', {
    mode: 0o600,
  });
  await nodeAssets(directory, profile, storeId, 'add');
  writeFileSync(join(selected.profilePath, 'ui/preferences.jsonc'), 'later preference bytes', {
    mode: 0o600,
  });
  writeFileSync(join(selected.profilePath, 'skill-workflow.jsonc'), 'later workflow bytes', {
    mode: 0o600,
  });
  seedTuiAsset(profile, storeId, 'later unsent original');
  await seedRecoveryAsset(profile, storeId, true);
  return {
    directory,
    profile,
    storeId,
    selected,
    backup,
    input: {
      profile,
      expectedStoreId: storeId,
      backup,
      intent: 'replace_with_selected_backup' as const,
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('restore publishes a new Store, preserves origins and fences pending facts without cold model work', async () => {
  const f = await fixture(true);
  try {
    const originalDb = new Database(f.selected.databasePath);
    originalDb.run("UPDATE execution SET state='outcome_unknown' WHERE id='old-plan'");
    originalDb.close(true);
    const originalStore = await openSqliteStore(f.profile);
    try {
      await fails(originalStore.acquireSessionOwner('s', 'must-not-bypass'), 'recovery_required');
    } finally {
      await originalStore.close();
    }
    const result = await restoreProfileBackup(f.input);
    expect(result.outcome).toBe('restored');
    expect(result.storeId).not.toBe(f.storeId);
    expect(inspectProfileRestore({ profile: f.profile })).toBeNull();
    const old = new Database(join(result.preservedDirectory, 'core.db'), { readonly: true });
    try {
      expect(old.query('SELECT title FROM session').get()).toEqual({
        title: 'later current title',
      });
    } finally {
      old.close(true);
    }
    const store = await openSqliteStore(f.profile);
    let calls = 0;
    const model: ModelAdapter = {
      async *stream() {
        calls++;
        yield finish;
      },
    };
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    });
    try {
      expect((await store.getMetadata()).storeId).toBe(result.storeId);
      expect((await store.getSession('s'))?.title).toBe('backup title');
      expect((await store.getCommand('old-pending'))?.status).toBe('needs_review');
      expect((await store.getCommand('old-work'))?.originStoreId).toBe(f.storeId);
      expect((await store.getExecution('old-plan'))?.status).toBe('outcome_unknown');
      expect((await store.getExecution('old-plan'))?.originStoreId).toBe(f.storeId);
      expect(calls).toBe(0);
      await fails(
        runtime.submitCommand({
          expectedStoreId: f.storeId,
          sessionId: 's',
          commandId: 'old-pending',
          subjectId: 'owner',
          request: { kind: 'run.start', content: 'accepted old' },
        }),
        'store_identity_mismatch',
      );
      expect(calls).toBe(0);
      await runtime.submitCommand({
        expectedStoreId: result.storeId,
        sessionId: 's',
        commandId: 'new-work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'explicit new work' },
      });
      const completed = await runtime.waitForCommand('new-work');
      expect((await runtime.getRun((completed.receipt as { runId: string }).runId))?.status).toBe(
        'completed',
      );
      expect(calls).toBe(1);
      const owner = (await store.acquireSessionOwner('s', 'verify-old-operation'))!;
      try {
        await fails(
          store.ensureOperation({
            expectedStoreId: result.storeId,
            owner,
            sessionId: 's',
            extensionId: 'fixture',
            originCommandId: 'old-work',
            parentExecutionId: 'old-plan',
            operationKey: 'missing-key',
            request: {
              kind: 'tool',
              definitionId: 'fixture/tool',
              definitionVersion: '1',
              input: {},
            },
          }),
          'operation_unverifiable',
        );
        expect((await store.getExecution('old-plan'))?.originStoreId).toBe(f.storeId);
        expect(calls).toBe(1);
      } finally {
        await store.releaseSessionOwner(owner);
      }
    } finally {
      await runtime.close();
    }
    // Fixture an uncertain new-Store execution; old restored-root provenance is not a waiver.
    const uncertain = new Database(f.selected.databasePath);
    uncertain
      .query("UPDATE execution SET state='outcome_unknown' WHERE origin_store_id=?")
      .run(result.storeId);
    uncertain.close(true);
    const blocked = await openSqliteStore(f.profile);
    try {
      await fails(blocked.acquireSessionOwner('s', 'new-uncertainty'), 'recovery_required');
    } finally {
      await blocked.close();
    }
  } finally {
    f.close();
  }
});

test('SIGKILL after journal removal still holds exclusive lock until exit and leaves verified new Store', async () => {
  const f = await fixture(),
    module = new URL('../../../src/maintenance/restore.ts', import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {runProfileRestore} from ${JSON.stringify(module)}; await runProfileRestore(${JSON.stringify(f.input)},async point=>{if(point==='journal_cleared'){console.log(point);await new Promise(()=>setInterval(()=>{},1000));}});`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('journal_cleared');
    reader.releaseLock();
    expect(inspectProfileRestore({ profile: f.profile })).toBeNull();
    await fails(openSqliteStore(f.profile), 'owner_busy');
    child.kill('SIGKILL');
    await child.exited;
    const opened = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await opened.getMetadata()).storeId).not.toBe(f.storeId);
      expect((await opened.getSession('s'))?.title).toBe('backup title');
      expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(configBytes);
      expect(readFileSync(join(f.selected.profilePath, 'skill-workflow.jsonc'))).toEqual(
        workflowBytes,
      );
      expect((await nodeAssets(f.directory, f.profile, f.storeId, 'read')).count).toBe(133);
      const tui = JSON.parse(readFileSync(join(f.selected.profilePath, 'ui', 'tui.json'), 'utf8'));
      expect(tui.drafts[0].storeId).toBe(f.storeId);
      expect(tui.drafts[0].text).toBe(tuiText);
    } finally {
      await opened.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    f.close();
  }
}, 30000);

test('an external effect performed after backup is not repeated by an old Store retry after restoration', async () => {
  const f = await fixture();
  const ledger = join(f.directory, 'external-ledger');
  writeFileSync(ledger, '0', { mode: 0o600 });
  let calls = 0;
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', id: 'actual-effect', name: 'fixture.effect', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
      } else yield finish;
    },
  };
  const store = await openSqliteStore(f.profile);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'owned external count',
            inputSchema: { type: 'object' },
            async execute() {
              writeFileSync(ledger, String(Number(readFileSync(ledger, 'utf8')) + 1));
              return { outcome: 'succeeded', content: 'counted' };
            },
          },
        ],
      },
    ],
  });
  try {
    await runtime.submitCommand({
      expectedStoreId: f.storeId,
      sessionId: 's',
      commandId: 'after-backup-effect',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'perform fixture count' },
    });
    const command = await runtime.waitForCommand('after-backup-effect');
    expect((await runtime.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(readFileSync(ledger, 'utf8')).toBe('1');
    expect(calls).toBe(2);
    await runtime.close();
    const restored = await restoreProfileBackup(f.input),
      cold = await openSqliteStore(f.profile);
    const next = createRuntime({
      store: cold,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    });
    try {
      expect(await cold.getCommand('after-backup-effect')).toBeNull();
      await fails(
        next.submitCommand({
          expectedStoreId: f.storeId,
          sessionId: 's',
          commandId: 'after-backup-effect',
          subjectId: 'owner',
          request: { kind: 'run.start', content: 'perform fixture count' },
        }),
        'store_identity_mismatch',
      );
      expect((await cold.getMetadata()).storeId).toBe(restored.storeId);
      expect(readFileSync(ledger, 'utf8')).toBe('1');
      expect(calls).toBe(2);
    } finally {
      await next.close();
    }
  } finally {
    await runtime.close();
    f.close();
  }
});

for (const point of [
  'prepared',
  'old_directory_moved',
  'old_moved',
  'candidate_published',
  'published',
  'verified',
]) {
  test(`SIGKILL at ${point} retains stable lock and journal, then exact complete or rollback`, async () => {
    const f = await fixture();
    const module = new URL('../../../src/maintenance/restore.ts', import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import {runProfileRestore} from ${JSON.stringify(module)}; await runProfileRestore(${JSON.stringify(f.input)},async point=>{if(point===${JSON.stringify(point)}){console.log(point);await new Promise(()=>setInterval(()=>{},1000));}});`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain(point);
      await fails(openSqliteStore(f.profile), 'owner_busy');
      const other = acquireProfileAccess(
        { dataRoot: f.profile.dataRoot, profile: 'other' },
        'exclusive',
      );
      other.lock.release();
      const observation = inspectProfileRestore({ profile: f.profile })!;
      expect(observation.journal.profileAccessKey).toBe(f.selected.profileAccessKey);
      child.kill('SIGKILL');
      await child.exited;
      const exists = existsSync(f.selected.profilePath);
      await fails(openSqliteStore(f.profile), 'restore_reconciliation_required');
      expect(existsSync(f.selected.profilePath)).toBe(exists);
      await fails(
        reconcileProfileRestore({
          profile: f.profile,
          restoreId: observation.journal.restoreId,
          expectedJournalDigest: '0'.repeat(64),
          decision: 'complete',
        }),
        'restore_journal_mismatch',
      );
      const decision = ['old_directory_moved', 'candidate_published', 'verified'].includes(point)
        ? 'rollback'
        : 'complete';
      const result = await reconcileProfileRestore({
        profile: f.profile,
        restoreId: observation.journal.restoreId,
        expectedJournalDigest: observation.digest,
        decision,
      });
      expect(result.outcome).toBe(decision === 'complete' ? 'restored' : 'rolled_back');
      expect(inspectProfileRestore({ profile: f.profile })).toBeNull();
      expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(
        decision === 'complete' ? configBytes : Buffer.from('later current configuration'),
      );
      expect(readFileSync(join(f.selected.profilePath, 'ui/preferences.jsonc'))).toEqual(
        decision === 'complete' ? preferenceBytes : Buffer.from('later preference bytes'),
      );
      expect(readFileSync(join(f.selected.profilePath, 'skill-workflow.jsonc'))).toEqual(
        decision === 'complete' ? workflowBytes : Buffer.from('later workflow bytes'),
      );
      const ui = await nodeAssets(f.directory, f.profile, f.storeId, 'read');
      expect(ui.count).toBe(decision === 'complete' ? 133 : 134);
      expect(ui.creations[0]?.input.expectedStoreId).toBe(f.storeId);
      expect(ui.creations[0]?.phase).toBe('unknown');
      expect(ui.recoveries).toHaveLength(decision === 'complete' ? 1 : 2);
      expect(ui.recoveries[0]).toMatchObject({
        storeId: f.storeId,
        sessionId: 's',
        commandId: 'original-recovery',
        phase: 'outcome_unknown',
      });
      const recovery = JSON.parse(
        readFileSync(join(f.selected.profilePath, 'ui/recovery.json'), 'utf8'),
      );
      expect(recovery.records).toHaveLength(decision === 'complete' ? 3 : 4);
      expect(
        recovery.records.every(
          (row: { intent: { request: { expectedStoreId: string } } }) =>
            row.intent.request.expectedStoreId === f.storeId,
        ),
      ).toBe(true);

      const tui = JSON.parse(readFileSync(join(f.selected.profilePath, 'ui', 'tui.json'), 'utf8'));
      expect(tui.drafts[0].storeId).toBe(f.storeId);
      expect(tui.drafts[0].text).toBe(decision === 'complete' ? tuiText : 'later unsent original');
      const reopened = await openSqliteStore({ ...f.profile, mode: 'readonly' });
      try {
        expect((await reopened.getMetadata()).storeId).toBe(result.storeId);
        expect((await reopened.getSession('s'))?.title).toBe(
          decision === 'complete' ? 'backup title' : 'later current title',
        );
      } finally {
        await reopened.close();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      f.close();
    }
  }, 30000);
}

test('preflight does not create a missing profile and changed preserved data cannot be guessed through reconciliation', async () => {
  const f = await fixture();
  try {
    await fails(
      restoreProfileBackup({ ...f.input, expectedStoreId: 'wrong' }),
      'store_identity_mismatch',
    );
    let error: unknown;
    try {
      await restoreProfileBackup({
        ...f.input,
        profile: { dataRoot: join(f.directory, 'missing'), profile: 'missing' },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(existsSync(join(f.directory, 'missing'))).toBe(false);
    await fails(
      runProfileRestore(f.input, async (point) => {
        if (point === 'old_moved') throw new Error('fixture pause');
      }),
      'fixture pause',
    );
    const observed = inspectProfileRestore({ profile: f.profile })!;
    writeFileSync(
      join(f.profile.dataRoot, observed.journal.preservedName, 'unexpected'),
      'changed',
      { mode: 0o600 },
    );
    await fails(
      reconcileProfileRestore({
        profile: f.profile,
        restoreId: observed.journal.restoreId,
        expectedJournalDigest: observed.digest,
        decision: 'complete',
      }),
      'restore_content_changed',
    );
    expect(
      readFileSync(join(f.selected.coordinationPath, 'restore-journal.json'), 'utf8'),
    ).toContain(observed.journal.restoreId);
    expect(existsSync(f.selected.profilePath)).toBe(false);
  } finally {
    f.close();
  }
});
