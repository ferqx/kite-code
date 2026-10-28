import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelRequest } from '@kite-ai/ai';
import { NativeCallerJournal } from '../../../apps/desktop/electron/caller-journal';
import { NativeCaller } from '../../../apps/desktop/electron/native-caller';
import type { NativeEvent, NativeState } from '../../../apps/desktop/src/native-bridge';
import { memoryPrivateData } from '../../../apps/desktop/test/private-data.fixture';
import { startService } from '../../../apps/service/src';
import { createClient, readOrdinaryCommandApplication } from '../../../packages/client/src';

async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (valid(value)) return value;
    if (Date.now() > deadline) throw new Error(`Input deadline: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}
async function code(work: Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(expected);
}
function gatedModel(oldTool = false, toolCount = 1) {
  const requests: ModelRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: ModelAdapter = {
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        let abort!: () => void;
        try {
          await Promise.race([
            gate,
            new Promise<never>((_resolve, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        } finally {
          signal.removeEventListener('abort', abort);
        }
        signal.throwIfAborted();
        if (oldTool) {
          yield { type: 'tool_call', id: 'old-call', name: 'fixture.old', arguments: '{}' };
          for (let index = 1; index < toolCount; index++)
            yield {
              type: 'tool_call',
              id: `old-call-${index}`,
              name: 'fixture.old',
              arguments: '{}',
            };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
      }
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { model, requests, release };
}
async function fixture(
  oldTool = false,
  options: {
    toolCount?: number;
    onTool?: (count: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-client-inputs-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const model = gatedModel(oldTool, options.toolCount);
  let effects = 0;
  const runtime = createRuntime({
    store,
    model: model.model,
    modelId: 'fixed',
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.old',
            version: '1',
            description: 'Harmless counted old decision',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              effects++;
              await options.onTool?.(effects, context.signal);
              return { outcome: 'succeeded', content: 'counted old decision' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'input-fixture',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands', 'inputs'] },
    bootstrap: service.bootstrap,
  });
  const close = async () => {
    model.release();
    client.disposeNetwork();
    try {
      await service.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'root',
    });
    const contextSelectionId = (await client.getView('s')).session.contextSelectionId;
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'original',
      kind: 'run.start',
      content: 'original model input',
    });
    await until(
      async () => model.requests.length,
      (count) => count === 1,
    );
    const run = (await client.getView('s')).runs[0]!;
    return {
      client,
      runtime,
      store,
      model,
      run,
      expectedStoreId,
      contextSelectionId,
      service,
      profile,
      get effects() {
        return effects;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('real Loop finishes the old Tool before twelve independent guidance messages reach the next Model', async () => {
  const f = await fixture(true);
  try {
    const businessIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const receipt = await f.client.steer('s', {
        expectedStoreId: f.expectedStoreId,
        commandId: `steer-${i}`,
        kind: 'input.steer',
        content: `steer content ${i}`,
        targetRunId: f.run.id,
        contextSelectionId: f.contextSelectionId,
      });
      expect(receipt.id).toBe(`steer-${i}`);
      expect(receipt.status).toBe('accepted');
      businessIds.push(receipt.id);
    }
    const ids: string[] = [];
    let afterSeq: string | undefined;
    do {
      const page = await f.client.listPendingInputs('s', {
        storeId: f.expectedStoreId,
        kind: 'input.steer',
        targetRunId: f.run.id,
        limit: 5,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      ids.push(...page.commands.map((command) => command.id));
      for (const command of page.commands)
        expect(command.request).toMatchObject({
          targetRunId: f.run.id,
          contextSelectionId: f.contextSelectionId,
        });
      afterSeq = page.nextAfterSeq ?? undefined;
    } while (afterSeq);
    expect(ids).toEqual(businessIds);
    expect(new Set(businessIds).size).toBe(12);
    expect(
      f.model.requests[0]?.messages.some((message) => message.content.startsWith('steer content')),
    ).toBe(false);
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect(f.effects).toBe(1);
    expect(f.model.requests).toHaveLength(2);
    const messages = await f.client.listMessages('s');
    expect(
      messages.some((message) => message.toolCalls?.some((call) => call.id === 'old-call')),
    ).toBe(true);
    expect(
      messages.filter((message) => message.role === 'tool' && message.toolCallId === 'old-call'),
    ).toHaveLength(1);
    expect(
      f.model.requests[1]?.messages.filter(
        (message) => message.role === 'tool' && message.toolCallId === 'old-call',
      ),
    ).toHaveLength(1);
    for (let i = 0; i < 12; i++) {
      const command = await f.client.getCommand(`steer-${i}`);
      expect(command.status).toBe('applied');
      expect(command.receipt).toMatchObject({ runId: f.run.id });
      const application = (await readOrdinaryCommandApplication(f.client, command, {
        targetRunId: f.run.id,
      }))!;
      expect(application.run?.id).toBe(f.run.id);
      const businessId = application.sourceCommandId;
      expect(businessId).toBe(command.id);
      const raw = await f.store.getCommand(command.id);
      expect(raw?.request).toMatchObject({
        content: `steer content ${i}`,
        kind: 'input.steer',
        targetRunId: f.run.id,
        contextSelectionId: f.contextSelectionId,
      });
      expect(messages.find((message) => message.originCommandId === businessId)).toMatchObject({
        content: `steer content ${i}`,
        inputKind: 'input.steer',
        contextSelectionId: f.contextSelectionId,
        sourceIds: [businessId],
      });
      expect(f.model.requests[1]?.messages).toContainEqual({
        role: 'user',
        content: `steer content ${i}`,
        sourceIds: [businessId],
      });
    }
    const original = await f.client.getCommand('steer-0');
    expect(
      await f.client.steer('s', {
        expectedStoreId: f.expectedStoreId,
        commandId: 'steer-0',
        kind: 'input.steer',
        content: 'steer content 0',
        targetRunId: f.run.id,
        contextSelectionId: f.contextSelectionId,
      }),
    ).toEqual(original);
    const originalApplication = (await readOrdinaryCommandApplication(f.client, original, {
      targetRunId: f.run.id,
    }))!;
    expect(
      (await f.client.listMessages('s')).filter(
        (message) => message.originCommandId === originalApplication.sourceCommandId,
      ),
    ).toHaveLength(1);
    expect(
      (await f.client.listPendingInputs('s', { storeId: f.expectedStoreId })).commands,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);

test('guidance cannot abort or overtake any foreground sibling; the next Model sees all real results before the independent user input', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const f = await fixture(true, {
    toolCount: 3,
    onTool: async (_count, signal) => {
      signals.push(signal);
      await gate;
      signal.throwIfAborted();
    },
  });
  try {
    f.model.release();
    await until(
      async () => f.effects,
      (count) => count === 3,
    );
    await f.client.steer('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'during-tools',
      kind: 'input.steer',
      content: '请先回复现在的进度。',
      targetRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    });
    await Bun.sleep(50);
    expect(f.model.requests).toHaveLength(1);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect((await f.client.getCommand('during-tools')).status).toBe('accepted');
    release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect(f.effects).toBe(3);
    const next = f.model.requests[1]!.messages;
    expect(next.filter((message) => message.role === 'tool')).toHaveLength(3);
    expect(
      next.filter(
        (message) => message.role === 'user' && message.content === '请先回复现在的进度。',
      ),
    ).toHaveLength(1);
    expect(
      next.findIndex((message) => message.sourceIds?.includes('during-tools')),
    ).toBeGreaterThan(
      Math.max(...next.map((message, index) => (message.role === 'tool' ? index : -1))),
    );
  } finally {
    release();
    await f.close();
  }
}, 15000);

test('queue-to-guidance is atomic, preserves exact text, rejects stale/changed input and never starts a duplicate follow-up', async () => {
  const f = await fixture(true);
  const content = '  独立问题 **进度**\r\n雪🙂  ';
  try {
    await f.client.followUp('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'queued',
      kind: 'input.follow_up',
      content,
      afterRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    });
    const intent = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'promoted',
      kind: 'input.steer' as const,
      content,
      targetRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
      queuedInputCommandId: 'queued',
    };
    await code(
      f.client.steer('s', { ...intent, commandId: 'wrong-body', content: 'changed' }),
      'input_target_changed',
    );
    expect((await f.client.getCommand('queued')).status).toBe('accepted');
    const receipt = await f.client.steer('s', intent);
    expect(receipt.status).toBe('accepted');
    expect(await f.client.getCommand('queued')).toMatchObject({
      status: 'rejected',
      receipt: { outcome: 'steered_before_apply', steerCommandId: 'promoted' },
    });
    expect(await f.client.steer('s', intent)).toEqual(receipt);
    await code(
      f.client.steer('s', { ...intent, commandId: 'duplicate' }),
      'input_already_consumed',
    );
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect(f.effects).toBe(1);
    expect((await f.client.getView('s')).runs).toHaveLength(1);
    expect(
      (await f.client.listMessages('s')).filter((message) => message.content === content),
    ).toHaveLength(1);
    expect(f.model.requests[1]!.messages).toContainEqual({
      role: 'user',
      content,
      sourceIds: ['promoted'],
    });
  } finally {
    await f.close();
  }
}, 15000);

test('a lost queue-to-guidance HTTP receipt is recovered by its original durable caller ID without another POST or duplicate Run', async () => {
  const f = await fixture(true);
  let posts = 0;
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.text() : undefined;
      const intent = body ? JSON.parse(body) : undefined;
      const headers = new Headers(request.headers);
      headers.set('host', new URL(f.service.endpoint).host);
      const response = await fetch(`${f.service.endpoint}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      if (intent?.kind === 'input.steer') {
        posts++;
        await response.arrayBuffer();
        return new Response('lost after commit', { status: 502 });
      }
      return response;
    },
  });
  const client = createClient({
    endpoint: relay.url.href,
    token: f.service.bootstrap.token,
    expected: { profile: f.profile, apiMajor: 1, requiredCapabilities: ['commands', 'inputs'] },
  });
  const data = memoryPrivateData();
  try {
    await client.connect();
    const content = '完整进度问题\n雪🙂';
    await f.client.followUp('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'queued-lost',
      kind: 'input.follow_up',
      afterRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
      content,
    });
    const request = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'guide-lost',
      kind: 'input.steer' as const,
      targetRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
      queuedInputCommandId: 'queued-lost',
      content,
    };
    const journal = new NativeCallerJournal(client, data);
    await journal.prepare('s', request);
    await expect(journal.submit(request.commandId)).rejects.toThrow();
    expect(journal.records()[0]!.phase).toBe('unknown');
    expect((await f.client.getCommand('queued-lost')).status).toBe('rejected');
    const cold = new NativeCallerJournal(client, data);
    expect((await cold.lookup(request.commandId)).id).toBe(request.commandId);
    expect(posts).toBe(1);
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect((await cold.lookup(request.commandId)).status).toBe('applied');
    expect(posts).toBe(1);
    expect(f.effects).toBe(1);
    expect((await f.client.getView('s')).runs).toHaveLength(1);
    expect(
      (await f.client.listMessages('s')).filter((message) => message.content === content),
    ).toHaveLength(1);
  } finally {
    client.disposeNetwork();
    relay.stop(true);
    await f.close();
  }
}, 15000);

test('real Native Main sends one observed queue item and publishes durable caller changes for recovery and cold source suppression', async () => {
  const f = await fixture(true);
  const events: NativeEvent[] = [];
  const client = createClient({
    endpoint: f.service.endpoint,
    token: f.service.bootstrap.token,
    expected: {
      profile: f.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'inputs', 'pending_input_queue'],
    },
  });
  await client.connect();
  const native = new NativeCaller(client, (event) => events.push(event), memoryPrivateData());
  try {
    await f.client.followUp('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'main-queued',
      kind: 'input.follow_up',
      afterRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
      content: '请直接回答进度',
    });
    const attached = (await native.invoke({ method: 'attach' })) as NativeState;
    const state = (await native.invoke({
      method: 'select',
      generation: attached.generation,
      sessionId: 's',
    })) as NativeState;
    const observed = await native.invoke({
      method: 'input.queue.read',
      generation: state.generation,
      viewSelection: state.selection!.viewSelection!,
      historyEpoch: state.historyEpoch ?? 0,
      readId: 'main-guide',
    });
    if (!observed || !('observationId' in observed)) throw Error('queue observation absent');
    const before = events.length;
    const sent = await native.invoke({
      method: 'input.queue.steer',
      generation: state.generation,
      observationId: observed.observationId,
      targetCommandId: 'main-queued',
    });
    expect(sent).toMatchObject({
      phase: 'accepted',
      request: { kind: 'input.steer', queuedInputCommandId: 'main-queued' },
    });
    expect(events.length).toBeGreaterThan(before);
    const saved = (await native.invoke({
      method: 'state',
      generation: state.generation,
    })) as NativeState;
    expect(
      saved.callerSubmissions?.filter((row) => row.request.kind === 'input.steer'),
    ).toHaveLength(1);
    expect((await f.client.getCommand('main-queued')).status).toBe('rejected');
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect(f.effects).toBe(1);
  } finally {
    f.model.release();
    await native.disposeNetwork();
    await f.close();
  }
}, 15000);

test('a complete one MiB escaped input fits the HTTP frame and precise cancellation prevents its application', async () => {
  const f = await fixture();
  try {
    const content = '\0'.repeat(1048576);
    const input = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'full-byte-budget',
      kind: 'input.steer' as const,
      content,
      targetRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    };
    expect(new TextEncoder().encode(content).length).toBe(1048576);
    expect(JSON.stringify(input).length).toBeGreaterThan(6 * 1048576);
    expect((await f.client.steer('s', input)).status).toBe('accepted');
    await f.client.cancelCommand('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-full-byte-budget',
      kind: 'command.cancel',
      targetCommandId: input.commandId,
    });
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect((await f.client.getCommand(input.commandId)).status).toBe('rejected');
    expect(
      (await f.client.listMessages('s')).some(
        (message) => message.originCommandId === input.commandId,
      ),
    ).toBe(false);
    expect(f.model.requests).toHaveLength(1);
    expect(f.effects).toBe(0);
  } finally {
    await f.close();
  }
}, 15000);

test('precise original Run cancellation preserves queued explicit follow-up while cancelling another input by original command ID creates no new Run/message', async () => {
  const f = await fixture();
  try {
    const content = { 'follow-one': 'New task: follow-one', 'follow-two': 'follow-two' };
    for (const id of ['follow-one', 'follow-two'])
      expect(
        (
          await f.client.followUp('s', {
            expectedStoreId: f.expectedStoreId,
            commandId: id,
            kind: 'input.follow_up',
            content: content[id as keyof typeof content],
            afterRunId: f.run.id,
            contextSelectionId: f.contextSelectionId,
          })
        ).status,
      ).toBe('accepted');
    const queued = await f.client.getCommand('follow-one');
    expect(queued.id).toBe('follow-one');
    expect((await f.store.getCommand(queued.id))?.request).toMatchObject({
      afterRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    });
    expect(
      (await f.client.listPendingInputs('s', { storeId: f.expectedStoreId })).commands.map(
        (command) => command.id,
      ),
    ).toEqual(['follow-one', 'follow-two']);
    const pendingInput = await f.client.getCommand('follow-two');
    const pendingRawId = pendingInput.id;
    expect(pendingInput.status).toBe('accepted');
    expect((await f.store.getCommand(pendingRawId))?.request).toMatchObject({
      kind: 'input.follow_up',
      afterRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    });
    await f.client.cancelCommand('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-follow-two',
      kind: 'command.cancel',
      targetCommandId: 'follow-two',
    });
    const cancelledRaw = await f.store.getCommand(pendingRawId);
    expect(cancelledRaw?.cancelRequestedAt).not.toBeNull();
    expect(cancelledRaw?.receipt).not.toHaveProperty('decisionCommandId');
    expect(
      (await f.client.listPendingInputs('s', { storeId: f.expectedStoreId })).commands.map(
        (command) => command.id,
      ),
    ).toEqual(['follow-one']);
    expect((await f.client.getRun(f.run.id)).isActive).toBe(true);
    await f.client.cancelRun('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-original',
      kind: 'run.cancel',
      runId: f.run.id,
    });
    await f.runtime.waitForCommand('follow-one', { timeoutMs: 5000 });
    const followCommand = await f.client.getCommand('follow-one');
    const application = (await readOrdinaryCommandApplication(f.client, followCommand))!;
    const businessId = application.sourceCommandId;
    const view = await f.client.getView('s');
    expect(view.runs.find((run) => run.id === f.run.id)?.status).toBe('cancelled');
    expect(view.runs.find((run) => run.id === application.run?.id)).toMatchObject({
      originCommandId: businessId,
      rootWorkCommandId: 'follow-one',
      status: 'completed',
    });
    expect(view.runs).toHaveLength(2);
    expect(await f.client.getCommand('follow-two')).toMatchObject({
      status: 'rejected',
      receipt: { outcome: 'cancelled_before_apply' },
    });
    expect(view.messages.some((message) => message.originCommandId === 'follow-two')).toBe(false);
    expect(view.messages.find((message) => message.originCommandId === businessId)).toMatchObject({
      inputKind: 'input.follow_up',
      contextSelectionId: f.contextSelectionId,
      sourceIds: [businessId],
      content: content['follow-one'],
    });
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[1]?.messages).toContainEqual({
      role: 'user',
      content: content['follow-one'],
      sourceIds: [businessId],
    });
    expect(
      (await f.client.listPendingInputs('s', { storeId: f.expectedStoreId })).commands,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);

test('additional input admission keeps old Store/Run/context intent; failed checks have zero commands/messages/Model effects', async () => {
  const f = await fixture();
  try {
    const intent = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'bad-steer',
      kind: 'input.steer' as const,
      content: 'draft retained',
      targetRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    };
    const before = await f.client.getView('s');
    await code(
      f.client.steer('s', { ...intent, expectedStoreId: 'old-store' }),
      'store_identity_mismatch',
    );
    await code(
      f.client.steer('s', { ...intent, targetRunId: 'different-run' }),
      'input_target_stopped',
    );
    await code(
      f.client.steer('s', { ...intent, contextSelectionId: 'old-context' }),
      'context_selection_changed',
    );
    await code(
      f.client.followUp('s', {
        expectedStoreId: f.expectedStoreId,
        commandId: 'bad-follow',
        kind: 'input.follow_up',
        content: 'later draft',
        afterRunId: null,
        contextSelectionId: f.contextSelectionId,
      }),
      'input_target_changed',
    );
    expect(await f.client.getView('s')).toEqual(before);
    expect(f.model.requests).toHaveLength(1);
    expect(f.effects).toBe(0);
    expect(await f.store.getCommand('bad-steer')).toBeNull();
    expect(await f.store.getCommand('bad-follow')).toBeNull();
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    await code(f.client.steer('s', intent), 'input_target_stopped');
    expect(intent.targetRunId).toBe(f.run.id);
    expect(intent.contextSelectionId).toBe(f.contextSelectionId);
    expect(intent.content).toBe('draft retained');
  } finally {
    await f.close();
  }
}, 15000);

test('an actual detached child remains readable but public additional inputs cannot mutate its origin', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-inputs-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childSessionId = '';
  let effects = 0;
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const parent = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const child = createFixedModel([
    [
      { type: 'tool_call', id: 'gate', name: 'fixture.gate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['fixture.gate'],
        snapshot: {},
      },
    ],
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Explicit delegation',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'background',
                cancellation: 'detached',
                request: {
                  kind: 'agent',
                  configurationId: 'child',
                  input: { content: 'background' },
                },
              });
              childSessionId = ref.childSessionId!;
              return { outcome: 'succeeded', content: 'delegated' };
            },
          },
          {
            id: 'fixture.gate',
            version: '1',
            description: 'Finite child gate',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              effects++;
              let abort!: () => void;
              try {
                await Promise.race([
                  gate,
                  new Promise<never>((_resolve, reject) => {
                    abort = () => reject(context.signal.reason);
                    context.signal.addEventListener('abort', abort, { once: true });
                    if (context.signal.aborted) abort();
                  }),
                ]);
                context.signal.throwIfAborted();
                return { outcome: 'succeeded', content: 'released' };
              } finally {
                context.signal.removeEventListener('abort', abort);
              }
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: 'new',
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'child-input',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['inputs'] },
    bootstrap: service.bootstrap,
  });
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'parent',
    });
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'parent',
      kind: 'run.start',
      content: 'delegate',
    });
    await runtime.waitForCommand('parent', { timeoutMs: 5000 });
    await until(
      async () => effects,
      (count) => count === 1,
    );
    const before = await client.getView(childSessionId);
    const run = before.runs[0]!;
    const contextSelectionId = before.session.contextSelectionId;
    await code(
      client.steer(childSessionId, {
        expectedStoreId,
        commandId: 'child-steer',
        kind: 'input.steer',
        content: 'forbidden',
        targetRunId: run.id,
        contextSelectionId,
      }),
      'group_root_required',
    );
    await code(
      client.followUp(childSessionId, {
        expectedStoreId,
        commandId: 'child-follow',
        kind: 'input.follow_up',
        content: 'forbidden',
        afterRunId: run.id,
        contextSelectionId,
      }),
      'group_root_required',
    );
    await code(
      client.listPendingInputs(childSessionId, { storeId: expectedStoreId }),
      'group_root_required',
    );
    expect(await client.getView(childSessionId)).toEqual(before);
    expect(await store.getCommand('child-steer')).toBeNull();
    expect(await store.getCommand('child-follow')).toBeNull();
    expect(child.requests).toHaveLength(1);
    expect(parent.requests).toHaveLength(2);
    expect(effects).toBe(1);
  } finally {
    release();
    client.disposeNetwork();
    try {
      await service.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 15000);
