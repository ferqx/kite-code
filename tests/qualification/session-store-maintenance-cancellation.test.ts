import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKiteSessionStoreSchema,
  initializeKiteHomeStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../../packages/runtime-storage-sqlite/src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../../packages/runtime-storage-sqlite/src/kite-session-maintenance';
import { prepareKiteSessionStore } from '../../packages/runtime-storage-sqlite/src/kite-session-store-preparation';
import {
  inspectKiteSessionPublication,
  resumeKiteSessionPublication,
} from '../../packages/runtime-storage-sqlite/src/kite-session-store-publication';
import { inspectKiteSessionStoreSources } from '../../packages/runtime-storage-sqlite/src/kite-session-store-sources';

const holder = join(
  import.meta.dir,
  '../../packages/runtime-storage-sqlite/test/fixtures/kite-session-maintenance-child.ts',
);
const crashedPublisher = join(import.meta.dir, 'fixtures/session-store-publication-child.ts');
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-maintenance-cancel-')));
  const canonicalPath = join(root, 'kite-session.sqlite');
  const historicalPath = join(root, 'kite.sqlite');
  using canonical = new Database(canonicalPath, { strict: true });
  initializeKiteSessionStoreIfNeeded(canonical);
  chmodSync(canonicalPath, 0o600);
  using historical = new Database(historicalPath, { strict: true });
  initializeKiteHomeStoreSchema(historical);
  chmodSync(historicalPath, 0o600);
  return {
    root,
    canonicalPath,
    historicalPath,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function ready(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

function makeCandidate(root: string): void {
  const migrationDirectory = join(
    root,
    'session-store-recovery',
    'migration-0123456789abcdef01234567',
  );
  const candidateDirectory = join(migrationDirectory, 'converted-0');
  mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(root, 'session-store-recovery'), 0o700);
  chmodSync(migrationDirectory, 0o700);
  chmodSync(candidateDirectory, 0o700);
  const candidatePath = join(candidateDirectory, 'kite-session.sqlite');
  using candidate = new Database(candidatePath, { strict: true });
  initializeKiteSessionStoreIfNeeded(candidate);
  chmodSync(candidatePath, 0o600);
}

describe.skipIf(process.platform === 'win32')('Store process termination and contention', () => {
  test('a shared client blocks migration; termination releases its OS lock for one retry', async () => {
    const data = fixture();
    const marker = join(data.root, 'holder-ready');
    const child = Bun.spawn(
      [process.execPath, holder, data.canonicalPath, 'shared', 'hold', marker],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    try {
      await ready(marker);
      const input = {
        databasePath: data.canonicalPath,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
      };
      await expect(prepareKiteSessionStore(input)).rejects.toThrow(
        expect.objectContaining({ code: 'store_busy' }),
      );
      expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([data.historicalPath]);
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
      child.kill();
      await child.exited;
      expect(await prepareKiteSessionStore(input)).toEqual({ status: 'prepared' });
      expect(await prepareKiteSessionStore(input)).toEqual({ status: 'current' });
      expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([]);
    } finally {
      child.kill();
      await child.exited;
      data.close();
    }
  }, 20_000);

  test('crashed exclusive publisher releases locks and another process resumes the same intent', async () => {
    const data = fixture();
    makeCandidate(data.root);
    try {
      const child = Bun.spawn([process.execPath, crashedPublisher, data.root], {
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const code = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(code).toBe(75);
      expect(stderr).toBe('');
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('pending');
      const locks = [data.canonicalPath, data.historicalPath].map((databasePath) => ({
        databasePath,
        maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
      }));
      try {
        resumeKiteSessionPublication({
          canonicalPath: data.canonicalPath,
          canonicalMaintenance: locks[0]!.maintenance,
          sourceMaintenance: locks,
          validatePublished: assertKiteSessionStoreSchema,
        });
      } finally {
        for (const lock of locks) lock.maintenance.release();
      }
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
      expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([]);
      using published = new Database(data.canonicalPath, { readonly: true });
      assertKiteSessionStoreSchema(published);
      expect(
        published.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_runs').get()
          ?.count,
      ).toBe(0);
    } finally {
      data.close();
    }
  }, 20_000);

  test('second startup cannot pass a durable intent while first publisher is held; cancellation resumes once', async () => {
    const data = fixture();
    makeCandidate(data.root);
    const marker = join(data.root, 'publisher-ready');
    const child = Bun.spawn(
      [process.execPath, crashedPublisher, data.root, 'hold-after-intent', marker],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    try {
      await ready(marker);
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('pending');
      const input = {
        databasePath: data.canonicalPath,
        codec,
        isSettledState: () => true,
        assertRetiredWritersStopped() {},
      };
      await expect(prepareKiteSessionStore(input)).rejects.toThrow(
        expect.objectContaining({ code: 'store_busy' }),
      );
      expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([data.historicalPath]);
      child.kill();
      await child.exited;
      expect(await prepareKiteSessionStore(input)).toEqual({ status: 'resumed' });
      expect(await prepareKiteSessionStore(input)).toEqual({ status: 'current' });
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
      expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([]);
    } finally {
      child.kill();
      await child.exited;
      data.close();
    }
  }, 20_000);
});
