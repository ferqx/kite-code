import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: unknown): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
test('actual Task message follows the exact child ledger at a Model safe checkpoint and public child input remains rejected', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-message-')));
  const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    childReady = resolve;
  });
  const childRequests: ModelRequest[] = [];
  const child: ModelAdapter = {
    async *stream(request, { signal }) {
      childRequests.push(structuredClone(request));
      if (childRequests.length === 1) {
        childReady();
        await Promise.race([
          gate,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
        ]);
      }
      yield finish;
    },
  };
  let parentCalls = 0;
  let agent!: {
    childSessionId: string;
    contextSelectionId: string;
    run: { id: string; deadlineAt: number };
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      parentCalls++;
      let events: ModelEvent[];
      if (parentCalls === 1)
        events = call('task', {
          key: 'child',
          role: 'reader',
          input: { content: 'original task' },
          cancellation: 'detached',
        });
      else if (parentCalls === 2) {
        await ready;
        events = call('task_read', { taskId: 'child' });
      } else if (parentCalls === 3) {
        const result = JSON.parse(
          request.messages.filter((message) => message.role === 'tool').at(-1)!.content,
        ) as { agent: typeof agent };
        agent = result.agent;
        expect(agent.run.deadlineAt).toBeGreaterThan(Date.now());
        const before = (await store.getMetadata()).lastChangeCursor;
        let rejected: unknown;
        try {
          await store.acceptCommand({
            expectedStoreId: (await store.getMetadata()).storeId,
            commandId: 'public-child',
            sessionId: agent.childSessionId,
            subjectId: 'owner',
            request: {
              kind: 'input.steer',
              targetRunId: agent.run.id,
              contextSelectionId: agent.contextSelectionId,
              content: 'pretend public child input',
            },
          });
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({ code: 'group_root_required' });
        expect((await store.getMetadata()).lastChangeCursor).toBe(before);
        events = call('send_message', {
          taskId: 'child',
          key: 'message1',
          content: 'exact extra instruction',
        });
      } else if (parentCalls === 4) {
        release();
        events = call('task_wait', { taskId: 'child', timeoutMs: 4000 });
      } else events = [finish];
      for (const event of events) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(directory, 'data'), profile: 'test' },
      store,
    }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 2,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'trusted child' }],
      }),
    ],
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'message',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'delegate' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect(childRequests).toHaveLength(2);
    const message = childRequests[1]!.messages.find((item) =>
      item.content.includes('exact extra instruction'),
    )!;
    expect(message.role).toBe('user');
    expect(message.sourceIds).toHaveLength(1);
    expect(JSON.parse(message.content.split('\n').slice(1).join('\n'))).toMatchObject({
      sourceSessionId: 'root',
      content: 'exact extra instruction',
    });
    const command = await store.getCommand(message.sourceIds![0]!);
    expect(command?.kind).toBe('agent.message');
    expect(command?.status).toBe('applied');
    expect(command?.sessionId).toBe('root');
    expect((await store.getRun(agent.run.id))?.status).toBe('completed');
    expect(
      (await store.listMessages(agent.childSessionId)).filter((item) =>
        item.sourceIds?.includes(message.sourceIds![0]!),
      ),
    ).toHaveLength(1);
    expect((await store.getView('root')).runs).toHaveLength(1);
  } finally {
    release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 12000);
