import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { binding, permissions } from './human-input-processing-crash-fixture';

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('processing_crash_timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw Error('processing_child_early_exit');
      text += new TextDecoder().decode(next.value);
      if (text.includes('\n')) return text.split('\n')[0]!;
    }
  } finally {
    reader.releaseLock();
  }
}
for (const window of ['model', 'decision'] as const)
  test(`SIGKILL processing after ${window}: exact cold resume consumes the durable interpretation once`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-input-processing-kill-')));
    writeFileSync(join(root, 'ledger'), '');
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./human-input-processing-crash-fixture.ts', import.meta.url)),
        root,
        window,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
      runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const ready = JSON.parse(await bounded(firstLine(child.stdout))) as {
        storeId: string;
        rawId: string;
        processingId: string;
        runId: string;
        generation: string;
      };
      child.kill('SIGKILL');
      expect(await bounded(child.exited)).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      expect(await bounded(new Response(child.stderr).text())).toBe('');
      const profile = { dataRoot: join(root, 'data'), profile: 'test' };
      const ledger = () => readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n');
      const before = ledger();
      expect(before.filter((l) => l.startsWith('interpret:'))).toHaveLength(1);
      const observer = await openSqliteStore({ ...profile, mode: 'readonly' });
      const originalRun = await observer.getRun(ready.runId);
      try {
        const cursor = (await observer.getMetadata()).lastChangeCursor;
        expect(originalRun).toMatchObject({ isActive: true, originCommandId: ready.processingId });
        expect((await observer.getCommand(ready.rawId))?.receipt).toMatchObject({
          state: window === 'model' ? 'pending' : 'decided',
        });
        expect((await observer.getMetadata()).lastChangeCursor).toBe(cursor);
        expect(ledger()).toEqual(before);
      } finally {
        await observer.close();
      }
      store = await openSqliteStore(profile);
      let recoveries = 0,
        currentCalls = 0;
      runtime = createRuntime({
        store,
        permissions,
        artifacts: createArtifactStore({ profile, store }),
        resolveRunConfiguration: async () => {
          currentCalls++;
          throw Error('current B binding must never recover A');
        },
        resolveRecoveryRunConfiguration: async ({ run }) => {
          recoveries++;
          const manifest = run.configuration as {
            snapshot: { kind?: string; originalConfiguration?: unknown; original?: string };
          };
          expect(
            manifest.snapshot.kind === 'human_input_processing'
              ? manifest.snapshot.originalConfiguration
              : manifest.snapshot,
          ).toMatchObject({ original: 'immutable A' });
          return binding(root, true);
        },
      });
      const cursor = (await store.getMetadata()).lastChangeCursor;
      await bounded(runtime.getView('s'));
      expect(recoveries).toBe(0);
      expect(ledger()).toEqual(before);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      const input = {
        expectedStoreId: ready.storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'resume',
        runId: ready.runId,
        expectedOwnerGeneration: ready.generation,
      };
      let denied: unknown;
      try {
        await runtime.resumeRun({ ...input, subjectId: 'foreign', commandId: 'foreign' });
      } catch (error) {
        denied = error;
      }
      expect(denied).toBeTruthy();
      expect(recoveries).toBe(0);
      await runtime.resumeRun(input);
      await runtime.waitForCommand('input', { timeoutMs: 5000 });
      await runtime.waitForCommand(ready.processingId, { timeoutMs: 5000 });
      await runtime.resumeRun(input);
      expect(currentCalls).toBe(0);
      const applied = (await store.getCommand('input'))!.receipt as {
        businessCommandId: string;
        runId: string;
        humanInputCommandId: string;
      };
      expect(applied.humanInputCommandId).toBe(ready.rawId);
      expect((await store.getCommand(ready.rawId))?.receipt).toMatchObject({
        businessCommandId: applied.businessCommandId,
        state: 'decided',
      });
      expect(await store.getRun(applied.runId)).toMatchObject({
        originCommandId: applied.businessCommandId,
        rootWorkCommandId: 'A',
      });
      expect((await store.getRun(ready.runId))?.configuration).toEqual(originalRun?.configuration);
      expect((await store.getRun(ready.runId))?.status).toBe('completed');
      expect((await store.getCommand('input'))?.receipt).toMatchObject({
        outcome: 'human_input_applied',
      });
      expect(ledger().filter((l) => l.startsWith('interpret:'))).toHaveLength(1);
      expect(ledger().filter((l) => l.startsWith('business:'))).toHaveLength(4);
      const effects = ledger().filter((l) => l.startsWith('effect:'));
      expect(effects).toHaveLength(2);
      expect(new Set(effects).size).toBe(2);
      const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
        readonly: true,
      });
      try {
        expect(db.query("SELECT id FROM command WHERE kind='human.input'").all()).toHaveLength(1);
        expect(
          db.query("SELECT id FROM command WHERE kind='human.input.decision'").all(),
        ).toHaveLength(1);
        expect(
          db.query('SELECT id FROM run WHERE origin_command_id=?').all(ready.processingId),
        ).toHaveLength(1);
        expect(
          db
            .query("SELECT id FROM execution WHERE kind='model' AND run_id=? AND state='succeeded'")
            .all(ready.runId),
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await runtime?.close();
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('SIGKILL after an unresolved decision preserves its first Model while cold response recovery pairs the unavailable Tool exactly once', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-input-unresolved-tool-kill-')));
  writeFileSync(join(root, 'ledger'), '');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./human-input-processing-crash-fixture.ts', import.meta.url)),
      root,
      'unresolved-tool-decision',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    runtime: ReturnType<typeof createRuntime> | undefined;
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const ledger = () => readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n');
  try {
    const ready = JSON.parse(await bounded(firstLine(child.stdout))) as {
      storeId: string;
      rawId: string;
      processingId: string;
      runId: string;
      generation: string;
    };
    child.kill('SIGKILL');
    expect(await bounded(child.exited)).toBe(137);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await bounded(new Response(child.stderr).text())).toBe('');
    store = await openSqliteStore(profile);
    const base = { expectedStoreId: ready.storeId, sessionId: 's', subjectId: 'owner' };
    const rawBefore = (await store.getCommand(ready.rawId))!;
    const receipt = rawBefore.receipt as { decisionCommandId: string };
    expect(rawBefore.receipt).toMatchObject({ state: 'unresolved', businessCommandId: null });
    const decision = (await store.getCommand(receipt.decisionCommandId))!;
    const firstModels = (await store.listExecutions('s')).filter(
      (execution) => execution.runId === ready.runId && execution.kind === 'model',
    );
    expect(firstModels).toHaveLength(1);
    expect(firstModels[0]?.status).toBe('succeeded');
    expect(decision.request).toMatchObject({
      interpretation: {
        executionId: firstModels[0]!.id,
        clarification: '请说明这条输入要补充哪项工作，或要另开一项工作。',
      },
      proposal: { relation: 'unresolved', purpose: 'clarify' },
    });
    expect(
      (await store.listExecutions('s')).filter(
        (execution) => execution.runId === ready.runId && execution.kind === 'tool',
      ),
    ).toHaveLength(0);
    const beforeLedger = ledger();
    expect(beforeLedger.filter((line) => line.startsWith('interpret:'))).toHaveLength(1);
    expect(beforeLedger.filter((line) => line.startsWith('effect:'))).toHaveLength(1);
    let currentBindings = 0;
    const options = {
      permissions,
      resolveRunConfiguration: async () => {
        currentBindings++;
        throw Error('unresolved input must not acquire a business binding');
      },
      resolveRecoveryRunConfiguration: async () =>
        binding(root, true, 'work', 'unresolved-tool-decision'),
    };
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      ...options,
    });
    const coldCursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.getView('s');
    expect(ledger()).toEqual(beforeLedger);
    expect((await store.getMetadata()).lastChangeCursor).toBe(coldCursor);
    const resume = {
      ...base,
      commandId: 'resume-unresolved',
      runId: ready.runId,
      expectedOwnerGeneration: ready.generation,
    };
    await runtime.resumeRun(resume);
    await runtime.waitForCommand(ready.processingId, { timeoutMs: 5000 });
    expect((await store.getRun(ready.runId))?.status).toBe('completed');
    expect(currentBindings).toBe(0);
    expect((await store.getCommand(ready.rawId))?.request).toEqual(rawBefore.request);
    expect((await store.getCommand(ready.rawId))?.receipt).toEqual(rawBefore.receipt);
    expect(await store.getCommand(decision.id)).toEqual(decision);
    expect(await store.readHumanWorkState(base)).toMatchObject({
      selectedWork: { rootWorkCommandId: 'A' },
      pendingInputIds: [ready.rawId],
    });
    const executions = await store.listExecutions('s');
    const models = executions.filter(
      (execution) => execution.runId === ready.runId && execution.kind === 'model',
    );
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe(firstModels[0]!.id);
    expect(models.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(JSON.parse((models[1]!.result as { content: string }).content)).toMatchObject({
      relation: 'same_work',
      purpose: 'work',
      target_root_work_command_id: 'A',
    });
    const processingTools = executions.filter(
      (execution) => execution.runId === ready.runId && execution.kind === 'tool',
    );
    expect(processingTools).toHaveLength(1);
    expect(processingTools[0]).toMatchObject({
      callId: 'hallucinated-follow-up',
      definitionId: 'follow_up_agent',
      status: 'failed',
      result: { outcome: 'failed', content: 'tool_not_available' },
    });
    expect(executions.filter((execution) => execution.childSessionId)).toHaveLength(0);
    const completedLedger = ledger();
    expect(completedLedger.filter((line) => line.startsWith('interpret:'))).toHaveLength(2);
    expect(completedLedger.filter((line) => line.startsWith('effect:'))).toHaveLength(1);
    const requests = completedLedger
      .filter((line) => line.startsWith('readonly-request:'))
      .map((line) => JSON.parse(line.slice('readonly-request:'.length)) as ModelRequest);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.tools.length === 0)).toBe(true);
    const assistant = requests[1]!.messages.findIndex((message) =>
      message.toolCalls?.some((call) => call.id === 'hallucinated-follow-up'),
    );
    expect(assistant).toBeGreaterThanOrEqual(0);
    expect(requests[1]!.messages[assistant + 1]).toMatchObject({
      role: 'tool',
      toolCallId: 'hallucinated-follow-up',
    });
    expect(requests[1]!.messages[assistant + 1]!.content).toContain('tool_not_available');
    const database = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
      readonly: true,
    });
    try {
      expect(database.query("SELECT id FROM command WHERE kind='human.input'").all()).toHaveLength(
        1,
      );
      expect(
        database.query("SELECT id FROM command WHERE kind='human.input.decision'").all(),
      ).toHaveLength(1);
      expect(database.query('SELECT id FROM run').all()).toHaveLength(2);
      expect(
        database.query('SELECT id FROM run WHERE origin_command_id=?').all(ready.processingId),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
    const settledCursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.resumeRun(resume);
    await runtime.getView('s');
    expect((await store.getMetadata()).lastChangeCursor).toBe(settledCursor);
    expect(ledger()).toEqual(completedLedger);
    await runtime.close();
    await store.close();
    store = await openSqliteStore(profile);
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      ...options,
    });
    await runtime.getView('s');
    expect((await store.getMetadata()).lastChangeCursor).toBe(settledCursor);
    expect(ledger()).toEqual(completedLedger);
    expect(await store.getCommand(decision.id)).toEqual(decision);
    expect(await store.readHumanWorkState(base)).toMatchObject({
      selectedWork: { rootWorkCommandId: 'A' },
      pendingInputIds: [ready.rawId],
    });
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
