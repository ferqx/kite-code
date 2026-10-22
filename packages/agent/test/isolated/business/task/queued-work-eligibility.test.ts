import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type { ToolDefinition } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error('Exact queued-work condition did not settle');
    await Bun.sleep(5);
  }
}

for (const ending of ['ordinary-input', 'explicit-stop', 'permission-denied'] as const) {
  test(`queued child survives ordinary parent input and rechecks its exact ${ending} boundary`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-queued-work-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    const release = [gate(), gate(), gate(), gate()];
    const firstThree = gate();
    let denied = false,
      permissionReads = 0,
      parentA = 0;
    const entered = new Set<number>();
    const childCalls = new Map<string, number>();
    let targetId: string | undefined, targetSession: string | undefined;
    const read: ToolDefinition = {
      id: 'fixture.queued-material',
      version: '1',
      model: { name: 'read_material' },
      description: 'Read the owned finite material.',
      inputSchema: {
        type: 'object',
        properties: { slot: { type: 'integer' } },
        required: ['slot'],
        additionalProperties: false,
      },
      async execute(input, context) {
        const slot = (input as { slot: number }).slot;
        entered.add(slot);
        if ([1, 2, 3].every((n) => entered.has(n))) firstThree.release();
        if (slot === 5)
          return { outcome: 'succeeded', content: 'Actual original A fifth material.' };
        try {
          await Promise.race([
            release[slot - 1]!.promise,
            new Promise<never>((_, reject) =>
              context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                once: true,
              }),
            ),
          ]);
        } catch (error) {
          if (context.signal.aborted)
            return { outcome: 'cancelled', content: 'Cancelled before reading.' };
          throw error;
        }
        if (context.signal.aborted)
          return { outcome: 'cancelled', content: 'Cancelled before reading.' };
        return { outcome: 'succeeded', content: `Actual owned material ${slot}.` };
      },
    };
    const model: ModelAdapter = {
      async *stream(request) {
        const execution = (await store.getExecution(request.requestId))!;
        if (execution.sessionId === 'root') {
          if (execution.rootWorkCommandId === 'A' && parentA++ === 0) {
            for (let slot = 1; slot <= 5; slot++)
              yield {
                type: 'tool_call',
                id: `spawn-${slot}`,
                name: 'spawn_agent',
                arguments: JSON.stringify({
                  prompt: `Read SLOT:${slot} and report its actual material.`,
                }),
              };
            yield { ...finish, reason: 'tool_calls' };
          } else {
            yield {
              type: 'text_delta',
              text: 'Parent turn completed without changing child work.',
            };
            yield finish;
          }
          return;
        }
        const n = childCalls.get(execution.sessionId) ?? 0;
        childCalls.set(execution.sessionId, n + 1);
        const slot = Number(
          request.messages
            .map((m) => m.content)
            .join('\n')
            .match(/SLOT:(\d)/)?.[1],
        );
        if (n === 0) {
          yield {
            type: 'tool_call',
            id: `read-${slot}`,
            name: 'read_material',
            arguments: JSON.stringify({ slot }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: `Actual owned material ${slot}.` };
          yield finish;
        }
      },
    };
    const ensure = store.ensureOperation.bind(store);
    const carriers: string[] = [];
    store.ensureOperation = async (input) => {
      if (carriers.length >= 3) await firstThree.promise;
      const ref = await ensure(input);
      carriers.push(ref.executionId!);
      if (carriers.length === 4) {
        targetId = ref.executionId!;
        targetSession = ref.childSessionId!;
      }
      return ref;
    };
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixture',
      modelConcurrency: 4,
      permissions: {
        async authorize(request) {
          if (request.executionId === targetId) permissionReads++;
          return {
            allowed: !(denied && request.executionId === targetId),
            revision: denied ? 'denied' : 'allowed',
          };
        },
      },
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'after-turn' };
        },
      },
      extensions: [
        { id: 'fixture.queued-material', version: '1', apiMajor: 1, tools: [read] },
        createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'worker', description: 'general' }],
        }),
      ],
      childConfigurations: [
        { id: 'worker', version: '1', model, modelId: 'child', toolIds: [read.id], snapshot: {} },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        workspaceId: 'w',
        commandId: 'create',
        title: 'Queued work selection',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'A',
        request: { kind: 'run.start', content: 'Start A.' },
      });
      await eventually(
        async () =>
          carriers.length === 5 &&
          (await store.getView('root')).runs.some(
            (r) => r.rootWorkCommandId === 'A' && r.status === 'completed',
          ),
      );
      const original = (await store.getExecution(targetId!))!;
      expect(original.status).toBe('planned');
      expect((await store.getView(targetSession!)).runs).toHaveLength(0);
      await runtime.submitCommand({
        ...scope,
        commandId: 'B',
        request: { kind: 'run.start', content: '新任务：独立检查 B。' },
      });
      await runtime.waitForCommand('B', { timeoutMs: 5000 });
      expect((await store.getExecution(targetId!))?.status).toBe('planned');
      const readsBefore = permissionReads;
      if (ending === 'permission-denied') denied = true;
      if (ending === 'explicit-stop')
        await runtime.cancelExecution({
          ...scope,
          commandId: 'stop-owned-child',
          executionId: targetId!,
        });
      release[0]!.release();
      await eventually(
        async () => (await store.getExecution(carriers[0]!))?.status === 'succeeded',
      );
      if (ending === 'ordinary-input') {
        await eventually(async () => entered.has(4));
        const run = (await store.getView(targetSession!)).runs[0]!;
        expect(run.rootWorkCommandId).toBe('A');
        expect(run.deadlineAt! - run.createdAt).toBe(30 * 60 * 1000);
        expect(permissionReads).toBeGreaterThan(readsBefore);
        release[3]!.release();
        await eventually(async () => (await store.getExecution(targetId!))?.status === 'succeeded');
        expect(childCalls.get(targetSession!)).toBe(2);
      } else {
        await eventually(async () =>
          ['cancelled', 'failed'].includes((await store.getExecution(targetId!))?.status ?? ''),
        );
        expect((await store.getView(targetSession!)).runs).toHaveLength(0);
        expect(entered.has(4)).toBe(false);
        if (ending === 'permission-denied') {
          expect(permissionReads).toBeGreaterThan(readsBefore);
          expect((await store.getExecution(targetId!))?.status).toBe('failed');
        } else expect((await store.getExecution(targetId!))?.status).toBe('cancelled');
      }
      expect(
        (await store.listExecutions('root')).filter((e) => e.childSessionId === targetSession),
      ).toHaveLength(1);
    } finally {
      for (const item of release) item.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}
