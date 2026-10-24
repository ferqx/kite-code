import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { NativeCaller } from '../../electron/native-caller';
import type { NativeBridge } from '../../src/native-bridge';
import { NativeHistory } from '../../src/native-history';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error('native_incremental_http_timeout');
    await Bun.sleep(5);
  }
}

test('real Desktop Main/SDK/Service stream applies same-seq changes, recovers a severed SSE and cold reopens saved messages once', async () => {
  const root = temporaryDirectory('kite-native-incremental-http-');
  const profile = { dataRoot: join(root, 'data'), profile: 'isolated' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const second = barrier(),
    finish = barrier();
  let modelCalls = 0;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      modelCalls++;
      yield { type: 'text_delta', text: 'first saved chunk' };
      await second.waiting;
      await Bun.sleep(100);
      signal.throwIfAborted();
      yield { type: 'text_delta', text: ' then second saved chunk' };
      await finish.waiting;
      signal.throwIfAborted();
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: storeId },
    buildId: 'native-incremental-http',
    subjectId: 'owner',
  });
  const requests: { method: string; path: string }[] = [];
  let offline = false,
    stream: AbortController | undefined;
  const originalFetch = globalThis.fetch;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    if (path === '/v1/events') {
      if (offline) throw TypeError('isolated disconnected stream');
      stream = new AbortController();
      return originalFetch(request, { signal: AbortSignal.any([request.signal, stream.signal]) });
    }
    return originalFetch(request);
  }) as typeof fetch;
  globalThis.fetch = transport;
  const connect = async () => {
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['history', 'message_changes', 'events'],
      },
    });
    await client.connect();
    return client;
  };
  let caller: NativeCaller | undefined, reader: NativeHistory | undefined;
  const open = async (client: Awaited<ReturnType<typeof connect>>) => {
    const refresh = () =>
      queueMicrotask(() => {
        const state = caller?.state();
        if (state?.selection) reader?.select(state.generation, state.selection, state.historyEpoch);
      });
    caller = new NativeCaller(client, refresh);
    reader = new NativeHistory(
      { request: (request) => caller!.invoke(request) } as NativeBridge,
      () => {},
    );
    await caller.invoke({ method: 'attach' });
    await until(() => (caller!.state().environmentRevision ?? 0) > 0);
    await caller.invoke({ method: 'state', generation: 1 });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    refresh();
    await until(() => reader!.state.phase === 'complete');
  };
  try {
    const client = await connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'test',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'stream',
    });
    await open(client);
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'work',
      content: 'original input',
    });
    await until(() =>
      reader!.state.messages.some((message) => message.content === 'first saved chunk'),
    );
    const original = reader!.state.messages.find(
      (message) => message.content === 'first saved chunk',
    )!;
    const epoch = caller!.state().historyEpoch!;
    const fullReads = requests.filter((request) => request.path.endsWith('/messages')).length;
    offline = true;
    stream!.abort();
    second.release();
    await until(async () =>
      (await store.listMessages('s')).some((message) =>
        message.content.includes('second saved chunk'),
      ),
    );
    offline = false;
    await until(
      () =>
        caller!.state().historyEpoch! > epoch &&
        reader!.state.phase === 'complete' &&
        reader!.state.messages.some((message) => message.content.includes('second saved chunk')),
    );
    expect(caller!.state().historyEpoch).toBeGreaterThan(epoch);
    expect(requests.filter((request) => request.path.endsWith('/messages')).length).toBeGreaterThan(
      fullReads,
    );
    expect(reader!.state.messages.filter((message) => message.id === original.id)).toHaveLength(1);
    expect(reader!.state.messages.find((message) => message.id === original.id)?.seq).toBe(
      original.seq,
    );
    expect(requests.some((request) => request.path.endsWith('/message-changes'))).toBe(true);
    reader!.dispose();
    reader = undefined;
    await caller!.close();
    caller = undefined;
    await open(await connect());
    expect(reader!.state.messages.filter((message) => message.id === original.id)).toHaveLength(1);
    expect(reader!.state.messages.find((message) => message.id === original.id)?.content).toBe(
      'first saved chunk then second saved chunk',
    );
    finish.release();
    await until(() =>
      reader!.state.messages.some(
        (message) => message.id === original.id && message.status === 'complete',
      ),
    );
    const identities = (messages: { id: string; seq: string; content: string; status: string }[]) =>
      messages.map(({ id, seq, content, status }) => ({ id, seq, content, status }));
    expect(identities(reader!.state.messages)).toEqual(identities(await runtime.listMessages('s')));
    expect(modelCalls).toBe(1);
    expect(
      requests.filter((request) => request.method === 'POST' && request.path.endsWith('/commands')),
    ).toHaveLength(1);
  } finally {
    second.release();
    finish.release();
    reader?.dispose();
    await caller?.close();
    globalThis.fetch = originalFetch;
    await service.close();
  }
}, 20000);
