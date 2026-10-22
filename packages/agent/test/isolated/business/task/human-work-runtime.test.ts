import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > deadline) throw Error('ordinary_input_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(
  respond: (request: ModelRequest, index: number) => AsyncGenerator<ModelEvent>,
  child?: ModelAdapter,
  childToolIds: string[] = [],
) {
  const root = temporaryDirectory('kite-ordinary-human-input-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const requests: ModelRequest[] = [];
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (
        [
          'registerHumanCommand',
          'registerHumanInput',
          'decideHumanInput',
          'beginHumanInputProcessing',
        ].includes(String(key))
      )
        return () => {
          throw Error(`retired_input_interpreter_called:${String(key)}`);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runtime = createRuntime({
    store: runtimeStore,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'ordinary',
    modelConcurrency: 4,
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        expect(request.messages.some((m) => m.content.includes('Original input identity: '))).toBe(
          false,
        );
        yield* respond(request, requests.length);
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'current' };
      },
    },
    afterTurn: {
      async authorize() {
        return { allowed: true, revision: 'completion' };
      },
    },
    ...(child
      ? {
          extensions: [
            createTaskExtension({
              roles: [{ id: 'worker', configurationId: 'worker', description: 'General child' }],
            }),
          ],
          childConfigurations: [
            {
              id: 'worker',
              version: '1',
              model: child,
              modelId: 'child',
              toolIds: childToolIds,
              snapshot: {},
            },
          ],
        }
      : {}),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...scope,
    commandId: 'create',
    workspaceId: 'w',
    title: 'ordinary inputs',
  });
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), { readonly: true });
  const start = (commandId: string, content: string) =>
    runtime.submitCommand({
      ...scope,
      commandId,
      request: { kind: 'run.start', content },
    });
  const follow = async (commandId: string, content: string) => {
    const view = await store.getView('root');
    return runtime.submitCommand({
      ...scope,
      commandId,
      request: {
        kind: 'input.follow_up',
        content,
        contextSelectionId: view.session.contextSelectionId,
        afterRunId: view.runs.at(-1)?.id ?? null,
      },
    });
  };
  const noInterpretation = () => {
    expect(
      db.query("SELECT id FROM command WHERE kind IN ('human.input','human.input.decision')").all(),
    ).toEqual([]);
    expect(
      db
        .query(
          "SELECT id FROM run WHERE json_extract(config_json,'$.snapshot.kind')='human_input_processing'",
        )
        .all(),
    ).toEqual([]);
  };
  return {
    store,
    runtime,
    scope,
    requests,
    db,
    start,
    follow,
    noInterpretation,
    profile,
    async close() {
      await runtime.close();
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const text of [
  'Inspect the "login" implementation.\n\n> Reference material only.',
  '先别做这个了，说明一下目前的情况。',
  '另外帮我检查搜索问题，不要修改文件。',
])
  test(`ordinary input reaches the main Agent once without an attribution reply: ${text.slice(0, 24)}`, async () => {
    const f = await fixture(async function* (request) {
      expect(request.messages.some((m) => m.role === 'user' && m.content === text)).toBe(true);
      yield { type: 'text_delta', text: 'Actual ordinary response or necessary clarification.' };
      yield finish;
    });
    try {
      await f.start('input', text);
      await f.runtime.waitForCommand('input', { timeoutMs: 5000 });
      f.noInterpretation();
      expect(f.requests).toHaveLength(1);
      const messages = await f.runtime.listMessages('root');
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', text],
        ['assistant', 'Actual ordinary response or necessary clarification.'],
      ]);
      expect((await f.store.getView('root')).runs).toHaveLength(1);
      expect(
        f.db.query("SELECT id FROM command WHERE kind IN ('run.cancel','execution.cancel')").all(),
      ).toEqual([]);
      const saved = await f.store.getCommand('input');
      await f.start('input', text);
      expect(await f.store.getCommand('input')).toEqual(saved);
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('identical explicit follow-ups remain separate user turns and cold reads issue no interpretation or Model', async () => {
  const text = 'Check "login".\n> reference';
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: 'Actual result' };
    yield finish;
  });
  try {
    await f.start('first', text);
    await f.runtime.waitForCommand('first', { timeoutMs: 5000 });
    await f.follow('second', text);
    await f.runtime.waitForCommand('second', { timeoutMs: 5000 });
    f.noInterpretation();
    expect(f.requests).toHaveLength(2);
    const messages = await f.runtime.listMessages('root');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([text, text]);
    const persisted = await f.store.listMessages('root');
    await f.runtime.close();
    const cold = await openSqliteStore(f.profile);
    try {
      expect(await cold.listMessages('root')).toEqual(persisted);
    } finally {
      await cold.close();
    }
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('a queued follow-up waits for the current turn and preserves its own public command and cancellation scope', async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture(async function* (_request, index) {
    if (index === 1) {
      entered.release();
      await release.promise;
    }
    yield { type: 'text_delta', text: index === 1 ? 'First finished' : 'Queued result' };
    yield finish;
  });
  try {
    await f.start('first', 'Work A');
    await entered.promise;
    const queued = await f.follow('queued', 'Check "B" next.');
    expect(queued.status).toBe('accepted');
    expect(f.requests).toHaveLength(1);
    expect((await f.store.getPendingInputQueue(f.scope)).commands.map((c) => c.id)).toEqual([
      'queued',
    ]);
    expect((await f.store.getView('root')).runs.filter((r) => r.isActive)).toHaveLength(1);
    release.release();
    await f.runtime.waitForCommand('queued', { timeoutMs: 5000 });
    f.noInterpretation();
    expect(f.requests).toHaveLength(2);
    const view = await f.store.getView('root');
    expect(view.runs.map((r) => r.originCommandId)).toEqual(['first', 'queued']);
    expect(view.runs.every((r) => r.status === 'completed')).toBe(true);
    expect(
      f.requests[1]!.messages.some((m) => m.role === 'user' && m.content === 'Check "B" next.'),
    ).toBe(true);
  } finally {
    release.release();
    await f.close();
  }
});

test('withdrawing a queued prompt does not cancel the running Agent or create a classifier', async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture(async function* () {
    entered.release();
    await release.promise;
    yield { type: 'text_delta', text: 'A complete' };
    yield finish;
  });
  try {
    await f.start('A', 'A original');
    await entered.promise;
    await f.follow('B', 'Independent B next');
    await f.runtime.cancelCommand({ ...f.scope, commandId: 'cancel-B', targetCommandId: 'B' });
    release.release();
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    expect((await f.store.getCommand('B'))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getCommand('A'))?.cancelRequestedAt).toBeNull();
    expect(f.requests).toHaveLength(1);
    f.noInterpretation();
  } finally {
    release.release();
    await f.close();
  }
});

test('active steering is delivered to the same main Run with no separate input-processing Run', async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture(async function* (request, index) {
    if (index === 1) {
      entered.release();
      await release.promise;
    } else
      expect(
        request.messages.some((m) => m.role === 'user' && m.content === 'Focus on search now'),
      ).toBe(true);
    yield { type: 'text_delta', text: index === 1 ? 'Original progress' : 'Steered answer' };
    yield finish;
  });
  try {
    await f.start('A', 'Inspect login');
    await entered.promise;
    const view = await f.store.getView('root');
    const run = view.runs[0]!;
    await f.runtime.submitCommand({
      ...f.scope,
      commandId: 'steer',
      request: {
        kind: 'input.steer',
        content: 'Focus on search now',
        targetRunId: run.id,
        contextSelectionId: view.session.contextSelectionId,
      },
    });
    release.release();
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    expect((await f.store.getView('root')).runs.map((r) => r.id)).toEqual([run.id]);
    expect((await f.store.getCommand('steer'))?.status).toBe('applied');
    expect(f.requests).toHaveLength(2);
    f.noInterpretation();
  } finally {
    release.release();
    await f.close();
  }
});

test('a late child result enters the active conversation Run with its original provenance and one Source', async () => {
  const childEntered = gate(),
    childRelease = gate(),
    nextEntered = gate(),
    nextRelease = gate();
  const child: ModelAdapter = {
    async *stream() {
      childEntered.release();
      await childRelease.promise;
      yield { type: 'text_delta', text: 'VERIFIED OLD CHILD RESULT' };
      yield finish;
    },
  };
  const f = await fixture(async function* (request, index) {
    if (index === 1) {
      yield {
        type: 'tool_call',
        id: 'spawn',
        name: 'spawn_agent',
        arguments: JSON.stringify({ prompt: 'Inspect login in the background' }),
      };
      yield { ...finish, reason: 'tool_calls' };
      return;
    }
    if (request.messages.some((m) => m.role === 'user' && m.content === 'Now discuss search')) {
      nextEntered.release();
      await nextRelease.promise;
    }
    yield { type: 'text_delta', text: 'Actual main reply' };
    yield finish;
  }, child);
  try {
    await f.start('A', 'Inspect login');
    await childEntered.promise;
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    const carrier = (await f.store.listExecutions('root')).find((e) => e.childSessionId)!;
    await f.follow('B', 'Now discuss search');
    await nextEntered.promise;
    const b = (await f.store.getView('root')).runs.find((r) => r.originCommandId === 'B')!;
    childRelease.release();
    await until(async () => (await f.store.getExecution(carrier.id))?.status === 'succeeded');
    nextRelease.release();
    await f.runtime.waitForCommand('B', { timeoutMs: 5000 });
    const accepted = (await f.store.getExecution(carrier.id))!;
    expect(accepted.rootWorkCommandId).toBe('A');
    expect(b.rootWorkCommandId).toBe('B');
    expect(accepted.resultAcceptance?.runId).toBe(b.id);
    expect(
      f.requests.some((r) =>
        r.messages.some((m) => m.content.includes('VERIFIED OLD CHILD RESULT')),
      ),
    ).toBe(true);
    expect(
      f.db
        .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
        .all(carrier.id),
    ).toHaveLength(1);
    expect((await f.store.getView('root')).runs.map((r) => r.originCommandId)).toEqual(['A', 'B']);
    f.noInterpretation();
  } finally {
    childRelease.release();
    nextRelease.release();
    await f.close();
  }
});

test('historical unresolved attribution does not block a new ordinary input or replay its interpreter', async () => {
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: 'Ordinary answer' };
    yield finish;
  });
  try {
    await f.start('A', 'Original A');
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    const view = await f.store.getView('root');
    const raw = await f.store.registerHumanInput({
      ...f.scope,
      commandId: 'legacy-input',
      content: 'unclear old input',
      observedRunId: view.runs[0]!.id,
      contextSelectionId: view.session.contextSelectionId,
      candidateWorkCommandIds: ['A'],
    });
    const pending = await f.store.beginHumanInputProcessing({
      ...f.scope,
      inputCommandId: raw.id,
      inputDigest: raw.requestDigest,
    });
    const historical = await f.store.getCommand(raw.id);
    await f.follow('new', 'Check "search" now');
    await f.runtime.waitForCommand('new', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(2);
    expect((await f.store.getCommand(pending.id))?.receipt).toMatchObject({
      reason: 'input_processing_removed',
    });
    expect(await f.store.getCommand(raw.id)).toEqual(historical);
    expect(f.db.query("SELECT id FROM command WHERE kind='human.input'").all()).toHaveLength(1);
    expect(f.db.query("SELECT id FROM command WHERE kind='human.input.decision'").all()).toEqual(
      [],
    );
    expect((await f.store.getView('root')).runs.map((r) => r.originCommandId)).toEqual([
      'A',
      'new',
    ]);
  } finally {
    await f.close();
  }
});

test('a question carried by an old child result is associated once with the later ordinary parent turn', async () => {
  const sendQuestion = gate(),
    questionSaved = gate(),
    finishChild = gate(),
    parentEntered = gate(),
    finishParent = gate();
  const question = 'Should the palette be blue or green?';
  let childCalls = 0;
  const child: ModelAdapter = {
    async *stream() {
      if (childCalls++ === 0) {
        await sendQuestion.promise;
        yield {
          type: 'tool_call',
          id: 'question',
          name: 'send_agent_message',
          arguments: JSON.stringify({ target: 'parent', content: question }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        questionSaved.release();
        await finishChild.promise;
        yield { type: 'text_delta', text: `Inspection is complete. Pending decision: ${question}` };
        yield finish;
      }
    },
  };
  const f = await fixture(
    async function* (request, index) {
      if (index === 1) {
        yield {
          type: 'tool_call',
          id: 'spawn',
          name: 'spawn_agent',
          arguments: JSON.stringify({ prompt: 'Inspect the palette' }),
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (
        request.messages.some(
          (message) => message.role === 'user' && message.content === 'Discuss the final palette',
        )
      ) {
        parentEntered.release();
        await finishParent.promise;
      }
      yield { type: 'text_delta', text: 'Actual ordinary reply' };
      yield finish;
    },
    child,
    ['task.message'],
  );
  try {
    await f.start('A', 'Inspect palette');
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    sendQuestion.release();
    await questionSaved.promise;
    const mail = (await f.store.listAgentMessages({ ...f.scope })).items[0]!;
    expect(mail.targetRunId).toBeNull();
    expect(mail.receivedRunId).toBeNull();
    await f.follow('B', 'Discuss the final palette');
    await parentEntered.promise;
    const b = (await f.store.getView('root')).runs.find((run) => run.originCommandId === 'B')!;
    finishChild.release();
    await until(
      async () =>
        f.db.query("SELECT id FROM command WHERE kind='job.report' AND status='accepted'").all()
          .length === 1,
    );
    finishParent.release();
    await f.runtime.waitForCommand('B', { timeoutMs: 5000 });
    const carrier = (await f.store.listExecutions('root')).find(
      (execution) => execution.childSessionId,
    )!;
    expect(carrier.resultAcceptance?.runId).toBe(b.id);
    expect((await f.store.getCommand(mail.id))?.receipt).toMatchObject({
      carriedByResult: {
        executionId: carrier.id,
        runId: b.id,
        sourceId: carrier.resultAcceptance!.sourceId,
      },
    });
    expect(
      (await f.store.getAgentMessage({ ...f.scope, messageId: mail.id }))?.receivedRunId,
    ).toBeNull();
    expect(
      f.requests.at(-1)!.messages.filter((message) => message.content.includes(question)),
    ).toHaveLength(1);
    expect(
      f.requests.at(-1)!.messages.some((message) => message.sourceIds?.includes(mail.id)),
    ).toBe(false);
    f.noInterpretation();
  } finally {
    sendQuestion.release();
    finishChild.release();
    finishParent.release();
    await f.close();
  }
});

test('direct ordinary admission still rejects a foreign subject before saving input or calling a Model', async () => {
  const f = await fixture(async function* () {
    yield finish;
  });
  try {
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    for (const [commandId, submit] of [
      ['runtime', f.runtime.submitCommand.bind(f.runtime)],
      ['store', f.store.acceptCommand.bind(f.store)],
    ] as const) {
      const result = await submit({
        ...f.scope,
        commandId,
        subjectId: 'foreign',
        request: { kind: 'run.start', content: 'Not the session owner' },
      }).catch((error) => error);
      expect(result.code).toBe('permission_denied');
      expect(await f.store.getCommand(commandId)).toBeNull();
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.requests).toHaveLength(0);
    f.noInterpretation();
  } finally {
    await f.close();
  }
});
