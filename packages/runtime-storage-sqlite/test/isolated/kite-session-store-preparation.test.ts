import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  initializeKiteHomeStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../../src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../../src/kite-session-maintenance';
import { captureKiteSessionPreservationManifest } from '../../src/kite-session-preservation';
import { prepareKiteSessionStore } from '../../src/kite-session-store-preparation';
import {
  captureKiteSessionPublicationSource,
  publishVerifiedKiteSessionCandidate,
} from '../../src/kite-session-store-publication';
import { inspectKiteSessionStoreSources } from '../../src/kite-session-store-sources';
import { KITE_SESSION_STORE11_DDL } from '../../src/kite-session-store11-conversion';

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as { type: string },
  encodeState: JSON.stringify,
  decodeState: JSON.parse,
  eventSummary: () => ({ isSessionNameCandidate: false, searchText: '' }),
  snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 27 }),
  rebindForkState: <T>(state: T) => state,
};
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-preparation-')));
  const databasePath = join(root, 'kite-session.sqlite');
  const paths = [
    databasePath,
    join(root, 'kite.sqlite'),
    join(root, 'source-profiles', '1'.repeat(32), 'kite-session.sqlite'),
  ];
  for (const [index, path] of paths.entries()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new Database(path);
    chmodSync(path, 0o600);
    if (index === 0) initializeKiteSessionStoreIfNeeded(database);
    else if (index === 1) initializeKiteHomeStoreSchema(database);
    else {
      for (const sql of KITE_SESSION_STORE11_DDL) database.run(sql);
      database.run(
        "INSERT INTO kite_meta VALUES ('schema_version', '11'), ('format_epoch', 'kite-session-accepted-runs-2026-09-15')",
      );
      database.run('PRAGMA user_version=11');
    }
    database.close(false);
  }
  return {
    root,
    databasePath,
    paths,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('known-format startup preparation', () => {
  test('publishes one canonical Store and retires historical entries before normal startup', async () => {
    using data = fixture();
    let admissions = 0;
    const input = {
      ...data,
      codec,
      isSettledState: () => true,
      nowMs: 500,
      assertRetiredWritersStopped: () => {
        admissions++;
      },
    };
    expect(await prepareKiteSessionStore(input)).toEqual({ status: 'prepared' });
    expect(admissions).toBe(2);
    expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
    expect(await prepareKiteSessionStore(input)).toEqual({ status: 'current' });
    expect(admissions).toBe(2);
    using database = new Database(data.databasePath, { readonly: true });
    expect(database.query("SELECT value FROM kite_meta WHERE key='schema_version'").get()).toEqual({
      value: '10',
    });
  });
  test('writer admission lease spans candidate validation and publication and is released on success', async () => {
    using data = fixture();
    const phases: string[] = [];
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => {
          phases.push('acquired');
          return {
            revalidate() {
              expect(existsSync(data.paths[1]!)).toBe(true);
              expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(true);
              phases.push('validated');
            },
            release() {
              expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
              phases.push('released');
            },
          };
        },
      }),
    ).toEqual({ status: 'prepared' });
    expect(phases).toEqual(['acquired', 'validated', 'released']);
  });

  test('reports bounded preparation stages without letting observer failure change publication', async () => {
    using data = fixture();
    const stages: string[] = [];
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
        onProgress(stage) {
          stages.push(stage);
          if (stage === 'preparing') throw new Error('observer failed');
        },
      }),
    ).toEqual({ status: 'prepared' });
    expect(stages).toEqual([
      'inspecting',
      'acquiring_maintenance',
      'preparing',
      'publishing',
      'ready',
    ]);
    expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
  });

  test('failed lease revalidation releases admission without publishing or losing original data', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    let released = false;
    await expect(
      prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => ({
          revalidate() {
            throw new Error('distribution changed');
          },
          release() {
            released = true;
          },
        }),
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'store_history_reconciliation_required',
        stage: 'preparing',
      }),
    );
    expect(released).toBe(true);
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
  });

  test('never archives an empty main file with a nonempty WAL without a verified backup', async () => {
    using data = fixture();
    const historical = data.paths[2]!;
    writeFileSync(historical, '');
    writeFileSync(`${historical}-wal`, 'unresolved committed WAL', { mode: 0o600 });
    const before = data.paths.map((path) => readFileSync(path));
    await expect(
      prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'store_history_reconciliation_required' }));
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(readFileSync(`${historical}-wal`, 'utf8')).toBe('unresolved committed WAL');
    expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(false);
  });

  test('insufficient disk space is rejected before any recovery asset or source change', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    const actual = fs.statfsSync(data.root, { bigint: true });
    const space = spyOn(fs, 'statfsSync').mockReturnValue({ ...actual, bavail: 0n } as never);
    try {
      await expect(
        prepareKiteSessionStore({
          ...data,
          codec,
          isSettledState: () => true,
          assertRetiredWritersStopped() {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'store_insufficient_space' }));
    } finally {
      space.mockRestore();
    }
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(false);
  });

  test('failed writer admission leaves original paths and content intact without creating recovery assets', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    await expect(
      prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {
          throw new Error('old writer still running');
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'store_history_reconciliation_required' }));
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'session-store-recovery'))).toBe(false);
  });

  test('cancellation gate retains maintenance and admission, then leaves sources unchanged', async () => {
    using data = fixture();
    const before = data.paths.map((path) => readFileSync(path));
    let enterGate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterGate = resolve;
    });
    let decide!: (decision: 'commit' | 'cancel') => void;
    const decision = new Promise<'commit' | 'cancel'>((resolve) => {
      decide = resolve;
    });
    let released = false;
    const preparing = prepareKiteSessionStore({
      ...data,
      codec,
      isSettledState: () => true,
      assertRetiredWritersStopped: () => ({
        revalidate() {},
        release() {
          released = true;
        },
      }),
      beforePublication: () => {
        enterGate();
        return decision;
      },
    });
    await entered;
    expect(released).toBe(false);
    expect(() => acquireKiteSessionStoreMaintenance(data.databasePath, 'exclusive')).toThrow(
      expect.objectContaining({ code: 'store_busy' }),
    );
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
    decide('cancel');
    await expect(preparing).rejects.toThrow(
      expect.objectContaining({
        code: 'store_preparation_cancelled',
        stage: 'preparing',
      }),
    );
    expect(released).toBe(true);
    expect(data.paths.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
    acquireKiteSessionStoreMaintenance(data.databasePath, 'exclusive').release();
  });

  test('commit gate revalidates admission after the wait and publishes', async () => {
    using data = fixture();
    const order: string[] = [];
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped: () => ({
          revalidate() {
            order.push('revalidate');
          },
          release() {
            order.push('release');
          },
        }),
        async beforePublication() {
          order.push('gate');
          return 'commit';
        },
      }),
    ).toEqual({ status: 'prepared' });
    expect(order).toEqual(['gate', 'revalidate', 'release']);
    expect(inspectKiteSessionStoreSources(data.databasePath)).toEqual([]);
  });

  test('pending committed publication settles without consulting cancellation gate', async () => {
    using data = fixture();
    const migrationDirectory = join(data.root, 'session-store-recovery', 'migration-test');
    mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
    const candidateDirectory = join(migrationDirectory, 'converted-0');
    mkdirSync(candidateDirectory, { mode: 0o700 });
    const candidatePath = join(candidateDirectory, 'kite-session.sqlite');
    copyFileSync(data.databasePath, candidatePath);
    chmodSync(candidatePath, 0o600);
    using candidate = new Database(candidatePath, { readonly: true });
    const candidateManifest = captureKiteSessionPreservationManifest(candidate);
    const sources = data.paths.map((databasePath) => ({
      databasePath,
      files: captureKiteSessionPublicationSource(data.databasePath, databasePath),
      maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
    }));
    try {
      expect(() =>
        publishVerifiedKiteSessionCandidate({
          canonicalPath: data.databasePath,
          canonicalMaintenance: sources[0]!.maintenance,
          candidatePath,
          candidateManifest,
          migrationDirectory,
          sources,
          validatePublished: () => {},
          fault(point) {
            if (point === 'intent_directory_fsync') throw new Error('simulated crash');
          },
        }),
      ).toThrow('simulated crash');
    } finally {
      for (const source of sources.reverse()) source.maintenance.release();
    }
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(true);
    let gateCalls = 0;
    expect(
      await prepareKiteSessionStore({
        ...data,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
        async beforePublication() {
          gateCalls++;
          return 'cancel';
        },
      }),
    ).toEqual({ status: 'resumed' });
    expect(gateCalls).toBe(0);
    expect(existsSync(join(data.root, 'kite-session-publication.json'))).toBe(false);
  });
});
