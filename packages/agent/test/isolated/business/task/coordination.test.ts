import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type {
  Extension,
  Json,
  OperationRef,
  ToolContext,
  ToolDefinition,
} from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: Json): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const base = () =>
  createTaskExtension({
    roles: [{ id: 'reader', configurationId: 'reader', description: 'Trusted fixture child' }],
  });
async function fixture(
  extension: Extension,
  parent: ModelAdapter,
  child: ModelAdapter,
  toolIds: string[] = [],
  approvalJob: boolean | 'leaf' = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-coordination-'))),
    store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const storeId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    extensions: [extension],
    modelConcurrency: 1,
    permissions: {
      async authorize(request) {
        if (
          (approvalJob === true && request.kind === 'job') ||
          (approvalJob === 'leaf' && request.definitionId === 'fixture.leafEffect')
        )
          return {
            allowed: false,
            revision: '1',
            approval: { request: { title: 'Actual child carrier approval' } },
          };
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      { id: 'reader', version: '1', model: child, modelId: 'child', toolIds, snapshot: {} },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'temp',
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'task',
  });
  return {
    root,
    store,
    storeId,
    runtime,
    async run() {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'coordinate' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 25000 });
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual 70 child carriers are paginated beyond 64; list excludes bodies and readonly reopen never starts history', async () => {
  let childCalls = 0,
    parentCalls = 0;
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      yield { type: 'text_delta', text: 'Actual finite child body' };
      yield finish;
    },
  };
  const extension = base();
  const list = extension.tools!.find((tool) => tool.id === 'list_agents')!;
  const probe: ToolDefinition = {
    id: 'fixture.enumerate',
    version: '1',
    description: 'Create actual children then read authoritative pages',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute(_input, ctx) {
      for (let n = 0; n < 70; n++) {
        const ref = await ctx.operations.ensure({
          key: `child-${n}`,
          request: { kind: 'agent', configurationId: 'reader', input: { content: `child ${n}` } },
          cancellation: 'detached',
        });
        await ctx.operations.wait(ref, { signal: ctx.signal, timeoutMs: 30000 });
      }
      const before = childCalls;
      const one = (await list.execute({ limit: 32 }, ctx)).details as {
        items: unknown[];
        upperSeq: string;
        nextAfterSeq: string;
      };
      const two = (
        await list.execute({ limit: 32, afterSeq: one.nextAfterSeq, upperSeq: one.upperSeq }, ctx)
      ).details as typeof one;
      const three = (
        await list.execute({ limit: 32, afterSeq: two.nextAfterSeq, upperSeq: one.upperSeq }, ctx)
      ).details as typeof one;
      expect([one.items.length, two.items.length, three.items.length]).toEqual([32, 32, 6]);
      expect(
        new Set(
          [...one.items, ...two.items, ...three.items].map(
            (item) => (item as { executionId: string }).executionId,
          ),
        ).size,
      ).toBe(70);
      expect(JSON.stringify(one)).not.toContain('Actual finite child body');
      expect(JSON.stringify(one)).not.toContain('resultRevision');
      const wait = extension.tools!.find((tool) => tool.id === 'wait_agents')!;
      const waited = (await wait.execute({ taskIds: ['child-69'], timeoutMs: 0 }, ctx)).details;
      expect(waited).toMatchObject({ reason: 'terminal' });
      expect(childCalls).toBe(before);
      expect(parentCalls).toBe(1);
      return { outcome: 'succeeded', content: '70 real carriers inspected' };
    },
  };
  const parent: ModelAdapter = {
    async *stream() {
      for (const event of parentCalls++ === 0 ? call(probe.id, {}) : [finish]) yield event;
    },
  };
  const f = await fixture({ ...extension, tools: [...extension.tools!, probe] }, parent, child);
  try {
    await f.run();
    expect(childCalls).toBe(70);
    const page = await f.store.listAgentSummaries({
      expectedStoreId: f.storeId,
      sessionId: 's',
      extensionId: extension.id,
      subjectId: 'owner',
      limit: 100,
    });
    expect(page.items).toHaveLength(70);
    expect(
      page.items.every((item) => item.status === 'succeeded' && item.run?.status === 'completed'),
    ).toBe(true);
    expect(page.items.every((item) => item.run?.deadlineAt !== null)).toBe(true);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const cold = await openSqliteStore({
      dataRoot: join(f.root, 'data'),
      profile: 'new',
      mode: 'readonly',
    });
    try {
      const copy = await cold.listAgentSummaries({
        expectedStoreId: f.storeId,
        sessionId: 's',
        extensionId: extension.id,
        subjectId: 'owner',
        limit: 100,
      });
      expect(copy).toEqual(page);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      for (const input of [
        { expectedStoreId: f.storeId, ref: page.items[0]!.ref, subjectId: 'intruder' },
        {
          expectedStoreId: f.storeId,
          ref: { ...page.items[0]!.ref, extensionId: 'foreign' },
          subjectId: 'owner',
        },
        {
          expectedStoreId: f.storeId,
          ref: { ...page.items[0]!.ref, executionId: 'foreign' },
          subjectId: 'owner',
        },
      ]) {
        let rejected: unknown;
        try {
          await cold.getAgentSummary(input);
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({ code: 'operation_not_found' });
      }
      let ahead: unknown;
      try {
        await cold.listAgentSummaries({
          expectedStoreId: f.storeId,
          sessionId: 's',
          extensionId: extension.id,
          subjectId: 'owner',
          upperSeq: '9223372036854775807',
        });
      } catch (error) {
        ahead = error;
      }
      expect(ahead).toMatchObject({ code: 'cursor_ahead' });
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);

      expect(
        await cold.listAgentSummaries({
          expectedStoreId: f.storeId,
          sessionId: 's',
          extensionId: 'foreign',
          subjectId: 'owner',
        }),
      ).toMatchObject({ items: [] });
      let error: unknown;
      try {
        await cold.getAgentSummary({
          expectedStoreId: 'wrong',
          ref: page.items[0]!.ref,
          subjectId: 'owner',
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'store_identity_mismatch' });
    } finally {
      await cold.close();
    }
    expect(childCalls).toBe(70);
    expect(parentCalls).toBe(2);
  } finally {
    await f.close();
  }
}, 30000);

test('interrupt binds the exact child Run and idempotent original request; wait_agents observes real cancellation without another Model', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let childCalls = 0,
    parentCalls = 0;
  let ref: OperationRef | undefined;
  let targetRunId = '';
  const extension = base(),
    task = extension.tools!.find((tool) => tool.id === 'task')!,
    interrupt = extension.tools!.find((tool) => tool.id === 'interrupt_agent')!;
  const block: ToolDefinition = {
    id: 'fixture.block',
    version: '1',
    description: 'Wait for real cancellation',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      entered();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: 'cancelled', content: 'real abort observed' };
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      for (const event of call(block.id, {})) yield event;
    },
  };
  const wrapped: Extension = {
    ...extension,
    tools: extension
      .tools!.map((tool) =>
        tool.id === 'task'
          ? {
              ...task,
              async execute(input: Json, ctx: ToolContext) {
                const result = await task.execute(input, ctx);
                ref = (result.details as { ref: unknown }).ref as OperationRef;
                await ready;
                targetRunId = (await ctx.operations.readAgent(ref)).run!.id;
                return result;
              },
            }
          : tool.id === 'interrupt_agent'
            ? {
                ...interrupt,
                async execute(input: Json, ctx: ToolContext) {
                  const one = await interrupt.execute(input, ctx),
                    two = await interrupt.execute(input, ctx);
                  expect(two).toEqual(one);
                  return one;
                },
              }
            : tool,
      )
      .concat(block),
  };
  const parent: ModelAdapter = {
    async *stream() {
      const step = parentCalls++;
      for (const event of step === 0
        ? call('task', {
            key: 'one',
            role: 'reader',
            input: { content: 'block' },
            cancellation: 'detached',
            resultDisposition: 'background',
          })
        : step === 1
          ? call('interrupt_agent', { taskId: 'one', commandId: 'interrupt-one', targetRunId })
          : step === 2
            ? call('wait_agents', { taskIds: ['one'], timeoutMs: 5000 })
            : step === 3
              ? call('list_agents', {})
              : [finish])
        yield event;
    },
  };
  const f = await fixture(wrapped, parent, child, [block.id]);
  try {
    await f.run();
    const run = await f.store.getRun(targetRunId);
    expect(run?.status).toBe('cancelled');
    expect(run?.isActive).toBe(false);
    expect((await f.store.getExecution(ref!.executionId!))?.status).toBe('cancelled');
    const command = await f.store.getCommand('interrupt-one');
    expect(command?.request).toEqual({ kind: 'run.cancel', runId: targetRunId });
    expect(command?.receipt).toMatchObject({ outcome: 'cancel_requested' });
    const page = await f.store.listAgentSummaries({
      expectedStoreId: f.storeId,
      sessionId: 's',
      extensionId: extension.id,
      subjectId: 'owner',
    });
    expect(page.items[0]?.run?.id).toBe(targetRunId);
    expect(page.items[0]?.status).toBe('cancelled');
    expect(childCalls).toBe(1);
    expect(parentCalls).toBe(5);
  } finally {
    await f.close();
  }
}, 10000);

test('a final interrupt transaction cannot follow an ended Run into a newly active follow-up carrier', async () => {
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let firstReady!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    firstReady = resolve;
  });
  let secondReady!: () => void;
  const secondEntered = new Promise<void>((resolve) => {
    secondReady = resolve;
  });
  let reached!: () => void;
  const atInterrupt = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let releaseInterrupt!: () => void;
  const interruptGate = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });
  let childCalls = 0,
    parentCalls = 0,
    blocked = 0;
  let ref!: OperationRef;
  let f!: Awaited<ReturnType<typeof fixture>>;
  const extension = base(),
    task = extension.tools!.find((tool) => tool.id === 'task')!;
  const block: ToolDefinition = {
    id: 'fixture.turn',
    version: '1',
    description: 'Actual bounded child turn barrier',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      if (blocked++ === 0) {
        firstReady();
        await firstGate;
        return { outcome: 'succeeded', content: 'first turn ended' };
      }
      secondReady();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { outcome: 'cancelled', content: 'new turn cleanup observed' };
    },
  };
  const probe: ToolDefinition = {
    id: 'fixture.interruptRace',
    version: '1',
    description: 'Test exact private interrupt linearization',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      const view = await ctx.operations.readAgent(ref),
        oldId = view.run!.id;
      const pending = ctx.operations.interruptAgent!(ref, {
        commandId: 'race-interrupt',
        targetRunId: oldId,
      });
      await atInterrupt;
      finishFirst();
      await ctx.operations.wait(ref, { signal: ctx.signal, timeoutMs: 5000 });
      const receipt = await ctx.operations.sendAgentInput(ref, {
        mode: 'follow_up',
        key: 'fresh',
        afterRunId: oldId,
        contextSelectionId: view.contextSelectionId,
        content: 'Explicit fresh work',
      });
      const next = (receipt.receipt as { ref: unknown }).ref as OperationRef;
      await secondEntered;
      const nextView = await ctx.operations.readAgent(next);
      expect(nextView.run!.id).not.toBe(oldId);
      releaseInterrupt();
      let error: unknown;
      try {
        await pending;
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'input_target_stopped' });
      expect(await f.store.getCommand('race-interrupt')).toBeNull();
      const actual = await f.store.getRun(nextView.run!.id);
      expect(actual?.isActive).toBe(true);
      expect((await f.store.getCommand(actual!.originCommandId))?.cancelRequestedAt).toBeNull();
      await ctx.operations.cancel!(next, { commandId: 'cleanup-fresh' });
      await ctx.operations.wait(next, { signal: ctx.signal, timeoutMs: 5000 });
      return { outcome: 'succeeded', content: 'Old Run interruption never selected the new Run' };
    },
  };
  const wrapped: Extension = {
    ...extension,
    tools: extension
      .tools!.map((tool) =>
        tool.id === 'task'
          ? {
              ...task,
              async execute(input: Json, ctx: ToolContext) {
                const result = await task.execute(input, ctx);
                ref = (result.details as { ref: unknown }).ref as OperationRef;
                await firstEntered;
                return result;
              },
            }
          : tool,
      )
      .concat(block, probe),
  };
  const parent: ModelAdapter = {
    async *stream() {
      const n = parentCalls++;
      for (const event of n === 0
        ? call('task', {
            key: 'old',
            role: 'reader',
            input: { content: 'first' },
            cancellation: 'detached',
            resultDisposition: 'background',
          })
        : n === 1
          ? call(probe.id, {})
          : [finish])
        yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      const n = childCalls++;
      for (const event of n === 0 || n === 2 ? call(block.id, {}) : [finish]) yield event;
    },
  };
  f = await fixture(wrapped, parent, child, [block.id]);
  const actualInterrupt = f.store.interruptAgent.bind(f.store);
  f.store.interruptAgent = async (input) => {
    if (input.commandId === 'race-interrupt') {
      reached();
      await interruptGate;
    }
    return actualInterrupt(input);
  };
  try {
    await f.run();
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    expect(childCalls).toBe(3);
    expect(parentCalls).toBe(3);
  } finally {
    finishFirst();
    releaseInterrupt();
    await f.close();
  }
}, 10000);

test('an already-pending carrier approval wakes wait_agents, while ordinary wait retains its terminal contract', async () => {
  let childCalls = 0,
    parentCalls = 0;
  let observed!: () => void;
  const ready = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let ref!: OperationRef;
  let card!: import('../../../../src/storage/types').InteractionRecord;
  let f!: Awaited<ReturnType<typeof fixture>>;
  const extension = base(),
    task = extension.tools!.find((tool) => tool.id === 'task')!,
    wait = extension.tools!.find((tool) => tool.id === 'wait_agents')!;
  const probe: ToolDefinition = {
    id: 'fixture.cardWait',
    version: '1',
    description: 'Observe a real pending card then wait for actual terminal',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      const result = await wait.execute({ taskIds: ['card'], timeoutMs: 3000 }, ctx);
      expect(result.details).toMatchObject({ reason: 'interaction' });
      expect(childCalls).toBe(0);
      const pending = ctx.operations.wait(ref, { signal: ctx.signal, timeoutMs: 5000 });
      observed();
      const actual = await pending;
      expect(actual.status).toBe('succeeded');
      return { outcome: 'succeeded', content: 'Actual terminal observed after human answer' };
    },
  };
  const wrapped: Extension = {
    ...extension,
    tools: extension
      .tools!.map((tool) =>
        tool.id === 'task'
          ? {
              ...task,
              async execute(input: Json, ctx: ToolContext) {
                const result = await task.execute(input, ctx);
                ref = (result.details as { ref: unknown }).ref as OperationRef;
                const deadline = Date.now() + 5000;
                for (;;) {
                  const cards = (
                    await f.runtime.listInteractions({
                      expectedStoreId: f.storeId,
                      sessionId: 's',
                      state: 'pending',
                    })
                  ).interactions;
                  const current = cards.find((item) => item.executionId === ref.executionId);
                  if (current) {
                    card = current;
                    break;
                  }
                  if (Date.now() > deadline) throw new Error('card_not_created');
                  await Bun.sleep(5);
                }
                return result;
              },
            }
          : tool,
      )
      .concat(probe),
  };
  const parent: ModelAdapter = {
    async *stream() {
      const n = parentCalls++;
      for (const event of n === 0
        ? call('task', {
            key: 'card',
            role: 'reader',
            input: { content: 'read' },
            cancellation: 'detached',
            resultDisposition: 'background',
          })
        : n === 1
          ? call(probe.id, {})
          : [finish])
        yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      yield finish;
    },
  };
  f = await fixture(wrapped, parent, child, [], true);
  try {
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'wait actual card' },
    });
    await ready;
    expect(card.state).toBe('pending');
    expect(childCalls).toBe(0);
    await f.runtime.answerInteraction({
      expectedStoreId: f.storeId,
      commandId: 'human-approve',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    expect(childCalls).toBe(1);
    expect(parentCalls).toBe(3);
  } finally {
    await f.close();
  }
}, 10000);

test('wait_agents reads sealed ancestry for an already-pending grandchild Tool card without authorizing it', async () => {
  let childCalls = 0,
    parentCalls = 0,
    effects = 0;
  let ref!: OperationRef;
  let f!: Awaited<ReturnType<typeof fixture>>;
  let card!: import('../../../../src/storage/types').InteractionRecord;
  let wake!: () => void;
  const observed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const extension = base(),
    task = extension.tools!.find((tool) => tool.id === 'task')!,
    wait = extension.tools!.find((tool) => tool.id === 'wait_agents')!;
  const leaf: ToolDefinition = {
    id: 'fixture.leafEffect',
    version: '1',
    description: 'Actual separately approved leaf',
    inputSchema: { type: 'object' },
    async execute() {
      effects++;
      return { outcome: 'succeeded', content: 'Approved exact leaf effect' };
    },
  };
  const delegate: ToolDefinition = {
    id: 'fixture.nested',
    version: '1',
    description: 'Same Loop grandchild',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      const nested = await ctx.operations.ensure({
        key: 'nested',
        request: { kind: 'agent', configurationId: 'reader', input: { content: 'Grandchild' } },
      });
      const result = await ctx.operations.wait(nested, { signal: ctx.signal, timeoutMs: 5000 });
      return { outcome: 'succeeded', content: JSON.stringify(result.result) };
    },
  };
  const probe: ToolDefinition = {
    id: 'fixture.nestedObserve',
    version: '1',
    description: 'Observe descendant card without approving',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      const result = await wait.execute({ taskIds: ['nested-root'], timeoutMs: 3000 }, ctx);
      expect(result.details).toMatchObject({ reason: 'interaction' });
      expect(effects).toBe(0);
      const pending = ctx.operations.wait(ref, { signal: ctx.signal, timeoutMs: 5000 });
      wake();
      const resultDone = await pending;
      expect(resultDone.status).toBe('succeeded');
      return { outcome: 'succeeded', content: 'Actual nested carrier settled' };
    },
  };
  const wrapped: Extension = {
    ...extension,
    tools: extension
      .tools!.map((tool) =>
        tool.id === 'task'
          ? {
              ...task,
              async execute(input: Json, ctx: ToolContext) {
                const result = await task.execute(input, ctx);
                ref = (result.details as { ref: unknown }).ref as OperationRef;
                const deadline = Date.now() + 5000;
                for (;;) {
                  const cards = (
                    await f.runtime.listInteractions({
                      expectedStoreId: f.storeId,
                      sessionId: 's',
                      state: 'pending',
                    })
                  ).interactions;
                  const actual = cards.find((item) => item.definitionId === leaf.id);
                  if (actual) {
                    card = actual;
                    break;
                  }
                  if (Date.now() > deadline) throw new Error('nested_card_missing');
                  await Bun.sleep(5);
                }
                return result;
              },
            }
          : tool,
      )
      .concat(leaf, delegate, probe),
  };
  const parent: ModelAdapter = {
    async *stream() {
      const n = parentCalls++;
      for (const event of n === 0
        ? call('task', {
            key: 'nested-root',
            role: 'reader',
            input: { content: 'Delegate' },
            cancellation: 'detached',
            resultDisposition: 'background',
          })
        : n === 1
          ? call(probe.id, {})
          : [finish])
        yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      const n = childCalls++;
      for (const event of n === 0 ? call(delegate.id, {}) : n === 1 ? call(leaf.id, {}) : [finish])
        yield event;
    },
  };
  f = await fixture(wrapped, parent, child, [leaf.id, delegate.id], 'leaf');
  try {
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Nested observation' },
    });
    await observed;
    expect(card.sessionId).not.toBe(ref.childSessionId);
    expect(card.ancestry).toContain(ref.childSessionId!);
    expect(effects).toBe(0);
    await f.runtime.answerInteraction({
      expectedStoreId: f.storeId,
      commandId: 'human-nested',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    expect(effects).toBe(1);
    expect(childCalls).toBe(4);
    expect(parentCalls).toBe(3);
  } finally {
    await f.close();
  }
}, 10000);
