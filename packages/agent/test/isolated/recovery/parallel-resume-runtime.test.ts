import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
import {
  observeOwnedProcessIdentity,
  ownedProcessKernelState,
} from '../../../src/process-observation';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { ExecutionRecord, InteractionRecord, SessionView } from '../../../src/storage/types';
import { parallelBinding, parallelResult } from './parallel-resume-fixture';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error('parallel_resume_boundary_unconfirmed');
    await Bun.sleep(5);
  }
}
function spawnFixture(directory: string) {
  return Bun.spawn(
    [process.execPath, join(import.meta.dir, 'parallel-resume-fixture.ts'), directory],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}
test('SIGKILL with original A planned and B succeeded resumes only A, preserves its Ask and never replays B', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-parallel-resume-')));
  let child: ReturnType<typeof spawnFixture> | undefined;
  let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    child = spawnFixture(directory);
    stdout = new Response(child.stdout).text();
    stderr = new Response(child.stderr).text();
    await until(async () => existsSync(join(directory, 'ready.json')));
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
      pid: number;
      expectedStoreId: string;
      runId: string;
      expectedOwnerGeneration: string;
      a: ExecutionRecord;
      b: ExecutionRecord;
      model: ExecutionRecord;
      card: InteractionRecord;
      view: SessionView;
    };
    expect(ready.pid).toBe(child.pid);
    expect(ready.a.status).toBe('planned');
    expect(ready.b.status).toBe('succeeded');
    expect(ready.b.result).toMatchObject({ content: parallelResult('B') });
    expect(ready.a.stepId).toBe(ready.b.stepId);
    expect(ready.a.callId).toBe('call-A');
    expect(ready.b.callId).toBe('call-B');
    expect(ready.model.status).toBe('succeeded');
    const original = observeOwnedProcessIdentity(child.pid);
    if (process.platform === 'darwin') {
      expect(original.birth).not.toBeNull();
      expect(original.parentPid).toBe(process.pid);
      expect(original.unavailable).toEqual([]);
      expect(ownedProcessKernelState(original)).toBe('alive');
    }
    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);
    expect(await stdout).toBe('');
    expect(await stderr).toBe('');
    if (process.platform === 'darwin') expect(ownedProcessKernelState(original)).toBe('absent');
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const effectsBefore = readFileSync(join(directory, 'effects'), 'utf8');
    const modelsBefore = readFileSync(join(directory, 'models'), 'utf8');
    expect(
      effectsBefore
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).name),
    ).toEqual(['B']);
    expect(modelsBefore.trim().split('\n')).toHaveLength(1);
    const reader = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect((await reader.getMetadata()).storeId).toBe(ready.expectedStoreId);
      expect(await reader.getView('s')).toEqual(ready.view);
      expect(await reader.getExecution(ready.a.id)).toEqual(ready.a);
      expect(await reader.getExecution(ready.b.id)).toEqual(ready.b);
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe(effectsBefore);
      expect(readFileSync(join(directory, 'models'), 'utf8')).toBe(modelsBefore);
    } finally {
      await reader.close();
    }
    store = await openSqliteStore(profile);
    let resolves = 0,
      disposals = 0;
    runtime = createRuntime({
      store,
      permissions: parallelBinding(directory).permissions!,
      artifacts: createArtifactStore({ profile, store }),
      resolveRecoveryRunConfiguration: async () => {
        resolves++;
        return {
          ...parallelBinding(directory),
          async dispose() {
            disposals++;
          },
        };
      },
    });
    expect(await runtime.getView('s')).toEqual(ready.view);
    expect(resolves).toBe(0);
    const input = {
      expectedStoreId: ready.expectedStoreId,
      runId: ready.runId,
      expectedOwnerGeneration: ready.expectedOwnerGeneration,
      commandId: 'resume',
      subjectId: 'owner',
      sessionId: 's',
    };
    const receipt = await runtime.resumeRun(input);
    expect(receipt.receipt).toMatchObject({
      outcome: 'run_resumed',
      runId: ready.runId,
      originalCommandId: 'work',
    });
    await until(
      async () =>
        (
          await runtime!.listInteractions({
            expectedStoreId: ready.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions.length === 1,
    );
    const card = (
      await runtime.listInteractions({
        expectedStoreId: ready.expectedStoreId,
        sessionId: 's',
        state: 'pending',
      })
    ).interactions[0]!;
    expect(card).toEqual(ready.card);
    expect(await store.getExecution(ready.b.id)).toEqual(ready.b);
    expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe(effectsBefore);
    expect(readFileSync(join(directory, 'models'), 'utf8')).toBe(modelsBefore);
    await runtime.answerInteraction({
      expectedStoreId: ready.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer-original-A',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    await until(
      async () =>
        !(await store!.getRun(ready.runId))!.isActive &&
        disposals === 1 &&
        (await store!.getSession('s'))!.ownerInstanceId === null,
    );
    const after = await store.getView('s');
    expect(after.session.ownerInstanceId).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({
      id: ready.runId,
      originCommandId: 'work',
      status: 'completed',
    });
    expect(after.executions.find((row) => row.id === ready.b.id)).toEqual(ready.b);
    expect(after.executions.find((row) => row.id === ready.model.id)).toEqual(ready.model);
    expect(after.executions.find((row) => row.id === ready.a.id)).toMatchObject({
      callId: 'call-A',
      stepId: ready.a.stepId,
      attempt: ready.a.attempt,
      definitionVersion: '1',
      input: ready.a.input,
      status: 'succeeded',
      result: { content: parallelResult('A') },
    });
    expect(after.executions.filter((row) => row.kind === 'tool')).toHaveLength(2);
    const effects = readFileSync(join(directory, 'effects'), 'utf8');
    expect(
      effects
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { name: 'B', input: { original: 'B' } },
      { name: 'A', input: { original: 'A' } },
    ]);
    const models = readFileSync(join(directory, 'models'), 'utf8');
    const requests = models
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(
      requests[1].messages
        .filter((message: { role: string }) => message.role === 'tool')
        .map((message: { toolCallId: string; content: string }) => ({
          callId: message.toolCallId,
          content: message.content,
        })),
    ).toEqual([
      { callId: 'call-A', content: parallelResult('A') },
      { callId: 'call-B', content: parallelResult('B') },
    ]);
    expect(await runtime.resumeRun(input)).toEqual(receipt);
    expect(resolves).toBe(1);
    const permissions = readFileSync(join(directory, 'permissions'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            executionId: string;
            definitionId: string;
            input: unknown;
          },
      );
    const aPermissions = permissions.filter(
      (row) => row.kind === 'tool' && row.definitionId === 'effect.A',
    );
    expect(aPermissions.length).toBeGreaterThan(1);
    expect(
      aPermissions.every(
        (row) =>
          row.executionId === ready.a.id &&
          JSON.stringify(row.input) === JSON.stringify(ready.a.input),
      ),
    ).toBe(true);
    await runtime.close();
    runtime = undefined;
    store = undefined;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect(await cold.getView('s')).toEqual(after);
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe(effects);
      expect(readFileSync(join(directory, 'models'), 'utf8')).toBe(models);
      expect(disposals).toBe(1);
    } finally {
      await cold.close();
    }
  } finally {
    if (child) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
    await Promise.all([stdout, stderr]);
    await runtime?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
