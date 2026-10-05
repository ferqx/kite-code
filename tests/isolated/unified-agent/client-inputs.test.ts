import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelRequest } from '@kite-ai/ai';
import { startService } from '../../../apps/service/src';
import { createClient } from '../../../packages/client/src';

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
function gatedModel(oldTool = false) {
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
async function fixture(oldTool = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-client-inputs-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const model = gatedModel(oldTool);
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
            async execute() {
              effects++;
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
      rootUri: `file://${root}`,
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

test('real Loop applies twelve accepted steer inputs before old Tool dispatch; public provenance and immutable first Model are preserved', async () => {
  const f = await fixture(true);
  try {
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
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `steer-${i}`));
    expect(
      f.model.requests[0]?.messages.some((message) => message.content.startsWith('steer content')),
    ).toBe(false);
    f.model.release();
    await f.runtime.waitForCommand('original', { timeoutMs: 5000 });
    expect(f.effects).toBe(0);
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
      expect(command.receipt).toMatchObject({ outcome: 'input_applied', runId: f.run.id });
      expect(messages.find((message) => message.originCommandId === `steer-${i}`)).toMatchObject({
        content: `steer content ${i}`,
        inputKind: 'input.steer',
        contextSelectionId: f.contextSelectionId,
        sourceIds: [`steer-${i}`],
      });
      expect(f.model.requests[1]?.messages).toContainEqual({
        role: 'user',
        content: `steer content ${i}`,
        sourceIds: [`steer-${i}`],
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
    expect(
      (await f.client.listMessages('s')).filter((message) => message.originCommandId === 'steer-0'),
    ).toHaveLength(1);
    expect(
      (await f.client.listPendingInputs('s', { storeId: f.expectedStoreId })).commands,
    ).toHaveLength(0);
  } finally {
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
    for (const id of ['follow-one', 'follow-two'])
      expect(
        (
          await f.client.followUp('s', {
            expectedStoreId: f.expectedStoreId,
            commandId: id,
            kind: 'input.follow_up',
            content: id,
            afterRunId: f.run.id,
            contextSelectionId: f.contextSelectionId,
          })
        ).status,
      ).toBe('accepted');
    expect(
      (await f.client.listPendingInputs('s', { storeId: f.expectedStoreId })).commands.map(
        (command) => command.id,
      ),
    ).toEqual(['follow-one', 'follow-two']);
    await f.client.cancelCommand('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-follow-two',
      kind: 'command.cancel',
      targetCommandId: 'follow-two',
    });
    await f.client.cancelRun('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-original',
      kind: 'run.cancel',
      runId: f.run.id,
    });
    await f.runtime.waitForCommand('follow-one', { timeoutMs: 5000 });
    const view = await f.client.getView('s');
    expect(view.runs.find((run) => run.id === f.run.id)?.status).toBe('cancelled');
    expect(view.runs.find((run) => run.originCommandId === 'follow-one')?.status).toBe('completed');
    expect(view.runs).toHaveLength(2);
    expect(await f.client.getCommand('follow-two')).toMatchObject({
      status: 'rejected',
      receipt: { outcome: 'cancelled_before_apply' },
    });
    expect(view.messages.some((message) => message.originCommandId === 'follow-two')).toBe(false);
    expect(view.messages.find((message) => message.originCommandId === 'follow-one')).toMatchObject(
      {
        inputKind: 'input.follow_up',
        contextSelectionId: f.contextSelectionId,
        sourceIds: ['follow-one'],
        content: 'follow-one',
      },
    );
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[1]?.messages).toContainEqual({
      role: 'user',
      content: 'follow-one',
      sourceIds: ['follow-one'],
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
      rootUri: `file://${root}`,
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
