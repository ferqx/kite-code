import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
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
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const result = await read();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw Error('queued_follow_up_fixture_timeout');
    await Bun.sleep(5);
  }
}
test('a queued-to-idle follow-up race rejects before admission and a fresh invocation starts exactly one turn', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-queued-follow-up-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let stage = 0,
    targetId = '',
    targetCalls = 0,
    injectedRace = false;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rejected: unknown, accepted: unknown;
  let rejectedCarrierCount = 0,
    rejectedChildCalls = 0;
  const actualList = store.listStableAgents.bind(store);
  const carriers = async () =>
    (await store.listExecutions('root')).filter((item) => item.childSessionId === targetId);
  store.listStableAgents = async (input) => {
    const original = await actualList(input);
    if (targetId && input.agentIds?.[0] === targetId && !injectedRace) {
      injectedRace = true;
      expect(original.items[0]?.runId).toBeNull();
      expect(original.items[0]?.state).toBe('queued');
      release();
      await until(async () => ((await carriers()).at(-1)?.status === 'succeeded' ? true : null));
    }
    return original;
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const body = last ? JSON.parse(last.content) : null;
      let events: ModelEvent[];
      switch (stage++) {
        case 0:
          events = call('spawn_agent', { prompt: 'Hold blocker' });
          break;
        case 1:
          events = call('spawn_agent', { prompt: 'Target assignment' });
          break;
        case 2:
          targetId = body.agent_id;
          events = call('follow_up_agent', { agent_id: targetId, content: 'Continue target' });
          break;
        case 3:
          rejected = body;
          rejectedCarrierCount = (await carriers()).length;
          rejectedChildCalls = targetCalls;
          events = call('follow_up_agent', { agent_id: targetId, content: 'Continue target' });
          break;
        case 4:
          accepted = body;
          events = [finish];
          break;
        default:
          events = [finish];
      }
      for (const event of events) yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      if (JSON.stringify(request.messages).includes('Hold blocker')) await blocker;
      else targetCalls++;
      yield { type: 'text_delta', text: 'Child finished' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 4,
    maxConcurrentSubagents: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'General child' }],
      }),
    ],
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'fixture',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'fixture',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'coordinate' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 12000 });
    expect(injectedRace).toBe(true);
    expect(rejected).toMatchObject({
      accepted: false,
      error: { code: 'target_changed', next_action: 'observe_then_new_call' },
    });
    expect(rejectedCarrierCount).toBe(1);
    expect(rejectedChildCalls).toBe(1);
    expect(accepted).toMatchObject({
      accepted: true,
      agent_id: targetId,
      mode: 'new_turn',
      state: 'queued',
    });
    await until(async () =>
      targetCalls === 2 && (await carriers()).at(-1)?.status === 'succeeded' ? true : null,
    );
    expect(await carriers()).toHaveLength(2);
    expect((await store.getView(targetId)).runs).toHaveLength(2);
  } finally {
    release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
