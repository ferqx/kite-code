import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { defineExtension, type Json } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { AgentError, OwnerRef } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
for (const scenario of ['pending', 'unknown', 'cancel', 'other_session'] as const) {
  test(`actual SQLite idle owner intake window preserves ${scenario} scope`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-owner-handoff-')));
    const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
    let effects = 0,
      injected = false,
      denied = false;
    let originalOwner: OwnerRef | undefined;
    let finishBackground!: () => void;
    const backgroundFinished = new Promise<void>((resolve) => {
      finishBackground = resolve;
    });
    const model = createFixedModel(
      scenario === 'unknown'
        ? [
            [
              { type: 'tool_call', id: 'unknown', name: 'fixture.unknown', arguments: '{}' },
              { ...finish, reason: 'tool_calls' },
            ],
            [finish],
            [finish],
          ]
        : [
            [
              { type: 'tool_call', id: 'background', name: 'fixture.background', arguments: '{}' },
              { ...finish, reason: 'tool_calls' },
            ],
            [finish],
            [finish],
          ],
    );
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixed' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          jobs: [
            {
              id: 'fixture.backgroundJob',
              version: '1',
              description: 'Owned harmless deferred background',
              inputSchema: { type: 'object' },
              start: async () => ({ reference: { id: 'original-background' } }),
              async *observe() {
                await backgroundFinished;
                yield {
                  type: 'terminal' as const,
                  result: { outcome: 'succeeded' as const, content: 'ended' },
                  supervision: 'ended' as const,
                };
              },
              cancel: async () => {
                finishBackground();
                return { status: 'stopped' as const };
              },
              dispose: async () => {},
            },
          ],
          tools: [
            {
              id: 'fixture.background',
              version: '1',
              description: 'Create one original background Job',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                await context.operations.ensure({
                  key: 'background',
                  cancellation: 'detached',
                  request: {
                    kind: 'job',
                    definitionId: 'fixture.backgroundJob',
                    definitionVersion: '1',
                    input: {},
                  },
                });
                return { outcome: 'succeeded' as const, content: 'original background started' };
              },
            },
            {
              id: 'fixture.unknown',
              version: '1',
              description: 'An explicitly unknown harmless effect',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                return { outcome: 'outcome_unknown', content: 'actual unresolved fixture fact' };
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: `file://${root}`,
    });
    for (const id of ['s', 'other'])
      await runtime.createSession({
        expectedStoreId,
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        subjectId: 'owner',
        title: id,
      });
    const list = store.listAcceptedCommands.bind(store);
    const release = store.releaseSessionOwner.bind(store);
    store.listAcceptedCommands = async (sessionId, limit) => {
      const commands = await list(sessionId, limit);
      if (sessionId !== 's' || commands.length || injected) return commands;
      if (!(await store.getView('s')).runs.some((run) => !run.isActive)) return commands;
      injected = true;
      // This real acceptance occurs after the old empty observation and before the release transaction.
      await store.acceptCommand({
        expectedStoreId,
        commandId: 'next',
        sessionId: scenario === 'other_session' ? 'other' : 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'precise newly accepted work' },
      });
      if (scenario !== 'unknown') {
        finishBackground();
        const end = Date.now() + 5000;
        while (
          runtime
            .getLifecycleState()
            .reasons.some((reason) => ['background', 'execution', 'cleanup'].includes(reason))
        ) {
          if (Date.now() > end) throw new Error('owned background settlement not observed');
          await Bun.sleep(10);
        }
      }
      return commands;
    };
    store.releaseSessionOwner = async (owner) => {
      originalOwner ??= structuredClone(owner);
      const result = await release(owner);
      if (!result && injected) {
        denied = true;
        if (scenario === 'cancel') {
          await runtime.cancelCommand({
            expectedStoreId,
            commandId: 'cancel-next',
            sessionId: 's',
            targetCommandId: 'next',
            subjectId: 'owner',
          });
        }
      }
      return result;
    };
    const deadline = async (read: () => Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await read())) {
        if (Date.now() > end) throw new Error('owner window not settled');
        await Bun.sleep(10);
      }
    };
    try {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'first',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'old ordinary turn' },
      });
      await runtime.waitForCommand('first', { timeoutMs: 5000 });
      await deadline(async () => injected);
      if (scenario === 'pending') {
        let failure: unknown;
        try {
          await runtime.waitForCommand('next', { timeoutMs: 5000 });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeUndefined();
        const executions = await store.listExecutions('s');
        const original = executions.find((execution) => execution.originCommandId === 'first')!;
        const next = executions.filter((execution) => execution.originCommandId === 'next');
        expect(next).toHaveLength(1);
        expect(next[0]!.kind).toBe('model');
        expect(next[0]!.ownerGeneration).toBe(original.ownerGeneration);
        expect(next[0]!.ownerGeneration).toBe(originalOwner!.generation);
        expect(next[0]!.originStoreId).toBe(expectedStoreId);
        expect(next[0]!.sessionId).toBe('s');
        expect(model.requests).toHaveLength(3);
        expect(denied).toBe(true);
      } else if (scenario === 'unknown') {
        let failure: unknown;
        try {
          await runtime.waitForCommand('next', { timeoutMs: 5000 });
        } catch (error) {
          failure = error;
        }
        expect((failure as AgentError)?.code).toBe('session_recovery_required');
        expect(
          (await store.listExecutions('s')).filter(
            (execution) => execution.originCommandId === 'next',
          ),
        ).toHaveLength(0);
        expect((await store.getCommand('next'))?.status).toBe('accepted');
        expect(model.requests).toHaveLength(1);
        expect(effects).toBe(1);
        expect(denied).toBe(true);
        const unknown = (await store.listExecutions('s')).find(
          (execution) => execution.kind === 'tool',
        )!;
        expect(unknown.status).toBe('outcome_unknown');
        expect(unknown.resultRevision).toBe('1');
      } else if (scenario === 'cancel') {
        await deadline(async () => (await store.getCommand('next'))?.status === 'rejected');
        expect(
          (await store.listExecutions('s')).filter(
            (execution) => execution.originCommandId === 'next',
          ),
        ).toHaveLength(0);
        expect(model.requests).toHaveLength(2);
        expect(denied).toBe(true);
      } else {
        expect((await store.getCommand('next'))?.sessionId).toBe('other');
        expect((await store.getCommand('next'))?.status).toBe('accepted');
        expect(await store.listExecutions('other')).toHaveLength(0);
        expect(model.requests).toHaveLength(2);
        expect(denied).toBe(false);
        await runtime.cancelCommand({
          expectedStoreId,
          commandId: 'cancel-other',
          sessionId: 'other',
          targetCommandId: 'next',
          subjectId: 'owner',
        });
      }
    } finally {
      finishBackground();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
}

test('actual SQLite root owner keeps peer Action intake after an empty control poll while its detached Job is hot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-hot-owner-intake-')));
  const storeA = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const storeB = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const starts: string[] = [];
  let finishBackground!: () => void;
  const backgroundFinished = new Promise<void>((resolve) => {
    finishBackground = resolve;
  });
  const extension = defineExtension({
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    jobs: [
      {
        id: 'fixture.held',
        version: '1',
        description: 'Harmless Job held at an explicit terminal barrier',
        inputSchema: { type: 'object' },
        resources: { slot: 'process' },
        async start(_input, context) {
          starts.push(context.executionId);
          return { reference: { id: context.executionId } };
        },
        async *observe() {
          await backgroundFinished;
          yield {
            type: 'terminal' as const,
            result: { outcome: 'succeeded' as const, content: 'ended' },
            supervision: 'ended' as const,
          };
        },
        async cancel() {
          finishBackground();
          return { status: 'stopped' as const };
        },
        async dispose() {},
      },
    ],
    actions: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'Admit one detached Job and return its actual reference',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute(input, context) {
          const ref = await context.operations.ensure({
            key: (input as { key: string }).key,
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.held',
              definitionVersion: '1',
              input: {},
            },
          });
          return { outcome: 'succeeded', content: 'admitted', details: ref as unknown as Json };
        },
      },
    ],
  });
  const permissions = {
    async authorize() {
      return { allowed: true, revision: 'fixed' };
    },
  };
  const runtimeA = createRuntime({
    store: storeA,
    instanceId: 'hot-owner-a',
    extensions: [extension],
    permissions,
    processConcurrency: 1,
  });
  const runtimeB = createRuntime({
    store: storeB,
    instanceId: 'hot-owner-b',
    extensions: [extension],
    permissions,
    processConcurrency: 1,
  });
  const until = async <T>(read: () => Promise<T>, valid: (value: T) => boolean): Promise<T> => {
    const end = Date.now() + 5000;
    while (true) {
      const value = await read();
      if (valid(value)) return value;
      if (Date.now() >= end) {
        console.error(JSON.stringify({ phase: 'hot_owner_intake_deadline', lastObserved: value }));
        throw new Error('hot_owner_intake_deadline', { cause: value });
      }
      await Bun.sleep(10);
    }
  };
  const expectedStoreId = (await storeA.getMetadata()).storeId;
  const submit = (runtime: typeof runtimeA, commandId: string) =>
    runtime.submitCommand({
      expectedStoreId,
      commandId,
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'fixture.launch',
        definitionVersion: '1',
        input: { key: commandId },
      },
    });
  const action = async (commandId: string) => {
    const command = await until(
      () => storeA.getCommand(commandId),
      (value) => value?.status === 'applied',
    );
    const executionId = (command!.receipt as { executionId: string }).executionId;
    return until(
      () => storeA.getExecution(executionId),
      (value) => value?.status === 'succeeded',
    );
  };
  try {
    await runtimeA.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: `file://${root}`,
    });
    await runtimeA.createSession({
      expectedStoreId,
      commandId: 'create-s',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 's',
    });
    let emptyObserved = false;
    let emptyReturned = false;
    const list = storeA.listAcceptedCommands.bind(storeA);
    storeA.listAcceptedCommands = async (sessionId, limit) => {
      const commands = await list(sessionId, limit);
      if (
        !emptyObserved &&
        starts.length > 0 &&
        sessionId === 's' &&
        limit === 1 &&
        commands.length === 0
      ) {
        emptyObserved = true;
        // Install before first acceptance so even the first empty control poll is observed.
        // The next turn follows pollControls' synchronous keep/delete decision.
        setImmediate(() => {
          emptyReturned = true;
        });
      }
      return commands;
    };
    await submit(runtimeA, 'first');
    const firstAction = (await action('first'))!;
    const firstJobId = (firstAction.result as { details: { executionId: string } }).details
      .executionId;
    const firstJob = (await until(
      () => storeA.getExecution(firstJobId),
      (value) => value?.status === 'running',
    ))!;
    expect(starts).toEqual([firstJobId]);
    await until(async () => emptyReturned, Boolean);
    expect(await storeB.acquireSessionOwner('s', 'hot-owner-b')).toBeNull();
    expect((await storeA.getExecution(firstJobId))?.status).toBe('running');
    expect((await submit(runtimeB, 'peer')).status).toBe('accepted');
    const peerAction = (await action('peer'))!;
    const peerJobId = (peerAction.result as { details: { executionId: string } }).details
      .executionId;
    const peerJob = (await storeA.getExecution(peerJobId))!;
    expect(peerAction.ownerGeneration).toBe(firstAction.ownerGeneration);
    expect(peerJob).toMatchObject({
      status: 'planned',
      sessionId: 's',
      originStoreId: expectedStoreId,
      ownerGeneration: firstJob.ownerGeneration,
    });
    expect(starts).toEqual([firstJobId]);
    expect((await storeA.getExecution(firstJobId))?.status).toBe('running');
    finishBackground();
    for (const executionId of [firstJobId, peerJobId])
      expect(
        (
          await until(
            () => storeA.getExecution(executionId),
            (value) => value?.status === 'succeeded',
          )
        )?.status,
      ).toBe('succeeded');
    expect(starts).toEqual([firstJobId, peerJobId]);
  } finally {
    finishBackground();
    await Promise.all([runtimeA.close(), runtimeB.close()]);
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
