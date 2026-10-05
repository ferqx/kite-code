import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
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
