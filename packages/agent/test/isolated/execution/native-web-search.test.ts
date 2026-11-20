import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createArtifactStore } from '../../../src/artifacts';
import { nativeSearchMessages } from '../../../src/execution/native-web-search';
import { matchesModelRequestIdentity } from '../../../src/model-request-identity';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 2, outputTokens: 3 },
};
const capability = () => 'supported' as const;
const digest = 'a'.repeat(64);
async function fixture(
  model: ModelAdapter,
  authorize: () => boolean = () => true,
  child?: ModelAdapter,
  parentNative = true,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-web-search-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  let store = await openSqliteStore(profile);
  const input = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 'session',
    subjectId: 'owner',
  };
  let ordinaryCalls = 0;
  let authorizations = 0;
  let childSessionId: string | undefined;
  const nativeWebSearch = {
    bindingDigest: digest,
    dialect: 'openai-web-search' as const,
    async authorize() {
      authorizations++;
      return authorize();
    },
  };
  const startRuntime = () =>
    createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelConcurrency: 3,
      ...(child
        ? {
            childConfigurations: [
              {
                id: 'child',
                version: '1',
                model: child,
                modelId: 'fixture-child',
                toolIds: [],
                snapshot: { test: true },
                nativeWebSearch,
              },
            ],
          }
        : {}),
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
              id: 'ordinary',
              version: '1',
              model: { name: 'web_search' },
              description: 'Owned ordinary callable tool',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                ordinaryCalls++;
                if (child) {
                  try {
                    const ref = await context.operations.ensure({
                      key: 'child',
                      request: {
                        kind: 'agent',
                        configurationId: 'child',
                        input: { content: 'child work' },
                      },
                    });
                    childSessionId = ref.childSessionId;
                    await context.operations.wait(ref, { signal: context.signal });
                  } catch (error) {
                    if (
                      error instanceof AgentError &&
                      error.code === 'child_web_search_scope_exceeds_parent'
                    )
                      return { outcome: 'failed', content: error.code };
                    throw error;
                  }
                }
                return { outcome: 'succeeded', content: 'ordinary reply' };
              },
            },
          ],
        },
      ],
      resolveRunConfiguration: async () => ({
        model,
        modelId: 'owned',
        snapshot: { test: true },
        ...(parentNative ? { nativeWebSearch } : {}),
      }),
    });
  let runtime = startRuntime();
  await runtime.createWorkspace({
    expectedStoreId: input.expectedStoreId,
    id: 'workspace',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...input,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'owned',
  });
  return {
    input,
    get runtime() {
      return runtime;
    },
    get store() {
      return store;
    },
    async reopen(adapter: ModelAdapter) {
      await runtime.close();
      await store.close();
      store = await openSqliteStore(profile);
      model = adapter;
      runtime = startRuntime();
    },
    get childSessionId() {
      return childSessionId;
    },
    get ordinaryCalls() {
      return ordinaryCalls;
    },
    get authorizations() {
      return authorizations;
    },
    async start(
      commandId = 'work',
      sessionId = input.sessionId,
      content = 'collect owned evidence',
    ) {
      await runtime.submitCommand({
        ...input,
        commandId,
        sessionId,
        request: { kind: 'run.start', content },
      });
    },
    async wait(commandId = 'work') {
      await runtime.waitForCommand(commandId);
      return runtime.getView(input.sessionId);
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('A03/A04/A11/A18 native progress precedes text, preserves response-level Unicode citations and dispatches only an ordinary model tool', async () => {
  const calls: ModelRequest[] = [];
  const resumed = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const block = '🐝source';
  const text = block + block;
  const secret = 'opaque-fixture';
  const f = await fixture({
    nativeWebSearchCapability: capability,
    async *stream(request) {
      calls.push(request);
      if (calls.length === 1) {
        yield {
          type: 'web_search',
          observation: { kind: 'activity', callId: 'ws-1', status: 'searching', query: 'owned' },
        };
        observed.resolve();
        await resumed.promise;
        yield {
          type: 'web_search',
          observation: { kind: 'activity', callId: 'ws-1', status: 'completed' },
        };
        yield {
          type: 'web_search',
          observation: { kind: 'activity', callId: 'ws-1', status: 'completed' },
        };
        yield { type: 'text_delta', text };
        const citation = {
          kind: 'citation',
          title: 'owned',
          blockIndex: 1,
          text: block,
          blockStartUtf16: block.length,
          startUtf16: 0,
          endUtf16: 2,
        } as const;
        yield {
          type: 'web_search',
          observation: { kind: 'source', url: 'https://example.test/source' },
        };
        yield {
          type: 'web_search',
          observation: { ...citation, url: 'https://example.test/good' },
        };
        yield {
          type: 'web_search',
          observation: {
            ...citation,
            url: 'https://example.test/wrong-offset',
            blockStartUtf16: 1,
          },
        };
        yield {
          type: 'web_search',
          observation: { ...citation, url: 'https://example.test/split', endUtf16: 1 },
        };
        yield {
          type: 'tool_call',
          name: request.tools.find((t) => t.description === 'Owned ordinary callable tool')!.id,
          id: 'ordinary-call',
          arguments: '{}',
        };
        yield { ...finish, reason: 'tool_calls', continuation: { fixture: secret } };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield finish;
    },
  });
  try {
    await f.start();
    await Promise.race([
      observed.promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('native_progress_missing')), 5000);
        timer.unref();
      }),
    ]);
    const executionId = calls[0]!.requestId;
    const early = await f.runtime.readWebSearchEvidence({ ...f.input, executionId });
    expect(early.blocks).toMatchObject([{ callId: 'ws-1', status: 'searching', query: 'owned' }]);
    expect(
      (await f.runtime.getView(f.input.sessionId)).messages.some(
        (m) => m.role === 'assistant' && m.content,
      ),
    ).toBe(false);
    resumed.resolve();
    const view = await f.wait();
    expect(view.runs[0]!.status).toBe('completed');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.nativeWebSearch).toEqual({ dialect: 'openai-web-search' });
    expect(calls[0]!.tools.some((t) => t.id === 'web_search')).toBe(false);
    expect(
      calls[1]!.messages.some(
        (m) => JSON.stringify(m.continuation) === JSON.stringify({ fixture: secret }),
      ),
    ).toBe(true);
    expect(f.ordinaryCalls).toBe(1);
    expect(view.executions.filter((e) => e.kind === 'tool').map((e) => e.definitionId)).toEqual([
      'ordinary',
    ]);
    const final = await f.runtime.readWebSearchEvidence({ ...f.input, executionId });
    expect(final.revision).toBe(3);
    expect(final.blocks[0]).toMatchObject({
      status: 'completed',
      query: 'owned',
      sources: [],
      citations: [],
    });
    expect(final.blocks[1]).toMatchObject({
      sourceScope: 'response',
      status: 'completed',
      sources: [{ url: 'https://example.test/source' }],
    });
    expect(final.blocks[1]!.citations[0]!.anchor).toEqual({
      executionId,
      blockIndex: 1,
      blockStartUtf16: block.length,
      blockLengthUtf16: block.length,
      startUtf16: 0,
      endUtf16: 2,
      textSha256: createHash('sha256').update(block).digest('hex'),
    });
    expect(final.blocks[1]!.citations.slice(1).every((c) => c.anchor === undefined)).toBe(true);
  } finally {
    resumed.resolve();
    await f.close();
  }
}, 15000);

for (const activity of [false, true]) {
  test(`A06/A08 owned HTTP peer received the request; drop ${activity ? 'after native activity' : 'before first event'} yields no resend or fallback`, async () => {
    let requests = 0,
      attempts = 0;
    const received = Promise.withResolvers<void>();
    const disconnect = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        requests++;
        received.resolve();
        await disconnect.promise;
        if (activity) res.end('searching');
        else req.socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('fixture_port');
    const f = await fixture({
      nativeWebSearchCapability: capability,
      async *stream(request, { signal }) {
        attempts++;
        try {
          const response = await fetch(`http://127.0.0.1:${address.port}/owned`, {
            method: 'POST',
            body: JSON.stringify(request.nativeWebSearch),
            signal,
          });
          if ((await response.text()) === 'searching')
            yield {
              type: 'web_search',
              observation: { kind: 'activity', callId: 'ws-1', status: 'searching' },
            };
        } catch {}
        // Omission does not prove a pre-send failure.
        throw new ModelAttemptError('connection_failed');
      },
    });
    try {
      await f.start();
      await received.promise;
      const active = (await f.runtime.getView(f.input.sessionId)).runs[0]!;
      const session = (await f.store.getSession(f.input.sessionId))!;
      const refusal = await f.store
        .verifyRunResume({
          ...f.input,
          runId: active.id,
          expectedOwnerGeneration: session.ownerGeneration,
          commandId: 'cold-resume',
        })
        .catch((e) => e);
      expect(refusal.code).toBe('run_resume_checkpoint_unavailable');
      disconnect.resolve();
      const view = await f.wait();
      expect(attempts).toBe(1);
      expect(requests).toBe(1);
      expect(f.ordinaryCalls).toBe(0);
      expect(view.runs[0]).toMatchObject({
        status: 'failed',
        reason: 'native_search_outcome_unknown',
      });
      const executions = view.executions.filter((e) => e.kind === 'model');
      expect(executions).toHaveLength(1);
      const original = executions[0]!;
      const source = original.decisionSource as Record<string, unknown>;
      expect(source.requestId).toBeUndefined();
      expect(source.nativeWebSearch).toEqual({
        version: 1,
        requestId: original.id,
        bindingDigest: digest,
        dialect: 'openai-web-search',
      });
      expect(matchesModelRequestIdentity(source, original.id)).toBe(true);
      expect(matchesModelRequestIdentity({ ...source, requestId: original.id }, original.id)).toBe(
        false,
      );
      expect(matchesModelRequestIdentity(source, 'foreign')).toBe(false);
      expect(executions[0]!.result).toMatchObject({
        incomplete: true,
        nativeSearchRetrySafety: activity ? 'unsafe' : 'unknown',
      });
      const evidence = await f.runtime.readWebSearchEvidence({
        ...f.input,
        executionId: executions[0]!.id,
      });
      expect(evidence.blocks[0]!.status).toBe('outcome_unknown');
      expect(evidence.blocks[0]!.callId).toBe(activity ? 'ws-1' : executions[0]!.id);
    } finally {
      disconnect.resolve();
      server.closeAllConnections();
      server.close();
      await f.close();
    }
  });
}

test('A16 a disabled or changed owner cannot reuse private native continuation; ordinary assistant text is intact', () => {
  const msg: ModelRequest['messages'][number] = {
    role: 'assistant',
    content: 'public text',
    continuation: {
      kind: 'native_web_search_continuation',
      version: 1,
      bindingDigest: digest,
      value: { opaque: 'test' },
    },
  };
  expect(nativeSearchMessages([msg], digest)[0]!.continuation).toEqual({ opaque: 'test' });
  for (const binding of [undefined, 'b'.repeat(64)])
    expect(nativeSearchMessages([msg], binding)).toEqual([
      { role: 'assistant', content: 'public text' },
    ]);
});

for (const allowed of [false, true]) {
  test(`A17 independently checked native grant=${allowed}; unknown adapter capability cannot declare search`, async () => {
    const calls: ModelRequest[] = [];
    const f = await fixture(
      {
        nativeWebSearchCapability: () => (allowed ? 'unknown' : 'supported'),
        async *stream(request) {
          calls.push(request);
          yield { type: 'text_delta', text: 'plain' };
          yield finish;
        },
      },
      () => allowed,
    );
    try {
      await f.start();
      const view = await f.wait();
      expect(view.runs[0]?.status).toBe('completed');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.nativeWebSearch).toBeUndefined();
      expect(f.authorizations).toBe(allowed ? 0 : 1);
    } finally {
      await f.close();
    }
  });
}

test('A05 unconfirmed, failed, and incomplete native activities retain their own terminal outcomes', async () => {
  const f = await fixture({
    nativeWebSearchCapability: capability,
    async *stream() {
      for (const status of ['failed', 'incomplete', 'searching'] as const) {
        yield { type: 'web_search', observation: { kind: 'activity', callId: status, status } };
      }
      yield {
        type: 'web_search',
        observation: { kind: 'source', url: 'https://example.test/source' },
      };
      yield { type: 'text_delta', text: 'What is known' };
      yield finish;
    },
  });
  try {
    await f.start();
    const view = await f.wait();
    const evidence = await f.runtime.readWebSearchEvidence({
      ...f.input,
      executionId: view.executions.find((e) => e.kind === 'model')!.id,
    });
    expect(evidence.blocks.map((b) => [b.sourceScope ?? b.callId, b.status])).toEqual([
      ['failed', 'failed'],
      ['incomplete', 'incomplete'],
      ['searching', 'incomplete'],
      ['response', 'failed'],
    ]);
    expect(f.ordinaryCalls).toBe(0);
  } finally {
    await f.close();
  }
});

test('A06 a proved local pre-send failure retries under fresh authorization; no native evidence is invented', async () => {
  let attempts = 0;
  const f = await fixture({
    nativeWebSearchCapability: capability,
    async *stream() {
      if (++attempts === 1) throw new ModelAttemptError('connection_failed', undefined, 'safe');
      yield { type: 'text_delta', text: 'done' };
      yield finish;
    },
  });
  try {
    await f.start();
    const view = await f.wait();
    expect(attempts).toBe(2);
    expect(f.authorizations).toBe(2);
    expect(view.runs[0]!.status).toBe('completed');
    const first = view.executions.find((e) => e.kind === 'model')!;
    expect(first.result).toMatchObject({ nativeSearchRetrySafety: 'safe' });
    expect(
      (await f.runtime.readWebSearchEvidence({ ...f.input, executionId: first.id })).blocks,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test('A04/A16 after reopening the original SQLite profile a real Responses SDK request carries the native search once; denial strips it', async () => {
  type Row = Record<string, unknown>;
  const requests: { input: Row[]; tools: Row[] }[] = [];
  const urls = Array.from({ length: 65 }, (_, n) => `https://example.test/result/${n}`);
  const remote = (n: number) => ({
    id: `ws_cold_${n}`,
    type: 'web_search_call',
    status: 'completed',
    action: {
      type: 'search',
      query: 'owned source',
      sources: urls.slice(0, n === 1 ? 64 : 65).map((url) => ({ type: 'url', url })),
    },
  });
  const event = (type: string, data: Row) => `data: ${JSON.stringify({ type, ...data })}\n\n`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: Row[]; tools: Row[] };
      requests.push(body);
      const n = requests.length,
        pos = n <= 2 ? 1 : 0,
        text = n === 1 ? 'source one' : 'ack';
      const item = (stage: string, pos: number, value: Row) =>
        event(`response.output_item.${stage}`, { output_index: pos, item: value });
      const id = `msg_${n}`;
      const stream =
        event('response.created', {
          response: { id: `response_${n}`, model: 'gpt-6.2-astra', created_at: 1 },
        }) +
        (n <= 2
          ? item('added', 0, { type: 'web_search_call', id: remote(n).id, status: 'in_progress' }) +
            item('done', 0, remote(n))
          : '') +
        item('added', pos, { type: 'message', id }) +
        event('response.output_text.delta', {
          item_id: id,
          content_index: 0,
          output_index: pos,
          delta: text,
        }) +
        item('done', pos, {
          type: 'message',
          role: 'assistant',
          id,
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }) +
        event('response.completed', {
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const transport = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) !== 'https://api.openai.com/v1/responses')
        throw Error('unexpected_fixture_destination');
      return fetch(server.url, init);
    },
    { preconnect: fetch.preconnect },
  );
  const adapter = () =>
    createSdkModelAdapter({
      models: new Map([
        [
          'owned',
          createCompatibleModelBinding({
            name: 'openai',
            protocol: 'responses',
            baseURL: 'https://api.openai.com/v1',
            modelId: 'gpt-6.2-astra',
            apiKey: 'synthetic-local-fixture',
            fetch: transport,
          }),
        ],
      ]),
    });
  let allowed = true;
  const f = await fixture(adapter(), () => allowed);
  try {
    await f.start();
    const first = await f.wait();
    expect(first.runs[0]!.status).toBe('completed');
    await f.reopen(adapter());
    await f.start('cold');
    const second = await f.wait('cold');
    expect(second.runs.find((r) => r.originCommandId === 'cold')?.status).toBe('completed');
    allowed = false;
    await f.reopen(adapter());
    for (const [commandId, truncated] of [
      ['work', false],
      ['cold', true],
    ] as const) {
      const run = second.runs.find((r) => r.originCommandId === commandId)!;
      const execution = second.executions.find((e) => e.runId === run.id && e.kind === 'model')!;
      const evidence = await f.runtime.readWebSearchEvidence({
        ...f.input,
        executionId: execution.id,
      });
      const response = evidence.blocks.find((block) => block.sourceScope === 'response');
      expect(response?.status).toBe('completed');
      expect(response?.sources.map((source) => source.url)).toEqual(urls.slice(0, 64));
      expect(response?.truncated).toBe(truncated);
    }
    expect(requests).toHaveLength(2);
    await f.start('revoked');
    const third = await f.wait('revoked');
    expect(third.runs.find((r) => r.originCommandId === 'revoked')?.status).toBe('completed');
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.tools.filter((t) => t.type === 'web_search').length)).toEqual([
      1, 1, 0,
    ]);
    expect(requests.map((r) => r.input.filter((t) => t.type === 'web_search_call'))).toEqual([
      [],
      [remote(1)],
      [],
    ]);
    expect(JSON.stringify(requests[2]!.input)).toContain('source one');
    expect(f.ordinaryCalls).toBe(0);
  } finally {
    await server.stop(true);
    await f.close();
  }
}, 15000);

test('link-free truncation produces a response receipt only for observed native search', async () => {
  let searches = true;
  const model: ModelAdapter = {
    nativeWebSearchCapability: capability,
    async *stream() {
      if (searches) {
        yield {
          type: 'web_search',
          observation: { kind: 'activity', callId: 'ws', status: 'completed' },
        };
      }
      yield { type: 'text_delta', text: 'answer' };
      yield { ...finish, webSearchTruncated: true };
    },
  };
  const f = await fixture(model);
  try {
    for (const command of ['searched', 'plain']) {
      searches = command === 'searched';
      await f.start(command);
      const view = await f.wait(command);
      const run = view.runs.find((r) => r.originCommandId === command)!;
      expect(run.status).toBe('completed');
      const execution = view.executions.find((e) => e.runId === run.id && e.kind === 'model')!;
      const { blocks } = await f.runtime.readWebSearchEvidence({
        ...f.input,
        executionId: execution.id,
      });
      if (searches) {
        expect(blocks.find((b) => b.sourceScope === 'response')).toMatchObject({
          status: 'completed',
          sources: [],
          citations: [],
          truncated: true,
        });
      } else expect(blocks).toEqual([]);
    }
  } finally {
    await f.close();
  }
});

test('A12 concurrently searching child and independent Session keep identical provider call IDs and Model usage scoped to each execution', async () => {
  const childStarted = Promise.withResolvers<void>(),
    peerStarted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  async function* search(
    request: ModelRequest,
    owner: 'peer' | 'child',
  ): AsyncGenerator<ModelEvent> {
    expect(request.nativeWebSearch).toBeDefined();
    yield {
      type: 'web_search',
      observation: { kind: 'activity', callId: 'reused', status: 'searching', query: owner },
    };
    (owner === 'child' ? childStarted : peerStarted).resolve();
    await release.promise;
    yield {
      type: 'web_search',
      observation: { kind: 'activity', callId: 'reused', status: 'completed' },
    };
    yield { type: 'text_delta', text: `${owner} done` };
    yield {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: owner === 'child' ? 5 : 101, outputTokens: 1 },
    };
  }
  const child: ModelAdapter = {
    nativeWebSearchCapability: capability,
    stream(request) {
      return search(request, 'child');
    },
  };
  const f = await fixture(
    {
      nativeWebSearchCapability: capability,
      async *stream(request) {
        if (request.messages.some((m) => m.content === 'independent peer')) {
          yield* search(request, 'peer');
        } else if (!request.messages.some((m) => m.role === 'tool')) {
          yield {
            type: 'tool_call',
            name: request.tools.find((t) => t.description === 'Owned ordinary callable tool')!.id,
            id: 'spawn',
            arguments: '{}',
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'parent done' };
          yield finish;
        }
      },
    },
    () => true,
    child,
  );
  try {
    await f.runtime.createSession({
      ...f.input,
      sessionId: 'peer',
      commandId: 'create-peer',
      workspaceId: 'workspace',
      title: 'peer',
    });
    await f.start();
    await f.start('peer-command', 'peer', 'independent peer');
    await Promise.race([
      Promise.all([childStarted.promise, peerStarted.promise]),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('concurrent_search_missing')), 6000);
        timer.unref();
      }),
    ]);
    release.resolve();
    await Promise.all([f.runtime.waitForCommand('work'), f.runtime.waitForCommand('peer-command')]);
    for (const [sessionId, label, inputTokens] of [
      [f.childSessionId!, 'child', 5],
      ['peer', 'peer', 101],
    ] as const) {
      const view = await f.runtime.getView(sessionId);
      const model = view.executions.find((e) => e.kind === 'model' && e.sessionId === sessionId)!;
      expect(model.status).toBe('succeeded');
      expect(model.result).toMatchObject({ usage: { inputTokens, outputTokens: 1 } });
      const evidence = await f.runtime.readWebSearchEvidence({
        ...f.input,
        sessionId,
        executionId: model.id,
      });
      expect(evidence.blocks).toMatchObject([
        { callId: 'reused', query: label, status: 'completed' },
      ]);
      const other = sessionId === 'peer' ? f.childSessionId! : 'peer';
      expect(
        await f.runtime
          .readWebSearchEvidence({ ...f.input, sessionId: other, executionId: model.id })
          .catch((e) => e.code),
      ).toBe('web_search_evidence_unavailable');
    }
  } finally {
    release.resolve();
    await f.close();
  }
}, 15000);

test('A17 a configured child cannot enable server search when its parent has no native grant', async () => {
  const childWire: ModelRequest[] = [];
  const child: ModelAdapter = {
    nativeWebSearchCapability: capability,
    async *stream(request) {
      childWire.push(request);
      yield { type: 'text_delta', text: 'ordinary child' };
      yield finish;
    },
  };
  const f = await fixture(
    {
      nativeWebSearchCapability: capability,
      async *stream(request) {
        if (request.messages.some((m) => m.role === 'tool')) {
          yield { type: 'text_delta', text: 'finished' };
          yield finish;
        } else {
          yield { type: 'tool_call', name: 'web_search', id: 'spawn', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        }
      },
    },
    () => true,
    child,
    false,
  );
  try {
    await f.start();
    const view = await f.wait();
    expect(view.runs[0]!.status).toBe('completed');
    expect(childWire).toHaveLength(0);
    expect(
      view.executions.find((e) => e.kind === 'tool' && e.definitionId === 'ordinary')!.result,
    ).toMatchObject({ outcome: 'failed', content: 'child_web_search_scope_exceeds_parent' });
    expect(f.ordinaryCalls).toBe(1);
  } finally {
    await f.close();
  }
});
