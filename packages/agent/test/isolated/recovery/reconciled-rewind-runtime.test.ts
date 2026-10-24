import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture(mode = 'running_model') {
  const directory = temporaryDirectory('kite-reconciled-rewind-');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
      directory,
      mode,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const stderr = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(directory, 'ready.json'))) {
      if (Date.now() > deadline) throw new Error('reconciled_rewind_fixture_timeout');
      await Bun.sleep(5);
    }
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    await stderr;
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
    expectedStoreId: string;
    expectedOwnerGeneration: string;
    executionId: string;
    runId: string;
  };
  child.kill('SIGKILL');
  await child.exited;
  expect(await stderr).toBe('');
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
  else expect(child.exitCode).not.toBe(0);
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const db = new Database(join(directory, 'data', 'test', 'core.db'));
  const requests: ModelRequest[] = [];
  const runtime = createRuntime({
    store,
    modelId: 'new',
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        yield { type: 'text_delta', text: 'New explicitly requested work completed' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'actual' };
      },
    },
  });
  const base = { expectedStoreId: ready.expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const reconciled = await runtime.reconcileSession({
    ...base,
    commandId: 'reconcile',
    expectedOwnerGeneration: ready.expectedOwnerGeneration,
  });
  expect(reconciled.outcome).toBe('reconciled');
  const rewind = async (commandId = 'rewind') =>
    runtime.selectContext({
      ...base,
      commandId,
      boundary: null,
      expectedContextSelectionId: (await store.getSession('s'))!.contextSelectionId,
    });
  const checkpoint = () =>
    db.query('SELECT * FROM session_reconciliation WHERE root_session_id=?').get('s');
  return {
    directory,
    profile,
    ready,
    base,
    reconciled,
    store,
    db,
    requests,
    runtime,
    rewind,
    checkpoint,
    async close() {
      await runtime.close();
      db.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const kind of ['run.start', 'input.follow_up'] as const)
  test(`SIGKILL reconciliation followed by Rewind admits new ${kind} without restoring the old Run`, async () => {
    const f = await fixture();
    try {
      expect(f.checkpoint()).not.toBeNull();
      const rewind = await f.rewind();
      expect(rewind.command.status).toBe('applied');
      const command = {
        ...f.base,
        commandId: 'new',
        request:
          kind === 'run.start'
            ? { kind, content: 'Only the new explicit task' }
            : {
                kind,
                content: 'Only the new explicit task',
                afterRunId: f.ready.runId,
                contextSelectionId: rewind.selection.id,
              },
      };
      // This public admission failed with run_resume_checkpoint_changed before
      // Rewind and retirement shared one transaction.
      await f.runtime.submitCommand(command);
      await f.runtime.waitForCommand('new', { timeoutMs: 5000 });
      expect(f.checkpoint()).toBeNull();
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.messages.filter((message) => message.role === 'user')).toEqual([
        expect.objectContaining({ content: 'Only the new explicit task', sourceIds: ['new'] }),
      ]);
      const saved = (await f.store.getCommand('new'))!;
      const runId = (saved.receipt as { runId: string }).runId;
      expect(runId).not.toBe(f.ready.runId);
      expect(await f.store.getRun(runId)).toMatchObject({ status: 'completed', isActive: false });
      expect(await f.store.getRun(f.ready.runId)).toMatchObject({
        status: 'interrupted',
        isActive: false,
        reason: 'owner_lost',
      });
      const before = await f.store.getView('s');
      expect(await f.runtime.submitCommand(command)).toEqual(saved);
      expect(
        await f.runtime.selectContext({
          ...f.base,
          commandId: 'rewind',
          boundary: null,
          expectedContextSelectionId: rewind.selection.previousSelectionId!,
        }),
      ).toEqual(rewind);
      expect(await f.store.getView('s')).toEqual(before);
      expect(f.requests).toHaveLength(1);
      const denied = await f.runtime
        .resumeRun({
          ...f.base,
          commandId: 'old-resume',
          runId: f.ready.runId,
          expectedOwnerGeneration: (await f.store.getSession('s'))!.ownerGeneration,
        })
        .catch((error) => error);
      expect(denied.code).toBe('run_not_active');
      expect(await f.store.getCommand('old-resume')).toBeNull();
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

for (const mode of ['dispatched', 'group_required'] as const)
  test(`Rewind preserves the original checkpoint when SIGKILL leaves unknown ${mode === 'dispatched' ? 'Tool' : 'child Job'} effects`, async () => {
    const f = await fixture(mode);
    try {
      const before = await f.store.getView('s');
      const saved = f.checkpoint();
      const ledger = readFileSync(join(f.directory, 'ledger'), 'utf8');
      expect(f.reconciled.report!.unknownExecutionIds.length).toBeGreaterThan(0);
      expect(before.executions.some((execution) => execution.status === 'outcome_unknown')).toBe(
        true,
      );
      const rejected = await f.rewind().catch((error) => error);
      expect(rejected.code).toBe('context_execution_unsettled');
      expect(f.checkpoint()).toEqual(saved);
      expect(await f.store.getView('s')).toEqual(before);
      expect(await f.store.getCommand('rewind')).toBeNull();
      expect(f.requests).toHaveLength(0);
      expect(readFileSync(join(f.directory, 'ledger'), 'utf8')).toBe(ledger);
      if (mode === 'group_required') {
        const children = before.executions.filter((execution) => execution.childSessionId);
        expect(children).toHaveLength(3);
        for (const carrier of children) {
          const child = await f.store.getView(carrier.childSessionId!);
          expect(child.runs.every((run) => !run.isActive)).toBe(true);
          const denied = await f.runtime
            .selectContext({
              ...f.base,
              sessionId: child.session.id,
              commandId: 'child-rewind',
              boundary: null,
              expectedContextSelectionId: child.session.contextSelectionId,
            })
            .catch((error) => error);
          expect(denied.code).toBe('group_root_required');
          expect(await f.store.getView(carrier.childSessionId!)).toEqual(child);
          expect(f.checkpoint()).toEqual(saved);
        }
      }
    } finally {
      await f.close();
    }
  });

test('Rewind rolls checkpoint retirement back with selection publication, then exact peer selection CAS admits only one branch', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    const before = await f.store.getView('s');
    const saved = f.checkpoint();
    f.db.run(`CREATE TRIGGER fail_reconciled_rewind BEFORE INSERT ON context_snapshot
      WHEN NEW.kind='selection' BEGIN SELECT RAISE(ABORT,'fixture_rewind_failure'); END`);
    const failed = await f.rewind('failed-rewind').catch((error) => error);
    expect(String(failed)).toContain('fixture_rewind_failure');
    expect(f.checkpoint()).toEqual(saved);
    expect(await f.store.getView('s')).toEqual(before);
    expect(await f.store.getCommand('failed-rewind')).toBeNull();
    f.db.run('DROP TRIGGER fail_reconciled_rewind');
    const request = {
      ...f.base,
      boundary: null,
      expectedContextSelectionId: before.session.contextSelectionId,
    };
    const attempts = await Promise.allSettled([
      f.runtime.selectContext({ ...request, commandId: 'first-rewind' }),
      peer.selectContext({ ...request, commandId: 'peer-rewind' }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason.code : null).toBe(
      'context_selection_changed',
    );
    expect(f.checkpoint()).toBeNull();
    expect(
      f.db.query("SELECT count(*) AS n FROM command WHERE kind='context.select'").get(),
    ).toEqual({
      n: 1,
    });
    expect(await f.store.getRun(f.ready.runId)).toMatchObject({
      status: 'interrupted',
      isActive: false,
    });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'new',
      request: { kind: 'run.start', content: 'Work only on the one committed branch' },
    });
    await f.runtime.waitForCommand('new', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(1);
  } finally {
    await peer.close();
    await f.close();
  }
});

for (const damage of ['checkpoint', 'execution', 'generation'] as const)
  test(`Rewind cannot discard an orphan checkpoint with damaged ${damage} proof`, async () => {
    const f = await fixture();
    try {
      // Deliberate corruption of this owned cold fixture, never a normal producer.
      if (damage === 'checkpoint')
        f.db.run(
          "UPDATE session_reconciliation SET checkpoint_json='{}' WHERE root_session_id='s'",
        );
      else if (damage === 'execution')
        f.db.run("UPDATE execution SET result_json='{}' WHERE id=?", [f.ready.executionId]);
      else f.db.run("UPDATE session SET owner_generation=owner_generation+1 WHERE id='s'");
      const before = await f.store.getView('s');
      const saved = f.checkpoint();
      const rejected = await f.rewind().catch((error) => error);
      expect(rejected.code).toBe(
        damage === 'checkpoint'
          ? 'run_resume_checkpoint_unavailable'
          : 'run_resume_checkpoint_changed',
      );
      expect(f.checkpoint()).toEqual(saved);
      expect(await f.store.getView('s')).toEqual(before);
      expect(await f.store.getCommand('rewind')).toBeNull();
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('Rewind retains a prepared recovery owner and rejects foreign identity or stale selection', async () => {
  const f = await fixture();
  let lease: Awaited<ReturnType<typeof f.store.beginRunResume>>['lease'] = null;
  try {
    const selected = (await f.store.getSession('s'))!;
    const request = {
      ...f.base,
      commandId: 'invalid-rewind',
      boundary: null,
      expectedContextSelectionId: selected.contextSelectionId,
    };
    const saved = f.checkpoint();
    for (const [change, code] of [
      [{ subjectId: 'foreign' }, 'permission_denied'],
      [{ expectedStoreId: 'foreign' }, 'store_identity_mismatch'],
      [{ expectedContextSelectionId: 'stale' }, 'context_selection_changed'],
    ] as const) {
      const rejected = await f.runtime
        .selectContext({ ...request, ...change })
        .catch((error) => error);
      expect(rejected.code).toBe(code);
      expect(f.checkpoint()).toEqual(saved);
      expect(await f.store.getSession('s')).toEqual(selected);
    }
    const resume = {
      ...f.base,
      commandId: 'prepared-resume',
      runId: f.ready.runId,
      expectedOwnerGeneration: selected.ownerGeneration,
    };
    const state = await f.store.verifyRunResume(resume);
    const begun = await f.store.beginRunResume({
      ...resume,
      instanceId: 'prepared-owner',
      checkpoint: state.checkpoint!,
    });
    lease = begun.lease;
    expect(lease).not.toBeNull();
    const before = await f.store.getView('s');
    const prepared = f.checkpoint();
    const rejected = await f.rewind().catch((error) => error);
    expect(rejected.code).toBe('owner_busy');
    expect(f.checkpoint()).toEqual(prepared);
    expect(await f.store.getView('s')).toEqual(before);
    expect(await f.store.getCommand('rewind')).toBeNull();
    expect(f.requests).toHaveLength(0);
  } finally {
    if (lease) await f.store.releaseRunResumeLease(lease);
    await f.close();
  }
});
