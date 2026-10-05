import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';

test('failed ordinary Action result commit retains its boundary across same-owner scheduling', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-action-result-boundary-')));
  const stage = (name: string, details: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ stage: `action_result_boundary_${name}`, ...details }));
  };
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const effects: string[] = [];
  let releaseResult!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let entered!: (executionId: string) => void;
  const faultEntered = new Promise<string>((resolve) => {
    entered = resolve;
  });
  const apply = store.applyExtensionAction.bind(store);
  let faultHits = 0;
  store.applyExtensionAction = async (input) => {
    const actual = await store.getExecution(input.executionId);
    if (actual?.originCommandId === 'original' && input.status === 'succeeded') {
      faultHits++;
      entered(actual.id);
      await gate;
      throw Error('original_action_result_commit_failed');
    }
    return apply(input);
  };
  const runtime = createRuntime({
    store,
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
        actions: [
          {
            id: 'effect',
            version: '1',
            description: 'Record the actual ordinary Action effect',
            inputSchema: {
              type: 'object',
              properties: { label: { type: 'string' } },
              required: ['label'],
            },
            async prepare(input) {
              return input;
            },
            async execute(input) {
              effects.push((input as { label: string }).label);
              return { outcome: 'succeeded', content: 'actual effect recorded' };
            },
          },
        ],
      },
    ],
  });
  const submit = (commandId: string, sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      commandId,
      sessionId,
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: { label: commandId },
      },
    });
  const awaitBlocked = async (commandId: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const command = await runtime.getCommand(commandId);
      if (command && 'dispatchFailure' in command) {
        expect(command.status).toBe('accepted');
        expect(command.dispatchFailure.code).toBe('session_recovery_required');
        return;
      }
      if (Date.now() > deadline) throw Error('original_action_boundary_not_observed');
      await Bun.sleep(10);
    }
  };
  let wait: Promise<unknown> | undefined;
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${root}`,
    });
    for (const sessionId of ['s', 'other']) {
      await runtime.createSession({
        expectedStoreId,
        sessionId,
        commandId: `create-${sessionId}`,
        workspaceId: 'w',
        title: sessionId,
        subjectId: 'owner',
      });
    }
    await submit('original');
    wait = runtime.waitForCommand('original', { timeoutMs: 5000 });
    void wait.catch((error: unknown) => {
      stage('original_wait_rejected', {
        code: error && typeof error === 'object' && 'code' in error ? error.code : 'unknown',
      });
    });
    const executionId = await faultEntered;
    await submit('queued');
    expect((await store.getCommand('queued'))?.status).toBe('accepted');
    expect(
      (await store.listExecutions('s')).filter(
        (execution) => execution.originCommandId === 'queued',
      ),
    ).toEqual([]);
    releaseResult();
    stage('result_released');
    await awaitBlocked('queued');
    stage('queued_blocked');
    // A new submission re-enters scheduling with the same still-held owner.
    await submit('later');
    await awaitBlocked('later');
    stage('later_blocked');
    await submit('independent', 'other');
    await runtime.waitForCommand('independent', { timeoutMs: 5000 });
    stage('independent_completed');
    let originalWaitError: unknown;
    try {
      await wait;
    } catch (error) {
      originalWaitError = error;
    }
    expect(originalWaitError).toMatchObject({ code: 'wait_timeout' });
    stage('original_wait_observed');
    const original = await runtime.getExecution(executionId);
    expect(original?.originCommandId).toBe('original');
    expect(original?.originStoreId).toBe(expectedStoreId);
    expect(original?.sessionId).toBe('s');
    expect(original?.status).toBe('dispatching');
    expect(original?.result).toBeNull();
    expect(original?.resultRevision).toBe('0');
    expect((await runtime.getCommand('original'))?.status).toBe('applied');
    expect((await store.getCommand('queued'))?.status).toBe('accepted');
    expect((await store.getCommand('later'))?.status).toBe('accepted');
    expect((await store.listExecutions('s')).map((execution) => execution.originCommandId)).toEqual(
      ['original'],
    );
    expect(effects).toEqual(['original', 'independent']);
    expect(faultHits).toBe(1);
    stage('close_started');
    await runtime.close();
    stage('close_confirmed');
    expect(runtime.getLifecycleState().state).toBe('closed');
  } finally {
    releaseResult();
    await wait?.catch(() => {});
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
