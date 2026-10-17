import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { openSqliteStore } from '../../../src/sqlite';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-artifact-pressure-')));
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'w',
  });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 's',
  });
  const input = {
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session' as const, id: 's' },
    mediaType: 'text/plain',
  };
  return {
    root,
    profile,
    store,
    artifacts,
    input,
    async close() {
      await artifacts.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('more than 64 pending publications wait with eight active sources and publish once each', async () => {
  const f = await fixture();
  const held = gate();
  const eight = gate();
  let active = 0;
  let peak = 0;
  let starts = 0;
  const outcomes = Promise.allSettled(
    Array.from({ length: 104 }, (_, index) =>
      f.artifacts.publishStream({
        ...f.input,
        refId: `p-${index}`,
        content: (async function* () {
          active++;
          starts++;
          peak = Math.max(peak, active);
          if (active === 8) eight.release();
          try {
            await held.promise;
            yield Buffer.from(`body-${index}`);
          } finally {
            active--;
          }
        })(),
      }),
    ),
  );
  try {
    await eight.promise;
    expect(starts).toBe(8);
    held.release();
    const settled = await outcomes;
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(starts).toBe(104);
    expect(peak).toBe(8);
    for (const index of [0, 71, 103]) {
      const content = await f.artifacts.read({ ...f.input, refId: `p-${index}` });
      expect(Buffer.from(content).toString()).toBe(`body-${index}`);
    }
  } finally {
    held.release();
    await outcomes;
    await f.close();
  }
}, 10000);

test('payload overflow seals original bytes without copying another large buffer, supports cancellation and cold reads', async () => {
  const f = await fixture();
  const held = gate();
  const active = Array.from({ length: 8 }, (_, index) =>
    f.artifacts.publishStream({
      ...f.input,
      refId: `held-${index}`,
      content: (async function* () {
        await held.promise;
        yield Buffer.from('held');
      })(),
    }),
  );
  const original = new Uint8Array(10 * 1024 * 1024).fill(65);
  const queued = f.artifacts.publish({ ...f.input, refId: 'queued-large', content: original });
  original.fill(66);
  const spilled = new Uint8Array(7 * 1024 * 1024).fill(67);
  const pendingInput = {
    ...f.input,
    scope: { ...f.input.scope },
    refId: 'spilled',
    content: spilled,
  };
  const pending = f.artifacts.publish(pendingInput);
  pendingInput.scope.id = 'other';
  pendingInput.subjectId = 'other';
  pendingInput.refId = 'mutated';
  spilled.fill(68);
  const abort = new AbortController();
  const reason = new Error('cancel snapshot');
  const cancelled = f.artifacts
    .publish({
      ...f.input,
      refId: 'cancelled',
      content: new Uint8Array(7 * 1024 * 1024),
      signal: abort.signal,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  try {
    abort.abort(reason);
    expect(await cancelled).toBe(reason);
    held.release();
    await Promise.all([...active, queued, pending]);
    for (const [refId, value, size] of [
      ['queued-large', 65, 10 * 1024 * 1024],
      ['spilled', 67, 7 * 1024 * 1024],
    ] as const) {
      const content = await f.artifacts.read({ ...f.input, refId });
      expect(content.byteLength).toBe(size);
      expect(content.every((byte) => byte === value)).toBe(true);
    }
    expect(await f.store.getArtifactReference({ ...f.input, refId: 'cancelled' })).toBeNull();
    await f.artifacts.close();
    const cold = createArtifactStore({ profile: f.profile, store: f.store });
    try {
      expect((await cold.read({ ...f.input, refId: 'spilled' }))[0]).toBe(67);
    } finally {
      await cold.close();
    }
    const { readdirSync } = await import('node:fs');
    expect(
      readdirSync(join(f.root, 'test', 'blobs')).filter((name) => name.startsWith('.publish-')),
    ).toEqual([]);
  } finally {
    held.release();
    await Promise.allSettled([...active, queued, pending, cancelled]);
    await f.close();
  }
}, 10000);

test('read overflow waits beyond 32 tickets, can cancel before lookup, and preserves publication progress', async () => {
  const f = await fixture();
  const reference = await f.artifacts.publish({
    ...f.input,
    refId: 'original',
    content: Buffer.from('full body'),
  });
  const streams = Array.from({ length: 6 }, () =>
    f.artifacts.readStream({ ...f.input, refId: reference.id })[Symbol.asyncIterator](),
  );
  const abort = new AbortController();
  const reason = new Error('cancel overflow read');
  let lookups = 0;
  const get = f.store.getArtifactReference.bind(f.store);
  f.store.getArtifactReference = async (input) => {
    lookups++;
    return get(input);
  };
  const reads: Promise<unknown>[] = [];
  try {
    await Promise.all(streams.map((stream) => stream.next()));
    const before = lookups;
    for (let i = 0; i < 48; i++)
      reads.push(
        f.artifacts
          .readReference({
            expectedStoreId: f.input.expectedStoreId,
            reference,
            signal: abort.signal,
          })
          .then(
            () => null,
            (error: unknown) => error,
          ),
      );
    const published = await f.artifacts.publish({
      ...f.input,
      refId: 'progress',
      content: Buffer.from('producer'),
    });
    expect(published.id).toBe('progress');
    expect(lookups).toBe(before);
    abort.abort(reason);
    expect((await Promise.all(reads)).every((error) => error === reason)).toBe(true);
    await Promise.all(streams.map((stream) => stream.return?.()));
    expect(
      Buffer.from(await f.artifacts.read({ ...f.input, refId: reference.id })).toString(),
    ).toBe('full body');
  } finally {
    abort.abort(reason);
    await Promise.allSettled(reads);
    await Promise.all(streams.map((stream) => stream.return?.()));
    await f.close();
  }
}, 10000);

test('close wakes callers outside bounded admission and drains admitted work before releasing profile use', async () => {
  const f = await fixture();
  const held = gate();
  const active = Array.from({ length: 8 }, (_, index) =>
    f.artifacts.publishStream({
      ...f.input,
      refId: `held-close-${index}`,
      content: (async function* () {
        await held.promise;
        yield Buffer.from('held');
      })(),
    }),
  );
  const queued = Array.from({ length: 64 }, (_, index) =>
    f.artifacts.publish({
      ...f.input,
      refId: `queued-close-${index}`,
      content: Buffer.from('queued'),
    }),
  );
  const overflow = f.artifacts
    .publish({ ...f.input, refId: 'overflow-close', content: Buffer.from('sealed') })
    .then(
      () => null,
      (error: unknown) => error,
    );
  let closed = false;
  const closing = f.artifacts.close().then(() => {
    closed = true;
  });
  try {
    expect(await overflow).toMatchObject({ code: 'artifact_closed' });
    expect(closed).toBe(false);
    held.release();
    await Promise.all([...active, ...queued]);
    await closing;
    expect(closed).toBe(true);
    expect(await f.store.getArtifactReference({ ...f.input, refId: 'overflow-close' })).toBeNull();
    expect(
      await f.store.getArtifactReference({ ...f.input, refId: 'queued-close-63' }),
    ).not.toBeNull();
  } finally {
    held.release();
    await Promise.allSettled([...active, ...queued, overflow]);
    await f.close();
  }
}, 10000);

test('a real Run waits behind saturated publication admission and completes without another Model call', async () => {
  const f = await fixture();
  const held = gate();
  const publishing = gate();
  const backlog = Array.from({ length: 72 }, (_, index) =>
    f.artifacts.publishStream({
      ...f.input,
      refId: `runtime-backlog-${index}`,
      content: (async function* () {
        await held.promise;
        yield Buffer.from('backlog');
      })(),
    }),
  );
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'finished once'.repeat(10000) },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  let publications = 0;
  const runtime = createRuntime({
    store: f.store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    artifacts: {
      publish(input) {
        publications++;
        publishing.release();
        return f.artifacts.publish(input);
      },
      read: (input) => f.artifacts.read(input),
      readReference: (input) => f.artifacts.readReference(input),
      close: () => f.artifacts.close(),
    },
  });
  try {
    await runtime.submitCommand({
      expectedStoreId: f.input.expectedStoreId,
      commandId: 'run',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'complete once' },
    });
    await Promise.race([
      publishing.promise,
      Bun.sleep(3000).then(() => {
        throw new Error('Runtime did not reach artifact publication');
      }),
    ]);
    held.release();
    await Promise.all(backlog);
    const command = await runtime.waitForCommand('run', { timeoutMs: 8000 });
    const runId = (command.receipt as { runId: string }).runId;
    expect(await f.store.getRun(runId)).toMatchObject({ status: 'completed', isActive: false });
    expect(model.requests).toHaveLength(1);
    expect(publications).toBeGreaterThan(0);
    expect(
      (await f.store.listExecutions('s')).every((execution) => execution.status === 'succeeded'),
    ).toBe(true);
  } finally {
    held.release();
    await Promise.allSettled(backlog);
    await runtime.close();
    await f.close();
  }
}, 10000);

test.skipIf(process.platform === 'win32')(
  'an unconfirmed snapshot writer close is reported once and retains profile authority',
  async () => {
    const f = await fixture();
    const original = fileURLToPath(new URL('../../../src/artifacts.ts', import.meta.url));
    const source = readFileSync(original, 'utf8')
      .replace('  closeSync,', '  closeSync as actualCloseSync,')
      .replace('acquireProfileAccess,', 'acquireProfileAccess as actualAcquireProfileAccess,')
      .replace(
        /from (['"])(\.[^'"]+)\1/g,
        (_match, quote, specifier) =>
          `from ${quote}${resolve(dirname(original), specifier)}${quote}`,
      );
    const modulePath = join(f.root, 'artifact-close-fixture.ts');
    writeFileSync(
      modulePath,
      `${source}
const heldFds = new Set<number>();
const heldAccesses = new Set<ReturnType<typeof actualAcquireProfileAccess>>();
export const faults = { armed: false, attempts: 0, releases: 0, cleanup() {
  for (const fd of heldFds) actualCloseSync(fd);
  heldFds.clear();
  for (const access of heldAccesses) access.lock.release();
  heldAccesses.clear();
} };
function closeSync(fd: number) {
  if (heldFds.has(fd)) { faults.attempts++; throw new Error('snapshot_close_unknown'); }
  if (faults.armed) { faults.armed = false; faults.attempts++; heldFds.add(fd); throw new Error('snapshot_close_unknown'); }
  actualCloseSync(fd);
}
function acquireProfileAccess(...args: Parameters<typeof actualAcquireProfileAccess>) {
  const access = actualAcquireProfileAccess(...args); heldAccesses.add(access); return { ...access, lock: { ...access.lock, release() { faults.releases++; access.lock.release(); } } };
}
`,
    );
    const selected = (await import(pathToFileURL(modulePath).href)) as {
      createArtifactStore: typeof createArtifactStore;
      faults: { armed: boolean; attempts: number; releases: number; cleanup(): void };
    };
    const artifacts = selected.createArtifactStore({ profile: f.profile, store: f.store });
    const held = gate();
    const active = Array.from({ length: 8 }, (_, index) =>
      artifacts.publishStream({
        ...f.input,
        refId: `unknown-held-${index}`,
        content: (async function* () {
          await held.promise;
          yield Buffer.from('held');
        })(),
      }),
    );
    const queued = artifacts.publish({
      ...f.input,
      refId: 'unknown-queued',
      content: new Uint8Array(10 * 1024 * 1024),
    });
    try {
      selected.faults.armed = true;
      const error = await artifacts
        .publish({ ...f.input, refId: 'unknown-close', content: new Uint8Array(7 * 1024 * 1024) })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(error).toMatchObject({ message: 'artifact_snapshot_close_unknown' });
      expect(selected.faults.attempts).toBe(1);
      held.release();
      await Promise.all([...active, queued]);
      const closing = artifacts.close();
      expect(
        await closing.then(
          () => null,
          (error: unknown) => error,
        ),
      ).toMatchObject({ message: 'artifact_snapshot_cleanup_unconfirmed' });
      expect(artifacts.close()).toBe(closing);
      expect(selected.faults.releases).toBe(0);
      expect(selected.faults.attempts).toBe(1);
      expect(await f.store.getArtifactReference({ ...f.input, refId: 'unknown-close' })).toBeNull();
      expect((await f.store.getSession('s'))?.id).toBe('s');
    } finally {
      held.release();
      await Promise.allSettled([...active, queued]);
      selected.faults.cleanup();
      await f.close();
    }
  },
  10000,
);

test.skipIf(process.platform === 'win32')(
  'an unconfirmed snapshot reader close is reported once and retains profile authority',
  async () => {
    const f = await fixture();
    const original = fileURLToPath(new URL('../../../src/artifacts.ts', import.meta.url));
    const source = readFileSync(original, 'utf8')
      .replace('  closeSync,', '  closeSync as actualCloseSync,')
      .replace('closeSync(reader);', 'closeSnapshotReader(reader);')
      .replace('acquireProfileAccess,', 'acquireProfileAccess as actualAcquireProfileAccess,')
      .replace(
        /from (['"])(\.[^'"]+)\1/g,
        (_match, quote, specifier) =>
          `from ${quote}${resolve(dirname(original), specifier)}${quote}`,
      );
    const modulePath = join(f.root, 'artifact-close-fixture.ts');
    writeFileSync(
      modulePath,
      `${source}
const heldFds = new Set<number>();
const heldAccesses = new Set<ReturnType<typeof actualAcquireProfileAccess>>();
export const faults = { armed: false, attempts: 0, releases: 0, cleanup() {
  for (const fd of heldFds) actualCloseSync(fd);
  heldFds.clear();
  for (const access of heldAccesses) access.lock.release();
  heldAccesses.clear();
} };
function closeSnapshotReader(fd: number) {
  if (heldFds.has(fd)) { faults.attempts++; throw new Error('snapshot_close_unknown'); }
  if (faults.armed) { faults.armed = false; faults.attempts++; heldFds.add(fd); throw new Error('snapshot_close_unknown'); }
  actualCloseSync(fd);
}
function closeSync(fd: number) { actualCloseSync(fd); }
function acquireProfileAccess(...args: Parameters<typeof actualAcquireProfileAccess>) {
  const access = actualAcquireProfileAccess(...args); heldAccesses.add(access); return { ...access, lock: { ...access.lock, release() { faults.releases++; access.lock.release(); } } };
}
`,
    );
    const selected = (await import(pathToFileURL(modulePath).href)) as {
      createArtifactStore: typeof createArtifactStore;
      faults: { armed: boolean; attempts: number; releases: number; cleanup(): void };
    };
    const artifacts = selected.createArtifactStore({ profile: f.profile, store: f.store });
    const held = gate();
    const active = Array.from({ length: 8 }, (_, index) =>
      artifacts.publishStream({
        ...f.input,
        refId: `unknown-held-${index}`,
        content: (async function* () {
          await held.promise;
          yield Buffer.from('held');
        })(),
      }),
    );
    const queued = artifacts.publish({
      ...f.input,
      refId: 'unknown-queued',
      content: new Uint8Array(10 * 1024 * 1024),
    });
    try {
      selected.faults.armed = true;
      const pending = artifacts
        .publish({ ...f.input, refId: 'unknown-close', content: new Uint8Array(7 * 1024 * 1024) })
        .then(
          () => null,
          (error: unknown) => error,
        );
      held.release();
      const error = await pending;
      expect(error).toMatchObject({ message: 'artifact_snapshot_close_unknown' });
      expect(selected.faults.attempts).toBe(1);
      held.release();
      await Promise.all([...active, queued]);
      const closing = artifacts.close();
      expect(
        await closing.then(
          () => null,
          (error: unknown) => error,
        ),
      ).toMatchObject({ message: 'artifact_snapshot_cleanup_unconfirmed' });
      expect(artifacts.close()).toBe(closing);
      expect(selected.faults.releases).toBe(0);
      expect(selected.faults.attempts).toBe(1);
      expect(await f.store.getArtifactReference({ ...f.input, refId: 'unknown-close' })).toBeNull();
      expect((await f.store.getSession('s'))?.id).toBe('s');
    } finally {
      held.release();
      await Promise.allSettled([...active, queued]);
      selected.faults.cleanup();
      await f.close();
    }
  },
  10000,
);
