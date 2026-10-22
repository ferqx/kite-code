import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { createTaskExtension } from '../../../src/extensions/task';
import { semanticDigest } from '../../../src/json';
import { createPermissionPolicy, type PermissionMode } from '../../../src/permissions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > end) throw Error('mode_collaboration_boundary_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(holdActivation = false, holdDispatch = false, reviewer?: ModelAdapter) {
  const root = temporaryDirectory('kite-mode-collaboration-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const actual = await openSqliteStore(profile),
    storeId = (await actual.getMetadata()).storeId;
  const base = { expectedStoreId: storeId, subjectId: 'owner' };
  const activation = gate(),
    activationReady = gate(),
    dispatch = gate(),
    dispatchReady = gate();
  const turns = [gate(), gate()];
  let failPolicy = false,
    effectCount = 0,
    childCalls = 0,
    follow = false,
    followSent = false,
    parentCalls = 0,
    childId = '',
    mutations = 0;
  const dispatches: Parameters<Store['markDispatching']>[0][] = [];
  const store = new Proxy(actual, {
    get(target, key) {
      if (key === 'activateChildRun')
        return async (input: Parameters<Store['activateChildRun']>[0]) => {
          activationReady.release();
          if (holdActivation) {
            holdActivation = false;
            await activation.promise;
          }
          return target.activateChildRun(input);
        };
      if (key === 'markDispatching')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          const execution = await target.getExecution(input.executionId);
          if (execution?.definitionId === 'fixture.effect') {
            if (holdDispatch) {
              holdDispatch = false;
              dispatchReady.release();
              await dispatch.promise;
            }
            const result = await target.markDispatching(input);
            dispatches.push(input);
            return result;
          }
          return target.markDispatching(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  async function setMode(mode: PermissionMode, loseResponse = false) {
    const scope = 'session:s';
    const current = await actual.readHostControl({ ...base, kind: 'permission.mode', scope });
    const safeRequest = {
      scope: 'session',
      sessionId: 's',
      mode,
      ifRevision: current.revision,
      makeDefault: false,
      ifDefaultRevision: '0',
    };
    const request = {
      ...base,
      commandId: `mode-${++mutations}`,
      kind: 'permission.mode' as const,
      scope,
      safeRequest,
      requestDigest: await semanticDigest(safeRequest),
    };
    await actual.beginHostMutation(request);
    // The actual transaction commits, then its transport drops the response. Recovery reads only the original ID.
    let lost = false;
    const commit = async () => {
      await actual.finishHostMutation({
        ...base,
        commandId: request.commandId,
        requestDigest: request.requestDigest,
        state: 'applied',
        receipt: { status: 'applied' },
      });
      if (loseResponse) throw Error('mode_response_lost');
    };
    try {
      await commit();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'mode_response_lost') throw error;
      lost = true;
    }
    if (loseResponse) {
      expect(lost).toBe(true);
      expect((await actual.getHostMutation({ ...base, commandId: request.commandId }))?.state).toBe(
        'applied',
      );
    }
    return actual.readHostControl({ ...base, kind: 'permission.mode', scope });
  }
  const policy = createPermissionPolicy({
    async readPolicy(request) {
      if (failPolicy) throw Error('current_policy_unavailable');
      const session = (await actual.getSession(request.sessionId))!;
      const scope = `session:${session.rootSessionId}`;
      const current = await actual.readHostControl({ ...base, kind: 'permission.mode', scope });
      return {
        mode: (current.record?.safeRequest as { mode: PermissionMode })?.mode ?? 'accept_edits',
        workspaceTrust: true,
        revision: current.revision,
        controlReads: [{ kind: 'permission.mode', scope, revision: current.revision }],
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      };
    },
    describeCapability(request) {
      const internal = request.kind === 'job' || request.definitionId.startsWith('task.');
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'fixture',
        hardAllowed: true,
        safeRead: request.kind === 'model',
        effects: request.kind === 'model' ? ['read'] : internal ? ['record_write'] : ['external'],
        ...(internal ? { internalRecordOnly: true as const } : {}),
      };
    },
  });
  const parent: ModelAdapter = {
    async *stream() {
      parentCalls++;
      if (parentCalls === 1 || (follow && !followSent)) {
        const spawn = parentCalls === 1;
        if (!spawn) followSent = true;
        yield {
          type: 'tool_call',
          id: spawn ? 'spawn' : 'follow',
          name: spawn ? 'spawn_agent' : 'follow_up_agent',
          arguments: JSON.stringify(
            spawn
              ? { prompt: 'One exact child effect' }
              : { agent_id: childId, content: 'Second exact child effect' },
          ),
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      yield {
        type: 'text_delta',
        text: 'Ordinary parent ended without cancelling the collaborator.',
      };
      yield finish;
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      const lastUser = request.messages.reduce(
        (last, message, index) => (message.role === 'user' ? index : last),
        -1,
      );
      if (request.messages.slice(lastUser + 1).some((message) => message.role === 'tool')) {
        yield finish;
        return;
      }
      const at = childCalls++;
      await turns[at]!.promise;
      yield { type: 'tool_call', id: `effect-${at}`, name: 'fixture.effect', arguments: '{}' };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 3,
    permissions: policy,
    ...(reviewer
      ? {
          authorizationCheck: {
            id: 'reviewer',
            version: '1',
            modelId: 'reviewer',
            model: reviewer,
          },
        }
      : {}),
    extensions: [
      createTaskExtension({
        roles: [
          { id: 'worker', configurationId: 'worker', description: 'fixture trusted finite role' },
        ],
      }),
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'exact external effect counter',
            inputSchema: { type: 'object' },
            async execute() {
              effectCount++;
              return { outcome: 'succeeded', content: 'effect recorded' };
            },
          },
        ],
      },
    ],
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['fixture.effect'],
        snapshot: {},
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'injected-child-ceiling' };
          },
        },
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'root',
  });
  const pending = () =>
    until(
      async () =>
        (
          await actual.listInteractions({
            expectedStoreId: storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
  const submit = () =>
    runtime.submitCommand({
      ...base,
      commandId: 'A',
      sessionId: 's',
      request: { kind: 'run.start', content: 'A' },
    });
  const discover = async () => {
    childId = (
      await until(
        async () =>
          (await actual.listExecutions('s')).find((e) => e.kind === 'job' && !!e.childSessionId) ??
          null,
      )
    ).childSessionId!;
    return childId;
  };
  return {
    actual,
    runtime,
    base,
    setMode,
    submit,
    pending,
    activation,
    activationReady,
    dispatch,
    dispatchReady,
    turns,
    discover,
    dispatches,
    failPolicy: () => {
      failPolicy = true;
    },
    effects: () => effectCount,
    childCalls: () => childCalls,
    async follow() {
      follow = true;
      const a = (await actual.getView('s')).runs.find((run) => run.originCommandId === 'A')!;
      return runtime.submitCommand({
        ...base,
        sessionId: 's',
        commandId: 'follow',
        request: {
          kind: 'input.follow_up',
          afterRunId: a.id,
          contextSelectionId: a.contextSelectionId,
          content: '补充 A：继续原协作者完成第二个动作',
        },
      });
    },
    async close() {
      activation.release();
      dispatch.release();
      for (const turn of turns) turn.release();
      await runtime.close();
      await actual.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('six-tool queued activation and idle reuse follow the current root mode bidirectionally after ordinary parent completion, including a lost mutation response without lifecycle callbacks', async () => {
  const f = await fixture(true);
  try {
    await f.setMode('full');
    await f.submit();
    await f.activationReady.promise;
    expect(f.childCalls()).toBe(0);
    await f.setMode('accept_edits');
    f.activation.release();
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    const child = await f.discover();
    await until(async () => (f.childCalls() === 1 ? true : null));
    expect((await f.actual.getSession(child))?.rootSessionId).toBe('s');
    f.turns[0]!.release();
    const old = await f.pending();
    expect(f.effects()).toBe(0);
    const relaxed = await f.setMode('full', true);
    await until(async () => (f.effects() === 1 ? true : null));
    await until(async () =>
      (await f.actual.getView(child)).runs.every((run) => !run.isActive) ? true : null,
    );
    expect(
      (
        await f.actual.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 's',
          interactionId: old.id,
        })
      )?.state,
    ).toBe('cancelled');
    expect(f.dispatches[0]?.authorization).toMatchObject({
      allowed: true,
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: relaxed.revision }],
    });
    await f.setMode('accept_edits');
    await f.follow();
    await f.runtime.waitForCommand('follow', { timeoutMs: 5000 });
    await until(async () => (f.childCalls() === 2 ? true : null));
    f.turns[1]!.release();
    const second = await f.pending();
    expect(second.id).not.toBe(old.id);
    expect(f.effects()).toBe(1);
    const again = await f.setMode('full');
    await until(async () => (f.effects() === 2 ? true : null));
    expect(f.dispatches[1]?.authorization).toMatchObject({
      allowed: true,
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: again.revision }],
    });
    expect((await f.actual.getView(child)).runs).toHaveLength(2);
    expect(
      (await f.actual.listExecutions('s'))
        .filter((e) => e.kind === 'tool')
        .map((e) => e.definitionId),
    ).toContain('task.follow_up');
    expect(
      (await f.actual.listExecutions('s'))
        .filter((e) => e.kind === 'job')
        .every((e) => e.childSessionId === child),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('a child old full proof cannot dispatch when the durable root revision changes and current policy reads fail', async () => {
  const f = await fixture(false, true);
  try {
    await f.setMode('full');
    await f.submit();
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    const child = await f.discover();
    await until(async () => (f.childCalls() === 1 ? true : null));
    f.turns[0]!.release();
    await f.dispatchReady.promise;
    f.failPolicy();
    await f.setMode('full');
    f.dispatch.release();
    await until(async () =>
      (await f.actual.getView(child)).runs.every((run) => !run.isActive) ? true : null,
    );
    expect(f.effects()).toBe(0);
    expect(f.dispatches).toHaveLength(0);
    const effect = (await f.actual.listExecutions(child)).find(
      (e) => e.definitionId === 'fixture.effect',
    );
    expect(effect?.status).toBe('failed');
    expect(effect?.authorization?.dispatched).not.toBe(true);
  } finally {
    await f.close();
  }
});

test('an ended parent child replaces pending human approval with a real automatic review and tightens back before a late automatic permit', async () => {
  const review = gate();
  let calls = 0;
  const f = await fixture(false, false, {
    async *stream(request) {
      calls++;
      expect(request.tools).toHaveLength(0);
      await review.promise;
      yield {
        type: 'text_delta',
        text: '{"decision":"approve_once","reason":"late automatic permit"}',
      };
      yield finish;
    },
  });
  try {
    await f.setMode('accept_edits');
    await f.submit();
    await f.runtime.waitForCommand('A', { timeoutMs: 5000 });
    const child = await f.discover();
    await until(async () => (f.childCalls() === 1 ? true : null));
    f.turns[0]!.release();
    const original = await f.pending();
    await f.setMode('auto');
    await until(async () => (calls === 1 ? true : null));
    expect(
      (
        await f.actual.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 's',
          interactionId: original.id,
        })
      )?.state,
    ).toBe('cancelled');
    const strict = await f.setMode('accept_edits');
    const current = await f.pending();
    expect(current.id).not.toBe(original.id);
    review.release();
    expect(f.effects()).toBe(0);
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'approve-current',
      presentationSessionId: current.presentationSessionId,
      interactionId: current.id,
      expectedRevision: current.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    await until(async () => (f.effects() === 1 ? true : null));
    await until(async () =>
      (await f.actual.getView(child)).runs.every((run) => !run.isActive) ? true : null,
    );
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]?.authorization).toMatchObject({
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: strict.revision }],
    });
    expect(calls).toBe(1);
    expect(f.effects()).toBe(1);
  } finally {
    review.release();
    await f.close();
  }
});
