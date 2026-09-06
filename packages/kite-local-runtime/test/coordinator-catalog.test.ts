import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoordinatorCatalogStorageIdentity,
  copyCoordinatorCatalogGeneration,
  openCoordinatorCatalog,
} from '@kite-ai/kite-local-runtime/coordinator';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storage(
  mode: CoordinatorCatalogStorageIdentity['mode'] = 'initialize_target',
  beforeWrite?: () => void,
): CoordinatorCatalogStorageIdentity {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-catalog-')));
  roots.push(root);
  const generation = 'generation-1';
  mkdirSync(join(root, 'layouts', generation), { recursive: true, mode: 0o700 });
  return {
    canonicalKiteHomeRoot: root,
    layoutGeneration: generation,
    catalogPath: join(root, 'layouts', generation, 'catalog.sqlite'),
    mode,
    ...(beforeWrite === undefined ? {} : { beforeWrite }),
  };
}

describe('Coordinator durable routing Catalog', () => {
  test('persists only path-free Session routing and outbox cursors', () => {
    const identity = storage();
    const catalog = openCoordinatorCatalog(identity);
    catalog.upsertSession({
      sessionId: 'session-1',
      workerScopeId: 'worker-scope-1',
      directoryRevision: 'revision-1',
      updatedAt: '2026-08-29T00:00:00.000Z',
      tombstone: false,
    });
    expect(catalog.advanceOutboxCursor('worker-scope-1', undefined, 'cursor-1')).toBe(true);
    expect(catalog.advanceOutboxCursor('worker-scope-1', undefined, 'cursor-2')).toBe(false);
    catalog.close();

    let writes = 0;
    const reopened = openCoordinatorCatalog({
      ...identity,
      mode: 'open_active',
      beforeWrite: () => {
        writes += 1;
      },
    });
    expect(reopened.listSessions()).toEqual([
      {
        sessionId: 'session-1',
        workerScopeId: 'worker-scope-1',
        directoryRevision: 'revision-1',
        updatedAt: '2026-08-29T00:00:00.000Z',
        tombstone: false,
      },
    ]);
    expect(reopened.outboxCursor('worker-scope-1')).toBe('cursor-1');
    reopened.removeSession('session-1');
    expect(writes).toBe(1);
    expect(JSON.stringify(reopened.listSessions())).not.toContain('/');
    reopened.close();
  });

  test('persists idempotency state without storing a capability response', () => {
    const catalog = openCoordinatorCatalog(storage());
    const operation = {
      idempotencyKey: 'mint-capability-1',
      method: 'mintWorkerConnectionCapability',
      requestDigest: 'a'.repeat(64),
    } as const;
    expect(catalog.admitOperation(operation)).toEqual({ status: 'new' });
    expect(catalog.admitOperation(operation)).toEqual({ status: 'in_progress' });
    catalog.settleOperation(operation, 'outcome_unknown');
    expect(catalog.admitOperation(operation)).toEqual({ status: 'outcome_unknown' });
    expect(catalog.admitOperation({ ...operation, requestDigest: 'b'.repeat(64) })).toEqual({
      status: 'digest_mismatch',
    });
    catalog.close();
  });

  test('requires an explicit active-layout identity and one process writer', () => {
    const identity = storage();
    const catalog = openCoordinatorCatalog(identity);
    expect(() => openCoordinatorCatalog(identity)).toThrow('target must be absent');
    catalog.close();
    const active = openCoordinatorCatalog({
      ...identity,
      mode: 'open_active',
      beforeWrite: () => undefined,
    });
    expect(() =>
      openCoordinatorCatalog({
        ...identity,
        mode: 'open_active',
        beforeWrite: () => undefined,
      }),
    ).toThrow('process writer');
    active.close();
    expect(() =>
      openCoordinatorCatalog({
        ...identity,
        catalogPath: join(identity.canonicalKiteHomeRoot, 'coordinator', 'v1', 'catalog.sqlite'),
      }),
    ).toThrow('active layout');
  });

  test('rejects hardlinked Catalog state and active writes without a layout fence', () => {
    const identity = storage();
    const catalog = openCoordinatorCatalog(identity);
    catalog.close();

    const active = openCoordinatorCatalog({ ...identity, mode: 'open_active' });
    expect(active.listSessions()).toEqual([]);
    expect(() =>
      active.upsertSession({
        sessionId: 'session-1',
        workerScopeId: 'scope-1',
        directoryRevision: 'revision-1',
        updatedAt: '2026-08-29T00:00:00.000Z',
        tombstone: false,
      }),
    ).toThrow('write-fence');
    active.close();

    linkSync(identity.catalogPath, `${identity.catalogPath}.alias`);
    expect(() =>
      openCoordinatorCatalog({
        ...identity,
        mode: 'open_active',
        beforeWrite: () => undefined,
      }),
    ).toThrow('unsafe');
  });

  test('persists strict profile and layout-generation metadata in the digest', () => {
    const identity = storage();
    const catalog = openCoordinatorCatalog(identity);
    catalog.close();
    const firstDigest = createHash('sha256')
      .update(readFileSync(identity.catalogPath))
      .digest('hex');

    const database = new Database(identity.catalogPath);
    expect(
      database
        .query('SELECT schema, profile, layout_generation FROM coordinator_catalog_metadata')
        .all(),
    ).toEqual([
      {
        schema: 'kite.local-coordinator-catalog.v1',
        profile: 'kite-coordinator-workspace-worker-web-v1-2026-08-28',
        layout_generation: 'generation-1',
      },
    ]);
    database.close();

    const reopened = openCoordinatorCatalog({
      ...identity,
      mode: 'open_active',
      beforeWrite: () => undefined,
    });
    reopened.close();
    expect(createHash('sha256').update(readFileSync(identity.catalogPath)).digest('hex')).toBe(
      firstDigest,
    );

    const tampered = new Database(identity.catalogPath);
    tampered.run(
      "UPDATE coordinator_catalog_metadata SET layout_generation = 'generation-2' WHERE catalog_id = 1",
    );
    tampered.close();
    expect(() =>
      openCoordinatorCatalog({
        ...identity,
        mode: 'open_active',
        beforeWrite: () => undefined,
      }),
    ).toThrow('metadata');
  });

  test('copies every Catalog fact while rebinding only the layout generation', () => {
    const sourceIdentity = storage();
    const source = openCoordinatorCatalog(sourceIdentity);
    source.upsertSession({
      sessionId: 'session-copy',
      workerScopeId: 'worker-copy',
      directoryRevision: 'revision-copy',
      updatedAt: '2026-08-30T00:00:00.000Z',
      tombstone: false,
    });
    expect(source.advanceOutboxCursor('worker-copy', undefined, 'cursor-copy')).toBe(true);
    const operation = {
      idempotencyKey: 'operation-copy',
      method: 'ensureWorkspaceWorker',
      requestDigest: 'c'.repeat(64),
    } as const;
    expect(source.admitOperation(operation)).toEqual({ status: 'new' });
    source.settleOperation(operation, 'committed');
    source.close();
    const sourceBytes = readFileSync(sourceIdentity.catalogPath);

    const targetGeneration = 'generation-2';
    const targetPath = join(
      sourceIdentity.canonicalKiteHomeRoot,
      'layouts',
      targetGeneration,
      'catalog.sqlite',
    );
    mkdirSync(join(sourceIdentity.canonicalKiteHomeRoot, 'layouts', targetGeneration), {
      mode: 0o700,
    });
    const digest = copyCoordinatorCatalogGeneration({
      canonicalKiteHomeRoot: sourceIdentity.canonicalKiteHomeRoot,
      sourceLayoutGeneration: sourceIdentity.layoutGeneration,
      targetLayoutGeneration: targetGeneration,
      sourceCatalogPath: sourceIdentity.catalogPath,
      targetCatalogPath: targetPath,
      expectedWorkerScopeIds: ['worker-copy'],
    });
    expect(createHash('sha256').update(readFileSync(targetPath)).digest('hex')).toBe(digest);
    expect(readFileSync(sourceIdentity.catalogPath)).toEqual(sourceBytes);

    const target = openCoordinatorCatalog({
      canonicalKiteHomeRoot: sourceIdentity.canonicalKiteHomeRoot,
      layoutGeneration: targetGeneration,
      catalogPath: targetPath,
      mode: 'open_active',
      beforeWrite: () => undefined,
    });
    expect(target.listSessions()).toEqual([
      {
        sessionId: 'session-copy',
        workerScopeId: 'worker-copy',
        directoryRevision: 'revision-copy',
        updatedAt: '2026-08-30T00:00:00.000Z',
        tombstone: false,
      },
    ]);
    expect(target.outboxCursor('worker-copy')).toBe('cursor-copy');
    expect(target.admitOperation(operation)).toEqual({ status: 'committed' });
    target.close();
  });

  test('refuses generation copy with an unsettled operation or unowned Workspace route', () => {
    const sourceIdentity = storage();
    const source = openCoordinatorCatalog(sourceIdentity);
    source.upsertSession({
      sessionId: 'session-unowned',
      workerScopeId: 'worker-unowned',
      directoryRevision: 'revision-1',
      updatedAt: '2026-08-30T00:00:00.000Z',
      tombstone: false,
    });
    source.admitOperation({
      idempotencyKey: 'operation-pending',
      method: 'ensureWorkspaceWorker',
      requestDigest: 'd'.repeat(64),
    });
    source.close();
    const targetGeneration = 'generation-blocked';
    const targetPath = join(
      sourceIdentity.canonicalKiteHomeRoot,
      'layouts',
      targetGeneration,
      'catalog.sqlite',
    );
    mkdirSync(join(sourceIdentity.canonicalKiteHomeRoot, 'layouts', targetGeneration), {
      mode: 0o700,
    });
    expect(() =>
      copyCoordinatorCatalogGeneration({
        canonicalKiteHomeRoot: sourceIdentity.canonicalKiteHomeRoot,
        sourceLayoutGeneration: sourceIdentity.layoutGeneration,
        targetLayoutGeneration: targetGeneration,
        sourceCatalogPath: sourceIdentity.catalogPath,
        targetCatalogPath: targetPath,
        expectedWorkerScopeIds: ['another-worker'],
      }),
    ).toThrow(/unowned Workspace|unsettled operation/u);
    expect(() => readFileSync(targetPath)).toThrow();

    const pendingGeneration = 'generation-pending';
    const pendingPath = join(
      sourceIdentity.canonicalKiteHomeRoot,
      'layouts',
      pendingGeneration,
      'catalog.sqlite',
    );
    mkdirSync(join(sourceIdentity.canonicalKiteHomeRoot, 'layouts', pendingGeneration), {
      mode: 0o700,
    });
    expect(() =>
      copyCoordinatorCatalogGeneration({
        canonicalKiteHomeRoot: sourceIdentity.canonicalKiteHomeRoot,
        sourceLayoutGeneration: sourceIdentity.layoutGeneration,
        targetLayoutGeneration: pendingGeneration,
        sourceCatalogPath: sourceIdentity.catalogPath,
        targetCatalogPath: pendingPath,
        expectedWorkerScopeIds: ['worker-unowned'],
      }),
    ).toThrow('unsettled operation');
    expect(() => readFileSync(pendingPath)).toThrow();
  });

  test('rejects an active target generation before creating a new Catalog', () => {
    const identity = storage();
    writeFileSync(
      join(identity.canonicalKiteHomeRoot, 'active-layout'),
      JSON.stringify({
        schema: 'kite.runtime-active-layout.v1',
        generation: identity.layoutGeneration,
      }),
      { mode: 0o600 },
    );
    expect(() => openCoordinatorCatalog(identity)).toThrow('already active');
    expect(() => readFileSync(identity.catalogPath)).toThrow();
  });

  test('rejects existing target entries, including dangling symlinks, for initialize_target', () => {
    const identity = storage();
    writeFileSync(identity.catalogPath, 'existing', { mode: 0o600 });
    expect(() => openCoordinatorCatalog(identity)).toThrow('target must be absent');
    rmSync(identity.catalogPath);
    symlinkSync('missing-target', identity.catalogPath);
    expect(() => openCoordinatorCatalog(identity)).toThrow(/unsafe|target must be absent/u);

    const sidecarIdentity = storage();
    writeFileSync(`${sidecarIdentity.catalogPath}-wal`, 'pre-existing', { mode: 0o600 });
    expect(() => openCoordinatorCatalog(sidecarIdentity)).toThrow('pre-existing SQLite sidecar');
    expect(() => readFileSync(sidecarIdentity.catalogPath)).toThrow();
  });

  test('fails close when a SQLite sidecar remains and releases the writer claim', () => {
    const identity = storage();
    const catalog = openCoordinatorCatalog(identity);
    writeFileSync(`${identity.catalogPath}-wal`, 'unexpected', { mode: 0o600 });
    expect(() => catalog.close()).toThrow('sidecar');
    chmodSync(`${identity.catalogPath}-wal`, 0o600);
    rmSync(`${identity.catalogPath}-wal`, { force: true });
    const reopened = openCoordinatorCatalog({
      ...identity,
      mode: 'open_active',
      beforeWrite: () => undefined,
    });
    reopened.close();
  });
});
