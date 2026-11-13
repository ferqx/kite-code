import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { executionEvidenceToolId } from '../../../src/business/execution-evidence';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

async function rejects(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

async function fixture() {
  const root = temporaryDirectory('kite-evidence-store-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'owned',
    rootUri: 'file:///fixture',
  });
  const base = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  await store.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'original',
  });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'Actual task' },
  });
  const owner = (await store.acquireSessionOwner(base.sessionId, 'host'))!;
  const write = { expectedStoreId, owner };
  const run = await store.startRun({
    ...write,
    commandId: 'work',
    configuration: {
      tools: [
        { id: executionEvidenceToolId, version: '1', extensionId: 'builtin.execution-evidence' },
        { id: 'files.edit', version: '2', extensionId: 'builtin.files' },
        { id: 'shell.launch', version: '1', extensionId: 'builtin.shell' },
        { id: 'task.spawn', version: '1', extensionId: 'builtin.task' },
        { id: 'task.follow_up', version: '1', extensionId: 'builtin.task' },
      ],
    },
  });
  const db = new Database(join(root, 'test/core.db'));
  async function add(
    id: string,
    definitionId = 'files.edit',
    input: Json = { path: `${id}.ts` },
    kind: 'tool' | 'job' | 'model' = 'tool',
  ) {
    const execution = await store.planExecution({
      ...write,
      executionId: id,
      sessionId: base.sessionId,
      runId: run.id,
      originCommandId: 'work',
      stepId: id,
      callId: id,
      kind: kind === 'job' ? 'tool' : kind,
      definitionId,
      definitionVersion: definitionId === 'files.edit' ? '2' : '1',
      input,
      decisionSource: { kind: 'fixture' },
    });
    db.query("UPDATE execution SET state='succeeded',result_json=? WHERE id=?").run(
      JSON.stringify({ outcome: 'succeeded', content: `original result ${id}` }),
      id,
    );
    db.query('UPDATE execution SET owner_generation=?,dispatched=1 WHERE id=?').run(
      owner.generation,
      id,
    );
    if (kind === 'job') db.query("UPDATE execution SET kind='job' WHERE id=?").run(id);
    return execution;
  }
  const request = (callerExecutionId = 'reader') => ({
    expectedStoreId,
    sessionId: base.sessionId,
    runId: run.id,
    callerExecutionId,
    limit: 100,
  });
  return {
    root,
    store,
    db,
    run,
    add,
    async job(key: string, parentExecutionId: string) {
      db.query("UPDATE execution SET state='running' WHERE id=?").run(parentExecutionId);
      const operation = await store.ensureOperation({
        ...write,
        sessionId: base.sessionId,
        extensionId: 'builtin.files',
        originCommandId: 'work',
        parentExecutionId,
        operationKey: key,
        request: {
          kind: 'job',
          definitionId: 'shell.command',
          definitionVersion: '1',
          input: { command: 'silent editor' },
        },
      });
      db.query("UPDATE execution SET state='succeeded' WHERE id=?").run(parentExecutionId);
      return operation.executionId!;
    },
    request,
    async child(key: string, parentExecutionId: string) {
      db.query("UPDATE execution SET state='running' WHERE id=?").run(parentExecutionId);
      const ref = await store.ensureOperation({
        ...write,
        sessionId: base.sessionId,
        extensionId: 'builtin.task',
        originCommandId: 'work',
        parentExecutionId,
        operationKey: key,
        request: { kind: 'agent', configurationId: 'worker', input: { content: 'Scoped child' } },
        childConfiguration: { id: 'worker', version: '1', snapshot: {} },
      });
      await store.markDispatching({
        ...write,
        executionId: ref.executionId!,
        authorization: {
          allowed: true,
          revision: 'fixture',
          definitionVersion: '1',
          inputDigest: await semanticDigest({ content: 'Scoped child' }),
        },
        requirements: [],
        freshness: { checked: true, source: { kind: 'fixture' } },
      });
      const activation = await store.activateChildRun({
        ...write,
        executionId: ref.executionId!,
        configuration: {},
        requirementEvaluations: [],
        freshness: { checked: true, source: { kind: 'fixture' } },
      });
      await store.markRunning({
        ...write,
        executionId: ref.executionId!,
        reference: { runId: activation.run.id, childSessionId: ref.childSessionId! },
      });
      db.query("UPDATE run SET status='completed',is_active=0 WHERE id=?").run(activation.run.id);
      db.query("UPDATE execution SET state='succeeded',result_json=? WHERE id=?").run(
        JSON.stringify({
          outcome: 'succeeded',
          content: 'Child report',
          details: { evidence: { marker: 'ORIGINAL_PUBLIC_EVIDENCE' } },
        }),
        ref.executionId!,
      );
      db.query("UPDATE execution SET state='succeeded' WHERE id=?").run(parentExecutionId);
      return {
        ...ref,
        executionId: ref.executionId!,
        childSessionId: ref.childSessionId!,
        runId: activation.run.id,
      };
    },
    write,
    async close() {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('parent reads its exact current-task child carrier public result while child internals and unrelated scopes stay private', async () => {
  const f = await fixture();
  try {
    await f.add('spawn', 'task.spawn', { prompt: 'Scoped child' });
    const ref = await f.child('child', 'spawn');
    await f.add('reader', executionEvidenceToolId, {});
    const detail = await f.store.readExecutionEvidence({
      ...f.request(),
      executionId: ref.executionId,
    });
    expect(detail.items[0]!.execution).toMatchObject({
      id: ref.executionId,
      kind: 'job',
      runId: null,
      result: {
        content: 'Child report',
        details: { evidence: { marker: 'ORIGINAL_PUBLIC_EVIDENCE' } },
      },
    });
    expect(
      (await f.store.readExecutionEvidence(f.request())).items.map((item) => item.execution.id),
    ).toContain(ref.executionId!);
    expect(detail.items[0]!.execution).not.toHaveProperty('input');
    for (const [column, value] of [
      ['session_id', ref.childSessionId],
      ['root_work_command_id', 'foreign'],
      ['parent_execution_id', null],
    ] as const) {
      const prior = f.db
        .query(`SELECT ${column} AS value FROM execution WHERE id=?`)
        .get(ref.executionId!) as { value: string | null };
      f.db.query(`UPDATE execution SET ${column}=? WHERE id=?`).run(value, ref.executionId!);
      await rejects(
        f.store.readExecutionEvidence({ ...f.request(), executionId: ref.executionId }),
        'execution_evidence_scope_denied',
      );
      f.db.query(`UPDATE execution SET ${column}=? WHERE id=?`).run(prior.value, ref.executionId!);
    }
    await f.add('private-child-tool');
    f.db
      .query("UPDATE execution SET session_id=? WHERE id='private-child-tool'")
      .run(ref.childSessionId!);
    await rejects(
      f.store.readExecutionEvidence({ ...f.request(), executionId: 'private-child-tool' }),
      'execution_evidence_scope_denied',
    );
    for (const [table, id, column, value] of [
      ['execution', 'spawn', 'run_id', 'other-parent-run'],
      ['command', ref.commandId, 'subject_id', 'other-subject'],
      ['command', ref.commandId, 'request_digest', '0'.repeat(64)],
      ['run', ref.runId, 'root_work_command_id', 'other-work'],
    ] as const) {
      const prior = f.db.query(`SELECT ${column} AS value FROM ${table} WHERE id=?`).get(id) as {
        value: string;
      };
      f.db.query(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, id);
      await rejects(
        f.store.readExecutionEvidence({ ...f.request(), executionId: ref.executionId }),
        'execution_evidence_scope_denied',
      );
      f.db.query(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(prior.value, id);
    }
    f.db.query("UPDATE execution SET adapter_id='custom-task' WHERE id='spawn'").run();
    await rejects(
      f.store.readExecutionEvidence({ ...f.request(), executionId: ref.executionId }),
      'execution_evidence_scope_denied',
    );
  } finally {
    await f.close();
  }
});

test('parent current task reads the exact follow-up carrier without confusing its predecessor or child Run', async () => {
  const f = await fixture();
  try {
    await f.add('spawn', 'task.spawn');
    const first = await f.child('child', 'spawn');
    await f.add('follow-up', 'task.follow_up');
    f.db.query("UPDATE execution SET state='running' WHERE id='follow-up'").run();
    const child = (await f.store.getSession(first.childSessionId!))!;
    const next = await f.store.ensureAgentFollowUp({
      ...f.write,
      sessionId: 'session',
      extensionId: 'builtin.task',
      originCommandId: 'work',
      parentExecutionId: 'follow-up',
      operationKey: 'followup',
      previous: first,
      afterRunId: first.runId,
      contextSelectionId: child.contextSelectionId,
      request: {
        kind: 'agent',
        configurationId: 'worker',
        input: { content: 'Complete remaining work' },
      },
      childConfiguration: { id: 'worker', version: '1', snapshot: {} },
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: next.executionId!,
      authorization: {
        allowed: true,
        revision: 'fixture',
        definitionVersion: '1',
        inputDigest: await semanticDigest({ content: 'Complete remaining work' }),
      },
      requirements: [],
      freshness: { checked: true, source: { kind: 'fixture' } },
    });
    const activated = await f.store.activateChildRun({
      ...f.write,
      executionId: next.executionId!,
      configuration: {},
      requirementEvaluations: [],
      freshness: { checked: true, source: { kind: 'fixture' } },
    });
    await f.store.markRunning({
      ...f.write,
      executionId: next.executionId!,
      reference: { runId: activated.run.id },
    });
    f.db
      .query("UPDATE execution SET state='succeeded',result_json=? WHERE id=?")
      .run(
        JSON.stringify({ outcome: 'succeeded', content: 'Exact follow-up public report' }),
        next.executionId!,
      );
    await f.add('reader', executionEvidenceToolId, {});
    const result = await f.store.readExecutionEvidence({
      ...f.request(),
      executionId: next.executionId!,
    });
    expect(result.items[0]!.execution.result).toEqual({
      outcome: 'succeeded',
      content: 'Exact follow-up public report',
    });
    const firstResult = await f.store.readExecutionEvidence({
      ...f.request(),
      executionId: first.executionId,
    });
    expect(firstResult.items[0]!.execution.result).toMatchObject({ content: 'Child report' });
    f.db
      .query('UPDATE execution SET reference_json=? WHERE id=?')
      .run(JSON.stringify({ runId: first.runId }), next.executionId!);
    await rejects(
      f.store.readExecutionEvidence({ ...f.request(), executionId: next.executionId! }),
      'execution_evidence_scope_denied',
    );
  } finally {
    await f.close();
  }
});

test('scoped Store evidence paginates beyond 200 with a frozen upper bound and retains original public detail', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 205; i++) await f.add(`edit-${i}`);
    await f.add('private-model', 'fixed', { secret: 'PRIVATE_MODEL_REQUEST' }, 'model');
    await f.add('reader', executionEvidenceToolId, {});
    const first = await f.store.readExecutionEvidence(f.request());
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]!.paths).toEqual([{ path: 'edit-0.ts', source: 'files_input' }]);
    await f.add('late-edit');
    await f.add('reader-two', executionEvidenceToolId, {});
    const second = await f.store.readExecutionEvidence({
      ...f.request('reader-two'),
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(100);
    const third = await f.store.readExecutionEvidence({
      ...f.request('reader-two'),
      cursor: second.nextCursor!,
    });
    expect(third.items).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.execution.id);
    expect(new Set(ids).size).toBe(205);
    expect(ids).not.toContain('late-edit');
    expect(ids).not.toContain('private-model');
    const detail = await f.store.readExecutionEvidence({ ...f.request(), executionId: 'edit-0' });
    expect(detail.items[0]!.execution.result).toEqual({
      outcome: 'succeeded',
      content: 'original result edit-0',
    });
    expect(detail.items[0]!.execution).not.toHaveProperty('input');
    expect(detail.items[0]!.execution).not.toHaveProperty('decisionSource');
  } finally {
    await f.close();
  }
});

test('Store evidence includes only real Job ancestry and exact registered target metadata, without guessing Shell changes', async () => {
  const f = await fixture();
  try {
    await f.add('parent-tool');
    const jobId = await f.job('real-job', 'parent-tool');
    f.db
      .query("UPDATE execution SET state='outcome_unknown',result_json=? WHERE id=?")
      .run(JSON.stringify({ outcome: 'outcome_unknown', content: 'Original stop unknown' }), jobId);
    await f.add('orphan-job', 'shell.command', {}, 'job');
    f.db
      .query("UPDATE execution SET run_id=NULL,parent_execution_id=NULL WHERE id='orphan-job'")
      .run();
    await f.add('shell-launch', 'shell.launch', {
      command: 'not parsed',
      key: 'DO_NOT_GUESS_FROM_INPUT',
    });
    f.db.query("UPDATE execution SET result_json=? WHERE id='shell-launch'").run(
      JSON.stringify({
        outcome: 'succeeded',
        content: JSON.stringify({ accepted: true, shellId: 'original-shell-reference' }),
      }),
    );
    await f.add('fake-files', 'files.edit');
    f.db.query("UPDATE execution SET definition_version='future' WHERE id='fake-files'").run();
    await f.add('reader', executionEvidenceToolId, {});
    const result = await f.store.readExecutionEvidence(f.request());
    expect(result.items.map((item) => item.execution.id)).toEqual([
      'parent-tool',
      jobId,
      'shell-launch',
      'fake-files',
    ]);
    const job = result.items.find((item) => item.execution.id === jobId)!;
    expect(job).toMatchObject({
      taskRunId: f.run.id,
      paths: [],
      execution: { runId: null, status: 'outcome_unknown' },
    });
    expect(job.shellId).toBeUndefined();
    expect(result.items.find((item) => item.execution.id === 'shell-launch')!.shellId).toBe(
      'original-shell-reference',
    );
    expect(result.items.find((item) => item.execution.id === 'fake-files')!.paths).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_GUESS_FROM_INPUT');
  } finally {
    await f.close();
  }
});

test('Store evidence rejects foreign Session, Run, Model IDs, forged cursors and caller identity before returning evidence', async () => {
  const f = await fixture();
  try {
    await f.add('edit-a');
    await f.add('edit-b');
    await f.add('private-model', 'fixed', { secret: 'PRIVATE_MODEL_REQUEST' }, 'model');
    await f.add('reader', executionEvidenceToolId, {});
    const first = await f.store.readExecutionEvidence({ ...f.request(), limit: 1 });
    await rejects(
      f.store.readExecutionEvidence({ ...f.request(), executionId: 'private-model' }),
      'execution_evidence_scope_denied',
    );
    await rejects(
      f.store.readExecutionEvidence({ ...f.request(), sessionId: 'foreign' }),
      'execution_evidence_scope_denied',
    );
    await rejects(
      f.store.readExecutionEvidence({ ...f.request(), runId: 'foreign' }),
      'execution_evidence_scope_denied',
    );
    await rejects(
      f.store.readExecutionEvidence(f.request('edit-a')),
      'execution_evidence_scope_denied',
    );
    const original = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    for (const patch of [
      { sessionId: 'foreign' },
      { runId: 'foreign' },
      { upperRowid: '9223372036854775807' },
      { anchorExecutionId: 'edit-a' },
      { afterRowid: '99999999' },
    ]) {
      const cursor = Buffer.from(JSON.stringify({ ...original, ...patch })).toString('base64url');
      await rejects(
        f.store.readExecutionEvidence({ ...f.request(), cursor }),
        'execution_evidence_cursor_invalid',
      );
    }
    f.db.query("UPDATE command SET subject_id='another-subject' WHERE id='work'").run();
    await rejects(f.store.readExecutionEvidence(f.request()), 'execution_evidence_scope_denied');
  } finally {
    await f.close();
  }
});

test('detail exposes only checkpoint metadata bound to the exact original file operation and task', async () => {
  const f = await fixture();
  try {
    await f.add('edit-a');
    await f.add('reader', executionEvidenceToolId, {});
    f.db
      .query("UPDATE execution SET decision_source_json=? WHERE id='edit-a'")
      .run(JSON.stringify({ kind: 'model_decision', modelExecutionId: 'original-model' }));
    const id = 'a'.repeat(64);
    const source = {
      executionId: 'edit-a',
      runId: f.run.id,
      definitionId: 'files.edit',
      definitionVersion: '2',
      attempt: 1,
      inputDigest: await semanticDigest({ path: 'edit-a.ts' }),
      modelExecutionId: 'original-model',
      modelInputHash: 'b'.repeat(64),
    };
    const put = (key: string, type: string, value: unknown) =>
      f.db
        .query(
          "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('builtin.files','session','session',?,1,?,1,?,?)",
        )
        .run(key, type, f.run.originStoreId, JSON.stringify(value));
    put(`checkpoint/${id}/point`, 'builtin.files.checkpoint', {
      id,
      boundary: {
        storeId: f.run.originStoreId,
        workspaceId: 'workspace',
        sessionId: 'session',
        runId: f.run.id,
      },
    });
    const file = {
      checkpointId: id,
      path: 'edit-a.ts',
      first: { source },
      last: null,
      pending: null,
      state: 'captured',
      secretPreimage: 'DO_NOT_EXPOSE_PREIMAGE',
    };
    put(`checkpoint/${id}/file/path`, 'builtin.files.checkpoint.file', file);
    const detail = await f.store.readExecutionEvidence({ ...f.request(), executionId: 'edit-a' });
    expect(detail.items[0]!.checkpoint).toEqual({ id, state: 'captured' });
    expect(JSON.stringify(detail)).not.toContain('DO_NOT_EXPOSE_PREIMAGE');
    f.db
      .query(
        "UPDATE extension_record SET json=? WHERE content_type='builtin.files.checkpoint.file'",
      )
      .run(JSON.stringify({ ...file, first: { source: { ...source, attempt: 2 } } }));
    const mismatched = await f.store.readExecutionEvidence({
      ...f.request(),
      executionId: 'edit-a',
    });
    expect(mismatched.items[0]!.checkpoint).toBeUndefined();
    expect(mismatched.items[0]!.paths).toEqual([{ path: 'edit-a.ts', source: 'files_input' }]);
  } finally {
    await f.close();
  }
});
