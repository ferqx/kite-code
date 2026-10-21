import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { artifactPath } from '../../../src/artifacts-files';
import { openSqliteStore } from '../../../src/sqlite';

test('same Store metadata and query progress during complete blob verification; close drains original registration', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-register-progress-')));
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'owned' };
  const store = await openSqliteStore(profile);
  let closed = false;
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: 'file:///owned',
    });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'owned',
      subjectId: 'owner',
    });
    const bytes = Buffer.alloc(32 * 1024 * 1024, 97);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const path = artifactPath(join(dataRoot, 'owned'), hash);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o400 });
    const input = {
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session' as const, id: 's' },
      refId: 'actual-large',
      hash,
      size: String(bytes.length),
      mediaType: 'text/plain',
    };
    let registered = false;
    let metadataBeforeRegistration = false;
    let viewBeforeRegistration = false;
    const registration = store.registerArtifact(input).then((value) => {
      registered = true;
      return value;
    });
    const metadata = store.getMetadata().then((value) => {
      metadataBeforeRegistration = !registered;
      return value;
    });
    const view = store.getView('s').then((value) => {
      viewBeforeRegistration = !registered;
      return value;
    });
    const closing = store.close().then(() => {
      closed = true;
    });
    const [reference, observed, snapshot] = await Promise.all([registration, metadata, view]);
    expect(metadataBeforeRegistration).toBe(true);
    expect(viewBeforeRegistration).toBe(true);
    expect(observed.storeId).toBe(expectedStoreId);
    expect(snapshot.session.id).toBe('s');
    expect(reference.hash).toBe(hash);
    await closing;
    expect(closed).toBe(true);
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect(await cold.getArtifactReference(input)).toEqual(reference);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(hash);
    } finally {
      await cold.close();
    }
  } finally {
    await store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 15000);

for (const fault of ['bytes', 'scope', 'verified-bytes', 'begin-bytes'] as const) {
  test(`a yielded original verifier rejects ${fault} drift with zero reference effects`, async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-register-drift-')));
    chmodSync(dataRoot, 0o700);
    const profile = { dataRoot, profile: 'owned' };
    const NativeWorker = globalThis.Worker;
    let fixtureWorker: Worker | undefined;
    let armed!: () => void;
    let yielded!: () => void;
    let mutatedInsideTransaction = false;
    const registrationAcks: { id: number; code?: string }[] = [];
    const arm = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const boundary = new Promise<void>((resolve) => {
      yielded = resolve;
    });
    class AuditedWorker extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof NativeWorker>) {
        super(new URL('./artifact-verification-worker-fixture.ts', import.meta.url).href, args[1]);
        fixtureWorker = this;
        this.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.fixture === 'verification-armed') armed();
          if (event.data?.fixture === 'verification-yielded') yielded();
          if (event.data?.fixture === 'verified-writer-wait') yielded();
          if (event.data?.fixture === 'after-successful-begin')
            mutatedInsideTransaction = event.data.inTransaction === true;
          if (event.data?.timing?.operation === 'registerArtifact')
            registrationAcks.push({ id: event.data.id, code: event.data.error?.code });
        });
      }
    }
    globalThis.Worker = AuditedWorker;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let peer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let writer: Database | undefined;
    try {
      store = await openSqliteStore(profile);
      globalThis.Worker = NativeWorker;
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: 'file:///owned',
      });
      await store.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'owned',
        subjectId: 'owner',
      });
      const bytes = Buffer.alloc(16 * 1024 * 1024, 97);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const path = artifactPath(join(dataRoot, 'owned'), hash);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o400 });
      const input = {
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        scope: { kind: 'session' as const, id: 's' },
        refId: 'must-not-register',
        hash,
        size: String(bytes.length),
        mediaType: 'text/plain',
      };
      if (fault === 'verified-bytes') {
        writer = new Database(join(dataRoot, 'owned', 'core.db'));
        writer.run('BEGIN IMMEDIATE');
      }
      fixtureWorker!.postMessage({
        fixture:
          fault === 'verified-bytes'
            ? 'arm-writer-wait'
            : fault === 'begin-bytes'
              ? 'arm-before-callback'
              : 'arm-verification',
      });
      await arm;
      let settled = false;
      const registration = store.registerArtifact(input).finally(() => {
        settled = true;
      });
      // Observe a real first verification segment; only this isolated Worker
      // holds its continuation until the exact fault is installed.
      await boundary;
      expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
      expect(settled).toBe(false);
      const db = new Database(join(dataRoot, 'owned', 'core.db'), { readonly: true });
      try {
        expect(db.query('SELECT count(*) AS n FROM blob_ref').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      if (fault === 'bytes' || fault === 'verified-bytes') {
        chmodSync(path, 0o600);
        writeFileSync(path, Buffer.alloc(bytes.length, 98));
        chmodSync(path, 0o400);
      } else if (fault === 'scope') {
        peer = await openSqliteStore(profile);
        const session = (await peer.getSession('s'))!;
        await peer.deleteSession({
          expectedStoreId,
          subjectId: 'owner',
          commandId: 'delete',
          sessionId: 's',
          ifRevision: session.controlRevision,
        });
      }
      if (writer) {
        writer.run('ROLLBACK');
        writer.close();
        writer = undefined;
      }
      fixtureWorker!.postMessage({ fixture: 'resume-verification' });
      let rejected: unknown;
      try {
        await registration;
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toMatchObject({
        code: fault !== 'scope' ? 'artifact_content_mismatch' : 'artifact_scope_denied',
      });
      if (fault === 'begin-bytes') expect(mutatedInsideTransaction).toBe(true);
      expect(registrationAcks).toHaveLength(1);
      expect(registrationAcks[0]!.id).toBeGreaterThan(0);
      expect(registrationAcks[0]!.code).toBe(
        fault === 'scope' ? 'artifact_scope_denied' : 'artifact_content_mismatch',
      );
      const after = new Database(join(dataRoot, 'owned', 'core.db'), { readonly: true });
      try {
        expect(after.query('SELECT count(*) AS n FROM blob_ref').get()).toEqual({ n: 0 });
        expect(after.query('SELECT count(*) AS n FROM blob').get()).toEqual({ n: 0 });
      } finally {
        after.close();
      }
      expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
    } finally {
      globalThis.Worker = NativeWorker;
      fixtureWorker?.postMessage({ fixture: 'resume-verification' });
      if (writer) {
        if (writer.inTransaction) writer.run('ROLLBACK');
        writer.close();
      }
      await peer?.close();
      await store?.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 15000);
}
