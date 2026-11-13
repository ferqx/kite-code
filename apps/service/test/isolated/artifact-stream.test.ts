import { expect, test } from 'bun:test';
import { createArtifactStream } from '../../src/artifact-stream';

test('partial Artifact response cancellation settles exactly once and preserves cleanup failure', async () => {
  const failure = Error('fixture_close_unconfirmed'),
    controller = new AbortController();
  const settled: unknown[] = [];
  let finalized = 0;
  const stream = createArtifactStream({
    controller,
    settled(error) {
      settled.push(error);
    },
    content: {
      async *[Symbol.asyncIterator]() {
        try {
          yield new Uint8Array([1]);
          yield new Uint8Array([2]);
        } finally {
          finalized++;
          // biome-ignore lint/correctness/noUnsafeFinally: inject a native cleanup failure, not normal application flow
          throw failure;
        }
      },
    },
  });
  const reader = stream.getReader();
  expect(await reader.read()).toEqual({ value: new Uint8Array([1]), done: false });
  let error: unknown;
  try {
    await reader.cancel();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBe(failure);
  expect(finalized).toBe(1);
  expect(settled).toEqual([failure]);
  controller.abort();
  expect(settled).toHaveLength(1);
  reader.releaseLock();
});

test('Artifact EOF and transport abort release their original iterators without extra pulls', async () => {
  let pulls = 0,
    finalized = 0,
    settlements = 0;
  const controller = new AbortController();
  const content = {
    async *[Symbol.asyncIterator]() {
      try {
        pulls++;
        yield new Uint8Array([7]);
        pulls++;
        yield new Uint8Array([8]);
      } finally {
        finalized++;
      }
    },
  };
  const reader = createArtifactStream({
    content,
    controller,
    settled(error) {
      expect(error).toBeUndefined();
      settlements++;
    },
  }).getReader();
  expect(pulls).toBe(0);
  expect((await reader.read()).value).toEqual(new Uint8Array([7]));
  expect(pulls).toBe(1);
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  let error: unknown;
  try {
    await reader.read();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(finalized).toBe(1);
  expect(settlements).toBe(1);
  reader.releaseLock();
});

test('EOF finally failure remains cleanup unknown even when a second return succeeds', async () => {
  const failure = Error('artifact_read_close_unknown'),
    settled: unknown[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const reader = createArtifactStream({
    controller: new AbortController(),
    settled(error, unknown) {
      settled.push({ error, unknown });
      finished();
    },
    content: {
      async *[Symbol.asyncIterator]() {
        try {
          yield new Uint8Array([1]);
        } finally {
          // biome-ignore lint/correctness/noUnsafeFinally: inject failure specifically at EOF cleanup
          throw failure;
        }
      },
    },
  }).getReader();
  await reader.read();
  let error: unknown;
  try {
    await reader.read();
  } catch (caught) {
    error = caught;
  }
  await done;
  expect(error).toBe(failure);
  expect(settled).toEqual([{ error: failure, unknown: true }]);
  reader.releaseLock();
});

test('abort during an in-flight next retains its later finally cleanup failure', async () => {
  let release!: () => void, entered!: () => void, finished!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    done = new Promise<void>((resolve) => {
      finished = resolve;
    });
  const controller = new AbortController(),
    failure = Error('artifact_read_close_unknown'),
    results: unknown[] = [];
  const reader = createArtifactStream({
    controller,
    settled(error, unknown) {
      results.push({ error, unknown });
      finished();
    },
    content: {
      async *[Symbol.asyncIterator]() {
        try {
          yield new Uint8Array([1]);
          entered();
          await gate;
          return;
        } finally {
          // biome-ignore lint/correctness/noUnsafeFinally: inject native close uncertainty after a cancelled pending read
          throw failure;
        }
      },
    },
  }).getReader();
  await reader.read();
  const next = reader.read().catch((error) => error);
  await started;
  controller.abort();
  release();
  await next;
  await done;
  expect(results).toEqual([{ error: failure, unknown: true }]);
  reader.releaseLock();
});

test('missing Artifact bytes remain an ordinary read failure rather than cleanup uncertainty', async () => {
  const failure = Object.assign(Error('missing'), { code: 'ENOENT' }),
    results: unknown[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const reader = createArtifactStream({
    controller: new AbortController(),
    settled(error, unknown) {
      results.push({ error, unknown });
      finished();
    },
    content: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            throw failure;
          },
        };
      },
    },
  }).getReader();
  let error: unknown;
  try {
    await reader.read();
  } catch (caught) {
    error = caught;
  }
  await done;
  expect(error).toBe(failure);
  expect(results).toEqual([{ error: failure, unknown: false }]);
  reader.releaseLock();
});
