import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
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
  const artifacts = createArtifactStore({ profile, store });
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
  let artifactObserved = false;
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
    const observe = client.observe.bind(client);
    client.observe = (options) =>
      observe({
        ...options,
        async onChange(change) {
          await options.onChange(change);
          if (change.type === 'artifact.published' && change.objectId === 'isolated-observed-ref')
            artifactObserved = true;
        },
      });
    return client;
  };
  let caller: NativeCaller | undefined, reader: NativeHistory | undefined;
  const open = async (client: Awaited<ReturnType<typeof connect>>) => {
    const refresh = () =>
      queueMicrotask(() => {
        const state = caller?.state();
        if (state?.selection) reader?.select(state.generation, state.selection, state.historyEpoch);
      });
    caller = new NativeCaller(client, (event) => {
      if (event.kind === 'messages.changed') reader?.advance(event);
      else if (event.kind === 'changed') refresh();
    });
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
    await until(() => caller!.state().selection?.viewLoading !== true);
    await Bun.sleep(120);
    const passiveStart = requests.length;
    await artifacts.publish({
      expectedStoreId: storeId,
      refId: 'isolated-observed-ref',
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session', id: 's' },
      mediaType: 'application/octet-stream',
      content: new Uint8Array([1, 2, 3]),
    });
    await until(() => artifactObserved);
    await Bun.sleep(120);
    expect(requests.slice(passiveStart).map(({ path }) => path)).toEqual([]);
    expect(reader!.state.messages.find((message) => message.id === original.id)).toBe(original);
    expect(caller!.state().selection?.viewLoading).not.toBe(true);
    const epoch = caller!.state().historyEpoch!;
    const fullReads = requests.filter((request) => request.path.endsWith('/messages')).length;
    const streamsBeforeLoss = requests.filter((request) => request.path === '/v1/events').length;
    const mutationsBeforeLoss = requests.filter((request) => request.method === 'POST').length;
    offline = true;
    stream!.abort();
    // The real SDK must expose transport loss to Main before any successful
    // reconnect. Healthy ordinary HTTP reads do not keep the old stream fresh.
    await until(
      () =>
        caller!.state().historyEpoch! > epoch &&
        caller!.state().selection?.permissionUnavailable === true,
    );
    expect(caller!.state().historyEpoch).toBeGreaterThan(epoch);
    expect(caller!.state().executionObservation?.phase).not.toBe('fresh');
    expect(caller!.state().backgroundUnavailable).toBe(true);
    await until(
      () => requests.filter((request) => request.path === '/v1/events').length > streamsBeforeLoss,
    );
    // A fresh HTTP baseline before ready must neither revive admission nor
    // reconcile the selected Session as an implicit activation.
    expect(caller!.state().selection?.permissionUnavailable).toBe(true);
    expect(caller!.state().executionObservation?.phase).not.toBe('fresh');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
      mutationsBeforeLoss,
    );
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
    // Settings / scheduled-task pages retain Main selection but close history.
    // A second real transport loss must not wait for an absent renderer EOF.
    const hiddenEpoch = caller!.state().historyEpoch!;
    const hiddenReads = requests.filter((request) => request.path.endsWith('/messages')).length;
    stream!.abort();
    await until(() => caller!.state().historyEpoch! > hiddenEpoch);
    await until(
      () =>
        !caller!.state().backgroundUnavailable && !caller!.state().selection?.permissionUnavailable,
    );
    finish.release();
    await until(() => {
      const observation = caller!.state().executionObservation;
      return (
        observation?.phase === 'fresh' && observation.runs.some((run) => run.status === 'completed')
      );
    });
    expect(requests.filter((request) => request.path.endsWith('/messages'))).toHaveLength(
      hiddenReads,
    );
    expect(caller!.state().executionObservation?.phase).toBe('fresh');
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
    expect(requests.some(({ path }) => path === '/v1/sessions/s/state')).toBe(true);
    expect(requests.some(({ path }) => path === '/v1/sessions/s/view')).toBe(false);
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
    await artifacts.close();
    await service.close();
  }
}, 20000);

test('real SQLite and Native HTTP reads a continuous long history and opens a legacy large body by original chunks', async () => {
  const root = temporaryDirectory('kite-native-continuous-http-');
  const profile = { dataRoot: join(root, 'data'), profile: 'isolated' };
  let store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  await store.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 'long',
    workspaceId: 'w',
    title: 'Long',
  });
  await store.close();
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
  const legacy = `${'长🙂\n'.repeat(720_000)}complete original tail`;
  db.transaction(() => {
    const insert = db.query(
      "INSERT INTO message(id,session_id,seq,role,status,source_json) VALUES(?,'long',?,'user','complete',?)",
    );
    for (let index = 2; index <= 5002; index++)
      insert.run(
        `saved-${index}`,
        index,
        JSON.stringify({ content: index === 5001 ? legacy : `message ${index}` }),
      );
    db.query("UPDATE session SET next_seq=5002 WHERE id='long'").run();
  })();
  db.close();
  store = await openSqliteStore(profile);
  const runtime = createRuntime({
    store,
    modelId: 'unused',
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'read-only-fixture' };
      },
    },
    model: {
      stream() {
        throw Error('Unexpected Model request');
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: storeId },
    buildId: 'native-continuous-http',
    subjectId: 'owner',
  });
  let caller: NativeCaller | undefined;
  let reader: NativeHistory | undefined;
  try {
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['session_state', 'message_changes'],
      },
    });
    await client.connect();
    caller = new NativeCaller(client, () => {});
    await caller.invoke({ method: 'attach' });
    const state = await caller.invoke({ method: 'select', generation: 1, sessionId: 'long' });
    if (!state || !('generation' in state) || !state.selection) throw Error('Expected selection');
    const selection = state.selection;
    expect(selection.canReadHistoryPreviews).toBe(true);
    const requested: string[] = [];
    reader = new NativeHistory(
      {
        request(request) {
          if (request.method === 'messages') {
            requested.push(request.afterSeq!);
            expect(request.previews).toBe(true);
          }
          return caller!.invoke(request);
        },
      } as NativeBridge,
      () => {},
    );
    reader.select(1, selection, state.historyEpoch);
    await until(() => reader!.state.phase === 'complete');
    expect(reader.state.messages).toHaveLength(5_001);
    expect(reader.state.messages[0]?.id).toBe('saved-2');
    expect(reader.state.messages.at(-1)?.id).toBe('saved-5002');
    expect(requested[0]).toBe('0');
    expect(requested.length).toBeGreaterThan(25);
    const large = reader.state.messages.find((message) => message.id === 'saved-5001')!;
    expect(large.deferredText).toEqual({
      bytes: String(Buffer.byteLength(legacy)),
      sha256: createHash('sha256').update(legacy).digest('hex'),
    });
    expect(large.content.length).toBeLessThan(2049);
    const chunks: Buffer[] = [];
    let offset = '0';
    do {
      const chunk = await caller.invoke({
        method: 'messages.text',
        generation: 1,
        viewSelection: selection.viewSelection!,
        historyEpoch: state.historyEpoch ?? 0,
        messageId: large.id,
        offset,
      });
      if (!chunk || !('sha256' in chunk) || chunk.kind !== 'messages.text')
        throw Error('Expected original text chunk');
      chunks.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
    } while (offset !== large.deferredText!.bytes);
    expect(Buffer.concat(chunks).toString()).toBe(legacy);
    expect((await client.getSessionState('long')).messages).toEqual([]);
    const retained = reader.state.messages[0];
    // Rebuild under a new epoch while keeping the full previous reading.
    reader.close();
    reader.select(1, selection, (state.historyEpoch ?? 0) + 1);
    expect(reader.state.messages).toHaveLength(5_001);
    expect(reader.state.messages[0]).toBe(retained);
    await until(() => reader!.state.phase === 'complete');
    expect(reader.state.messages).toHaveLength(5_001);
    expect(reader.state.messages[0]).toBe(retained);
  } finally {
    reader?.dispose();
    await caller?.close();
    await service.close();
  }
}, 45_000);
