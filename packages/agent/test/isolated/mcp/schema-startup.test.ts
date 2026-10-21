import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';

// Process-isolated observers delegate original bytes and digest results unchanged.
const nativeFS = { ...fs };
const nativeRead = fs.readFile;
let held: { entered(): void; wait: Promise<void> } | undefined;
mock.module('node:fs/promises', () => ({
  ...nativeFS,
  async readFile(...args: Parameters<typeof fs.readFile>) {
    const bytes = await nativeRead(...args);
    if (held && String(args[0]).endsWith('/mcp/schema-worker.js')) {
      const lease = held;
      lease.entered();
      await lease.wait;
    }
    return bytes;
  },
}));
const NativeWorker = globalThis.Worker;
let created = 0;
globalThis.Worker = class extends NativeWorker {
  constructor(...args: ConstructorParameters<typeof NativeWorker>) {
    super(...args);
    created++;
  }
};
afterAll(() => {
  globalThis.Worker = NativeWorker;
  mock.module('node:fs/promises', () => nativeFS);
});
const { createMcpSchemaValidation } = await import('../../../src/mcp/schema-validation');
function delay() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  held = { entered: enter, wait };
  return { entered, release };
}
const capture = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

for (const boundary of ['abort', 'timeout'] as const) {
  test(`schema startup ${boundary} seals shared asset preparation, waits real IO, and never starts its Worker`, async () => {
    const gate = delay();
    const validation = createMcpSchemaValidation(
      [{ input: { type: 'object' } }],
      boundary === 'timeout' ? 20 : 10000,
    );
    const abort = new AbortController();
    const before = created;
    let firstSettled = false;
    let peerSettled = false;
    const first = capture(validation.prepare(abort.signal)).then((result) => {
      firstSettled = true;
      return result;
    });
    const peer = capture(validation.prepare()).then((result) => {
      peerSettled = true;
      return result;
    });
    try {
      await gate.entered;
      if (boundary === 'abort') abort.abort(new Error('owned_start_cancel'));
      await Bun.sleep(35);
      console.log(
        'schema-startup-held',
        JSON.stringify({ boundary, firstSettled, peerSettled, createdWorkers: created - before }),
      );
      expect(firstSettled).toBe(false);
      expect(peerSettled).toBe(false);
      expect(created).toBe(before);
      gate.release();
      const results = await Promise.all([first, peer]);
      expect(results[0]!.error).toMatchObject({
        code: boundary === 'abort' ? 'mcp_cancelled_before_call' : 'mcp_admission_rejected',
      });
      expect(results[1]!.error).toMatchObject({
        code: boundary === 'abort' ? 'mcp_catalogue_stale' : 'mcp_admission_rejected',
      });
      expect(created).toBe(before);
      const cancelledStartupCreatedWorkers = created - before;
      held = undefined;
      // A new call may start pure computation only after the retired startup IO settled.
      if (boundary === 'abort') {
        await validation.prepare();
        expect(created).toBe(before + 1);
      }
      console.log(
        'schema-startup-control',
        JSON.stringify({ boundary, firstSettled, peerSettled, cancelledStartupCreatedWorkers }),
      );
    } finally {
      gate.release();
      held = undefined;
      await Promise.all([first, peer]);
      await validation.close();
    }
  });
}

test('schema close seals asset preparation immediately and joins the original actual read before returning', async () => {
  const gate = delay();
  const validation = createMcpSchemaValidation([{ input: { type: 'object' } }], 10000);
  const before = created;
  let settled = false;
  let closed = false;
  const pending = capture(validation.prepare()).then((result) => {
    settled = true;
    return result;
  });
  let closing: Promise<void> | undefined;
  try {
    await gate.entered;
    closing = validation.close().then(() => {
      closed = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    expect(created).toBe(before);
    gate.release();
    expect((await pending).error).toMatchObject({ code: 'mcp_catalogue_stale' });
    await closing;
    expect(closed).toBe(true);
    expect(created).toBe(before);
    console.log(
      'schema-startup-control',
      JSON.stringify({ boundary: 'close', settled, closed, createdWorkers: created - before }),
    );
  } finally {
    gate.release();
    held = undefined;
    await pending;
    await closing;
    await validation.close();
  }
});

test('schema deadline includes the actual asset hash and cannot create a Worker after a delayed digest completes', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const observer = spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const actual = await digest(...args);
    entered();
    await gate;
    return actual;
  });
  const validation = createMcpSchemaValidation([{ input: { type: 'object' } }], 1000);
  const before = created;
  let settled = false;
  const pending = capture(validation.prepare()).then((result) => {
    settled = true;
    return result;
  });
  try {
    await started;
    await Bun.sleep(1100);
    expect(settled).toBe(false);
    expect(created).toBe(before);
    release();
    expect((await pending).error).toMatchObject({ code: 'mcp_admission_rejected' });
    expect(created).toBe(before);
    console.log(
      'schema-startup-control',
      JSON.stringify({ boundary: 'hash-deadline', settled, createdWorkers: created - before }),
    );
  } finally {
    release();
    observer.mockRestore();
    await pending;
    await validation.close();
  }
});
