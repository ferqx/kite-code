import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
  expect(await f.artifact.publish(input)).toEqual(ref);
  const secondType = await f.artifact.publish({
    ...input,
    refId: 'same-bytes-other-type',
    mediaType: 'application/octet-stream',
  });
  expect(secondType.hash).toBe(ref.hash);
  expect(secondType.mediaType).toBe('application/octet-stream');
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
  const inFlight = Array.from({ length: 8 }, (_, i) =>
    f.artifact.publish({ ...common, refId: `bound-${i}` }),
  );
  await code(f.artifact.publish({ ...common, refId: 'refused' }), 'artifact_busy');
  const closing = f.artifact.close();
  await code(f.artifact.publish({ ...common, refId: 'after-close' }), 'artifact_closed');
  await Promise.all(inFlight);
  await closing;
  expect(await f.store.getArtifactReference({ ...common, refId: 'refused' })).toBeNull();
  expect(await f.store.getArtifactReference({ ...common, refId: 'bound-7' })).not.toBeNull();
});
