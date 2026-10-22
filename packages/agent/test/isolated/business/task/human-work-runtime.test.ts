import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import type { ToolDefinition } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import type { Store } from '../../../../src/storage/port';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('cancelled queued B preserves its selection while A finitely hands off without rejected Model spin or child-result adoption', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-cancelled-queued-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const parentEntered = gate(),
    parentGate = gate(),
    childEntered = gate(),
    childGate = gate();
  let parentCalls = 0,
    childCalls = 0,
    finiteStarts = 0,
    finiteCompletions = 0;
  let finiteExecutionId: string | undefined;
  const finite: ToolDefinition = {
    id: 'fixture.finite',
    version: '1',
    model: { name: 'finite_probe' },
    description: 'Complete one owned finite filesystem probe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input, context) {
      finiteStarts++;
      finiteExecutionId = context.executionId;
      parentEntered.release();
      await parentGate.promise;
      context.signal.throwIfAborted();
      writeFileSync(join(root, 'finite-result'), 'completed\n');
      finiteCompletions++;
      return { outcome: 'succeeded', content: readFileSync(join(root, 'finite-result'), 'utf8') };
    },
  };
  const parent: ModelAdapter = {
    async *stream() {
      if (++parentCalls !== 1) throw Error('cancelled queued B must not create another A Model');
      yield {
        type: 'tool_call',
        id: 'spawn',
        name: 'spawn_agent',
        arguments: JSON.stringify({
          prompt:
            'Keep inspecting A until the finite read completes, then report its actual result.',
        }),
      };
      yield { type: 'tool_call', id: 'finite', name: 'finite_probe', arguments: '{}' };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      childEntered.release();
      await childGate.promise;
      yield { type: 'text_delta', text: 'Exact A child result after queued B was cancelled.' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'original-A',
    modelConcurrency: 3,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    afterTurn: {
      async authorize() {
        return { allowed: true, revision: 'current' };
      },
    },
    extensions: [
      { id: 'fixture.finite', version: '1', apiMajor: 1, tools: [finite] },
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'general' }],
      }),
    ],
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), { readonly: true });
  let closed = false;
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
      title: 'queued cancellation',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'A',
      request: { kind: 'run.start', content: 'Inspect original A.' },
    });
    await parentEntered.promise;
    await childEntered.promise;
    const a = (await store.getView('root')).runs.find((run) => run.rootWorkCommandId === 'A')!;
    const carrier = (await store.getView('root')).executions.find(
      (execution) => execution.childSessionId,
    )!;
    expect(a.isActive).toBe(true);
    expect(await store.getExecution(finiteExecutionId!)).toMatchObject({
      status: 'dispatching',
      authorization: { dispatched: true },
      cancelRequestedAt: null,
    });
    expect(parentCalls).toBe(1);
    expect(childCalls).toBe(1);
    await runtime.submitCommand({
      ...scope,
      commandId: 'B',
      request: { kind: 'run.start', content: '新任务：独立检查 B，不要接管 A。' },
    });
    await eventually(async () => {
      const command = await store.getCommand('B');
      return (command?.receipt as { outcome?: string } | null)?.outcome === 'human_input_queued';
    });
    const b = (await store.getCommand('B'))!;
    const queued = b.receipt as {
      humanInputCommandId: string;
      businessCommandId: string;
      runId: null;
    };
    expect(queued.runId).toBeNull();
    const raw = (await store.getCommand(queued.humanInputCommandId))!;
    expect(raw.receipt).toMatchObject({
      state: 'decided',
      businessCommandId: queued.businessCommandId,
    });
    const business = (await store.getCommand(queued.businessCommandId))!;
    expect(business.status).toBe('accepted');
    expect(business.rootWorkCommandId).toBe('B');
    expect((await store.getView('root')).runs.some((run) => run.rootWorkCommandId === 'B')).toBe(
      false,
    );
    expect(await store.readHumanWorkState(scope)).toMatchObject({
      selectedWork: { rootWorkCommandId: 'B' },
    });
    await runtime.cancelCommand({ ...scope, commandId: 'cancel-B', targetCommandId: 'B' });
    expect((await store.getCommand('cancel-B'))?.status).toBe('applied');
    expect((await store.getCommand('B'))?.cancelRequestedAt).not.toBeNull();
    expect((await store.getCommand(raw.id))?.cancelRequestedAt).not.toBeNull();
    expect((await store.getCommand(business.id))?.cancelRequestedAt).not.toBeNull();
    expect((await store.getRun(a.id))?.isActive).toBe(true);
    expect((await store.getExecution(finiteExecutionId!))?.cancelRequestedAt).toBeNull();
    // Count durable Model executions, not only adapter calls: work_not_selected can
    // fail before the adapter and otherwise conceal a zero-HTTP rejection loop.
    const assertNoNewAModel = () => {
      expect(
        db
          .query("SELECT count(*) AS count FROM execution WHERE kind='model' AND run_id=?")
          .get(a.id),
      ).toEqual({ count: 1 });
      expect(parentCalls).toBe(1);
    };
    assertNoNewAModel();
    parentGate.release();
    childGate.release();
    await eventually(async () => {
      assertNoNewAModel();
      const current = await store.getRun(a.id);
      return current?.isActive === false;
    });
    expect(await store.getRun(a.id)).toMatchObject({
      status: 'completed',
      reason: 'human_work_deferred',
      isActive: false,
    });
    await eventually(async () => {
      assertNoNewAModel();
      return (await store.getExecution(carrier.id))?.status === 'succeeded';
    });
    await eventually(async () => {
      assertNoNewAModel();
      const reports = await store.listPendingJobReports({ expectedStoreId, sessionId: 'root' });
      return reports.commands.some(
        (command) => (command.receipt as { reason?: string }).reason === 'work_not_selected',
      );
    });
    await eventually(async () => {
      assertNoNewAModel();
      const parentView = await store.getView('root');
      const childView = await store.getView(carrier.childSessionId!);
      return (
        parentView.runs.every((run) => !run.isActive) &&
        childView.runs.every((run) => !run.isActive) &&
        parentView.session.ownerInstanceId === null &&
        childView.session.ownerInstanceId === null
      );
    });
    expect(finiteStarts).toBe(1);
    expect(finiteCompletions).toBe(1);
    expect(readFileSync(join(root, 'finite-result'), 'utf8')).toBe('completed\n');
    expect(await store.getExecution(finiteExecutionId!)).toMatchObject({
      status: 'succeeded',
      cancelRequestedAt: null,
    });
    expect(await store.getExecution(carrier.id)).toMatchObject({
      status: 'succeeded',
      cancelRequestedAt: null,
      resultAcceptance: null,
    });
    const finalView = await store.getView('root');
    expect(finalView.runs).toHaveLength(1);
    expect(
      finalView.messages.some((message) => message.content.includes('Exact A child result')),
    ).toBe(false);
    expect(await store.readHumanWorkState(scope)).toMatchObject({
      selectedWork: { rootWorkCommandId: 'B' },
    });
    expect(db.query("SELECT count(*) AS count FROM execution WHERE kind='model'").get()).toEqual({
      count: 2,
    });
    assertNoNewAModel();
    const finalMetadata = await store.getMetadata();
    await runtime.close();
    await store.close();
    closed = true;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    const coldRuntime = createRuntime({
      store: cold,
      model: parent,
      modelId: 'original-A',
      permissions: {
        async authorize() {
          throw Error('cold read cannot authorize work');
        },
      },
    });
    try {
      expect((await coldRuntime.getView('root')).runs).toEqual(finalView.runs);
      expect(await cold.readHumanWorkState(scope)).toMatchObject({
        selectedWork: { rootWorkCommandId: 'B' },
      });
      expect(await cold.getExecution(carrier.id)).toMatchObject({
        status: 'succeeded',
        resultAcceptance: null,
      });
      expect(await cold.getMetadata()).toEqual(finalMetadata);
      expect(parentCalls).toBe(1);
      expect(childCalls).toBe(1);
      expect(finiteCompletions).toBe(1);
      expect(db.query("SELECT count(*) AS count FROM execution WHERE kind='model'").get()).toEqual({
        count: 2,
      });
    } finally {
      await coldRuntime.close();
      await cold.close();
    }
  } finally {
    parentGate.release();
    childGate.release();
    if (!closed) {
      await runtime.close();
      await store.close();
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function eventually(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('actual boundary not reached');
    await Bun.sleep(10);
  }
}

test.each([
  '请问 work_A 的进度怎样？work_B 的当前安排保持。',
  '是不是应该停掉其中一个？',
])('a rejected observation keeps the original Model and exposes clarification: %s', async (content) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-progress-target-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const rejectedAnswer = 'This answer was associated with the wrong work.';
  let processingCalls = 0;
  const model: ModelAdapter = {
    async *stream(request) {
      const instruction = request.messages.find(
        (message) =>
          message.role === 'system' && message.content.includes('Original input identity:'),
      );
      if (instruction) {
        processingCalls++;
        expect(request.tools).toEqual([]);
        const identity = JSON.parse(
          instruction.content
            .split('\n')
            .find((line) => line.startsWith('Original input identity: '))!
            .slice('Original input identity: '.length),
        );
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            ...identity,
            relation: 'same_work',
            purpose: 'progress',
            target_root_work_command_id: 'work_B',
            selection_effect: 'keep',
            answer: rejectedAnswer,
            clarification: null,
          }),
        };
      } else yield { type: 'text_delta', text: 'Ordinary work completed.' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixture',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
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
      commandId: 'create',
      workspaceId: 'w',
      title: 'progress target',
    });
    for (const [commandId, content] of [
      ['work_A', 'Inspect A.'],
      ['work_B', '新任务：Inspect B.'],
    ] as const) {
      await runtime.submitCommand({ ...scope, commandId, request: { kind: 'run.start', content } });
      await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    }
    const originalRuns = (await store.getView('root')).runs;
    const accepted = await runtime.submitCommand({
      ...scope,
      commandId: 'progress',
      request: { kind: 'run.start', content },
    });
    const rawId = (accepted.receipt as { humanInputCommandId: string }).humanInputCommandId;
    await eventually(
      async () =>
        typeof ((await store.getCommand(rawId))?.receipt as { decisionCommandId?: string } | null)
          ?.decisionCommandId === 'string' &&
        (await store.getView('root')).runs.every((run) => !run.isActive),
    );
    const raw = (await store.getCommand(rawId))!;
    expect(raw.request).toMatchObject({ content });
    expect(raw.receipt).toMatchObject({
      state: 'unresolved',
      businessCommandId: null,
      observation: { answer: null },
    });
    const fact = raw.receipt as {
      decisionCommandId: string;
      observation: { clarification: string };
    };
    expect(fact.observation.clarification).toBeTruthy();
    expect((await store.getCommand(fact.decisionCommandId))?.request).toMatchObject({
      proposal: { relation: 'unresolved', targetRootWorkCommandId: null },
    });
    expect((await store.readHumanWorkState(scope)).selectedWork?.rootWorkCommandId).toBe('work_B');
    const view = await store.getView('root');
    expect(view.runs.filter((run) => ['work_A', 'work_B'].includes(run.rootWorkCommandId))).toEqual(
      originalRuns,
    );
    expect(view.messages.some((message) => message.content.includes(rejectedAnswer))).toBe(true);
    expect(
      (await runtime.getView('root')).messages.some((message) =>
        message.content.includes(rejectedAnswer),
      ),
    ).toBe(false);
    expect(processingCalls).toBe(1);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['independent', 'progress', 'idle_progress'] as const)
  test(`real human ${mode}: raw invocation, original work and actual business admission remain separate`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-work-runtime-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const storeId = (await store.getMetadata()).storeId;
    const parentReady = gate(),
      parentGate = gate(),
      childReady = gate(),
      childGate = gate();
    const requests: ModelRequest[] = [];
    let initial = 0,
      childCalls = 0;
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        const interpreter = request.messages.find(
          (message) =>
            message.role === 'system' && message.content.includes('Original input identity:'),
        );
        if (interpreter) {
          expect(request.tools).toHaveLength(0);
          const line = interpreter.content
            .split('\n')
            .find((value) => value.startsWith('Original input identity: '))!;
          const identity = JSON.parse(line.slice('Original input identity: '.length));
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              ...identity,
              relation: 'same_work',
              purpose: 'progress',
              target_root_work_command_id: 'A',
              selection_effect: 'keep',
              answer: 'The original child is still running.',
              clarification: null,
            }),
          };
          yield finish;
          return;
        }
        if (request.messages.some((message) => message.content === '继续 A')) {
          expect(
            request.messages.some((message) =>
              message.sourceIds?.some((id) => id.startsWith('result-')),
            ),
          ).toBe(true);
          yield { type: 'text_delta', text: 'A resumed from its exact result.' };
          yield finish;
          return;
        }
        if (request.messages.some((message) => message.content === '新任务：B')) {
          expect(
            request.messages.some((message) =>
              message.sourceIds?.some((id) => id.startsWith('result-')),
            ),
          ).toBe(false);
          yield { type: 'text_delta', text: 'B finished independently.' };
          yield finish;
          return;
        }
        if (initial++ === 0) {
          yield {
            type: 'tool_call',
            id: 'spawn',
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: 'A child remains alive until released.' }),
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (initial === 2) {
          parentReady.release();
          await parentGate.promise;
        }
        yield { type: 'text_delta', text: 'A ordinary turn ended; child work remains pending.' };
        yield finish;
      },
    };
    const child: ModelAdapter = {
      async *stream() {
        childCalls++;
        childReady.release();
        await childGate.promise;
        yield { type: 'text_delta', text: 'Exact A child result.' };
        yield finish;
      },
    };
    let omitViewExecutions = false;
    const observedStore = new Proxy(store, {
      get(target, key) {
        if (key === 'getView')
          return async (...args: Parameters<Store['getView']>) => {
            const view = await target.getView(...args);
            return omitViewExecutions ? { ...view, executions: [] } : view;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = createRuntime({
      store: observedStore,
      model,
      modelId: 'root',
      modelConcurrency: 3,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'current' };
        },
      },
      extensions: [
        createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'worker', description: 'general' }],
        }),
      ],
      childConfigurations: [
        { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'fixture',
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'human work',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'A',
        sessionId: 'root',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'A' },
      });
      await parentReady.promise;
      await childReady.promise;
      const a = (await store.getView('root')).runs.find((run) => run.isActive)!;
      if (mode === 'idle_progress') {
        parentGate.release();
        await eventually(async () => !(await store.getRun(a.id))!.isActive);
      }
      const originalRequest =
        mode === 'idle_progress'
          ? {
              kind: 'input.follow_up' as const,
              afterRunId: a.id,
              contextSelectionId: a.contextSelectionId,
              content: '进度怎样',
            }
          : {
              kind: 'input.steer' as const,
              targetRunId: a.id,
              contextSelectionId: a.contextSelectionId,
              content: mode === 'independent' ? '新任务：B' : '进度怎样',
            };
      const accepted = await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'input',
        sessionId: 'root',
        subjectId: 'owner',
        request: originalRequest,
      });
      expect(accepted).toMatchObject({
        id: 'input',
        kind: originalRequest.kind,
        request: originalRequest,
        status: 'accepted',
      });
      if (mode !== 'idle_progress')
        expect((await store.getView('root')).runs.filter((run) => run.isActive)).toHaveLength(1);
      parentGate.release();
      const applied = await runtime.waitForCommand('input', { timeoutMs: 5000 });
      if (applied.status !== 'applied') throw Error(JSON.stringify(applied.receipt));
      expect(JSON.parse(JSON.stringify(applied.request))).toEqual(originalRequest);
      const childCarrier = (await store.getView('root')).executions.find(
        (execution) => execution.childSessionId,
      )!;
      if (mode === 'independent') {
        const b = await store.getRun((applied.receipt as { runId: string }).runId);
        expect(b?.rootWorkCommandId).toBe('input');
        expect(b?.originCommandId).toBe(
          (applied.receipt as { businessCommandId: string }).businessCommandId,
        );
        await eventually(async () => !(await store.getRun(b!.id))!.isActive);
        expect((await store.getRun(a.id))?.reason).toBe('human_work_deferred');
        expect((await store.getExecution(childCarrier.id))?.cancelRequestedAt).toBeNull();
        await runtime.submitCommand({
          expectedStoreId: storeId,
          commandId: 'progress-A',
          sessionId: 'root',
          subjectId: 'owner',
          request: { kind: 'run.start', content: '请问 A 的进度怎样？' },
        });
        const progress = await runtime.waitForCommand('progress-A', { timeoutMs: 5000 });
        const observation = progress.receipt as {
          runId: null;
          observation: { runId: string; answer: string };
        };
        expect(observation.runId).toBeNull();
        expect(observation.observation.answer).toBe('The original child is still running.');
        const processingRun = (await store.getRun(observation.observation.runId))!;
        await eventually(async () => !(await store.getRun(processingRun.id))!.isActive);
        expect(processingRun.rootWorkCommandId).toBe(processingRun.originCommandId);
        expect(processingRun.rootWorkCommandId).not.toBe('A');
        expect(processingRun.rootWorkCommandId).not.toBe('input');
        expect(
          (
            await store.readHumanWorkState({
              expectedStoreId: storeId,
              sessionId: 'root',
              subjectId: 'owner',
            })
          ).selectedWork?.rootWorkCommandId,
        ).toBe('input');
        expect((await store.getExecution(childCarrier.id))?.resultAcceptance).toBeNull();
        childGate.release();
        await runtime.waitForCommand(childCarrier.originCommandId, { timeoutMs: 5000 });
        await eventually(async () =>
          (
            await store.listPendingJobReports({ expectedStoreId: storeId, sessionId: 'root' })
          ).commands.some(
            (command) => (command.receipt as { reason?: string }).reason === 'work_not_selected',
          ),
        );
        const before = requests.length;
        await runtime.cancelCommand({
          expectedStoreId: storeId,
          commandId: 'cancel-B',
          targetCommandId: 'input',
          sessionId: 'root',
          subjectId: 'owner',
        });
        await Bun.sleep(75);
        expect(requests).toHaveLength(before);
        expect(
          (
            await store.readHumanWorkState({
              expectedStoreId: storeId,
              sessionId: 'root',
              subjectId: 'owner',
            })
          ).selectedWork?.rootWorkCommandId,
        ).toBe('input');
        const resumed = await runtime.submitCommand({
          expectedStoreId: storeId,
          commandId: 'resume-A',
          sessionId: 'root',
          subjectId: 'owner',
          request: {
            kind: 'input.follow_up',
            afterRunId: processingRun.id,
            contextSelectionId: a.contextSelectionId,
            content: '继续 A',
          },
        });
        expect(resumed.status).toBe('accepted');
        const result = await runtime.waitForCommand('resume-A', { timeoutMs: 5000 });
        if (result.status !== 'applied') throw Error(JSON.stringify(result.receipt));
        const resumedRun = await store.getRun((result.receipt as { runId: string }).runId);
        expect(resumedRun?.rootWorkCommandId).toBe('A');
        expect(resumedRun?.status).toBe('completed');
        expect((await store.getExecution(childCarrier.id))?.resultAcceptance?.runId).toBe(
          resumedRun?.id,
        );
      } else {
        await eventually(async () => !(await store.getRun(a.id))!.isActive);
        expect(
          (
            await store.readHumanWorkState({
              expectedStoreId: storeId,
              sessionId: 'root',
              subjectId: 'owner',
            })
          ).selectedWork?.rootWorkCommandId,
        ).toBe('A');
        expect((await store.getView('root')).runs).toHaveLength(mode === 'idle_progress' ? 2 : 1);
        const observation = applied.receipt as {
          runId: string | null;
          observation: { runId: string; executionId: string; messageId: string; answer: string };
        };
        expect(observation.runId).toBeNull();
        expect(observation.observation.answer).toBe('The original child is still running.');
        expect(
          (await runtime.getView('root')).messages.find(
            (message) => message.id === observation.observation.messageId,
          )?.content,
        ).toBe(observation.observation.answer);
        // A bounded View can omit an older Model while retaining its Message.
        // The ordinary transcript must still use the exact sealed observation.
        omitViewExecutions = true;
        expect(
          (await runtime.getView('root')).messages.find(
            (message) => message.id === observation.observation.messageId,
          )?.content,
        ).toBe(observation.observation.answer);
        omitViewExecutions = false;
        expect(
          (await store.getView('root')).messages.find(
            (message) => message.id === observation.observation.messageId,
          )?.content,
        ).toContain('input_digest');
        if (mode === 'idle_progress') {
          const processing = await store.getRun(observation.observation.runId);
          expect(processing?.configuration).toMatchObject({
            tools: [],
            snapshot: { kind: 'human_input_processing' },
          });
          expect(processing?.rootWorkCommandId).toBe(processing?.originCommandId);
          expect(processing?.rootWorkCommandId).not.toBe('A');
        }
        childGate.release();
        await runtime.waitForCommand(childCarrier.originCommandId, { timeoutMs: 5000 });
        await eventually(
          async () => (await store.getExecution(childCarrier.id))?.resultAcceptance != null,
        );
        expect((await store.getExecution(childCarrier.id))?.delivery).toBe('consumed');
      }
      for (const request of requests) {
        const interpreter = request.messages.find(
          (message) =>
            message.role === 'system' && message.content.includes('Original input identity:'),
        );
        if (!interpreter) continue;
        const line = interpreter.content
          .split('\n')
          .find((value) => value.startsWith('Original input identity: '))!;
        const identity = JSON.parse(line.slice('Original input identity: '.length));
        const currentRaw = (await store.getCommand(identity.input_command_id))!;
        expect(currentRaw.kind).toBe('human.input');
        expect(request.messages.filter((message) => message.role === 'user').at(-1)).toEqual({
          role: 'user',
          content: (currentRaw.request as { content: string }).content,
          sourceIds: [`human-input-${currentRaw.id}`],
        });
        expect(interpreter.content).toContain('Return one JSON object, without Markdown');
        // Current input follows the original history; it does not replace or rewrite it.
        const originalHistory = requests[0]!.messages.filter(
          (message) => message.role === 'user' && message.content === 'A',
        );
        expect(originalHistory).toHaveLength(1);
        expect(
          request.messages.filter((message) =>
            message.sourceIds?.some((id) => originalHistory[0]!.sourceIds?.includes(id)),
          ),
        ).toEqual(originalHistory);
      }
      expect(childCalls).toBe(1);
    } finally {
      parentGate.release();
      childGate.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

test('ambiguous actual input asks once in a read-only ordinary Model and a new real clarification closes its exact pending scope', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-clarification-runtime-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let calls = 0;
  const model: ModelAdapter = {
    async *stream(request) {
      calls++;
      const instruction = request.messages.find(
        (message) =>
          message.role === 'system' && message.content.includes('Original input identity:'),
      );
      if (instruction) {
        expect(request.tools).toHaveLength(0);
        const identity = JSON.parse(
          instruction.content
            .split('\n')
            .find((line) => line.startsWith('Original input identity: '))!
            .slice('Original input identity: '.length),
        );
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            ...identity,
            relation: 'unresolved',
            purpose: 'clarify',
            target_root_work_command_id: null,
            selection_effect: 'keep',
            answer: null,
            clarification: '你指的是 A 的原工作吗？',
            clarifies_input_id: null,
          }),
        };
      } else yield { type: 'text_delta', text: 'The current explicit work completed.' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'original-A',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'fixture',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'clarification',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'A',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'A' },
    });
    await runtime.waitForCommand('A');
    const unresolvedRequest = { kind: 'run.start' as const, content: '先别做这个' };
    const unknown = await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'unknown',
      sessionId: 'root',
      subjectId: 'owner',
      request: unresolvedRequest,
    });
    expect(unknown.request).toEqual(unresolvedRequest);
    const rawId = (unknown.receipt as { humanInputCommandId: string }).humanInputCommandId;
    await eventually(
      async () =>
        (await store.getCommand(rawId))?.receipt !== null &&
        ((await store.getCommand(rawId))!.receipt as { state?: string }).state === 'unresolved',
    );
    await eventually(async () => (await store.getView('root')).runs.every((run) => !run.isActive));
    const before = await store.readHumanWorkState({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
    });
    expect(before).toMatchObject({
      selectedWork: { rootWorkCommandId: 'A' },
      pendingInputIds: [rawId],
    });
    expect((await store.getCommand('unknown'))?.status).toBe('accepted');
    expect(
      (await runtime.getView('root')).messages.some(
        (message) => message.content === '你指的是 A 的原工作吗？',
      ),
    ).toBe(true);
    const answer = await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'clarification',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: '补充 A：我指的是 A 的原工作，核对原事实。' },
    });
    expect(answer.status).toBe('accepted');
    const applied = await runtime.waitForCommand('clarification');
    const actual = await store.getRun((applied.receipt as { runId: string }).runId);
    expect(actual?.rootWorkCommandId).toBe('A');
    expect(actual?.configuration).toEqual((await store.getView('root')).runs[0]!.configuration);
    expect((await store.getCommand(rawId))?.request).toMatchObject({
      content: unresolvedRequest.content,
    });
    expect((await store.getCommand(rawId))?.receipt).toMatchObject({
      state: 'clarified',
      clarifyingInputId: (applied.receipt as { humanInputCommandId: string }).humanInputCommandId,
    });
    expect((await runtime.waitForCommand('unknown')).receipt).toMatchObject({
      outcome: 'human_input_observed',
      reason: 'clarified_by_input',
    });
    expect(
      (
        await store.readHumanWorkState({
          expectedStoreId: storeId,
          sessionId: 'root',
          subjectId: 'owner',
        })
      ).pendingInputIds,
    ).toEqual([]);
    expect(calls).toBe(3);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('explicit Continue B with historical A and negative action constraints stays one direct original B business Run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-continue-historical-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(request);
      expect(
        request.messages.some(
          (message) =>
            message.role === 'system' && message.content.includes('Original input identity:'),
        ),
      ).toBe(false);
      yield { type: 'text_delta', text: 'The exact selected original work completed.' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'original-B-configuration',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
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
      title: 'exact continuation',
    });
    for (const [commandId, content] of [
      ['A', 'Inspect original compatibility.'],
      ['B', '新任务：独立整理费用摘要。'],
    ] as const) {
      await runtime.submitCommand({ ...scope, commandId, request: { kind: 'run.start', content } });
      await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      await eventually(async () =>
        (await store.getView('root')).runs.every((run) => !run.isActive),
      );
    }
    const before = await store.getView('root');
    const originalA = before.runs.find((run) => run.rootWorkCommandId === 'A')!;
    const originalB = before.runs.find((run) => run.rootWorkCommandId === 'B')!;
    const originalACommand = await store.getCommand('A');
    const originalBCommand = await store.getCommand('B');
    expect((await store.readHumanWorkState(scope)).selectedWork?.rootWorkCommandId).toBe('B');
    expect(requests).toHaveLength(2);
    const content =
      'Continue B. Keep A historical. Do not spawn, write yourself, or control other collaborators.';
    await runtime.submitCommand({
      ...scope,
      commandId: 'continue-B',
      request: { kind: 'run.start', content },
    });
    const applied = await runtime.waitForCommand('continue-B', { timeoutMs: 5000 });
    await eventually(async () => (await store.getView('root')).runs.every((run) => !run.isActive));
    const receipt = applied.receipt as { humanInputCommandId: string; runId: string };
    const raw = (await store.getCommand(receipt.humanInputCommandId))!;
    const fact = raw.receipt as { decisionCommandId: string; businessCommandId: string };
    const decision = (await store.getCommand(fact.decisionCommandId))!;
    expect(raw).toMatchObject({
      kind: 'human.input',
      sessionId: 'root',
      subjectId: 'owner',
      request: { content },
      receipt: { state: 'decided' },
    });
    expect(decision).toMatchObject({
      kind: 'human.input.decision',
      status: 'applied',
      request: {
        inputCommandId: raw.id,
        inputDigest: raw.requestDigest,
        proposal: {
          relation: 'same_work',
          purpose: 'continue',
          targetRootWorkCommandId: 'B',
          selectionEffect: 'select_work',
          basis: { kind: 'explicit_text', instruction: content },
        },
      },
    });
    expect(decision.request).not.toHaveProperty('interpretation');
    expect((await store.getCommand(fact.businessCommandId))?.rootWorkCommandId).toBe('B');
    const current = await store.getRun(receipt.runId);
    expect(current).toMatchObject({
      rootWorkCommandId: 'B',
      status: 'completed',
      configuration: originalB.configuration,
    });
    expect(current?.id).not.toBe(originalB.id);
    expect(await store.readHumanWorkState(scope)).toMatchObject({
      selectedWork: { rootWorkCommandId: 'B' },
      pendingInputIds: [],
    });
    const after = await store.getView('root');
    expect(after.runs.filter((run) => run.rootWorkCommandId === 'A')).toEqual([originalA]);
    expect(await store.getCommand('A')).toEqual(originalACommand);
    expect(await store.getCommand('B')).toEqual(originalBCommand);
    expect(after.runs).toHaveLength(3);
    expect(after.runs.filter((run) => !before.runs.some((old) => old.id === run.id))).toEqual([
      current!,
    ]);
    expect(
      after.executions.filter(
        (execution) => !before.executions.some((old) => old.id === execution.id),
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'model', runId: current!.id, status: 'succeeded' }),
    ]);
    expect(after.executions.some((execution) => execution.childSessionId !== null)).toBe(false);
    expect(requests).toHaveLength(3);
    expect(
      requests[2]!.messages.some(
        (message) => message.role === 'user' && message.content.includes(content),
      ),
    ).toBe(true);
    expect(await store.getCommand(raw.id)).toEqual(raw);
    expect(await store.getCommand(decision.id)).toEqual(decision);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

for (const confirmation of [
  '我指的是 A。现在继续 A，把已经保存的结果汇总，不要另开工作。',
  'To clarify, A. Please resume A.',
] as const)
  test(`a real confirmation of older A closes an ambiguous A/B input while B was selected: ${confirmation.startsWith('To') ? 'English' : 'Chinese'}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-older-work-confirmation-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
    let calls = 0;
    const model: ModelAdapter = {
      async *stream(request) {
        calls++;
        const instruction = request.messages.find(
          (message) =>
            message.role === 'system' && message.content.includes('Original input identity:'),
        );
        if (instruction) {
          expect(request.tools).toHaveLength(0);
          const line = instruction.content
            .split('\n')
            .find((value) => value.startsWith('Original input identity: '))!;
          const identity = JSON.parse(line.slice('Original input identity: '.length));
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              ...identity,
              relation: 'unresolved',
              purpose: 'clarify',
              target_root_work_command_id: null,
              selection_effect: 'keep',
              answer: null,
              clarification: '请明确指向哪项原工作。',
              clarifies_input_id: null,
            }),
          };
        } else yield { type: 'text_delta', text: 'The exact ordinary work completed.' };
        yield finish;
      },
    };
    const runtime = createRuntime({
      store,
      model,
      modelId: 'original',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
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
        title: 'confirmation',
      });
      for (const [commandId, content] of [
        ['A', 'Inspect original compatibility.'],
        ['B', '新任务：独立整理费用摘要。'],
      ] as const) {
        await runtime.submitCommand({
          ...scope,
          commandId,
          request: { kind: 'run.start', content },
        });
        await runtime.waitForCommand(commandId);
        await eventually(async () =>
          (await store.getView('root')).runs.every((run) => !run.isActive),
        );
      }
      const ambiguous = await runtime.submitCommand({
        ...scope,
        commandId: 'ambiguous',
        request: { kind: 'run.start', content: '先别做这个。' },
      });
      const rawId = (ambiguous.receipt as { humanInputCommandId: string }).humanInputCommandId;
      await eventually(
        async () =>
          (await store.getCommand(rawId))?.receipt !== null &&
          ((await store.getCommand(rawId))!.receipt as { state?: string }).state === 'unresolved',
      );
      await eventually(async () =>
        (await store.getView('root')).runs.every((run) => !run.isActive),
      );
      const original = (await store.getCommand(rawId))!;
      expect(
        (original.receipt as { candidateWorkCommandIds: string[] }).candidateWorkCommandIds
          .slice()
          .sort(),
      ).toEqual(['A', 'B']);
      expect((await store.readHumanWorkState(scope)).selectedWork?.rootWorkCommandId).toBe('B');
      await runtime.submitCommand({
        ...scope,
        commandId: 'confirm',
        request: {
          kind: 'run.start',
          content: confirmation,
        },
      });
      const confirmed = await runtime.waitForCommand('confirm');
      await eventually(async () =>
        (await store.getView('root')).runs.every((run) => !run.isActive),
      );
      const current = await store.getCommand(rawId);
      expect(current?.request).toEqual(original.request);
      expect(current?.receipt).toMatchObject({
        state: 'clarified',
        clarifyingInputId: (confirmed.receipt as { humanInputCommandId: string })
          .humanInputCommandId,
      });
      expect((await store.readHumanWorkState(scope)).pendingInputIds).toEqual([]);
      expect((await store.readHumanWorkState(scope)).selectedWork?.rootWorkCommandId).toBe('A');
      const run = await store.getRun((confirmed.receipt as { runId: string }).runId);
      expect(run).toMatchObject({ rootWorkCommandId: 'A', status: 'completed' });
      const view = await store.getView('root');
      expect(view.runs.filter((candidate) => candidate.rootWorkCommandId === 'A')).toHaveLength(2);
      expect(view.runs.filter((candidate) => candidate.rootWorkCommandId === 'B')).toHaveLength(1);
      expect(view.runs.filter((candidate) => candidate.isActive)).toHaveLength(0);
      expect(calls).toBe(4);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

for (const inputMode of ['idle', 'active'] as const)
  test(`sealed unresolved ${inputMode} input: hallucinated unavailable Tool preserves one decision and the original work`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-human-sealed-decision-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const requests: ModelRequest[] = [];
    let processingCalls = 0;
    let authorizations = 0;
    let initialCalls = 0;
    const parentReady = gate(),
      parentGate = gate(),
      childReady = gate(),
      childGate = gate();
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        const instruction = request.messages.find(
          (message) =>
            message.role === 'system' && message.content.includes('Original input identity:'),
        );
        if (!instruction) {
          if (inputMode === 'active') {
            if (++initialCalls === 1) {
              yield {
                type: 'tool_call',
                id: 'spawn-child',
                name: 'spawn_agent',
                arguments: JSON.stringify({ prompt: 'Keep original A child running.' }),
              };
              yield { ...finish, reason: 'tool_calls' };
              return;
            }
            if (initialCalls === 2) {
              parentReady.release();
              await parentGate.promise;
            }
          }
          yield { type: 'text_delta', text: 'Original A completed.' };
          yield finish;
          return;
        }
        expect(request.tools).toEqual([]);
        if (++processingCalls === 1) {
          yield { type: 'text_delta', text: 'I will perform this ambiguous request.' };
          yield {
            type: 'tool_call',
            id: 'hallucinated-follow-up',
            name: 'follow_up_agent',
            arguments: JSON.stringify({
              agent_id: 'root',
              prompt: 'Produce an unauthorized effect.',
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        const identity = JSON.parse(
          instruction.content
            .split('\n')
            .find((line) => line.startsWith('Original input identity: '))!
            .slice('Original input identity: '.length),
        );
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            ...identity,
            relation: 'same_work',
            purpose: 'continue',
            target_root_work_command_id: 'A',
            selection_effect: 'select_work',
            answer: null,
            clarification: null,
            clarifies_input_id: null,
          }),
        };
        yield finish;
      },
    };
    const options = {
      model,
      modelId: 'original-A',
      extensions: [
        createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'worker', description: 'general' }],
        }),
      ],
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: {
            async *stream() {
              childReady.release();
              await childGate.promise;
              yield { type: 'text_delta' as const, text: 'Original A child completed.' };
              yield finish;
            },
          },
          modelId: 'child',
          toolIds: [],
          snapshot: {},
        },
      ],
      permissions: {
        async authorize() {
          authorizations++;
          return { allowed: true as const, revision: 'fixture' };
        },
      },
    };
    let runtime = createRuntime({ store, ...options });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'fixture',
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'sealed clarification',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'A',
        sessionId: 'root',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'A' },
      });
      if (inputMode === 'active') {
        await parentReady.promise;
        await childReady.promise;
      } else await runtime.waitForCommand('A');
      const originalRun = (await store.getView('root')).runs[0]!;
      const childCarrier = (await store.getView('root')).executions.find(
        (execution) => execution.childSessionId,
      );
      const invocation = {
        expectedStoreId: storeId,
        commandId: 'ambiguous',
        sessionId: 'root',
        subjectId: 'owner',
        request:
          inputMode === 'active'
            ? {
                kind: 'input.steer' as const,
                targetRunId: originalRun.id,
                contextSelectionId: originalRun.contextSelectionId,
                content: '先处理一下',
              }
            : { kind: 'run.start' as const, content: '先处理一下' },
      };
      const accepted = await runtime.submitCommand(invocation);
      parentGate.release();
      const rawId = (accepted.receipt as { humanInputCommandId: string }).humanInputCommandId;
      await eventually(
        async () =>
          (await store.getView('root')).runs.length === (inputMode === 'active' ? 1 : 2) &&
          (await store.getView('root')).runs.every((run) => !run.isActive),
      );
      const raw = (await store.getCommand(rawId))!;
      const fact = raw.receipt as {
        decisionCommandId: string;
        processingRunId: string;
        observation: { runId: string };
      };
      const decision = (await store.getCommand(fact.decisionCommandId))!;
      const view = await store.getView('root');
      const processing =
        inputMode === 'active'
          ? view.runs[0]!
          : view.runs.find((run) => run.rootWorkCommandId !== 'A')!;
      expect(processing.status).toBe('completed');
      if (inputMode === 'idle')
        expect(processing).toMatchObject({
          status: 'completed',
          configuration: { tools: [], snapshot: { kind: 'human_input_processing' } },
        });
      for (const request of requests.slice(inputMode === 'active' ? 2 : 1))
        expect(request.tools).toEqual([]);
      expect(processingCalls).toBe(inputMode === 'active' ? 1 : 2);
      expect(requests).toHaveLength(3);
      const messages = inputMode === 'active' ? view.messages : requests.at(-1)!.messages;
      const assistantIndex = messages.findIndex((message) =>
        message.toolCalls?.some((call) => call.id === 'hallucinated-follow-up'),
      );
      const resultIndex = messages.findIndex(
        (message) => message.role === 'tool' && message.toolCallId === 'hallucinated-follow-up',
      );
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(resultIndex).toBe(assistantIndex + 1);
      expect(messages[resultIndex]!.content).toContain('tool_not_available');
      const tools = view.executions.filter(
        (execution) => execution.kind === 'tool' && execution.callId === 'hallucinated-follow-up',
      );
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        definitionId: 'follow_up_agent',
        definitionVersion: 'unavailable',
        status: 'failed',
        result: { outcome: 'failed', details: { code: 'tool_not_available' } },
      });
      if (inputMode === 'idle')
        expect(view.executions.filter((execution) => execution.childSessionId)).toEqual([]);
      else {
        expect(processing.reason).toBe('human_work_deferred');
        expect(view.messages[assistantIndex]!.runId).toBe(originalRun.id);
        expect(view.messages[resultIndex]!.runId).toBe(originalRun.id);
        expect(tools[0]!.runId).toBe(originalRun.id);
        expect(childCarrier).toBeDefined();
        expect(await store.getExecution(childCarrier!.id)).toMatchObject({
          cancelRequestedAt: null,
          resultAcceptance: null,
        });
        const childView = await store.getView(childCarrier!.childSessionId!);
        expect(childView.runs[0]!.isActive).toBe(true);
        childGate.release();
        await eventually(async () =>
          (await store.getView(childCarrier!.childSessionId!)).runs.every((run) => !run.isActive),
        );
        expect((await store.getExecution(childCarrier!.id))?.cancelRequestedAt).toBeNull();
      }
      expect(raw).toMatchObject({
        kind: 'human.input',
        request: { content: invocation.request.content },
        receipt: { state: 'unresolved', businessCommandId: null },
      });
      expect(decision).toMatchObject({
        kind: 'human.input.decision',
        status: 'applied',
        request: { proposal: { relation: 'unresolved', purpose: 'clarify' } },
      });
      const firstInterpretation = view.executions.find(
        (execution) =>
          execution.kind === 'model' &&
          (execution.result as { content?: string } | null)?.content ===
            'I will perform this ambiguous request.',
      )!;
      expect(firstInterpretation).toBeDefined();
      expect(decision.request).toMatchObject({
        interpretation: { executionId: firstInterpretation.id },
      });
      const scope = { expectedStoreId: storeId, sessionId: 'root', subjectId: 'owner' };
      expect(await store.readHumanWorkState(scope)).toMatchObject({
        selectedWork: { rootWorkCommandId: 'A' },
        pendingInputIds: [rawId],
        controlRevision: (decision.receipt as { controlRevision: string }).controlRevision,
      });
      expect(BigInt((decision.receipt as { controlRevision: string }).controlRevision)).toBe(
        BigInt((decision.request as { expectedControlRevision: string }).expectedControlRevision) +
          1n,
      );
      const clarification = '请说明这条输入要补充哪项工作，或要另开一项工作。';
      expect(
        (await runtime.getView('root')).messages.filter(
          (message) => message.content === clarification,
        ),
      ).toHaveLength(1);
      const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
        readonly: true,
      });
      try {
        expect(
          db.query("SELECT id FROM command WHERE kind='human.input.decision'").all(),
        ).toHaveLength(1);
        expect(db.query("SELECT id FROM command WHERE kind='human.input'").all()).toEqual([
          { id: rawId },
        ]);
      } finally {
        db.close();
      }
      const beforeCalls = requests.length;
      const beforeAuthorizations = authorizations;
      await runtime.close();
      await store.close();
      store = await openSqliteStore(profile);
      runtime = createRuntime({ store, ...options });
      const cursor = (await store.getMetadata()).lastChangeCursor;
      expect(await store.getCommand(rawId)).toEqual(raw);
      expect(await store.getCommand(decision.id)).toEqual(decision);
      expect(
        (await runtime.getView('root')).runs.find((run) => run.id === processing.id)?.status,
      ).toBe('completed');
      expect(await runtime.submitCommand(invocation)).toEqual(
        (await store.getCommand(invocation.commandId))!,
      );
      expect(await runtime.submitCommand(invocation)).toEqual(
        (await store.getCommand(invocation.commandId))!,
      );
      expect(requests).toHaveLength(beforeCalls);
      expect(authorizations).toBe(beforeAuthorizations);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(await store.getCommand(rawId)).toEqual(raw);
      expect(await store.getCommand(decision.id)).toEqual(decision);
    } finally {
      parentGate.release();
      childGate.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
