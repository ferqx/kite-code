import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../apps/service/src';
import { BackgroundExecutionPageSchema } from '../../../apps/service/src/http/schema';
import { semanticDigest } from '../../../packages/agent/src/json';

test('public background directory reads all original Jobs beyond history, scopes before paging and fences snapshots without writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-background-directory-'));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' }),
    storeId = (await store.getMetadata()).storeId;
  const db = new Database(join(root, 'test', 'core.db'));
  let models = 0;
  const runtime = createRuntime({
    store,
    model: {
      async *stream() {
        models++;
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'deny' };
      },
    },
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  const source = { kind: 'model_decision', modelExecutionId: 'fixture' };
  try {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'w',
      rootUri: 'file:///disposable',
    });
    for (const [sessionId, subjectId] of [
      ['s', 'owner'],
      ['foreign', 'other'],
    ])
      await store.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId: sessionId!,
        subjectId: subjectId!,
        workspaceId: 'w',
        title: sessionId!,
      });
    await store.acceptCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'fixture' },
    });
    const owner = (await store.acquireSessionOwner('s', 'fixture'))!,
      run = await store.startRun({
        expectedStoreId: storeId,
        owner,
        commandId: 'work',
        configuration: { tools: [{ id: 'fixture/parent', version: '1', extensionId: 'fixture' }] },
      });
    for (let i = 0; i < 205; i++)
      await store.planExecution({
        expectedStoreId: storeId,
        owner,
        executionId: `history-${i}`,
        sessionId: 's',
        runId: run.id,
        originCommandId: 'work',
        stepId: `step-${i}`,
        callId: `call-${i}`,
        kind: 'tool',
        definitionId: 'fixture/parent',
        definitionVersion: '1',
        input: { large: 'x'.repeat(1024) },
        decisionSource: source,
      });
    await store.markDispatching({
      expectedStoreId: storeId,
      owner,
      executionId: 'history-0',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({ large: 'x'.repeat(1024) }),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    const add = async (key: string, agent = false) =>
      store.ensureOperation({
        expectedStoreId: storeId,
        owner,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: 'work',
        parentExecutionId: 'history-0',
        operationKey: key,
        request: agent
          ? { kind: 'agent', configurationId: 'child', input: { task: 'fixture' } }
          : { kind: 'job', definitionId: 'fixture/job', definitionVersion: '1', input: {} },
        ...(agent
          ? {
              childConfiguration: {
                id: 'child',
                version: '1',
                snapshot: {
                  tools: [{ id: 'fixture/parent', version: '1', extensionId: 'fixture' }],
                },
              },
            }
          : {}),
      });
    for (let i = 0; i < 205; i++) await add(`job-${i}`);
    const child = await add('child', true);
    await store.planExecution({
      expectedStoreId: storeId,
      owner,
      executionId: child.executionId!,
      sessionId: 's',
      runId: null,
      originCommandId: child.commandId,
      parentExecutionId: 'history-0',
      stepId: `operation-${child.commandId}`,
      callId: child.commandId,
      kind: 'job',
      definitionId: 'agent/child',
      definitionVersion: '1',
      input: { task: 'fixture' },
      decisionSource: source,
    });
    await store.markDispatching({
      expectedStoreId: storeId,
      owner,
      executionId: child.executionId!,
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({ task: 'fixture' }),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    const activation = await store.activateChildRun({
      expectedStoreId: storeId,
      owner,
      executionId: child.executionId!,
      configuration: { tools: [{ id: 'fixture/parent', version: '1', extensionId: 'fixture' }] },
      requirementEvaluations: [],
      freshness: { checked: true, source },
    });
    await store.planExecution({
      expectedStoreId: storeId,
      owner,
      executionId: 'nested-parent',
      sessionId: activation.session.id,
      runId: activation.run.id,
      originCommandId: activation.command.id,
      stepId: 'nested',
      callId: 'nested',
      kind: 'tool',
      definitionId: 'fixture/parent',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await store.markDispatching({
      expectedStoreId: storeId,
      owner,
      executionId: 'nested-parent',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    const nested = await store.ensureOperation({
      expectedStoreId: storeId,
      owner,
      sessionId: activation.session.id,
      extensionId: 'fixture',
      originCommandId: activation.command.id,
      parentExecutionId: 'nested-parent',
      operationKey: 'nested-job',
      request: { kind: 'job', definitionId: 'fixture/job', definitionVersion: '1', input: {} },
    });
    const probe = await store.listBackgroundExecutions({
      expectedStoreId: storeId,
      subjectId: 'owner',
    });
    BackgroundExecutionPageSchema.parse(probe);
    service = await startService({
      runtime,
      profile: { dataRoot: root, name: 'test', accessKey: 'background' },
      buildId: 'test',
      subjectId: 'owner',
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: { dataRoot: root, name: 'test', accessKey: 'background' },
        apiMajor: 1,
        requiredCapabilities: ['sessions'],
      },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    // A later unrelated child Run must never replace the exact carrier's original Run.
    const copyRow = (table: string, originalId: string, override: Record<string, unknown>) => {
      const row = db.query(`SELECT * FROM ${table} WHERE id=?`).get(originalId) as Record<
        string,
        unknown
      >;
      Object.assign(row, override);
      const keys = Object.keys(row);
      db.query(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ).run(...(Object.values(row) as never[]));
    };
    copyRow('command', activation.command.id, {
      id: 'later-child-command',
      seq: 9999,
      status: 'applied',
    });
    copyRow('run', activation.run.id, {
      id: 'later-child-run',
      origin_command_id: 'later-child-command',
      is_active: 0,
      status: 'completed',
    });
    const baseline = (await store.getMetadata()).lastChangeCursor;
    const counts = () =>
      ['command', 'run', 'execution', 'change_event', 'execution_output'].map(
        (table) =>
          (db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
      );
    const beforeCounts = counts();
    const first = await client.listBackgroundExecutions(
      { storeId },
      { signal: AbortSignal.timeout(3000) },
    );
    expect(first.items).toHaveLength(200);
    expect(first.items[0]!.seq).toBe('206');
    const all = await client.listAllBackgroundExecutions({ signal: AbortSignal.timeout(3000) });
    expect(all).toHaveLength(207);
    expect(new Set(all.map((i) => i.execution.id)).size).toBe(207);
    expect(
      all.every(
        (i) =>
          !('input' in i.execution) && !('result' in i.execution) && !('reference' in i.execution),
      ),
    ).toBe(true);
    const carrier = all.find((i) => i.execution.id === child.executionId)!;
    expect(carrier.childSession?.id).toBe(child.childSessionId);
    expect(carrier.childRun?.id).toBe(activation.run.id);
    expect(carrier.run?.id).toBe(run.id);
    const descendant = all.find((i) => i.execution.id === nested.executionId)!;
    expect(descendant.session.id).toBe(activation.session.id);
    expect(descendant.rootSession.id).toBe('s');
    expect(descendant.run?.id).toBe(activation.run.id);
    expect(
      (
        await store.listBackgroundExecutions({
          expectedStoreId: storeId,
          subjectId: 'other',
          limit: 1,
        })
      ).items,
    ).toHaveLength(0);
    expect(await client.listAllBackgroundExecutions({ workspaceId: 'absent' })).toHaveLength(0);
    expect(
      (await client.listBackgroundExecutions({ storeId, executionId: child.executionId! })).items,
    ).toHaveLength(1);
    expect((await store.getMetadata()).lastChangeCursor).toBe(baseline);
    expect(counts()).toEqual(beforeCounts);
    expect(models).toBe(0);
    db.run('UPDATE execution SET reference_json=? WHERE id=?', [
      JSON.stringify({ runId: 'later-child-run' }),
      child.executionId!,
    ]);
    const failed = await store
      .listBackgroundExecutions({
        expectedStoreId: storeId,
        subjectId: 'owner',
        executionId: child.executionId!,
      })
      .then(
        () => null,
        (error) => error.code,
      );
    expect(failed).toBe('directory_identity_conflict');
    db.run('UPDATE execution SET reference_json=? WHERE id=?', [
      JSON.stringify({ runId: activation.run.id }),
      child.executionId!,
    ]);
    await add('late');
    const second = await client.listBackgroundExecutions({
      storeId,
      afterSeq: first.nextAfterSeq!,
      upperSeq: first.upperSeq,
    });
    expect(second.items).toHaveLength(7);
    expect(second.nextAfterSeq).toBeNull();
    await expect(
      client.listBackgroundExecutions({
        storeId,
        afterSeq: first.nextAfterSeq!,
        upperSeq: first.upperSeq,
        snapshotCursor: first.snapshotCursor,
      }),
    ).rejects.toMatchObject({ code: 'directory_changed', status: 409 });
    const raw = await fetch(
      `${service.endpoint}/v1/background-executions?storeId=${storeId}&subjectId=other`,
      { headers: { authorization: `Bearer ${service.bootstrap.token}` } },
    );
    expect(raw.status).toBe(400);
    await raw.body?.cancel();
    await expect(
      store.listBackgroundExecutions({ expectedStoreId: 'wrong', subjectId: 'owner' }),
    ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    await expect(
      store.listBackgroundExecutions({ expectedStoreId: storeId, subjectId: 'owner', limit: 201 }),
    ).rejects.toMatchObject({ code: 'invalid_page' });
    db.run('UPDATE command SET subject_id=? WHERE id=?', ['other', nested.commandId]);
    expect(
      (await client.listBackgroundExecutions({ storeId, executionId: nested.executionId! })).items,
    ).toHaveLength(0);
    db.run('UPDATE command SET subject_id=? WHERE id=?', ['owner', nested.commandId]);
    db.run('UPDATE session SET parent_id=? WHERE id=?', ['foreign', activation.session.id]);
    expect(
      (await client.listBackgroundExecutions({ storeId, executionId: nested.executionId! })).items,
    ).toHaveLength(0);
    db.run('UPDATE session SET parent_id=? WHERE id=?', ['s', activation.session.id]);
    db.run('UPDATE session SET delete_requested=1 WHERE id=?', [activation.session.id]);
    expect(
      (await client.listBackgroundExecutions({ storeId, executionId: nested.executionId! })).items,
    ).toHaveLength(0);
    // Tombstone exclusion applies to the whole owned subtree, before LIMIT.
    db.run('UPDATE session SET delete_requested=1 WHERE id=?', ['s']);
    expect(await client.listAllBackgroundExecutions()).toHaveLength(0);
    client.disposeNetwork();
  } finally {
    await service?.close();
    await runtime.close();
    db.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
