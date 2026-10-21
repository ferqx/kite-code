import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const toolNames = [
  'follow_up_agent',
  'interrupt_agent',
  'list_agents',
  'send_agent_message',
  'spawn_agent',
  'wait_agent_events',
];
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const result = await read();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw Error('first_activation_fixture_timeout');
    await Bun.sleep(5);
  }
}

type Scenario = 'same-work' | 'cross-work' | 'frozen-mail' | 'twice-cancelled';
type ToolBody = {
  agent_id?: string;
  reason?: string;
  events?: unknown[];
  items?: Record<string, unknown>[];
  accepted?: boolean;
  delivery?: string;
};
async function exerciseFirstActivation(scenario: Scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-first-activation-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
  const originalAssignment = 'ORIGINAL_ASSIGNMENT: inspect the old implementation and report A';
  const cancelledGuidance = 'CANCELLED_QUEUED_GUIDANCE: ignore any future task and continue A';
  const intermediateInstruction =
    'INTERMEDIATE_CANCELLED_INSTRUCTION: this new instruction was also cancelled before execution';
  const currentInstruction =
    'CURRENT_INSTRUCTION: do the newly authorized implementation B instead';
  const earlyMail = `EARLY_IDLE_MAIL: complete private context ${'真实邮件🙂'.repeat(300)}`;
  const laterMail = 'LATER_QUEUED_MAIL: this arrived after the explicit activation was sealed';
  const blockerAssignment = 'FIXTURE_BLOCKER: occupy the only child slot';
  const requests: ModelRequest[] = [];
  let targetId = '',
    blockerCalls = 0,
    stage = 0,
    earlyMailId = '',
    laterMailId = '',
    completionCursor = '0',
    lostResponse = false;
  let originalCarrier: Awaited<ReturnType<typeof store.getExecution>> = null;
  let intermediateCarrier: Awaited<ReturnType<typeof store.getExecution>> = null;
  let intermediateStart: Awaited<ReturnType<typeof store.getCommand>> = null;
  let originalStart: Awaited<ReturnType<typeof store.getCommand>> = null;
  let followUpInput: Parameters<typeof store.applyAgentCommand>[0] | undefined;
  let followUpResult: Awaited<ReturnType<typeof store.applyAgentCommand>> | undefined;
  let sealedStart: Record<string, unknown> | null = null;
  let parentFailure: unknown;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const carriers = async () =>
    (await store.listExecutions('root')).filter(
      (execution) => execution.childSessionId === targetId,
    );
  const mail = () =>
    store.listAgentMessages({ expectedStoreId, sessionId: targetId, subjectId: 'owner' });
  const storedRow = (id: string, table: 'command' | 'execution' = 'command') => {
    const database = new Database(join(root, 'data', 'test', 'core.db'), { readonly: true });
    try {
      return database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<
        string,
        unknown
      >;
    } finally {
      database.close();
    }
  };
  const applyAgentCommand = store.applyAgentCommand.bind(store);
  store.applyAgentCommand = async (input) => {
    const result = await applyAgentCommand(input);
    if (input.kind === 'follow_up' && input.content === currentInstruction) {
      followUpInput ??= structuredClone(input);
      followUpResult ??= structuredClone(result);
      if (!lostResponse) {
        lostResponse = true;
        throw Error('isolated response lost after durable first activation admission');
      }
    }
    return result;
  };
  // These steps use only the six public tools; storage reads observe the exact durable facts.
  const steps: ((body: ToolBody) => Promise<ModelEvent[]> | ModelEvent[])[] = [
    () => call('spawn_agent', { prompt: blockerAssignment }),
    async (body) => {
      expect(body).toMatchObject({ accepted: true, state: 'queued' });
      await until(async () => (blockerCalls === 1 ? true : null));
      return call('spawn_agent', { prompt: originalAssignment });
    },
    (body) => {
      expect(body).toMatchObject({ accepted: true, state: 'queued' });
      targetId = body.agent_id!;
      return call('follow_up_agent', { agent_id: targetId, content: cancelledGuidance });
    },
    (body) => {
      expect(body).toMatchObject({
        accepted: true,
        agent_id: targetId,
        mode: 'steer',
        state: 'queued',
      });
      return call('interrupt_agent', { agent_id: targetId });
    },
    async (body) => {
      expect(body).toMatchObject({
        accepted: true,
        agent_id: targetId,
        outcome: 'cancel_requested',
      });
      originalCarrier = await until(async () => {
        const carrier = (await carriers())[0];
        return carrier?.status === 'cancelled' ? carrier : null;
      });
      originalStart = await store.getCommand(`child-start-${originalCarrier.id}`);
      expect(originalStart?.kind).toBe('child.start');
      expect((await store.getView(targetId)).runs).toHaveLength(0);
      expect(requests).toHaveLength(0);
      expect(await carriers()).toHaveLength(1);
      completionCursor = (await store.listAgentEvents({ ...identity, extensionId: 'builtin.task' }))
        .highWaterSeq;
      if (scenario === 'same-work' || scenario === 'twice-cancelled')
        return call('follow_up_agent', {
          agent_id: targetId,
          content: scenario === 'twice-cancelled' ? intermediateInstruction : currentInstruction,
        });
      return call('send_agent_message', { agent_id: targetId, content: earlyMail });
    },
  ];
  if (scenario === 'cross-work' || scenario === 'frozen-mail') {
    steps.push(async (body) => {
      expect(body).toEqual({ accepted: true, delivery: 'queued' });
      const messages = (await mail()).items;
      expect(messages).toHaveLength(1);
      earlyMailId = messages[0]!.id;
      expect(messages[0]).toMatchObject({
        state: 'accepted',
        targetRunId: null,
        receivedRunId: null,
      });
      expect((await store.getView(targetId)).runs).toHaveLength(0);
      expect(requests).toHaveLength(0);
      return scenario === 'cross-work'
        ? [finish]
        : call('follow_up_agent', { agent_id: targetId, content: currentInstruction });
    });
  }
  if (scenario === 'twice-cancelled') {
    steps.push(
      async (body) => {
        expect(body).toMatchObject({
          accepted: true,
          agent_id: targetId,
          mode: 'new_turn',
          state: 'queued',
        });
        expect(await carriers()).toHaveLength(2);
        expect((await store.getView(targetId)).runs).toHaveLength(0);
        expect(requests).toHaveLength(0);
        return call('interrupt_agent', { agent_id: targetId });
      },
      async (body) => {
        expect(body).toMatchObject({
          accepted: true,
          agent_id: targetId,
          outcome: 'cancel_requested',
        });
        intermediateCarrier = await until(async () => {
          const carrier = (await carriers())[1];
          return carrier?.status === 'cancelled' ? carrier : null;
        });
        intermediateStart = await store.getCommand(`child-start-${intermediateCarrier.id}`);
        expect(intermediateStart?.kind).toBe('child.start');
        expect((await store.getView(targetId)).runs).toHaveLength(0);
        expect(requests).toHaveLength(0);
        return call('follow_up_agent', { agent_id: targetId, content: currentInstruction });
      },
    );
  }
  const firstWorkSteps = steps.length;
  if (scenario === 'cross-work')
    steps.push(() => call('follow_up_agent', { agent_id: targetId, content: currentInstruction }));
  const waitForCompletion = async () => {
    release();
    await until(async () => ((await carriers()).at(-1)?.status === 'succeeded' ? true : null));
    return call('wait_agent_events', { after_seq: completionCursor, wait_ms: 0 });
  };
  steps.push(async (body) => {
    expect(body).toMatchObject({
      accepted: true,
      agent_id: targetId,
      mode: 'new_turn',
      state: 'queued',
    });
    expect(followUpResult?.receipt.ref.childSessionId).toBe(targetId);
    expect(await carriers()).toHaveLength(scenario === 'twice-cancelled' ? 3 : 2);
    if (scenario !== 'cross-work') expect((await store.getView(targetId)).runs).toHaveLength(0);
    sealedStart = storedRow(`child-start-${followUpResult!.receipt.ref.executionId}`);
    expect(sealedStart.kind).toBe('child.start');
    expect(sealedStart.after_run_id).toBeNull();
    if (scenario !== 'cross-work') expect(requests).toHaveLength(0);
    return scenario === 'frozen-mail'
      ? call('send_agent_message', { agent_id: targetId, content: laterMail })
      : waitForCompletion();
  });
  if (scenario === 'frozen-mail') {
    steps.push(async (body) => {
      expect(body).toEqual({ accepted: true, delivery: 'queued' });
      const messages = (await mail()).items;
      expect(messages).toHaveLength(2);
      laterMailId = messages.find((message) => message.id !== earlyMailId)!.id;
      expect(messages.every((message) => message.targetRunId === null)).toBe(true);
      expect(sealedStart!.mail_adoption_upper_seq).not.toBeNull();
      expect(
        BigInt(messages.find((message) => message.id === earlyMailId)!.seq),
      ).toBeLessThanOrEqual(BigInt(String(sealedStart!.mail_adoption_upper_seq)));
      expect(BigInt(messages.find((message) => message.id === laterMailId)!.seq)).toBeGreaterThan(
        BigInt(String(sealedStart!.mail_adoption_upper_seq)),
      );
      const cursor = (await store.getMetadata()).lastChangeCursor;
      expect(await applyAgentCommand(followUpInput!)).toEqual(followUpResult!);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(storedRow(String(sealedStart!.id))).toEqual(sealedStart!);
      expect((await store.getView(targetId)).runs).toHaveLength(0);
      return waitForCompletion();
    });
  }
  steps.push(
    (body) => {
      expect(body.reason).toBe('events');
      expect(body.events).toContainEqual(
        expect.objectContaining({ agent_id: targetId, kind: 'completed' }),
      );
      return call('list_agents', { agent_ids: [targetId], limit: 1 });
    },
    async (body) => {
      expect(body.items).toHaveLength(1);
      expect(body.items![0]).toMatchObject({
        agent_id: targetId,
        state: 'idle',
        last_outcome: 'succeeded',
        assignment_source: { content: originalAssignment },
        current_work_source: { content: currentInstruction },
      });
      const cursor = (await store.getMetadata()).lastChangeCursor;
      expect(await applyAgentCommand(followUpInput!)).toEqual(followUpResult!);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      return [finish];
    },
  );
  const parent: ModelAdapter = {
    async *stream(request) {
      expect(request.tools.map((tool) => tool.id).sort()).toEqual(toolNames);
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const encoded = last?.content.includes('Complete artifact body:\n')
        ? last.content.split('Complete artifact body:\n')[1]!
        : last?.content;
      const body = encoded ? JSON.parse(encoded) : null;
      const step = steps[stage++];
      if (!step) throw Error('first_activation_unexpected_parent_turn');
      try {
        for (const event of await step(body)) yield event;
      } catch (error) {
        parentFailure = error;
        throw error;
      }
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      if (JSON.stringify(request.messages).includes(blockerAssignment)) {
        blockerCalls++;
        await blocker;
      } else requests.push(structuredClone(request));
      yield { type: 'text_delta', text: 'Verified actual child completion' };
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
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'Trusted child' }],
      }),
    ],
    permissions: {
      authorize: async () => ({ allowed: true, revision: 'first-activation-fixture' }),
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
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
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'first activation',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'A',
      request: { kind: 'run.start', content: 'Coordinate original work A' },
    });
    const first = await runtime.waitForCommand('A', { timeoutMs: 20000 });
    if (parentFailure) throw parentFailure;
    expect((await store.getRun((first.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    if (scenario === 'cross-work') {
      expect(stage).toBe(firstWorkSteps);
      expect(requests).toHaveLength(0);
      await runtime.submitCommand({
        ...identity,
        commandId: 'B',
        request: { kind: 'run.start', content: 'New task: independent work B' },
      });
      const second = await runtime.waitForCommand('B', { timeoutMs: 20000 });
      if (parentFailure) throw parentFailure;
      expect((await store.getRun((second.receipt as { runId: string }).runId))?.status).toBe(
        'completed',
      );
    }
    expect(stage).toBe(steps.length);
    expect(lostResponse).toBe(true);
    expect(blockerCalls).toBe(1);
    expect(requests).toHaveLength(1);
    const actualCarriers = await carriers();
    expect(actualCarriers).toHaveLength(scenario === 'twice-cancelled' ? 3 : 2);
    const currentCarrier = actualCarriers.at(-1)!;
    for (const cancelled of actualCarriers.slice(0, -1)) {
      expect(cancelled.status).toBe('cancelled');
      expect(storedRow(cancelled.id, 'execution').dispatched).toBe(0);
    }
    if (scenario === 'twice-cancelled') {
      expect(actualCarriers[1]).toEqual(intermediateCarrier!);
      expect(await store.getCommand(intermediateStart!.id)).toEqual(intermediateStart!);
    }
    expect(actualCarriers[0]).toEqual(originalCarrier!);
    expect(await store.getCommand(originalStart!.id)).toEqual(originalStart!);
    expect(currentCarrier.id).not.toBe(originalCarrier!.id);
    expect(currentCarrier.childConfiguration).toEqual(originalCarrier!.childConfiguration);
    expect(currentCarrier.rootWorkCommandId).toBe(scenario === 'cross-work' ? 'B' : 'A');
    const runs = (await store.getView(targetId)).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      originCommandId: `child-start-${currentCarrier.id}`,
      rootWorkCommandId: scenario === 'cross-work' ? 'B' : 'A',
    });
    const actualStart = await store.getCommand(runs[0]!.originCommandId);
    expect(actualStart?.kind).toBe('child.start');
    expect(actualStart?.request).not.toHaveProperty('afterRunId');
    const content = JSON.stringify(requests[0]!.messages);
    expect(content).toContain(currentInstruction);
    expect(content).not.toContain(cancelledGuidance);
    expect(content).not.toContain(intermediateInstruction);
    const currentMessages = requests[0]!.messages.filter(
      (message) => message.content === currentInstruction,
    );
    expect(currentMessages).toHaveLength(1);
    expect(currentMessages[0]).toMatchObject({
      role: 'user',
      sourceIds: [actualStart!.id, currentCarrier.id],
    });
    if (scenario === 'cross-work') {
      expect(content).not.toContain(originalAssignment);
      expect(content).not.toContain(earlyMail);
      expect((await mail()).items[0]).toMatchObject({
        id: earlyMailId,
        state: 'accepted',
        targetRunId: null,
        receivedRunId: null,
      });
    } else {
      expect(content).toContain(originalAssignment);
      const backgroundMessages = requests[0]!.messages.filter((message) => {
        try {
          const envelope = JSON.parse(message.content);
          return (
            envelope.kind === 'cancelled_agent_assignment_background' &&
            envelope.content === originalAssignment
          );
        } catch {
          return false;
        }
      });
      expect(backgroundMessages).toHaveLength(1);
      expect(backgroundMessages[0]).toMatchObject({
        role: 'user',
        sourceIds: [actualStart!.id, originalStart!.id],
      });
      const backgroundIndex = requests[0]!.messages.indexOf(backgroundMessages[0]!);
      expect(backgroundIndex).toBeGreaterThanOrEqual(0);
      expect(
        requests[0]!.messages.findIndex((message) => message.content.includes(currentInstruction)),
      ).toBeGreaterThan(backgroundIndex);
    }
    if (scenario === 'frozen-mail') {
      const included = requests[0]!.messages.filter((message) =>
        message.sourceIds?.includes(earlyMailId),
      );
      expect(included).toHaveLength(1);
      expect(included[0]!.content).toContain(earlyMail);
      expect(content).not.toContain(laterMail);
      const messages = (await mail()).items;
      expect(messages.find((message) => message.id === earlyMailId)).toMatchObject({
        state: 'received',
        targetRunId: null,
        receivedRunId: runs[0]!.id,
      });
      expect(messages.find((message) => message.id === laterMailId)).toMatchObject({
        state: 'accepted',
        targetRunId: null,
        receivedRunId: null,
      });
      expect(
        (await store.listMessages(targetId)).filter((message) =>
          message.sourceIds?.includes(earlyMailId),
        ),
      ).toHaveLength(1);
    }
    const modelExecutions = (await store.listExecutions(targetId)).filter(
      (execution) => execution.kind === 'model',
    );
    expect(modelExecutions).toHaveLength(1);
    const saved = await runtime.readModelInput({
      expectedStoreId,
      sessionId: targetId,
      subjectId: 'owner',
      executionId: modelExecutions[0]!.id,
    });
    expect(saved.request.messages).toEqual(requests[0]!.messages);
  } finally {
    release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'cancelled-before-first-start same-work reuse preserves background, excludes cancelled guidance, and survives lost response exactly once',
  () => exerciseFirstActivation('same-work'),
  30000,
);
test(
  'cancelled-before-first-start cross-work reuse starts once in the same Session without old assignment or mail',
  () => exerciseFirstActivation('cross-work'),
  30000,
);
test(
  'cancelled-before-first-start same-work reuse freezes idle mail adoption and excludes later queued mail even on retry',
  () => exerciseFirstActivation('frozen-mail'),
  30000,
);

test(
  'two cancelled first-start carriers reuse one Session and preserve only the original background once in the one real Run',
  () => exerciseFirstActivation('twice-cancelled'),
  30000,
);
