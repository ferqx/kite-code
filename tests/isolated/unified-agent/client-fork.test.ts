import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('public Fork history proves original full Model output beyond 17MiB; Native/Cookie reads preserve immutable scope and a new explicit Run never replays old effects', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-public-fork-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const content = `Original α\0\n${'x'.repeat(17 * 1024 * 1024)}\nEXACT FORK TAIL`;
  const events: ModelEvent[] = [];
  for (let offset = 0; offset < content.length; offset += 32768)
    events.push({ type: 'text_delta', text: content.slice(offset, offset + 32768) });
  events.push(
    { type: 'tool_call', id: 'original-call', name: 'effect', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  );
  const model = createFixedModel([
    events,
    [{ type: 'text_delta', text: 'Original complete' }, finish],
    [{ type: 'text_delta', text: 'New branch complete' }, finish],
  ]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    model,
    artifacts: createArtifactStore({ profile, store }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'effect',
            version: '1',
            description: 'Owned harmless effect ledger',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'Original exact effect result' };
            },
          },
        ],
      },
    ],
  });
  const host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' };
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'public-fork',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['context', 'model_outputs'] },
  });
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined,
    browser: ReturnType<typeof createBrowserClient> | undefined,
    coldRuntime: ReturnType<typeof createRuntime> | undefined,
    closed = false;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Owned',
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 'source',
      commandId: 'create',
      workspaceId: 'w',
      title: 'Original',
    });
    await client.startRun('source', {
      expectedStoreId,
      commandId: 'original',
      kind: 'run.start',
      content: 'Owned original work',
    });
    await runtime.waitForCommand('original', { timeoutMs: 15000 });
    const source = await client.getView('source');
    expect(source.runs[0]!.status).toBe('completed');
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    const originalMessage = source.messages.find(
      (message) => message.outputBody?.toolCallCount === 1,
    )!;
    const executionId = originalMessage.outputBody!.executionId;
    const originalOutput = await client.getModelOutput('source', executionId);
    const { snapshotCursor: _originalReadCursor, ...immutableOutput } = originalOutput;
    const fork = await client.forkSession('source', {
      expectedStoreId,
      commandId: 'fork',
      expectedContextSelectionId: source.session.contextSelectionId,
      newSessionId: 'branch',
      title: 'Explicit branch',
    });
    expect(fork.omittedExtensionState).toBe(true);
    const branch = await client.getView('branch');
    expect(branch.runs).toHaveLength(0);
    expect(branch.executions).toHaveLength(0);
    const copied = branch.messages.find(
      (message) => message.outputBody?.executionId === executionId,
    )!;
    expect(copied.runId).toBeNull();
    expect(copied.originMessage).toEqual({
      storeId: expectedStoreId,
      sessionId: 'source',
      messageId: originalMessage.id,
      runId: originalMessage.runId,
    });
    expect(copied.outputBody).toEqual(originalMessage.outputBody);
    const context = await client.getContext('branch', { storeId: expectedStoreId });
    expect(context.messages.find((message) => message.id === copied.id)).toEqual(copied);
    expect(
      (await client.listMessages('branch')).find((message) => message.id === copied.id),
    ).toEqual(copied);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    expect(await client.getModelOutput(copied.originMessage!.sessionId, executionId)).toMatchObject(
      immutableOutput,
    );
    const denied = await client
      .getModelOutput('branch', executionId)
      .catch((error: unknown) => error);
    expect((denied as { code: string }).code).toBe('model_input_scope_denied');
    expect(originalOutput.output.content).toBe(content);
    expect(originalOutput.output.toolCalls).toEqual([
      { id: 'original-call', name: 'effect', arguments: '{}' },
    ]);
    gateway = startDevelopmentWeb({ admittedClient: client });
    const document = await fetch(gateway.endpoint);
    await document.body?.cancel();
    const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
    browser = createBrowserClient({
      origin: gateway.endpoint,
      pageIdentity: gateway.pageIdentity,
      fetch: Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetch(url, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              cookie,
              origin: gateway!.endpoint,
            },
          }),
        { preconnect: fetch.preconnect },
      ),
    });
    await browser.connect();
    const browserMessage = (await browser.listMessages('branch')).find(
      (message) => message.id === copied.id,
    )!;
    expect(browserMessage.originMessage).toEqual(copied.originMessage);
    expect(
      await browser.getModelOutput(browserMessage.originMessage!.sessionId, executionId),
    ).toMatchObject(immutableOutput);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(model.requests).toHaveLength(2);
    expect(effects).toBe(1);
    expect(client.lastAppliedCursor).toBeUndefined();
    for (const value of [branch, context, fork])
      expect(JSON.stringify(value)).not.toContain('model-output-');
    const { command: forkCommand, ...forkWithoutCommand } = fork;
    for (const value of [branch, context, forkWithoutCommand])
      expect(JSON.stringify(value)).not.toContain('"subjectId"');
    const storedForkCommand = await store.getCommand('fork');
    const publicForkCommand = await client.getCommand('fork');
    expect(forkCommand.id).toBe('fork');
    expect(forkCommand.subjectId).toBe('owner');
    expect(forkCommand.subjectId).toBe(client.serverInfo!.subjectId);
    expect(forkCommand.subjectId).toBe(storedForkCommand!.subjectId);
    expect(forkCommand.subjectId).toBe(publicForkCommand.subjectId);
    expect(forkCommand.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(forkCommand.requestDigest).toBe(storedForkCommand!.requestDigest);
    expect(forkCommand.requestDigest).toBe(publicForkCommand.requestDigest);
    await client.startRun('branch', {
      expectedStoreId,
      commandId: 'new-work',
      kind: 'run.start',
      content: 'New explicit work',
    });
    await runtime.waitForCommand('new-work', { timeoutMs: 15000 });
    expect((await client.getView('branch')).runs[0]!.status).toBe('completed');
    const actual = model.requests[2]!;
    expect(
      actual.messages.find((message) =>
        message.toolCalls?.some((call) => call.id === 'original-call'),
      )?.content,
    ).toBe(content);
    expect(
      actual.messages.find((message) =>
        message.toolCalls?.some((call) => call.id === 'original-call'),
      )?.sourceIds,
    ).toEqual(originalMessage.sourceIds);
    expect(
      actual.messages.filter(
        (message) => message.role === 'tool' && message.toolCallId === 'original-call',
      ),
    ).toHaveLength(1);
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(3);
    await gateway.close();
    gateway = undefined;
    await service.close();
    closed = true;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    coldRuntime = createRuntime({
      store: cold,
      artifacts: createArtifactStore({ profile, store: cold }),
      permissions: {
        async authorize() {
          throw Error('cold_authorize');
        },
      },
      sources: {
        async capture() {
          throw Error('cold_capture');
        },
      },
    });
    const coldService = await startService({
      runtime: coldRuntime,
      profile: host,
      buildId: 'public-fork-cold',
      subjectId: 'owner',
    });
    const coldClient = createClient({
      endpoint: coldService.endpoint,
      token: coldService.bootstrap.token,
      expected: { profile: host, apiMajor: 1, requiredCapabilities: ['history', 'model_outputs'] },
    });
    try {
      await coldClient.connect();
      const water = (await cold.getMetadata()).lastChangeCursor;
      expect(
        (await coldClient.getView('branch')).messages.find((message) => message.id === copied.id),
      ).toEqual(copied);
      expect((await coldClient.getModelOutput('source', executionId)).bodyHash).toBe(
        originalOutput.bodyHash,
      );
      expect((await cold.getMetadata()).lastChangeCursor).toBe(water);
      expect(model.requests).toHaveLength(3);
      expect(effects).toBe(1);
    } finally {
      coldClient.disposeNetwork();
      await coldService.close();
    }
  } finally {
    browser?.disposeNetwork();
    client.disposeNetwork();
    await gateway?.close();
    if (!closed) await service.close();
    await coldRuntime?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);
