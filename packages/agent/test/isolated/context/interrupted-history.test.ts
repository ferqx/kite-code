import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('interrupted_history_deadline');
    await Bun.sleep(5);
  }
}

test('genuine SIGKILL history remains readable but an independent Model receives exact terminal historical input facts', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-interrupted-history-')));
  writeFileSync(join(directory, 'original.txt'), 'original reference content');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./interrupted-history-child.ts', import.meta.url)),
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const output = new Response(child.stderr).text();
  const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  const requests: ModelRequest[] = [];
  const configuration = {
    modelId: 'fixed',
    model: {
      async *stream(request: ModelRequest) {
        requests.push(structuredClone(request));
        yield { type: 'text_delta' as const, text: 'Only the current explicit work completed' };
        yield {
          type: 'finish' as const,
          reason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'actual' };
      },
    },
  };
  try {
    await until(() => existsSync(join(directory, 'ready.json')));
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
    child.kill('SIGKILL');
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(await output).toBe('');
    store = await openSqliteStore(profile);
    const input = { expectedStoreId: ready.expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const originalMessages = await store.listMessages('s');
    const originalCommand = await store.getCommand('original');
    const oldExecutions = (await store.getView('s')).executions.map((execution) => execution.id);
    runtime = createRuntime({ store, ...configuration });
    await runtime.submitCommand({
      ...input,
      commandId: 'new-work',
      request: { kind: 'run.start', content: 'A separate explicit user request' },
    });
    await runtime.waitForCommand('new-work');
    const view = await runtime.getView('s');
    expect(view.runs.find((run) => run.id === ready.runId)).toMatchObject({
      status: 'interrupted',
      isActive: false,
      reason: 'owner_lost',
    });
    expect(requests).toHaveLength(1);
    const oldInput = requests[0]!.messages.find((message) =>
      message.sourceIds?.includes('original'),
    )!;
    expect(oldInput.role).toBe('user');
    expect(oldInput.content).toContain('Historical user input');
    expect(oldInput.content).toContain('Original unfinished user instruction 雪🙂');
    expect(oldInput.content).toContain('original.txt');
    expect(oldInput.content).toContain('not a pending task');
    expect(oldInput.content).toContain('"status":"interrupted"');
    expect(oldInput.content).toContain('"reason":"owner_lost"');
    expect(oldInput.content).toContain(ready.runId);
    expect(oldInput.sourceIds).toEqual(originalMessages[0]!.sourceIds);
    const current = requests[0]!.messages.find((message) =>
      message.sourceIds?.includes('new-work'),
    )!;
    expect(current.content).toBe('A separate explicit user request');
    const freshModel = view.executions.find(
      (execution) => execution.kind === 'model' && !oldExecutions.includes(execution.id),
    )!;
    const snapshot = await runtime.readModelInput({ ...input, executionId: freshModel.id });
    expect(snapshot.request.messages).toEqual(requests[0]!.messages);
    const raw = (await store.listMessages('s')).filter((message) => message.runId === ready.runId);
    expect(raw).toEqual(originalMessages);
    expect(await store.getCommand('original')).toEqual(originalCommand);
    expect(
      view.executions
        .filter((execution) => execution.runId === ready.runId)
        .map((execution) => execution.id),
    ).toEqual(oldExecutions);
    await runtime.close();
    runtime = undefined;
    await store.close();
    store = await openSqliteStore(profile);
    runtime = createRuntime({ store, ...configuration });
    for (let read = 0; read < 2; read++) {
      await runtime.getView('s');
      expect(
        (await runtime.readModelInput({ ...input, executionId: freshModel.id })).request.messages,
      ).toEqual(requests[0]!.messages);
    }
    expect(requests).toHaveLength(1);
    expect(
      (await store.getView('s')).executions
        .filter((execution) => execution.runId === ready.runId)
        .map((execution) => execution.id),
    ).toEqual(oldExecutions);
    expect(
      (await store.listMessages('s')).filter((message) => message.runId === ready.runId),
    ).toEqual(originalMessages);
    await runtime.forkSession({
      expectedStoreId: ready.expectedStoreId,
      sourceSessionId: 's',
      expectedContextSelectionId: (await store.getSession('s'))!.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'sealed history',
    });
    await runtime.submitCommand({
      ...input,
      sessionId: 'fork',
      commandId: 'fork-work',
      request: { kind: 'run.start', content: 'Explicit work in the sealed Fork' },
    });
    await runtime.waitForCommand('fork-work');
    const copied = requests[1]!.messages.find((message) =>
      message.sourceIds?.includes('original'),
    )!;
    expect(copied.content).toContain('Original unfinished user instruction 雪🙂');
    expect(copied.content).not.toContain('Historical user input');
    expect(copied.content).not.toContain('owner_lost');
    expect(copied.sourceIds).toEqual(originalMessages[0]!.sourceIds);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const terminal of ['failed', 'cancelled'] as const)
  test(`a ${terminal} Run input is historical while a new explicit request can authorize the same original work`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-history-')));
    const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'owned' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const input = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const requests: ModelRequest[] = [];
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(directory).href,
      });
      await store.createSession({
        ...input,
        workspaceId: 'w',
        commandId: 'create',
        title: 'terminal',
      });
      await store.acceptCommand({
        ...input,
        commandId: 'old',
        request: { kind: 'run.start', content: 'Exact same legitimate work' },
      });
      const owner = (await store.acquireSessionOwner('s', 'seed-owner'))!;
      const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId: 'old',
        configuration: {},
      });
      await store.acceptCommand({
        ...input,
        commandId: 'old-steer',
        request: {
          kind: 'input.steer',
          targetRunId: run.id,
          contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
          content: 'An actually applied earlier steering instruction',
        },
      });
      await store.applyInput({
        expectedStoreId,
        owner,
        commandId: 'old-steer',
        kind: 'steer',
        runId: run.id,
      });
      await store.planExecution({
        expectedStoreId,
        owner,
        executionId: 'internal-result',
        sessionId: 's',
        runId: run.id,
        originCommandId: 'old',
        stepId: 'internal-result',
        callId: 'internal-result',
        kind: 'tool',
        definitionId: 'fixture.internal',
        definitionVersion: '1',
        input: {},
        decisionSource: { kind: 'fixture_internal_result' },
      });
      await store.finishExecution({
        expectedStoreId,
        owner,
        executionId: 'internal-result',
        status: 'cancelled',
        result: { code: 'not_dispatched' },
        message: {
          role: 'user',
          content: 'Internal runtime result, not a human instruction',
          sourceIds: ['internal-result'],
        },
      });
      await store.finishRun({
        expectedStoreId,
        owner,
        runId: run.id,
        status: terminal,
        reason: `actual_${terminal}`,
        requirements: [],
      });
      await store.releaseSessionOwner(owner);
      const before = await store.listMessages('s');
      runtime = createRuntime({
        store,
        modelId: 'fixed',
        model: {
          async *stream(request) {
            requests.push(structuredClone(request));
            yield { type: 'text_delta', text: 'Current explicit authorization observed' };
            yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'actual' };
          },
        },
      });
      await runtime.submitCommand({
        ...input,
        commandId: 'new',
        request: { kind: 'run.start', content: 'Exact same legitimate work' },
      });
      await runtime.waitForCommand('new');
      expect(requests).toHaveLength(1);
      const old = requests[0]!.messages.find((message) => message.sourceIds?.includes('old'))!;
      expect(old.content).toContain('Historical user input');
      expect(old.content).toContain(`"status":"${terminal}"`);
      expect(old.content).toContain(`"reason":"actual_${terminal}"`);
      expect(old.content).toContain('Exact same legitimate work');
      expect(old.sourceIds).toEqual(before[0]!.sourceIds);
      expect(await store.getCommand('old-steer')).toMatchObject({
        kind: 'input.steer',
        status: 'applied',
      });
      const steer = requests[0]!.messages.find((message) =>
        message.sourceIds?.includes('old-steer'),
      )!;
      expect(steer.content).toContain('Historical user input');
      expect(steer.content).toContain('An actually applied earlier steering instruction');
      expect(steer.content).toContain('"inputCommandId":"old-steer"');
      expect(steer.content).toContain('"inputKind":"input.steer"');
      expect(steer.content).toContain(`"status":"${terminal}"`);
      const internal = requests[0]!.messages.find((message) =>
        message.sourceIds?.includes('internal-result'),
      )!;
      expect(internal.content).toBe('Internal runtime result, not a human instruction');
      expect(internal.role).toBe('user');
      expect(
        requests[0]!.messages.find((message) => message.sourceIds?.includes('new'))!.content,
      ).toBe('Exact same legitimate work');
      expect((await store.listMessages('s')).filter((message) => message.runId === run.id)).toEqual(
        before,
      );
      expect(
        (await store.getView('s')).executions
          .filter((execution) => execution.runId === run.id)
          .map((execution) => ({ id: execution.id, status: execution.status })),
      ).toEqual([{ id: 'internal-result', status: 'cancelled' }]);
    } finally {
      await runtime?.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('explicit original Run resume keeps its own input current after genuine SIGKILL reconciliation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resumed-history-')));
  writeFileSync(join(directory, 'original.txt'), 'original reference content');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./interrupted-history-child.ts', import.meta.url)),
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const error = new Response(child.stderr).text();
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  const requests: ModelRequest[] = [];
  try {
    await until(() => existsSync(join(directory, 'ready.json')));
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
    child.kill('SIGKILL');
    await child.exited;
    expect(await error).toBe('');
    store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'owned' });
    runtime = createRuntime({
      store,
      modelId: 'fixed',
      model: {
        async *stream(request) {
          requests.push(structuredClone(request));
          yield { type: 'text_delta', text: 'Explicitly resumed the original work' };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'actual' };
        },
      },
    });
    const input = {
      expectedStoreId: ready.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      expectedOwnerGeneration: ready.expectedOwnerGeneration,
    };
    const reconciled = await runtime.reconcileSession({ ...input, commandId: 'reconcile' });
    expect(await store.getRun(ready.runId)).toMatchObject({
      status: 'interrupted',
      isActive: false,
    });
    await runtime.resumeRun({
      ...input,
      commandId: 'resume',
      runId: ready.runId,
      expectedOwnerGeneration: reconciled.report!.generation,
    });
    await until(async () => (await store!.getRun(ready.runId))!.status === 'completed');
    expect(requests).toHaveLength(1);
    const original = requests[0]!.messages.find((message) =>
      message.sourceIds?.includes('original'),
    )!;
    expect(original.content).toStartWith('Original unfinished user instruction 雪🙂');
    expect(original.content).not.toContain('Historical user input');
    expect(original.content).not.toContain('owner_lost');
    expect(original.content).toContain('original.txt');
    const execution = (await store.getView('s')).executions.find(
      (entry) => entry.kind === 'model' && entry.id !== ready.executionId,
    )!;
    expect(
      (
        await runtime.readModelInput({
          expectedStoreId: input.expectedStoreId,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
          executionId: execution.id,
        })
      ).request.messages,
    ).toEqual(requests[0]!.messages);
    expect(
      (await store.listMessages('s')).filter((message) => message.role === 'user'),
    ).toHaveLength(1);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
