import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArtifactStore, createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const roots: string[] = [];
const stores: Store[] = [];
const artifacts: ArtifactStore[] = [];
afterEach(async () => {
  for (const handle of artifacts.splice(0)) await handle.close();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-artifacts-')));
  chmodSync(dataRoot, 0o700);
  roots.push(dataRoot);
  const profile = { dataRoot, profile: 'new' };
  const store = await openSqliteStore(profile);
  stores.push(store);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///disposable',
    name: 'fixture',
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: 'fixture',
      subjectId: sessionId === 's' ? 'owner' : 'other-owner',
    });
  const artifact = createArtifactStore({ profile, store });
  artifacts.push(artifact);
  return {
    store,
    profile,
    artifact,
    expectedStoreId,
    scope: { kind: 'session' as const, id: 's' },
    sessionId: 's',
    subjectId: 'owner',
    profilePath: join(dataRoot, 'new'),
  };
}
async function code(work: Promise<unknown>, expected: string) {
  let actual = '';
  try {
    await work;
  } catch (error) {
    actual = (error as { code?: string }).code ?? '';
  }
  expect(actual).toBe(expected);
}
test('immutable publication precedes scoped reference, hash alone cannot grant read, readonly restart preserves original identity', async () => {
  const f = await fixture();
  const bytes = Buffer.from('immutable你好');
  const input = {
    expectedStoreId: f.expectedStoreId,
    sessionId: f.sessionId,
    subjectId: f.subjectId,
    scope: f.scope,
    refId: 'ref',
    content: bytes,
    mediaType: 'text/plain',
  };
  const ref = await f.artifact.publish(input);
  expect(ref.size).toBe(String(bytes.length));
  expect(Buffer.from(await f.artifact.read(input))).toEqual(bytes);
  expect(
    Buffer.from(
      await f.artifact.readReference({ expectedStoreId: f.expectedStoreId, reference: ref }),
    ),
  ).toEqual(bytes);
  expect(await f.artifact.publish(input)).toEqual(ref);
  const secondType = await f.artifact.publish({
    ...input,
    refId: 'same-bytes-other-type',
    mediaType: 'application/octet-stream',
  });
  expect(secondType.hash).toBe(ref.hash);
  expect(secondType.mediaType).toBe('application/octet-stream');
  await code(
    f.artifact.readReference({
      expectedStoreId: f.expectedStoreId,
      reference: { ...ref, mediaType: secondType.mediaType },
    }),
    'artifact_reference_mismatch',
  );
  await code(
    f.artifact.readReference({
      expectedStoreId: f.expectedStoreId,
      reference: { ...ref, storeId: 'different-origin' },
    }),
    'artifact_reference_mismatch',
  );
  await code(
    f.artifact.readReference({
      expectedStoreId: f.expectedStoreId,
      reference: { ...ref, subjectId: 'intruder' },
    }),
    'artifact_scope_denied',
  );
  expect((await f.store.getArtifactReference(input))?.mediaType).toBe('text/plain');
  await code(
    f.artifact.publish({ ...input, mediaType: 'application/octet-stream' }),
    'artifact_reference_conflict',
  );
  const shared = new Database(join(f.profilePath, 'core.db'));
  expect(shared.query('SELECT count(*) AS n FROM blob WHERE hash=?').get(ref.hash)).toEqual({
    n: 1,
  });
  shared.close();
  await code(f.artifact.read({ ...input, subjectId: 'intruder' }), 'artifact_scope_denied');
  await code(
    f.artifact.read({
      ...input,
      sessionId: 'other',
      subjectId: 'other-owner',
      scope: { kind: 'session', id: 'other' },
    }),
    'artifact_reference_not_found',
  );
  await code(f.artifact.read({ ...input, refId: ref.hash }), 'artifact_reference_not_found');
  await code(
    f.artifact.read({ ...input, expectedStoreId: 'different' }),
    'store_identity_mismatch',
  );
  expect(readFileSync(artifactPath(f.profilePath, ref.hash))).toEqual(bytes);
  await f.artifact.close();
  await f.store.close();
  const store = await openSqliteStore({ ...f.profile, mode: 'readonly' });
  stores.push(store);
  const reader = createArtifactStore({ profile: f.profile, store });
  artifacts.push(reader);
  expect(Buffer.from(await reader.read(input))).toEqual(bytes);
  expect(
    Buffer.from(await reader.readReference({ expectedStoreId: f.expectedStoreId, reference: ref })),
  ).toEqual(bytes);
  await code(reader.publish({ ...input, refId: 'read-only' }), 'read_only');
});
test('two actual Workers compete for same hash/reference and verify content rather than trusting filename', async () => {
  const f = await fixture();
  const second = await openSqliteStore(f.profile);
  stores.push(second);
  const a2 = createArtifactStore({ profile: f.profile, store: second });
  artifacts.push(a2);
  const input = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    refId: 'race',
    content: Buffer.from('racing same blob'),
    mediaType: 'text/plain',
  };
  const [one, two] = await Promise.all([f.artifact.publish(input), a2.publish(input)]);
  expect(one).toEqual(two);
  const separate = await a2.publish({ ...input, refId: 'another-explicit-ref' });
  expect(separate.hash).toBe(one.hash);
  expect(separate.id).toBe('another-explicit-ref');
  const db = new Database(join(f.profilePath, 'core.db'));
  expect(db.query('SELECT count(*) AS n FROM blob').get()).toEqual({ n: 1 });
  expect(db.query('SELECT count(*) AS n FROM blob_ref').get()).toEqual({ n: 2 });
  db.close();
  const path = artifactPath(f.profilePath, one.hash);
  chmodSync(path, 0o600);
  writeFileSync(path, 'racing same BLOB');
  chmodSync(path, 0o400);
  await code(a2.publish(input), 'artifact_content_mismatch');
  await code(f.artifact.read(input), 'artifact_content_mismatch');
  await code(
    f.artifact.readReference({ expectedStoreId: f.expectedStoreId, reference: one }),
    'artifact_content_mismatch',
  );
});
test('real registration transaction failure leaves only orphan bytes; nonexistent and symlink blobs never register', async () => {
  const f = await fixture();
  const db = new Database(join(f.profilePath, 'core.db'));
  db.run(
    "CREATE TRIGGER artifact_fault BEFORE INSERT ON blob_ref BEGIN SELECT RAISE(ABORT,'artifact transaction fault'); END",
  );
  const input = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    refId: 'fault',
    content: Buffer.from('orphan publication'),
    mediaType: 'text/plain',
  };
  let failed = false;
  try {
    await f.artifact.publish(input);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  const hash = createHash('sha256').update(input.content).digest('hex');
  expect(existsSync(artifactPath(f.profilePath, hash))).toBe(true);
  expect(db.query('SELECT count(*) AS n FROM blob').get()).toEqual({ n: 0 });
  expect(db.query('SELECT count(*) AS n FROM blob_ref').get()).toEqual({ n: 0 });
  expect(await f.store.getArtifactReference(input)).toBeNull();
  expect(readdirSync(join(f.profilePath, 'blobs', hash.slice(0, 2)))).toEqual([hash]);
  db.run('DROP TRIGGER artifact_fault');
  let missing = false;
  try {
    await f.store.registerArtifact({ ...input, hash: 'a'.repeat(64), size: '1' });
  } catch {
    missing = true;
  }
  expect(missing).toBe(true);
  const path = artifactPath(f.profilePath, hash);
  unlinkSync(path);
  const outside = join(f.profile.dataRoot, 'outside');
  writeFileSync(outside, input.content);
  symlinkSync(outside, path);
  failed = false;
  try {
    await f.store.registerArtifact({ ...input, hash, size: String(input.content.length) });
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(db.query('SELECT count(*) AS n FROM blob_ref').get()).toEqual({ n: 0 });
  db.close();
});
test('original session/subject and exact execution/message scope are verified, ref ID conflicts and limits have zero reference effects', async () => {
  const f = await fixture();
  const input = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    refId: 'scope',
    content: Buffer.from('bytes'),
    mediaType: 'text/plain',
  };
  await code(
    f.artifact.publish({ ...input, scope: { kind: 'execution', id: 'missing' } }),
    'artifact_scope_denied',
  );
  await code(
    f.artifact.publish({ ...input, scope: { kind: 'message', id: 'missing' } }),
    'artifact_scope_denied',
  );
  await code(f.artifact.publish({ ...input, subjectId: 'intruder' }), 'artifact_scope_denied');
  const ref = await f.artifact.publish(input);
  await code(
    f.artifact.publish({ ...input, content: Buffer.from('different') }),
    'artifact_reference_conflict',
  );
  expect((await f.store.getArtifactReference(input))?.hash).toBe(ref.hash);
  const large = await f.artifact.publish({
    ...input,
    refId: 'large',
    content: new Uint8Array(16 * 1024 * 1024 + 1),
  });
  expect(large.size).toBe(String(16 * 1024 * 1024 + 1));
  const db = new Database(join(f.profilePath, 'core.db'));
  db.run("UPDATE session SET delete_requested=1 WHERE id='s'");
  await code(f.artifact.publish({ ...input, refId: 'deleted' }), 'artifact_scope_denied');
  expect(Buffer.from(await f.artifact.read(input))).toEqual(input.content);
  db.close();
});

test('two real processes publish one immutable hash and original ref without temp leaks', async () => {
  const f = await fixture();
  const child = new URL('./publish-child.ts', import.meta.url).pathname;
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, child, f.profile.dataRoot], { stdout: 'pipe', stderr: 'pipe' }),
  );
  const results = await Promise.all(
    children.map(async (child) => {
      const [out, err, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(err).toBe('');
      expect(status).toBe(0);
      return JSON.parse(out) as { hash: string };
    }),
  );
  expect(results[0]).toEqual(results[1]);
  const hash = results[0]!.hash;
  expect(readdirSync(join(f.profilePath, 'blobs', hash.slice(0, 2)))).toEqual([hash]);
  expect(
    Buffer.from(
      await f.artifact.read({
        expectedStoreId: f.expectedStoreId,
        refId: 'process-race',
        sessionId: 's',
        subjectId: 'owner',
        scope: f.scope,
      }),
    ).toString(),
  ).toBe('two process immutable');
});

test('valid execution/message reference scopes retain original authorization and restored origins cannot be rebound by read', async () => {
  const f = await fixture();
  await f.store.acceptCommand({
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: 'work',
    request: { kind: 'run.start', content: 'fixture' },
  });
  const owner = (await f.store.acquireSessionOwner('s', 'fixture'))!;
  const run = await f.store.startRun({
    expectedStoreId: f.expectedStoreId,
    owner,
    commandId: 'work',
    configuration: {},
  });
  await f.store.planExecution({
    expectedStoreId: f.expectedStoreId,
    owner,
    executionId: 'tool',
    sessionId: 's',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'step',
    callId: 'call',
    kind: 'tool',
    definitionId: 'fixture',
    definitionVersion: '1',
    input: {},
    decisionSource: {},
  });
  const messages = await f.store.listMessages('s');
  const message = messages.find((m) => m.role === 'user')!;
  expect(message).toBeDefined();
  const shared = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    content: Buffer.from('scoped bytes'),
    mediaType: 'text/plain',
  };
  const executionInput = {
    ...shared,
    refId: 'execution-ref',
    scope: { kind: 'execution' as const, id: 'tool' },
  };
  const messageInput = {
    ...shared,
    refId: 'message-ref',
    scope: { kind: 'message' as const, id: message.id },
  };
  const executionRef = await f.artifact.publish(executionInput);
  await f.artifact.publish(messageInput);
  expect(Buffer.from(await f.artifact.read(executionInput)).toString()).toBe('scoped bytes');
  expect(Buffer.from(await f.artifact.read(messageInput)).toString()).toBe('scoped bytes');
  expect(
    await f.store.getArtifactReference({ ...executionInput, scope: messageInput.scope }),
  ).toBeNull();
  const db = new Database(join(f.profilePath, 'core.db'));
  db.run("UPDATE blob_ref SET origin_store_id='old-origin' WHERE id='execution-ref'");
  expect(await f.store.getArtifactReference(executionInput)).toBeNull();
  await code(f.artifact.publish(executionInput), 'artifact_reference_conflict');
  expect(
    db.query("SELECT origin_store_id AS origin FROM blob_ref WHERE id='execution-ref'").get(),
  ).toEqual({ origin: 'old-origin' });
  expect(executionRef.storeId).toBe(f.expectedStoreId);
  db.close();
});

test('Artifact host admission is bounded and close drains accepted publications before releasing profile authority', async () => {
  const f = await fixture();
  const common = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    content: Buffer.from('bounded publication'),
    mediaType: 'text/plain',
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const inFlight = Array.from({ length: 8 }, (_, i) =>
    f.artifact.publishStream({
      ...common,
      refId: `bound-${i}`,
      content: (async function* () {
        entered++;
        await gate;
        yield common.content;
      })(),
    }),
  );
  const admissionDeadline = Date.now() + 5000;
  while (entered < 8 && Date.now() < admissionDeadline) await Bun.sleep(1);
  expect(entered).toBe(8);
  const queued = Array.from({ length: 64 }, (_, i) =>
    f.artifact.publish({ ...common, refId: `queued-${i}` }),
  );
  await code(f.artifact.publish({ ...common, refId: 'refused' }), 'artifact_busy');
  expect(entered).toBe(8);
  const closing = f.artifact.close();
  await code(f.artifact.publish({ ...common, refId: 'after-close' }), 'artifact_closed');
  release();
  await Promise.all([...inFlight, ...queued]);
  await closing;
  expect(await f.store.getArtifactReference({ ...common, refId: 'refused' })).toBeNull();
  expect(await f.store.getArtifactReference({ ...common, refId: 'bound-7' })).not.toBeNull();
  expect(await f.store.getArtifactReference({ ...common, refId: 'queued-63' })).not.toBeNull();
});

test('Artifact queued byte budget rejects before another copy, and queued reads abort without a Store lookup', async () => {
  const f = await fixture();
  const common = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    mediaType: 'text/plain',
  };
  const ref = await f.artifact.publish({
    ...common,
    refId: 'original',
    content: Buffer.from('original'),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = Array.from({ length: 8 }, (_, i) =>
    f.artifact.publishStream({
      ...common,
      refId: `held-${i}`,
      content: (async function* () {
        await gate;
        yield Buffer.from('held');
      })(),
    }),
  );
  const bytes = new Uint8Array(10 * 1024 * 1024).fill(65);
  const accepted = f.artifact.publish({ ...common, refId: 'queued-large', content: bytes });
  bytes.fill(66);
  let error: unknown;
  try {
    await f.artifact.publish({
      ...common,
      refId: 'over-budget',
      content: new Uint8Array(7 * 1024 * 1024),
    });
  } catch (cause) {
    error = cause;
  }
  expect(error).toMatchObject({ code: 'artifact_busy', retryable: true });
  let lookups = 0;
  const original = f.store.getArtifactReference.bind(f.store);
  f.store.getArtifactReference = async (input) => {
    lookups++;
    return original(input);
  };
  const abort = new AbortController();
  const read = f.artifact
    .readReference({ expectedStoreId: f.expectedStoreId, reference: ref, signal: abort.signal })
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  const streamAbort = new AbortController();
  const stream = f.artifact
    .readStream({ ...common, refId: ref.id, signal: streamAbort.signal })
    [Symbol.asyncIterator]();
  const next = stream.next().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  const reason = Error('only_cancel_read');
  abort.abort(reason);
  streamAbort.abort(reason);
  expect(await read).toBe(reason);
  expect(await next).toBe(reason);
  expect(lookups).toBe(0);
  release();
  await Promise.all([...active, accepted]);
  const content = await f.artifact.read({ ...common, refId: 'queued-large' });
  expect(content.length).toBe(bytes.length);
  expect(content[0]).toBe(65);
  expect(content.at(-1)).toBe(65);
});

test('Artifact read streams reserve publication capacity and queued-reader saturation preserves producer admission', async () => {
  const f = await fixture();
  const common = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    mediaType: 'text/plain',
  };
  await f.artifact.publish({ ...common, refId: 'original', content: Buffer.alloc(128 * 1024, 65) });
  const readers = Array.from({ length: 6 }, () =>
    f.artifact.readStream({ ...common, refId: 'original' })[Symbol.asyncIterator](),
  );
  await Promise.all(readers.map((reader) => reader.next()));
  const controller = new AbortController();
  const queued = Array.from({ length: 32 }, () =>
    f.artifact.read({ ...common, refId: 'original', signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
  await code(f.artifact.read({ ...common, refId: 'original' }), 'artifact_busy');
  await f.artifact.publish({
    ...common,
    refId: 'not-starved',
    content: Buffer.from('producer continues'),
  });
  const abortReason = Error('release_queued_reads');
  controller.abort(abortReason);
  expect((await Promise.all(queued)).every((error) => error === abortReason)).toBe(true);
  await Promise.all(readers.map((reader) => reader.return!()));
  expect(Buffer.from(await f.artifact.read({ ...common, refId: 'not-starved' })).toString()).toBe(
    'producer continues',
  );
});

test('Artifact waiting scope read makes progress before a continuous queued publisher backlog is exhausted', async () => {
  const f = await fixture();
  const common = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    mediaType: 'text/plain',
  };
  await f.artifact.publish({
    ...common,
    refId: 'fair-original',
    content: Buffer.from('accurate scoped reading'),
  });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  const admitted = gate();
  let initialStarted = 0;
  const initialGates = Array.from({ length: 8 }, gate);
  const active = initialGates.map((entry, index) =>
    f.artifact.publishStream({
      ...common,
      refId: `fair-active-${index}`,
      content: (async function* () {
        if (++initialStarted === initialGates.length) admitted.release();
        await entry.promise;
        yield Buffer.from('initial publication');
      })(),
    }),
  );
  await admitted.promise;
  type Progress = { kind: 'publisher'; index: number } | { kind: 'reader' };
  const events: Progress[] = [];
  let wake: (() => void) | undefined;
  const notify = (event: Progress) => {
    events.push(event);
    wake?.();
  };
  const next = async () => {
    if (!events.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = undefined;
    return events.shift()!;
  };
  const queuedGates = Array.from({ length: 16 }, gate);
  let queuedStarted = 0;
  const queued = queuedGates.map((entry, index) =>
    f.artifact.publishStream({
      ...common,
      refId: `fair-queued-${index}`,
      content: (async function* () {
        queuedStarted++;
        notify({ kind: 'publisher', index });
        await entry.promise;
        yield Buffer.from('queued publication');
      })(),
    }),
  );
  const original = f.store.getArtifactReference.bind(f.store);
  f.store.getArtifactReference = (input) => {
    if (input.refId === 'fair-original') notify({ kind: 'reader' });
    return original(input);
  };
  const abort = new AbortController();
  const reading = f.artifact.read({ ...common, refId: 'fair-original', signal: abort.signal });
  try {
    for (const entry of initialGates) entry.release();
    for (;;) {
      const event = await next();
      if (event.kind === 'reader') break;
      // Keep publishers arriving at the admission boundary without relying on wall-clock timing.
      queuedGates[event.index]!.release();
    }
    expect(queuedStarted).toBeLessThan(queuedGates.length);
    expect(Buffer.from(await reading).toString()).toBe('accurate scoped reading');
  } finally {
    abort.abort();
    for (const entry of [...initialGates, ...queuedGates]) entry.release();
    await Promise.allSettled([reading, ...active, ...queued]);
  }
});

test('a committed reference keeps its full stream identity when a delayed publication reply completes', async () => {
  const f = await fixture();
  const originalRegister = f.store.registerArtifact;
  let returnReply!: () => void;
  const reply = new Promise<void>((resolve) => {
    returnReply = resolve;
  });
  let committed!: (ref: Awaited<ReturnType<Store['registerArtifact']>>) => void;
  const registration = new Promise<Awaited<ReturnType<Store['registerArtifact']>>>((resolve) => {
    committed = resolve;
  });
  f.store.registerArtifact = async (input) => {
    const ref = await originalRegister.call(f.store, input);
    committed(ref);
    await reply;
    return ref;
  };
  const input = {
    expectedStoreId: f.expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: f.scope,
    refId: 'delayed-publication',
    content: Buffer.alloc(128 * 1024 + 23, 0x61),
    mediaType: 'application/octet-stream',
  };
  const publishing = f.artifact.publish(input);
  let reader: AsyncIterator<Uint8Array> | undefined;
  try {
    const ref = await Promise.race([registration, publishing]);
    reader = f.artifact.readStream(input)[Symbol.asyncIterator]();
    const first = await reader.next();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBe(64 * 1024);
    const path = artifactPath(f.profilePath, ref.hash);
    const opened = lstatSync(path, { bigint: true });
    returnReply();
    expect(await publishing).toEqual(ref);
    const after = lstatSync(path, { bigint: true });
    const identity = (stat: typeof opened) =>
      Object.fromEntries(
        ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'nlink'].map((key) => [
          key,
          String(stat[key as keyof typeof stat]),
        ]),
      );
    console.log(
      'ARTIFACT_PUBLICATION_REPLY_IDENTITY',
      JSON.stringify({ opened: identity(opened), after: identity(after), hash: ref.hash }),
    );
    const chunks = [first.value!];
    while (true) {
      const next = await reader.next();
      if (next.done) break;
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes).toEqual(input.content);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.hash);
    expect(after.dev).toBe(opened.dev);
    expect(after.ino).toBe(opened.ino);
    expect(after.ctimeNs).toBe(opened.ctimeNs);
    expect(after.nlink).toBe(1n);
    expect(
      readdirSync(join(f.profilePath, 'blobs')).some((name) => name.startsWith('.publish-')),
    ).toBe(false);
  } finally {
    returnReply();
    await Promise.allSettled([publishing]);
    await reader?.return?.();
    f.store.registerArtifact = originalRegister;
  }
});
