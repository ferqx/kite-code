import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { openAutomaticTitleOperation } from '../../../src/business/session-title/operation';
import {
  automaticTitleIdentity,
  automaticTitleRecord,
  readAutomaticTitleAttempt,
} from '../../../src/business/session-title/state';
import { semanticDigest } from '../../../src/json';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { isStorageRequestSettled } from '../../../src/storage/transaction-state';
import type { Json } from '../../../src/storage/types';
import { AgentError } from '../../../src/storage/types';

async function fixture() {
  const root = temporaryDirectory('kite-title-publication-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: '' });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const base = { expectedStoreId, owner };
  await store.acceptCommand({
    ...scope,
    commandId: 'work',
    request: { kind: 'run.start', content: '原始输入内容' },
  });
  const claimed = (await store.claimAutomaticSessionTitle({ ...scope, sourceCommandId: 'work' }))!;
  const input = { commandId: 'work' };
  const commandId = `lifecycle-${await semanticDigest({ phase: 'before_start', commandId: 'work', extensionId: automaticTitleRecord.extensionId })}`;
  await store.acceptCommand({
    ...scope,
    commandId,
    request: {
      kind: 'extension.invoke',
      extensionId: automaticTitleRecord.extensionId,
      actionId: 'fallback',
      definitionVersion: '1',
      input,
    },
  });
  const source: Json = {
    kind: 'action_decision',
    commandId,
    extensionId: automaticTitleRecord.extensionId,
    actionId: 'fallback',
    definitionVersion: '1',
    preparedDigest: await semanticDigest(input),
    sources: [],
    reads: [],
    recordReads: [],
    recordListReads: [],
  };
  await store.planAction({
    ...base,
    commandId,
    executionId: 'fallback',
    extensionId: automaticTitleRecord.extensionId,
    definitionId: 'builtin.session-title/fallback',
    definitionVersion: '1',
    input,
    decisionSource: source,
  });
  const dispatch = (executionId: string) =>
    store.markDispatching({
      ...base,
      executionId,
      authorization: {
        allowed: true,
        revision: 'fixture',
        definitionVersion: '1',
        inputDigest: semanticInput,
      },
      requirements: [],
      freshness: { checked: true, source },
      ...(executionId === 'fallback' ? { readSet: { records: [], recordLists: [] } } : {}),
    });
  const semanticInput = await semanticDigest(input);
  await dispatch('fallback');
  const identity = automaticTitleIdentity(expectedStoreId, 's', 'work');
  const operation = await store.ensureOperation({
    ...base,
    sessionId: 's',
    extensionId: automaticTitleRecord.extensionId,
    originCommandId: commandId,
    parentExecutionId: 'fallback',
    operationKey: identity.operationKey,
    request: {
      kind: 'job',
      definitionId: 'builtin.session-title/generate',
      definitionVersion: '1',
      input,
    },
    cancellation: 'detached',
  });
  await store.applyExtensionAction({
    ...base,
    extensionId: automaticTitleRecord.extensionId,
    executionId: 'fallback',
    status: 'succeeded',
    result: { outcome: 'succeeded', content: 'fallback_saved' },
  });
  await dispatch(operation.executionId!);
  await store.markRunning({
    ...base,
    executionId: operation.executionId!,
    reference: { operation: operation.commandId },
  });
  const titleBase = { ...base, sessionId: 's', jobExecutionId: operation.executionId! };
  const bound = await store.bindAutomaticSessionTitle({
    ...titleBase,
    expectedRevision: claimed.record.revision,
  });
  const run = await store.startRun({
    ...base,
    commandId: 'work',
    configuration: { modelId: 'fixture' },
  });
  const ready = await store.bindAutomaticSessionTitle({
    ...titleBase,
    sourceRunId: run.id,
    expectedRevision: bound.revision,
  });
  const request = {
    requestId: 'title-model',
    modelId: 'fixture',
    messages: [{ role: 'user', content: '原始输入内容' }],
    tools: [],
  };
  const model = await store.ensureInternalModel({
    ...base,
    parentExecutionId: operation.executionId!,
    request,
  });
  await store.dispatchInternalModel({
    ...base,
    executionId: model.execution.id,
    authorization: {
      allowed: true,
      revision: 'fixture-model',
      definitionVersion: '1',
      inputDigest: await semanticDigest(request),
    },
  });
  const title = '会话优化';
  await store.finishInternalModel({
    ...base,
    executionId: model.execution.id,
    status: 'succeeded',
    result: {
      content: title,
      finishReason: 'stop',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  });
  return {
    root,
    profile,
    store,
    scope,
    base,
    titleBase,
    claimed,
    ready,
    operation,
    run,
    model,
    title,
    identity,
    publish: {
      ...titleBase,
      expectedRevision: ready.revision,
      modelExecutionId: model.execution.id,
      title,
    },
    async finish(status: 'completed' | 'failed' | 'cancelled' = 'completed') {
      return store.finishRun({ ...base, runId: run.id, status, requirements: [] });
    },
    async close() {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const refused = async (work: Promise<unknown>, code: string) =>
  expect(((await work.catch((error) => error)) as { code?: string }).code).toBe(code);

for (const publication of ['pending', 'published'] as const)
  test(`backup restoration retains the original ${publication} title facts without granting publication in the replacement Store`, async () => {
    const f = await fixture();
    let restored: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    try {
      await f.finish();
      if (publication === 'published') await f.store.publishAutomaticSessionTitle(f.publish);
      const record = await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' });
      const receipt = await f.store.getCommand(f.identity.publicationCommandId);
      const title = (await f.store.getSession('s'))!.title;
      await f.store.close();
      const backup = await createProfileBackup({
        profile: f.profile,
        destinationRoot: join(f.root, 'backups'),
      });
      const result = await restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.scope.expectedStoreId,
        backup,
        intent: 'replace_with_selected_backup',
      });
      expect(result.outcome).toBe('restored');
      expect(result.storeId).not.toBe(f.scope.expectedStoreId);
      restored = await openSqliteStore(f.profile);
      expect((await restored.getMetadata()).storeId).toBe(result.storeId);
      expect(
        await restored.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }),
      ).toEqual(record);
      expect(await restored.getCommand(f.identity.publicationCommandId)).toEqual(receipt);
      expect((await restored.getRun(f.run.id))?.originStoreId).toBe(f.scope.expectedStoreId);
      expect((await restored.getExecution(f.operation.executionId!))?.originStoreId).toBe(
        f.scope.expectedStoreId,
      );
      await refused(restored.publishAutomaticSessionTitle(f.publish), 'owner_changed');
      const owner = (await restored.acquireSessionOwner('s', 'replacement'))!;
      const current = { ...f.publish, owner };
      const cursor = (await restored.getMetadata()).lastChangeCursor;
      await refused(restored.publishAutomaticSessionTitle(current), 'store_identity_mismatch');
      await refused(
        restored.publishAutomaticSessionTitle({ ...current, expectedStoreId: result.storeId }),
        'session_title_attempt_invalid',
      );
      expect((await restored.getMetadata()).lastChangeCursor).toBe(cursor);
      expect((await restored.getSession('s'))?.title).toBe(title);
      expect(
        await restored.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }),
      ).toEqual(record);
      expect(await restored.releaseSessionOwner(owner)).toBe(true);
    } finally {
      await restored?.close();
      await f.close();
    }
  });

test.each([
  'trusted',
  'attached-impostor',
] as const)('cold owner acquisition closes only a proven abandoned naming publication: %s', async (mode) => {
  const f = await fixture();
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.finish();
    if (mode === 'attached-impostor') {
      const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
      try {
        db.run('UPDATE execution SET cancel_with_parent=1 WHERE id=?', [f.operation.executionId!]);
      } finally {
        db.close();
      }
    }
    await f.store.close();
    cold = await openSqliteStore(f.profile);
    if (mode === 'attached-impostor') {
      await refused(cold.acquireSessionOwner('s', 'cold-host'), 'recovery_required');
      expect(
        (await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }))?.value,
      ).toMatchObject({ publication: 'pending' });
    } else {
      const owner = (await cold.acquireSessionOwner('s', 'cold-host'))!;
      expect(owner.generation).toBe('2');
      const record = await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' });
      expect(record?.value).toMatchObject({
        publication: 'closed',
        closedReason: 'title_supervisor_lost',
      });
      expect((await cold.getExecution(f.operation.executionId!))?.status).toBe('running');
      expect((await cold.getExecution(f.model.execution.id))?.status).toBe('succeeded');
      expect((await cold.getSession('s'))?.title).toBe(f.claimed.session.title);
      expect(await cold.releaseSessionOwner(owner)).toBe(true);
    }
  } finally {
    await cold?.close();
    await f.close();
  }
});

test('only original completed Run publishes the exact complete Model title in one metadata transaction', async () => {
  const f = await fixture();
  try {
    await refused(
      f.store.publishAutomaticSessionTitle(f.publish),
      'session_title_run_not_complete',
    );
    expect((await f.store.getSession('s'))?.title).toBe(f.claimed.session.title);
    await f.finish();
    const value = await f.store.publishAutomaticSessionTitle(f.publish);
    expect(value.session).toMatchObject({ title: f.title, controlRevision: '0' });
    expect(value.command?.id).toBe(f.identity.publicationCommandId);
    expect(readAutomaticTitleAttempt(value.record.value)).toMatchObject({
      publication: 'published',
      publicationCommandId: value.command?.id,
      sourceRunId: f.run.id,
      modelExecutionId: f.model.execution.id,
    });
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const again = await f.store.publishAutomaticSessionTitle(f.publish);
    expect(again.command).toEqual(value.command);
    expect(again.record).toEqual(value.record);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const closed = await f.store.closeAutomaticSessionTitle({
      ...f.titleBase,
      expectedRevision: f.ready.revision,
      reason: 'late_cancel',
    });
    expect(closed).toEqual(value.record);
  } finally {
    await f.close();
  }
});

test('a manual same-name ABA closes the original attempt without publishing over user facts', async () => {
  const f = await fixture(),
    peer = await openSqliteStore(f.profile);
  try {
    await peer.renameSession({
      ...f.scope,
      commandId: 'manual-a',
      ifRevision: '0',
      title: '手动名称',
    });
    await peer.renameSession({
      ...f.scope,
      commandId: 'manual-b',
      ifRevision: '1',
      title: f.claimed.session.title,
    });
    await f.finish();
    const value = await f.store.publishAutomaticSessionTitle(f.publish);
    expect(readAutomaticTitleAttempt(value.record.value)).toMatchObject({
      publication: 'closed',
      closedReason: 'manual_title_changed',
    });
    expect(value.command).toBeNull();
    expect(value.session.controlRevision).toBe('2');
    expect(value.session.title).toBe(f.claimed.session.title);
    expect(await f.store.getCommand(f.identity.publicationCommandId)).toBeNull();
  } finally {
    await peer.close();
    await f.close();
  }
});

test.each([
  'failed',
  'cancelled',
] as const)('an original %s Run cannot borrow a later success to publish', async (status) => {
  const f = await fixture();
  try {
    await f.finish(status);
    await f.store.acceptCommand({
      ...f.scope,
      commandId: 'later',
      request: { kind: 'run.start', content: 'later work' },
    });
    const later = await f.store.startRun({
      ...f.base,
      commandId: 'later',
      configuration: { modelId: 'fixture' },
    });
    await f.store.finishRun({ ...f.base, runId: later.id, status: 'completed', requirements: [] });
    await refused(
      f.store.bindAutomaticSessionTitle({
        ...f.titleBase,
        expectedRevision: f.ready.revision,
        sourceRunId: later.id,
      }),
      'session_title_run_invalid',
    );
    const value = await f.store.publishAutomaticSessionTitle(f.publish);
    expect(readAutomaticTitleAttempt(value.record.value)?.publication).toBe('closed');
    expect(value.command).toBeNull();
    expect(value.session.title).toBe(f.claimed.session.title);
  } finally {
    await f.close();
  }
});

test('explicit resume closes abandoned naming publication without changing fallback or execution facts', async () => {
  const f = await fixture();
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let peer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const originalJob = await f.store.getExecution(f.operation.executionId!);
    const originalModel = await f.store.getExecution(f.model.execution.id);
    const fallback = (await f.store.getSession('s'))!.title;
    expect(fallback).toBe('原始输入内容');
    await f.store.close();
    cold = await openSqliteStore(f.profile);
    const input = {
      ...f.scope,
      commandId: 'resume-title-source',
      runId: f.run.id,
      expectedOwnerGeneration: f.base.owner.generation,
    };
    const state = await cold.verifyRunResume(input);
    const begun = await cold.beginRunResume({
      ...input,
      checkpoint: state.checkpoint!,
      instanceId: 'resuming-host',
    });
    expect(
      (await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }))?.value,
    ).toMatchObject({ publication: 'pending' });
    await refused(
      cold.commitRunResume({
        expectedStoreId: f.scope.expectedStoreId,
        lease: begun.lease!,
        checkpoint: state.checkpoint!,
        expectedConfiguration: { modelId: 'changed' },
      }),
      'run_configuration_changed',
    );
    expect(
      (await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }))?.value,
    ).toMatchObject({ publication: 'pending' });
    const resumed = await cold.commitRunResume({
      expectedStoreId: f.scope.expectedStoreId,
      lease: begun.lease!,
      checkpoint: state.checkpoint!,
      expectedConfiguration: { modelId: 'fixture' },
    });
    expect(
      (await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }))?.value,
    ).toMatchObject({ publication: 'closed', closedReason: 'title_supervisor_lost' });
    expect(await cold.getExecution(f.operation.executionId!)).toEqual(originalJob);
    expect(await cold.getExecution(f.model.execution.id)).toEqual(originalModel);
    expect((await cold.getSession('s'))!.title).toBe(fallback);
    await cold.finishRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: resumed.owner,
      runId: f.run.id,
      status: 'completed',
      requirements: [],
    });
    expect(await cold.releaseSessionOwner(resumed.owner)).toBe(true);
    // The original Store stays open: another Worker must acquire the real root lock now.
    peer = await openSqliteStore(f.profile);
    const nextOwner = await peer.acquireSessionOwner('s', 'next-host');
    expect(nextOwner).not.toBeNull();
    expect(await peer.releaseSessionOwner(nextOwner!)).toBe(true);
  } finally {
    await peer?.close();
    await cold?.close();
    await f.close();
  }
});

test('failed resume adoption rolls back abandoned naming closure with its receipt', async () => {
  const f = await fixture();
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.store.close();
    cold = await openSqliteStore(f.profile);
    const faultDb = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      faultDb.run(`CREATE TRIGGER fail_title_resume BEFORE UPDATE OF status ON command
        WHEN NEW.id='resume-title-source' AND NEW.status='applied'
        BEGIN SELECT RAISE(ABORT, 'injected_resume_commit_failure'); END`);
    } finally {
      faultDb.close();
    }
    const input = {
      ...f.scope,
      commandId: 'resume-title-source',
      runId: f.run.id,
      expectedOwnerGeneration: f.base.owner.generation,
    };
    const state = await cold.verifyRunResume(input);
    const begun = await cold.beginRunResume({
      ...input,
      checkpoint: state.checkpoint!,
      instanceId: 'resuming-host',
    });
    const cursor = (await cold.getMetadata()).lastChangeCursor;
    const failed = await cold
      .commitRunResume({
        expectedStoreId: f.scope.expectedStoreId,
        lease: begun.lease!,
        checkpoint: state.checkpoint!,
        expectedConfiguration: { modelId: 'fixture' },
      })
      .catch((error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(String(failed)).toContain('injected_resume_commit_failure');
    expect(
      (await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }))?.value,
    ).toMatchObject({ publication: 'pending' });
    expect((await cold.getCommand(input.commandId))?.status).toBe('accepted');
    expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await cold.getSession('s'))?.title).toBe('原始输入内容');
    await cold.releaseRunResumeLease(begun.lease!);
  } finally {
    await cold?.close();
    await f.close();
  }
});

test('publish and close have one terminal CAS winner and a foreign Worker cannot borrow the owner', async () => {
  const f = await fixture(),
    peer = await openSqliteStore(f.profile);
  try {
    await f.finish();
    await refused(
      peer.closeAutomaticSessionTitle({
        ...f.titleBase,
        expectedRevision: f.ready.revision,
        reason: 'cancelled',
      }),
      'owner_changed',
    );
    const [publication, closure] = await Promise.all([
      f.store.publishAutomaticSessionTitle(f.publish),
      f.store.closeAutomaticSessionTitle({
        ...f.titleBase,
        expectedRevision: f.ready.revision,
        reason: 'cancelled',
      }),
    ]);
    const current = await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' });
    expect(current).toEqual(publication.record);
    expect(current).toEqual(closure);
    const published = readAutomaticTitleAttempt(current!.value)?.publication === 'published';
    expect((await f.store.getSession('s'))?.title).toBe(
      published ? f.title : f.claimed.session.title,
    );
    expect((await f.store.getCommand(f.identity.publicationCommandId)) !== null).toBe(published);
  } finally {
    await peer.close();
    await f.close();
  }
});

test('publication failure after title and receipt writes rolls back the entire metadata effect', async () => {
  const f = await fixture();
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    await f.finish();
    const before = await f.store.getSession('s'),
      cursor = (await f.store.getMetadata()).lastChangeCursor;
    physical.run(
      "CREATE TRIGGER fail_title_publish BEFORE UPDATE ON extension_record WHEN NEW.key='automatic-title-attempt' AND json_extract(NEW.json,'$.publication')='published' BEGIN SELECT RAISE(ABORT,'rollback publication'); END",
    );
    const rejected = await f.store.publishAutomaticSessionTitle(f.publish).catch((error) => error);
    expect(rejected.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(isStorageRequestSettled(rejected)).toBe(true);
    expect(await f.store.getSession('s')).toEqual(before);
    expect(await f.store.getCommand(f.identity.publicationCommandId)).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' })).toEqual(
      f.ready,
    );
    physical.run('DROP TRIGGER fail_title_publish');
    expect((await f.store.publishAutomaticSessionTitle(f.publish)).command?.id).toBe(
      f.identity.publicationCommandId,
    );
  } finally {
    physical.close();
    await f.close();
  }
});

test('closing an early title is terminal even after the original Run succeeds and repeated close never changes its reason', async () => {
  const f = await fixture();
  try {
    const closed = await f.store.closeAutomaticSessionTitle({
      ...f.titleBase,
      expectedRevision: f.ready.revision,
      reason: 'cancelled',
    });
    expect(readAutomaticTitleAttempt(closed.value)).toMatchObject({
      publication: 'closed',
      closedReason: 'cancelled',
    });
    await f.finish();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect((await f.store.publishAutomaticSessionTitle(f.publish)).record).toEqual(closed);
    expect(
      await f.store.closeAutomaticSessionTitle({
        ...f.titleBase,
        expectedRevision: f.ready.revision,
        reason: 'later_failure',
      }),
    ).toEqual(closed);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getSession('s'))?.title).toBe(f.claimed.session.title);
  } finally {
    await f.close();
  }
});

test('non-title control changes preserve publication, while deletion closes its original eligibility', async () => {
  for (const deletion of [false, true]) {
    const f = await fixture();
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      await f.finish();
      if (deletion)
        await f.store.deleteSession({ ...f.scope, commandId: 'delete', ifRevision: '0' });
      else physical.run("UPDATE session SET control_revision=7 WHERE id='s'");
      const value = await f.store.publishAutomaticSessionTitle(f.publish);
      expect(readAutomaticTitleAttempt(value.record.value)?.publication).toBe(
        deletion ? 'closed' : 'published',
      );
      expect(value.session.controlRevision).toBe(deletion ? '1' : '7');
      expect(value.session.title).toBe(deletion ? f.claimed.session.title : f.title);
    } finally {
      physical.close();
      await f.close();
    }
  }
});

for (const corruption of [
  'attached',
  'foreign-key',
  'wrong-purpose',
  'wrong-root',
  'action-root',
  'model-parent',
  'partial-model',
  'wrong-title',
  'stale-record',
] as const)
  test(`publication rejects ${corruption} without a title, receipt or record effect`, async () => {
    const f = await fixture();
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      await f.finish();
      if (corruption === 'attached')
        physical.run('UPDATE execution SET cancel_with_parent=1 WHERE id=?', [
          f.operation.executionId!,
        ]);
      if (corruption === 'foreign-key')
        physical.run("UPDATE command SET operation_key='other' WHERE id=?", [
          f.operation.commandId,
        ]);
      if (corruption === 'wrong-purpose')
        physical.run("UPDATE execution SET adapter_id='fixture/generate' WHERE id=?", [
          f.operation.executionId!,
        ]);
      if (corruption === 'wrong-root')
        physical.run("UPDATE execution SET root_work_command_id='other' WHERE id=?", [
          f.operation.executionId!,
        ]);
      if (corruption === 'action-root') {
        const parent = await f.store.getExecution('fallback');
        physical.run(
          "UPDATE command SET root_work_command_id='work',root_work_seq=2 WHERE id IN (?,?)",
          [f.operation.commandId, parent!.originCommandId],
        );
        physical.run(
          "UPDATE execution SET root_work_command_id='work',root_work_seq=2 WHERE id IN ('fallback',?)",
          [f.operation.executionId!],
        );
      }
      if (corruption === 'model-parent')
        physical.run("UPDATE execution SET parent_execution_id='fallback' WHERE id=?", [
          f.model.execution.id,
        ]);
      if (corruption === 'partial-model')
        physical.run("UPDATE execution SET state='running' WHERE id=?", [f.model.execution.id]);
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      const before = await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' });
      const request = {
        ...f.publish,
        ...(corruption === 'wrong-title' ? { title: '伪造候选' } : {}),
        ...(corruption === 'stale-record' ? { expectedRevision: '1' } : {}),
      };
      const code = ['model-parent', 'partial-model'].includes(corruption)
        ? 'session_title_model_invalid'
        : corruption === 'wrong-title'
          ? 'session_title_candidate_invalid'
          : corruption === 'stale-record'
            ? 'record_revision_conflict'
            : 'session_title_job_invalid';
      await refused(f.store.publishAutomaticSessionTitle(request), code);
      expect((await f.store.getSession('s'))?.title).toBe(f.claimed.session.title);
      expect(await f.store.getCommand(f.identity.publicationCommandId)).toBeNull();
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' })).toEqual(
        before,
      );
    } finally {
      physical.close();
      await f.close();
    }
  });

test('publication receipts remain exact after a manual rename and cannot be reused by the public entry', async () => {
  const f = await fixture();
  try {
    await f.finish();
    const value = await f.store.publishAutomaticSessionTitle(f.publish);
    await f.store.renameSession({
      ...f.scope,
      commandId: 'manual',
      ifRevision: '0',
      title: '用户名称',
    });
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const again = await f.store.publishAutomaticSessionTitle(f.publish);
    expect(again.command).toEqual(value.command);
    expect(again.session.title).toBe('用户名称');
    await refused(
      f.store.renameSession({
        ...f.scope,
        commandId: f.identity.publicationCommandId,
        ifRevision: '0',
        title: f.title,
      }),
      'command_conflict',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('a lost publication reply is resolved from the original receipt and cold readonly facts without another effect', async () => {
  const f = await fixture();
  const query = {
    expectedStoreId: f.scope.expectedStoreId,
    sessionId: 's',
    jobExecutionId: f.operation.executionId!,
    modelExecutionId: f.model.execution.id,
    title: f.title,
  };
  try {
    await f.finish();
    const lost = await f.store
      .publishAutomaticSessionTitle(f.publish)
      .then(() => {
        throw Object.assign(new Error('lost reply'), { code: 'reply_lost' });
      })
      .catch((error) => error);
    expect(lost.code).toBe('reply_lost');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const receipt = await f.store.getCommand(f.identity.publicationCommandId);
    expect(receipt).toMatchObject({
      kind: 'session.rename',
      status: 'applied',
      receipt: { outcome: 'renamed', session: { title: f.title, controlRevision: '0' } },
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.readAutomaticSessionTitlePublication(query)).command).toEqual(receipt);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.store.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(await cold.getCommand(f.identity.publicationCommandId)).toEqual(receipt);
      expect((await cold.readAutomaticSessionTitlePublication(query)).command).toEqual(receipt);
      const record = await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' });
      expect(readAutomaticTitleAttempt(record!.value)).toMatchObject({
        publication: 'published',
        jobExecutionId: f.operation.executionId,
        sourceRunId: f.run.id,
        modelExecutionId: f.model.execution.id,
      });
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('an unavailable publication query preserves the shared failure and never closes an unconfirmed attempt', async () => {
  const f = await fixture();
  let publications = 0,
    closes = 0;
  const failure = new AgentError('worker_unavailable');
  const store = new Proxy(f.store, {
    get(target, key) {
      if (key === 'publishAutomaticSessionTitle')
        return async () => {
          publications++;
          throw failure;
        };
      if (key === 'readAutomaticSessionTitlePublication')
        return async () => {
          throw failure;
        };
      if (key === 'closeAutomaticSessionTitle')
        return async () => {
          closes++;
          throw Error('must not close');
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Store;
  try {
    await f.finish();
    const operation = await openAutomaticTitleOperation({
      store,
      jobExecutionId: f.operation.executionId!,
      sourceCommandId: 'work',
      owner: f.base.owner,
      signal: new AbortController().signal,
      checkpoint() {},
      wait: async () => {
        throw Error('must not wait on failed Store');
      },
    });
    await operation.activated();
    expect(await operation.publish(f.model.execution.id, f.title).catch((error) => error)).toBe(
      failure,
    );
    expect(publications).toBe(1);
    expect(closes).toBe(0);
    expect(
      (await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }))?.value,
    ).toMatchObject({ publication: 'pending' });
    expect(await f.store.getCommand(f.identity.publicationCommandId)).toBeNull();
  } finally {
    await f.close();
  }
});
