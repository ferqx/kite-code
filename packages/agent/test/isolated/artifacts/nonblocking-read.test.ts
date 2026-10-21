import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactStore } from '../../../src/artifacts';
import type { Store } from '../../../src/storage/port';

// This file runs in its own process. Observe real native reads without replacing
// bytes, identity, short reads, scope checks or the SQLite Worker.
const native = { ...fs };
const descriptors = new Set<number>();
let selectedPath = '';
let firstRead: (() => void) | undefined;
let bodyReads = 0;
mock.module('node:fs', () => ({
  ...native,
  openSync(...args: Parameters<typeof fs.openSync>) {
    const descriptor = native.openSync(...args);
    if (String(args[0]) === selectedPath) descriptors.add(descriptor);
    return descriptor;
  },
  readSync: ((...args: unknown[]) => {
    if (descriptors.has(args[0] as number)) {
      bodyReads++;
      const first = firstRead;
      firstRead = undefined;
      first?.();
    }
    return (native.readSync as (...args: unknown[]) => number)(...args);
  }) as typeof fs.readSync,
  closeSync(descriptor: number) {
    native.closeSync(descriptor);
    descriptors.delete(descriptor);
  },
}));
const { createArtifactStore } = await import('../../../src/artifacts');
const { openSqliteStore } = await import('../../../src/sqlite');
// The native descriptor observer is POSIX-specific. Existing Windows Artifact
// tests retain the actual HANDLE/ACL contracts; these local probes do not grant it qualification.
const posixTest = process.platform === 'win32' ? test.skip : test;

const roots: string[] = [];
const stores: Store[] = [];
const artifacts: ArtifactStore[] = [];
afterEach(async () => {
  firstRead = undefined;
  selectedPath = '';
  for (const handle of artifacts.splice(0)) await handle.close();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) native.rmSync(root, { recursive: true, force: true });
  expect(descriptors.size).toBe(0);
  bodyReads = 0;
});

async function fixture() {
  const root = native.realpathSync(native.mkdtempSync(join(tmpdir(), 'kite-artifact-responsive-')));
  roots.push(root);
  const profile = { dataRoot: root, profile: 'fixture' };
  const store = await openSqliteStore(profile);
  stores.push(store);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'fixture',
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'fixture',
    subjectId: 'owner',
  });
  const artifact = createArtifactStore({ profile, store });
  artifacts.push(artifact);
  const input = {
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session' as const, id: 's' },
    refId: 'body',
  };
  const content = Buffer.alloc(16 * 1024 * 1024, 0x61);
  const reference = await artifact.publish({
    ...input,
    mediaType: 'application/octet-stream',
    content,
  });
  selectedPath = join(root, profile.profile, 'blobs', reference.hash.slice(0, 2), reference.hash);
  bodyReads = 0;
  return { artifact, store, input, reference, content, path: selectedPath };
}
type Kind = 'read' | 'readReference' | 'readStream';
async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error;
  }
}
async function consume(f: Awaited<ReturnType<typeof fixture>>, kind: Kind, signal?: AbortSignal) {
  if (kind === 'readStream') {
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of f.artifact.readStream({ ...f.input, signal })) {
      size += chunk.byteLength;
      digest.update(chunk);
    }
    return { size, hash: digest.digest('hex') };
  }
  const bytes =
    kind === 'read'
      ? await f.artifact.read({ ...f.input, signal })
      : await f.artifact.readReference({
          expectedStoreId: f.input.expectedStoreId,
          reference: f.reference,
          signal,
        });
  return { size: bytes.byteLength, hash: createHash('sha256').update(bytes).digest('hex') };
}

for (const kind of ['read', 'readReference', 'readStream'] as const) {
  posixTest(
    `${kind} lets an actual macrotask query the Store before complete verified EOF`,
    async () => {
      const f = await fixture();
      let settled = false;
      let progress = false;
      let release!: () => void;
      let reject!: (cause: unknown) => void;
      const macro = new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      firstRead = () => {
        setImmediate(() => {
          void f.store.getMetadata().then(() => {
            progress = !settled;
            release();
          }, reject);
        });
      };
      const reading = consume(f, kind).finally(() => {
        settled = true;
      });
      const [result] = await Promise.all([reading, macro]);
      expect(result).toEqual({ size: f.content.length, hash: f.reference.hash });
      expect(progress).toBe(true);
      expect(bodyReads).toBeGreaterThan(1);
    },
  );

  posixTest(
    `${kind} observes cancellation during body IO and closes its original descriptor`,
    async () => {
      const f = await fixture();
      const controller = new AbortController();
      const reason = new Error('owned_artifact_cancel');
      let readsAtAbort = 0;
      let release!: () => void;
      const macro = new Promise<void>((resolve) => {
        release = resolve;
      });
      firstRead = () => {
        setImmediate(() => {
          readsAtAbort = bodyReads;
          controller.abort(reason);
          release();
        });
      };
      const [result] = await Promise.all([
        consume(f, kind, controller.signal).then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        ),
        macro,
      ]);
      expect(result.error).toBe(reason);
      expect(readsAtAbort).toBeGreaterThan(0);
      expect(bodyReads).toBe(readsAtAbort);
      expect(descriptors.size).toBe(0);
    },
  );
}

posixTest(
  'close waits for the actual active read and rejects new admission without closing its live FD',
  async () => {
    const f = await fixture();
    let settled = false;
    let closeDuringRead = false;
    let heldDescriptors = 0;
    let closing: Promise<void> | undefined;
    let release!: () => void;
    const macro = new Promise<void>((resolve) => {
      release = resolve;
    });
    firstRead = () => {
      setImmediate(() => {
        closeDuringRead = !settled;
        heldDescriptors = descriptors.size;
        closing = f.artifact.close();
        release();
      });
    };
    const [result] = await Promise.all([
      consume(f, 'readReference').finally(() => {
        settled = true;
      }),
      macro,
    ]);
    await closing;
    expect(closeDuringRead).toBe(true);
    expect(heldDescriptors).toBe(1);
    expect(result).toEqual({ size: f.content.length, hash: f.reference.hash });
    expect(descriptors.size).toBe(0);
    expect(await failure(f.artifact.read(f.input))).toMatchObject({ code: 'artifact_closed' });
  },
);

posixTest(
  'a body changed during a cooperative pause cannot be returned as verified complete content',
  async () => {
    const f = await fixture();
    let release!: () => void;
    let reject!: (cause: unknown) => void;
    const macro = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    firstRead = () => {
      setImmediate(() => {
        try {
          native.chmodSync(f.path, 0o600);
          const descriptor = native.openSync(f.path, 'r+');
          try {
            native.writeSync(descriptor, Buffer.from('changed!'), 0, 8, f.content.length - 8);
          } finally {
            native.closeSync(descriptor);
          }
          native.chmodSync(f.path, 0o444);
          release();
        } catch (error) {
          reject(error);
        }
      });
    };
    const [result] = await Promise.all([
      consume(f, 'readReference').then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      ),
      macro,
    ]);
    expect(result.error).toMatchObject({ code: 'artifact_content_mismatch' });
    expect(descriptors.size).toBe(0);
  },
);

posixTest('stream early return closes the original reader and releases admission', async () => {
  const f = await fixture();
  const iterator = f.artifact.readStream(f.input)[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(first.value!.byteLength).toBeLessThanOrEqual(64 * 1024);
  expect(descriptors.size).toBe(1);
  await iterator.return?.();
  expect(descriptors.size).toBe(0);
  await f.artifact.close();
});

posixTest('stream cancellation between next calls closes before any further body IO', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const iterator = f.artifact
    .readStream({ ...f.input, signal: controller.signal })
    [Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  const readsBeforeAbort = bodyReads;
  const reason = new Error('owned_artifact_stream_prefix_cancel');
  controller.abort(reason);
  expect(await failure(iterator.next())).toBe(reason);
  expect(bodyReads).toBe(readsBeforeAbort);
  expect(descriptors.size).toBe(0);
});

posixTest('scope rejection and pre-abort never begin native body IO', async () => {
  const f = await fixture();
  expect(await failure(f.artifact.read({ ...f.input, subjectId: 'foreign' }))).toMatchObject({
    code: 'artifact_scope_denied',
  });
  const controller = new AbortController();
  const reason = new Error('pre_aborted');
  controller.abort(reason);
  for (const kind of ['read', 'readReference', 'readStream'] as const)
    expect(await failure(consume(f, kind, controller.signal))).toBe(reason);
  expect(bodyReads).toBe(0);
});
