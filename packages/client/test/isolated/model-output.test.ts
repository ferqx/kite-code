import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createClient, verifyModelOutputSnapshot } from '../../src';
import { createBrowserClient } from '../../src/browser';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pageIdentity = 'a'.repeat(64);
const profile = { dataRoot: '/owned', name: 'new', accessKey: 'owned' };
const info = {
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  profile,
  storeId: 'store',
  dataAvailability: 'available',
  capabilities: ['model_outputs'],
};
function snapshot(complete = true) {
  const output = {
    complete,
    content: `FULL α\0${'x'.repeat(64 * 1024)}END`,
    reasoning: 'Original reasoning',
    toolCalls: complete ? [{ arguments: '{"data":"actual"}', id: 'call', name: 'tool' }] : [],
  };
  const bytes = JSON.stringify(output);
  return {
    storeId: 'store',
    sessionId: 's',
    rootSessionId: 's',
    runId: 'run',
    executionId: 'model',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '9007199254740993',
    attempt: 1,
    status: complete ? 'succeeded' : 'cancelled',
    snapshotCursor: '9223372036854775807',
    contentBytes: String(Buffer.byteLength(output.content)),
    reasoningBytes: String(Buffer.byteLength(output.reasoning)),
    bodyHash: sha(bytes),
    bodyBytes: String(Buffer.byteLength(bytes)),
    output,
  };
}

test('public output verifier preserves only the verified original copy while caller aliases change', async () => {
  const value = snapshot();
  const content = value.output.content;
  const reading = verifyModelOutputSnapshot(value);
  value.output.content = 'different body';
  const verified = await reading;
  expect(verified.output.content).toBe(content);
  expect(verified).not.toBe(value);
  const error = await verifyModelOutputSnapshot({
    ...snapshot(),
    snapshotCursor: '9223372036854775808',
  }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeDefined();
});
function wire(value: unknown, change: { hash?: string; truncate?: boolean } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return new Response(change.truncate ? bytes.subarray(0, bytes.length - 1) : bytes, {
    headers: {
      'content-type': 'application/json',
      'x-kite-web-identity': pageIdentity,
      'x-model-output-size': String(bytes.length),
      'x-model-output-hash': change.hash ?? sha(bytes),
    },
  });
}
function fixture(read: () => Response) {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push(request.clone());
      if (new URL(request.url).pathname.endsWith('/server'))
        return new Response(JSON.stringify({ ...info, pageIdentity }), {
          headers: { 'x-kite-web-identity': pageIdentity },
        });
      return read();
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const native = createClient({
    endpoint,
    token: 'native-only',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['model_outputs'] },
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

test('Native and Cookie Model output readers verify full text, reasoning and calls beyond their ordinary JSON budget, preserving incomplete prefixes', async () => {
  let selected = snapshot();
  const f = fixture(() => wire(selected));
  try {
    await f.native.connect();
    await f.browser.connect();
    for (const client of [f.native, f.browser]) {
      const full = await client.getModelOutput('s', 'model');
      expect(full.output).toEqual(selected.output);
      expect(full.rootWorkSeq).toBe('9007199254740993');
      expect(full.output.content.endsWith('END')).toBe(true);
    }
    selected = snapshot(false);
    const prefix = await f.browser.getModelOutput('s', 'model');
    expect(prefix.output.complete).toBe(false);
    expect(prefix.output.toolCalls).toEqual([]);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    const cookieRead = f.requests.find((request) => request.url.includes('/browser/v1/sessions/'))!;
    expect(cookieRead.headers.has('authorization')).toBe(false);
    expect(new URL(cookieRead.url).searchParams.has('storeId')).toBe(false);
    expect(f.native.lastAppliedCursor).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('bad wire EOF, body hash, byte accounting, completion or exact identity never publishes a Model output', async () => {
  const full = snapshot();
  const cases = [
    { value: full, wire: { truncate: true }, code: 'model_output_incomplete' },
    { value: full, wire: { hash: 'b'.repeat(64) }, code: 'model_output_hash_mismatch' },
    { value: { ...full, bodyHash: 'b'.repeat(64) }, code: 'model_output_hash_mismatch' },
    { value: { ...full, contentBytes: '1' }, code: 'model_output_hash_mismatch' },
    { value: { ...full, status: 'cancelled' }, code: 'model_output_hash_mismatch' },
    { value: { ...full, storeId: 'foreign' }, code: 'model_output_identity_mismatch' },
    { value: { ...full, sessionId: 'foreign' }, code: 'model_output_identity_mismatch' },
    { value: { ...full, executionId: 'foreign' }, code: 'model_output_identity_mismatch' },
  ];
  for (const sample of cases) {
    const f = fixture(() => wire(sample.value, sample.wire));
    try {
      await f.browser.connect();
      await expect(f.browser.getModelOutput('s', 'model')).rejects.toThrow(sample.code);
      expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally {
      await f.close();
    }
  }
});

test('local cancellation releases an in-flight Model output response and issues no execution cancellation', async () => {
  const bytes = Buffer.from(JSON.stringify(snapshot()));
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(() => {
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            entered = true;
            controller.enqueue(bytes.subarray(0, 100));
            return;
          }
          await gate;
          controller.enqueue(bytes.subarray(100));
          controller.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/json',
          'x-kite-web-identity': pageIdentity,
          'x-model-output-size': String(bytes.length),
          'x-model-output-hash': sha(bytes),
        },
      },
    );
  });
  try {
    await f.native.connect();
    const abort = new AbortController();
    const pending = f.native
      .getModelOutput('s', 'model', { signal: abort.signal })
      .catch((error) => error);
    const deadline = Date.now() + 3000;
    while (!entered) {
      if (Date.now() > deadline) throw Error('output_wire_deadline');
      await Bun.sleep(1);
    }
    abort.abort();
    expect(
      await Promise.race([pending, Bun.sleep(1000).then(() => 'not_released')]),
    ).toBeInstanceOf(Error);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    release();
    await f.close();
  }
});
