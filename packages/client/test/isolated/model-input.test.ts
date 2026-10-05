import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createClient, verifyModelInputSnapshot } from '../../src';
import { createBrowserClient } from '../../src/browser';
import { readModelInputResponse } from '../../src/model-input';

const pageIdentity = 'a'.repeat(64);
const profile = { dataRoot: '/fixed', name: 'test', accessKey: 'fixed' };
const serverInfo = {
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  profile,
  storeId: 'store',
  dataAvailability: 'available',
  capabilities: ['model_inputs'],
};
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function snapshot(content = 'Original α\0 end') {
  // Deliberate canonical key order, independent of the Client encoder.
  const request = {
    messages: [
      { content: 'Original system', role: 'system' as const },
      { content, role: 'user' as const, sourceIds: ['original-source'] },
    ],
    modelId: 'local',
    requestId: 'model',
    tools: [
      {
        definitionVersion: 'old',
        description: 'Original tool',
        id: 'tool',
        inputSchema: {
          properties: { data: { description: content, type: 'string' } },
          type: 'object',
        },
      },
    ],
  };
  const original = JSON.stringify(request);
  return {
    storeId: 'store',
    sessionId: 'session',
    rootSessionId: 'session',
    runId: 'run',
    executionId: 'model',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '9007199254740993',
    attempt: 1,
    status: 'succeeded',
    confirmation: 'succeeded',
    bodyHash: sha(original),
    bodyBytes: String(Buffer.byteLength(original)),
    snapshotCursor: '9223372036854775807',
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

test('public input verifier freezes its own complete bytes against alias mutation, rejects invalid original proof and honors abort', async () => {
  const value = snapshot();
  const verified = verifyModelInputSnapshot(value);
  value.request.messages[1]!.content = 'changed while digest was pending';
  const result = await verified;
  expect(result.request.messages[1]!.content).toBe('Original α\0 end');
  expect(result).not.toBe(value);
  for (const changed of [
    { ...snapshot(), bodyHash: '0'.repeat(64) },
    { ...snapshot(), rootWorkSeq: '9223372036854775808' },
    { ...snapshot(), executionId: 'other' },
    { ...snapshot(), confirmation: 'unconfirmed' },
  ]) {
    const error = await verifyModelInputSnapshot(changed).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeDefined();
  }
  const controller = new AbortController();
  controller.abort(new Error('view ended'));
  expect(
    await verifyModelInputSnapshot(snapshot(), controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toBe(controller.signal.reason);
});

function fixture(read: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(request.clone());
      const path = new URL(request.url).pathname;
      if (path.endsWith('/server'))
        return new Response(
          JSON.stringify(
            path.startsWith('/browser/') ? { ...serverInfo, pageIdentity } : serverInfo,
          ),
          { headers: { 'x-kite-web-identity': pageIdentity } },
        );
      return read(request);
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const native = createClient({
    endpoint,
    token: 'native-only',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['model_inputs'] },
    maxResponseBytes: 1024,
  });
  const browser = createBrowserClient({ origin: endpoint, pageIdentity, maxResponseBytes: 1024 });
  return {
    native,
    browser,
    requests,
    async close() {
      native.disposeNetwork();
      browser.disposeNetwork();
      await server.stop(true);
    },
  };
}

function body(value: unknown, change: { size?: string; hash?: string; truncate?: boolean } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return new Response(change.truncate ? bytes.subarray(0, bytes.length - 1) : bytes, {
    headers: {
      'content-type': 'application/json',
      'x-kite-web-identity': pageIdentity,
      'x-model-input-size': change.size ?? String(bytes.length),
      'x-model-input-hash': change.hash ?? sha(bytes),
    },
  });
}

test('malformed size metadata cancels an unconsumed body before releasing its network owner', async () => {
  for (const size of ['01', '-1', '9223372036854775808', '']) {
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      }),
      {
        headers: {
          'content-type': 'application/json',
          'x-model-input-size': size,
          'x-model-input-hash': 'a'.repeat(64),
        },
      },
    );
    await expect(readModelInputResponse(response, new AbortController().signal)).rejects.toThrow(
      'model_input_metadata_invalid',
    );
    expect(cancelled).toBe(1);
    expect(response.body!.locked).toBe(false);
  }
});

test('real Native and Cookie-only reads verify complete original messages/schema beyond the ordinary JSON budget', async () => {
  const content = `BEGIN α${'x'.repeat(17 * 1024 * 1024)}\0 END`;
  const original = snapshot(content);
  const f = fixture(() => body(original));
  try {
    await f.native.connect();
    await f.browser.connect();
    for (const client of [f.native, f.browser]) {
      const read = await client.getModelInput('session', 'model');
      expect(read.request).toEqual(original.request);
      expect(read.bodyHash).toBe(original.bodyHash);
      expect(read.rootWorkSeq).toBe('9007199254740993');
      expect(read.request.messages[1]!.content.endsWith('\0 END')).toBe(true);
      expect(read.request.tools[0]!.inputSchema).toEqual(original.request.tools[0]!.inputSchema);
    }
    expect(f.native.lastAppliedCursor).toBeUndefined();
    const browserRead = f.requests.find((request) =>
      request.url.includes('/browser/v1/sessions/'),
    )!;
    expect(browserRead.headers.has('authorization')).toBe(false);
    expect(new URL(browserRead.url).searchParams.has('storeId')).toBe(false);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    await f.close();
  }
}, 20000);

test('truncated, corrupt, foreign and unconfirmed-inconsistent snapshots fail without publishing a partial request', async () => {
  const cases = [
    { value: snapshot(), change: { truncate: true }, code: 'model_input_incomplete' },
    { value: snapshot(), change: { hash: 'b'.repeat(64) }, code: 'model_input_hash_mismatch' },
    { value: { ...snapshot(), bodyHash: 'b'.repeat(64) }, code: 'model_input_hash_mismatch' },
    { value: { ...snapshot(), bodyBytes: '1' }, code: 'model_input_hash_mismatch' },
    { value: { ...snapshot(), storeId: 'foreign' }, code: 'model_input_identity_mismatch' },
    { value: { ...snapshot(), sessionId: 'foreign' }, code: 'model_input_identity_mismatch' },
    { value: { ...snapshot(), confirmation: 'unconfirmed' }, code: 'model_input_hash_mismatch' },
  ];
  for (const sample of cases) {
    const f = fixture(() => body(sample.value, sample.change));
    try {
      await f.browser.connect();
      await expect(f.browser.getModelInput('session', 'model')).rejects.toThrow(sample.code);
      expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally {
      await f.close();
    }
  }
});

test('pending wire reads are released locally and a prepared original request stays unconfirmed', async () => {
  let entered = false;
  const original = { ...snapshot(), status: 'planned', confirmation: 'unconfirmed' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async () => {
    entered = true;
    await gate;
    return body(original);
  });
  try {
    await f.native.connect();
    const abort = new AbortController();
    const pending = f.native.getModelInput('session', 'model', { signal: abort.signal });
    const rejected = pending.catch((error: unknown) => error);
    const deadline = Date.now() + 3000;
    while (!entered) {
      if (Date.now() > deadline) throw new Error('wire_read_deadline');
      await Bun.sleep(1);
    }
    abort.abort();
    expect(await rejected).toBeInstanceOf(Error);
    release();
    expect((await f.native.getModelInput('session', 'model')).confirmation).toBe('unconfirmed');
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    release();
    await f.close();
  }
});

test('abort and Browser disposal reject a large response while its producer is stalled after the first wire chunk', async () => {
  for (const mode of ['native-abort', 'browser-dispose'] as const) {
    const bytes = Buffer.from(
      JSON.stringify(snapshot(`START ${'x'.repeat(17 * 1024 * 1024)} END`)),
    );
    let entered = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(() => {
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset === 0) {
              controller.enqueue(bytes.subarray(0, 65536));
              offset = 65536;
              entered = true;
              return;
            }
            await gate;
            if (offset === bytes.length) controller.close();
            else {
              controller.enqueue(bytes.subarray(offset));
              offset = bytes.length;
            }
          },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'x-kite-web-identity': pageIdentity,
            'x-model-input-size': String(bytes.length),
            'x-model-input-hash': sha(bytes),
          },
        },
      );
    });
    try {
      const selected = mode === 'native-abort' ? f.native : f.browser;
      await selected.connect();
      const abort = new AbortController();
      const pending = selected.getModelInput('session', 'model', { signal: abort.signal });
      const rejected = pending.catch((error: unknown) => error);
      const deadline = Date.now() + 3000;
      while (!entered) {
        if (Date.now() > deadline) throw new Error('first_wire_chunk_deadline');
        await Bun.sleep(1);
      }
      if (mode === 'native-abort') abort.abort();
      else f.browser.disposeNetwork();
      const result = await Promise.race([
        rejected,
        Bun.sleep(1000).then(() => 'read_did_not_release'),
      ]);
      expect(result).toBeInstanceOf(Error);
      expect(f.requests).toHaveLength(2);
      expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(f.native.lastAppliedCursor).toBeUndefined();
    } finally {
      release();
      await f.close();
    }
  }
}, 10000);

test('directory bounds and exact Session identity are checked before publishing a history page', async () => {
  const page = {
    storeId: 'store',
    sessionId: 'session',
    rootSessionId: 'session',
    highWaterSeq: '9007199254740993',
    upperSeq: '9007199254740993',
    snapshotCursor: '9223372036854775807',
    nextAfterSeq: null,
    items: [
      {
        seq: '9007199254740993',
        executionId: 'model',
        sessionId: 'session',
        runId: 'run',
        originCommandId: 'command',
        rootWorkCommandId: 'command',
        rootWorkSeq: '9007199254740993',
        attempt: 1,
        status: 'succeeded',
        confirmation: 'succeeded',
        modelId: 'local',
      },
    ],
  };
  let selected = page;
  const f = fixture(
    () =>
      new Response(JSON.stringify(selected), {
        headers: { 'x-kite-web-identity': pageIdentity },
      }),
  );
  try {
    await f.browser.connect();
    const options = { upperSeq: '9007199254740993' };
    expect((await f.browser.listModelInputs('session', options)).items[0]!.seq).toBe(
      options.upperSeq,
    );
    selected = { ...page, items: [] };
    expect((await f.browser.listModelInputs('session', options)).upperSeq).toBe(options.upperSeq);
    const before = f.requests.length;
    expect(() => f.browser.listModelInputs('session', { afterSeq: '01' })).toThrow();
    expect(() => f.browser.listModelInputs('session', { storeId: 'forged' } as never)).toThrow();
    expect(f.requests).toHaveLength(before);
    selected = { ...selected, sessionId: 'foreign' };
    await expect(f.browser.listModelInputs('session')).rejects.toThrow(
      'model_input_identity_mismatch',
    );
    selected = { ...selected, sessionId: 'session', upperSeq: '9007199254740992' };
    await expect(f.browser.listModelInputs('session', options)).rejects.toThrow(
      'invalid_page_bounds',
    );
  } finally {
    await f.close();
  }
});
