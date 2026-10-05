import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { type AgentClient, createClient, type ModelInputSnapshot } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { readModelDirectory } from '@kite-ai/ui';
import { type ModelOutputViewScope, NativeModelOutputReads } from '../electron/model-output-reads';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { NativeBridge, NativeState } from '../src/native-bridge';
import { createNativeModelInputPort, readNativeModelInput } from '../src/native-model-input';

const sha = (body: string) => createHash('sha256').update(body).digest('hex');
function snapshot(content: string): ModelInputSnapshot {
  const request = {
    messages: [{ content, role: 'user' as const, sourceIds: ['original-source'] }],
    modelId: 'fixed',
    requestId: 'e',
    tools: [],
  };
  const canonical = JSON.stringify(request);
  return {
    storeId: 'store',
    sessionId: 's',
    rootSessionId: 's',
    runId: 'r',
    executionId: 'e',
    originCommandId: 'cmd',
    rootWorkCommandId: 'cmd',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    confirmation: 'succeeded',
    bodyHash: sha(canonical),
    bodyBytes: String(Buffer.byteLength(canonical)),
    snapshotCursor: '1',
    metadata: {
      version: 1,
      adapter: { availability: 'unavailable', reason: 'not_recorded' },
      assembly: null,
      context: null,
      authorization: { availability: 'unavailable', reason: 'not_dispatched' },
    },
    request,
  };
}
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}
function fixture(value: ModelInputSnapshot) {
  let scope: ModelOutputViewScope | undefined = {
      generation: 1,
      selection: 1,
      storeId: 'store',
      sessionId: 's',
    },
    reads = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['model_inputs'] },
    async getModelInput() {
      reads++;
      return value;
    },
  } as unknown as AgentClient;
  const main = new NativeModelOutputReads(client, () => scope, 'modelInput');
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      decodeNativeRequest(request);
      if (request.method === 'modelInput.open') return main.open(request);
      if (request.method === 'modelInput.read') return main.read(request);
      if (request.method === 'modelInput.close') {
        main.close(request.readId);
        return null;
      }
      throw Error('unexpected_command');
    },
  };
  return {
    main,
    bridge,
    get reads() {
      return reads;
    },
    switch() {
      scope = { generation: 2, selection: 2, storeId: 'store', sessionId: 'other' };
      main.release();
    },
  };
}
test('input uses the existing finite body lease and public verifier: complete >17MiB bytes, original scope and at-most64KiB chunks', async () => {
  const content = `${'large original α '.repeat(1100000)}ORIGINAL INPUT COMPLETE TAIL`;
  expect(Buffer.byteLength(content)).toBeGreaterThan(17 * 1048576);
  const value = snapshot(content),
    f = fixture(value);
  let chunks = 0,
    max = 0;
  const bridge: NativeBridge = {
    watch: f.bridge.watch,
    async request(input) {
      const reply = await f.bridge.request(input);
      if (reply && 'data' in reply) {
        chunks++;
        max = Math.max(max, Buffer.from(reply.data, 'base64').length);
      }
      return reply;
    },
  };
  const result = await readNativeModelInput({
    bridge,
    generation: 1,
    expectedStoreId: 'store',
    sessionId: 's',
    executionId: 'e',
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.request.messages[0]!.content).toBe(content);
  expect(result.metadata).toEqual(value.metadata);
  expect(max).toBe(65536);
  expect(chunks).toBeGreaterThan(200);
  expect(f.reads).toBe(1);
  expect(() => f.main.read({ readId: 'old', offset: 0, limit: 1 })).toThrow(
    'model_input_read_missing',
  );
});
test('input identity, bad chunk offsets/hash, abort and late selection are local read failures; no mutation port exists', async () => {
  const f = fixture(snapshot('ORIGINAL'));
  const input = {
    bridge: f.bridge,
    generation: 1,
    expectedStoreId: 'store',
    sessionId: 's',
    executionId: 'e',
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  expect(await code(readNativeModelInput({ ...input, expectedStoreId: 'wrong' }))).toBe(
    'store_identity_mismatch',
  );
  expect(f.reads).toBe(0);
  const malicious: NativeBridge = {
    watch: f.bridge.watch,
    async request(request) {
      const reply = await f.bridge.request(request);
      return reply && 'data' in reply ? { ...reply, nextOffset: reply.nextOffset + 1 } : reply;
    },
  };
  expect(await code(readNativeModelInput({ ...input, bridge: malicious }))).toBe(
    'model_input_chunk_invalid',
  );
  const corrupted = fixture({ ...snapshot('ORIGINAL'), bodyHash: '0'.repeat(64) });
  expect(await code(readNativeModelInput({ ...input, bridge: corrupted.bridge }))).toBe(
    'model_input_hash_mismatch',
  );
  let release!: () => void, enter!: () => void;
  const ready = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const late = fixture(snapshot('ORIGINAL'));
  const bridge: NativeBridge = {
    watch: late.bridge.watch,
    async request(request) {
      const reply = await late.bridge.request(request);
      if (request.method === 'modelInput.open') {
        enter();
        await gate;
      }
      return reply;
    },
  };
  let current = true;
  const pending = code(readNativeModelInput({ ...input, bridge, isCurrent: () => current }));
  await ready;
  current = false;
  late.switch();
  release();
  expect(await pending).toBe('model_input_view_changed');
  expect(late.reads).toBe(1);
  const abort = new AbortController();
  abort.abort();
  expect(await code(readNativeModelInput({ ...input, signal: abort.signal }))).not.toBe('success');
  expect(f.reads).toBe(1);
  expect(() =>
    decodeNativeRequest({
      method: 'modelInputs.list',
      generation: 1,
      readId: 'x',
      sessionId: 's',
      expectedStoreId: 'store',
      limit: 201,
    }),
  ).toThrow('invalid_native_request');
});
test('actual Core fixed Adapter records 205 original requests; Native public SDK directory exhausts fixed upper through two pages with zero remote Provider', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-native-input-pages-')),
    profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const model = createFixedModel(Array.from({ length: 205 }, () => [finish]));
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-fixture' };
      },
    },
  });
  const host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'temporary' };
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'native-input-pages',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['model_inputs'] },
  });
  let caller: NativeCaller | undefined;
  try {
    await client.connect();
    await runtime.createWorkspace({
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
      expectedStoreId: storeId,
    });
    await runtime.createSession({
      commandId: 'create-s',
      sessionId: 's',
      workspaceId: 'w',
      title: 's',
      subjectId: 'owner',
      expectedStoreId: storeId,
    });
    for (let i = 0; i < 205; i++) {
      const commandId = `fixed-original-${i}`;
      await runtime.submitCommand({
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        expectedStoreId: storeId,
        request: { kind: 'run.start', content: `original-${i}` },
      });
      await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    }
    expect(model.requests).toHaveLength(205);
    caller = new NativeCaller(client, () => {});
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    const queries: { afterSeq?: string; upperSeq?: string }[] = [];
    const bridge: NativeBridge = {
      watch: () => () => {},
      async request(input) {
        if (input.method === 'modelInputs.list') queries.push(input);
        return caller!.invoke(input);
      },
    };
    const port = createNativeModelInputPort({
      bridge,
      generation,
      storeId,
      sessionId: 's',
      enabled: true,
      isCurrent: () => true,
    });
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const directory = await readModelDirectory(port, 's', storeId, new AbortController().signal);
    expect(directory).toHaveLength(205);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.upperSeq).toBeDefined();
    expect(BigInt(queries[1]!.afterSeq!)).toBeGreaterThan(0n);
    const last = await port.getModelInput!('s', directory[204]!.executionId, {});
    expect(last.request as unknown).toEqual(model.requests[204]!);
    expect(last.originCommandId).toBe('fixed-original-204');
    expect(last.confirmation).toBe('succeeded');
    expect(model.requests).toHaveLength(205);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await caller?.close();
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
