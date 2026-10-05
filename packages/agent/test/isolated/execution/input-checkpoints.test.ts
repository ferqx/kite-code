import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { Permissions, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string, value: string): ModelEvent[] => [
  { type: 'tool_call', id, name: 'fixture.effect', arguments: JSON.stringify({ value }) },
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  let enter!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    entered,
    release,
    async wait(signal?: AbortSignal) {
      enter();
      if (signal?.aborted) throw signal.reason;
      await Promise.race([
        released,
        ...(signal
          ? [
              new Promise<never>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              ),
            ]
          : []),
      ]);
      signal?.throwIfAborted();
    },
  };
}
async function entered(gate: { entered: Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.entered,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Gate not entered')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out: ${label}`);
}
const allow: Permissions = {
  async authorize() {
    return { allowed: true, revision: 'policy-1' };
  },
};
const ask: Permissions = {
  async authorize(request) {
    return request.kind === 'tool'
      ? {
          allowed: false,
          revision: 'policy-1',
          approval: { request: { title: 'Exact new input' } },
        }
      : { allowed: true, revision: 'policy-1' };
  },
};
async function fixture(
  model: ModelAdapter,
  options: Partial<RuntimeOptions> = {},
  tools: ToolDefinition[] = [],
  wrap?: (store: Store) => Store,
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-input-checkpoint-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const runtime = createRuntime({
    store: wrap?.(store) ?? store,
    model,
    modelId: 'fixed',
    permissions: allow,
    modelConcurrency: 1,
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools }],
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'temporary',
  });
  const session = async (id = 's') =>
    runtime.createSession({
      expectedStoreId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      subjectId: 'owner',
      title: id,
    });
  await session();
  const submit = (id = 'work', sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      commandId: id,
      sessionId,
      subjectId: 'owner',
      request: { kind: 'run.start', content: `original ${id}` },
    });
  const steer = async (id: string, content: string, sessionId = 's') => {
    const view = await runtime.getView(sessionId);
    const run = view.runs.find((value) => value.isActive)!;
    return runtime.submitCommand({
      expectedStoreId,
      commandId: id,
      sessionId,
      subjectId: 'owner',
      request: {
        kind: 'input.steer',
        content,
        targetRunId: run.id,
        contextSelectionId: view.session.contextSelectionId,
      },
    });
  };
  const pending = (exclude?: string) =>
    until(async () => {
      const page = await runtime.listInteractions({
        expectedStoreId,
        sessionId: 's',
        state: 'pending',
      });
      return page.interactions.find((value) => value.id !== exclude);
    }, 'approval');
  return {
    root,
    store,
    runtime,
    expectedStoreId,
    session,
    submit,
    steer,
    pending,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function tool(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    id: 'fixture.effect',
    version: '1',
    description: 'Harmless ledger effect',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    execute,
  };
}

test('steer supersedes an unstarted approved decision with paired result, fresh model and fresh approval', async () => {
  const model = createFixedModel([call('old-call', 'old'), call('new-call', 'new'), [finish]]);
  const effects: string[] = [];
  const f = await fixture(model, { permissions: ask }, [
    tool(async (input) => {
      effects.push((input as { value: string }).value);
      return { outcome: 'succeeded', content: 'effect' };
    }),
  ]);
  try {
    await f.submit();
    const old = await f.pending();
    const oldExecution = await f.store.getExecution(old.executionId);
    await f.steer('steer', 'new user direction');
    const next = await f.pending(old.id);
    expect(
      (
        await f.runtime.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: old.id,
        })
      )?.state,
    ).toBe('cancelled');
    expect((await f.store.getExecution(old.executionId))?.status).toBe('cancelled');
    expect(
      (
        await f.runtime.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: old.id,
        })
      )?.acceptedDecisionRevision,
    ).toBeNull();
    expect((await f.store.getExecution(old.executionId))?.input).toEqual(oldExecution?.input);
    expect((await f.store.getExecution(old.executionId))?.result).toMatchObject({
      content: 'superseded_by_user_input',
      details: { adapterAttempted: false },
    });
    expect(effects).toEqual([]);
    expect(next.executionId).not.toBe(old.executionId);
    expect(next.inputDigest).not.toBe(old.inputDigest);
    const second = model.requests[1]!;
    expect(
      second.messages.find((value) => value.content === 'new user direction')?.sourceIds,
    ).toEqual(['steer']);
    expect(second.messages.find((value) => value.content === 'original work')?.sourceIds).toContain(
      'work',
    );
    expect(
      second.messages.some((value) => value.toolCalls?.some((call) => call.id === 'old-call')),
    ).toBe(true);
    expect(second.messages.find((value) => value.toolCallId === 'old-call')?.content).toContain(
      'superseded_by_user_input',
    );
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      commandId: 'approve-new',
      subjectId: 'owner',
      presentationSessionId: 's',
      interactionId: next.id,
      expectedRevision: next.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('s');
    expect(effects).toEqual(['new']);
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.status).toBe('completed');
    expect(
      view.executions
        .filter((value) => value.kind === 'tool')
        .map((value) => value.status)
        .sort(),
    ).toEqual(['cancelled', 'succeeded']);
  } finally {
    await f.close();
  }
}, 10000);

test('queued B model refreshes accepted input before first dispatch when shared model slot frees', async () => {
  const held = gate();
  const a = createFixedModel([[finish]]);
  const b = createFixedModel([[finish]]);
  const gated: ModelAdapter = {
    async *stream(request, { signal }) {
      await held.wait(signal);
      yield* a.stream(request, { signal });
    },
  };
  const f = await fixture(a, {
    resolveRunConfiguration: async ({ session }) => ({
      model: session.id === 'a' ? gated : b,
      modelId: session.id,
      snapshot: { modelId: session.id },
    }),
  });
  try {
    await f.session('a');
    await f.session('b');
    await f.submit('a-work', 'a');
    await entered(held);
    await f.submit('b-work', 'b');
    const queued = await until(
      async () =>
        (await f.runtime.getView('b')).executions.find(
          (value) => value.kind === 'model' && value.status === 'planned',
        ),
      'B planned model',
    );
    expect(b.requests).toHaveLength(0);
    await f.steer('b-steer', 'B updated before dispatch', 'b');
    held.release();
    await f.runtime.waitForCommand('a-work');
    await f.runtime.waitForCommand('b-work');
    expect(b.requests).toHaveLength(1);
    expect(
      b.requests[0]?.messages.find((value) => value.content === 'B updated before dispatch')
        ?.sourceIds,
    ).toEqual(['b-steer']);
    expect(
      b.requests[0]?.messages.find((value) => value.content === 'original b-work')?.sourceIds,
    ).toContain('b-work');
    const view = await f.runtime.getView('b');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.status).toBe('completed');
    expect((await f.store.getExecution(queued.id))?.status).toBe('cancelled');
    expect((await f.store.getExecution(queued.id))?.result).toMatchObject({
      content: 'superseded_by_user_input',
      details: { adapterAttempted: false },
    });
  } finally {
    held.release();
    await f.close();
  }
}, 10000);

test('real finish transaction rejects intervening steer and continues same Run instead of false terminal', async () => {
  const held = gate();
  let first = true;
  const failures: string[] = [];
  const model = createFixedModel([[finish], [finish]]);
  const f = await fixture(
    model,
    {},
    [],
    (store) =>
      new Proxy(store, {
        get(target, key) {
          if (key === 'finishRun')
            return async (...args: Parameters<Store['finishRun']>) => {
              if (args[0].status === 'completed' && first) {
                first = false;
                await held.wait();
              }
              try {
                return await target.finishRun(...args);
              } catch (error) {
                failures.push((error as { code: string }).code);
                throw error;
              }
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.submit();
    await entered(held);
    const original = (await f.runtime.getView('s')).runs[0]!;
    await f.steer('last-steer', 'accepted at final transaction gate');
    expect((await f.store.getRun(original.id))?.isActive).toBe(true);
    held.release();
    await f.runtime.waitForCommand('work');
    expect(failures).toEqual(['input_pending']);
    expect(model.requests).toHaveLength(2);
    expect(
      model.requests[1]?.messages.find(
        (value) => value.content === 'accepted at final transaction gate',
      )?.sourceIds,
    ).toEqual(['last-steer']);
    const view = await f.runtime.getView('s');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.id).toBe(original.id);
    expect(view.runs[0]?.status).toBe('completed');
  } finally {
    held.release();
    await f.close();
  }
}, 10000);

test('steer never rewrites an already dispatched physical tool; cancelled pending steer creates no message', async () => {
  const held = gate();
  const model = createFixedModel([call('live-call', 'original-effect'), [finish]]);
  let ledger = '';
  const f = await fixture(model, {}, [
    tool(async (input, context) => {
      appendFileSync(ledger, `${(input as { value: string }).value}\n`);
      await held.wait(context.signal);
      return { outcome: 'succeeded', content: 'physical effect completed' };
    }),
  ]);
  ledger = join(f.root, 'ledger');
  try {
    await f.submit();
    await entered(held);
    const before = await f.runtime.getView('s');
    const execution = before.executions.find((value) => value.kind === 'tool')!;
    const originalModel = before.executions.find((value) => value.kind === 'model')!;
    expect(execution.status).toBe('dispatching');
    await f.steer('discarded', 'must not enter context');
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-discarded',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'discarded',
    });
    await f.steer('steer-live', 'direction after physical dispatch');
    expect((await f.store.getExecution(execution.id))?.input).toEqual(execution.input);
    expect((await f.store.getExecution(originalModel.id))?.result).toEqual(originalModel.result);
    expect((await f.store.getExecution(execution.id))?.status).toBe('dispatching');
    expect(readFileSync(ledger, 'utf8')).toBe('original-effect\n');
    held.release();
    await f.runtime.waitForCommand('work');
    expect(readFileSync(ledger, 'utf8')).toBe('original-effect\n');
    expect(model.requests).toHaveLength(2);
    expect(
      model.requests[1]?.messages.find(
        (value) => value.content === 'direction after physical dispatch',
      )?.sourceIds,
    ).toEqual(['steer-live']);
    expect(
      model.requests[1]?.messages.some((value) => value.sourceIds?.includes('discarded')),
    ).toBe(false);
    const view = await f.runtime.getView('s');
    expect(view.messages.some((value) => value.sourceIds?.includes('discarded'))).toBe(false);
    expect((await f.store.getExecution(execution.id))?.input).toEqual(execution.input);
    expect((await f.store.getExecution(execution.id))?.status).toBe('succeeded');
    expect((await f.store.getExecution(originalModel.id))?.input).toEqual(originalModel.input);
    expect((await f.store.getExecution(originalModel.id))?.decisionSource).toEqual(
      originalModel.decisionSource,
    );
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]?.status).toBe('completed');
  } finally {
    held.release();
    await f.close();
  }
}, 10000);
