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
import { AgentError } from '../../../../src/storage/types';

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

for (const ending of ['continue', 'stop', 'replace', 'permission-denied'] as const) {
  test(`queued original child defers outside selected work, releases its slot, and respects ${ending}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-queued-work-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    const release = [gate(), gate(), gate(), gate()];
    const firstThree = gate(),
      deferred = gate(),
      nextDeferred = gate();
    let deferredAttempts = 0,
      denied = false,
      permissionReads = 0,
      parentA = 0;
    const entered = new Set<number>();
    const childCalls = new Map<string, number>();
    let targetId: string | undefined, targetSession: string | undefined;
    const originalDispatch = store.markDispatching.bind(store);
    store.markDispatching = async (input) => {
      try {
        return await originalDispatch(input);
      } catch (error) {
        if (
          input.executionId === targetId &&
          error instanceof AgentError &&
          error.code === 'work_not_selected'
        ) {
          deferredAttempts++;
          deferred.release();
        }
        if (
          input.executionId === carriers[4] &&
          error instanceof AgentError &&
          error.code === 'work_not_selected'
        )
          nextDeferred.release();
        throw error;
      }
    };
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
          const instruction = request.messages.find(
            (m) => m.role === 'system' && m.content.includes('Original input identity: '),
          );
          if (instruction) {
            const line = instruction.content
              .split('\n')
              .find((v) => v.startsWith('Original input identity: '))!;
            const identity = JSON.parse(line.slice('Original input identity: '.length));
            yield {
              type: 'text_delta',
              text: JSON.stringify({
                ...identity,
                relation: 'same_work',
                purpose: 'replace',
                target_root_work_command_id: 'A',
                selection_effect: 'select_work',
                answer: null,
                clarification: null,
                clarifies_input_id: null,
              }),
            };
            yield finish;
            return;
          }
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
      await eventually(
        async () =>
          (await store.readHumanWorkState(scope)).selectedWork?.rootWorkCommandId === 'B' &&
          (await store.getView('root')).runs.some(
            (r) => r.rootWorkCommandId === 'B' && r.status === 'completed',
          ),
      );
      release[0]!.release();
      await deferred.promise;
      await nextDeferred.promise;
      await eventually(
        async () => (await store.getExecution(carriers[0]!))?.status === 'succeeded',
      );
      // The next original queued child reached final dispatch with the same A slot:
      // T must have released admission/resources while its work remained deferred.
      expect(entered.has(5)).toBe(false);
      // The failing implementation settles this same carrier before any new human control.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await store.getExecution(targetId!)).toMatchObject({
        status: 'planned',
        rootWorkCommandId: 'A',
        cancelRequestedAt: null,
      });
      expect((await store.getView(targetSession!)).runs).toHaveLength(0);
      expect(childCalls.get(targetSession!)).toBeUndefined();
      expect(entered.has(4)).toBe(false);
      expect(deferredAttempts).toBe(1);
      const readsBefore = permissionReads;
      if (ending === 'permission-denied') denied = true;
      await runtime.submitCommand({
        ...scope,
        commandId: 'control-A',
        request: {
          kind: 'run.start',
          content: ending === 'stop' ? '停止 A。' : ending === 'replace' ? '替换 A。' : '继续 A',
        },
      });
      if (ending === 'continue') {
        await eventually(async () => entered.has(4));
        const run = (await store.getRun((await store.getView(targetSession!)).runs[0]!.id))!;
        expect(run.rootWorkCommandId).toBe('A');
        expect(run.deadlineAt! - run.createdAt).toBe(30 * 60 * 1000);
        release[3]!.release();
        await eventually(async () => (await store.getExecution(targetId!))?.status === 'succeeded');
        expect((await store.getView(targetSession!)).runs).toHaveLength(1);
        expect(childCalls.get(targetSession!)).toBe(2);
        expect(permissionReads).toBeGreaterThan(readsBefore);
      } else {
        await eventually(async () =>
          ['cancelled', 'failed'].includes((await store.getExecution(targetId!))?.status ?? ''),
        );
        expect((await store.getView(targetSession!)).runs).toHaveLength(0);
        expect(childCalls.get(targetSession!)).toBeUndefined();
        expect(entered.has(4)).toBe(false);
        if (ending === 'permission-denied') {
          expect(permissionReads).toBeGreaterThan(readsBefore);
          expect((await store.getExecution(targetId!))?.status).toBe('failed');
        } else if (ending === 'stop')
          expect((await store.getExecution(targetId!))?.status).toBe('cancelled');
        else
          expect((await store.getExecution(targetId!))?.result).toMatchObject({
            outcome: 'failed',
            content: 'work_replaced',
          });
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
