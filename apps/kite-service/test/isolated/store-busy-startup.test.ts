import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireKiteSessionStoreMaintenance,
  type KiteSessionMaintenanceLock,
} from '@kite-ai/runtime-storage-sqlite';
import { KITE_SESSION_STORE11_DDL } from '../../../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import {
  createKiteSessionAppServerStorageComposition,
  type KiteStoreStartupProgress,
} from '../../src/bootstrap';

type StartupStage = Parameters<KiteStoreStartupProgress>[0];

function busyStore(): {
  root: string;
  databasePath: string;
  release(): void;
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-store-busy-startup-'));
  const databasePath = join(root, 'kite-session.sqlite');
  let lock: KiteSessionMaintenanceLock | undefined = acquireKiteSessionStoreMaintenance(
    databasePath,
    'exclusive',
  );
  return {
    root,
    databasePath,
    release() {
      lock?.release();
      lock = undefined;
    },
  };
}

test('Service retries a genuinely busy Store and opens it after maintenance releases', async () => {
  const fixture = busyStore();
  const stages: StartupStage[] = [];
  const release = setTimeout(() => fixture.release(), 450);
  try {
    const owner = await createKiteSessionAppServerStorageComposition({
      databasePath: fixture.databasePath,
      hostInstanceId: 'busy-release',
      onStoreStartupProgress: (stage) => {
        stages.push(stage);
      },
    });
    try {
      expect(stages).toContain('waiting_for_store');
      expect(stages.at(-1)).toBe('ready');
      expect(existsSync(fixture.databasePath)).toBe(true);
    } finally {
      owner.disposeStorage();
    }
  } finally {
    clearTimeout(release);
    fixture.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Service preserves explicit busy after deadline without creating an empty Store', async () => {
  const fixture = busyStore();
  const stages: StartupStage[] = [];
  try {
    await expect(
      createKiteSessionAppServerStorageComposition({
        databasePath: fixture.databasePath,
        hostInstanceId: 'busy-timeout',
        onStoreStartupProgress: (stage) => {
          stages.push(stage);
        },
      }),
    ).rejects.toMatchObject({ code: 'store_busy', stage: 'waiting_for_store' });
    expect(stages).toContain('waiting_for_store');
    expect(stages).not.toContain('ready');
    expect(existsSync(fixture.databasePath)).toBe(false);
  } finally {
    fixture.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 15_000);

test('Service stops waiting on startup cancellation and leaves no maintenance owner', async () => {
  const fixture = busyStore();
  let shouldStop = false;
  const stages: StartupStage[] = [];
  try {
    await expect(
      createKiteSessionAppServerStorageComposition({
        databasePath: fixture.databasePath,
        hostInstanceId: 'busy-cancel',
        shouldStopStartup: () => shouldStop,
        onStoreStartupProgress: (stage) => {
          stages.push(stage);
          if (stage === 'waiting_for_store') shouldStop = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'store_preparation_cancelled' });
    expect(stages).toContain('waiting_for_store');
    expect(stages).not.toContain('ready');
    expect(existsSync(fixture.databasePath)).toBe(false);
    fixture.release();
    const successor = acquireKiteSessionStoreMaintenance(fixture.databasePath, 'exclusive');
    successor.release();
  } finally {
    fixture.release();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a stop after an earlier busy wait and publication does not replay stale busy', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-store-published-stop-'));
  const databasePath = join(root, 'kite-session.sqlite');
  const oldStore = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  for (const sql of KITE_SESSION_STORE11_DDL) oldStore.run(sql);
  oldStore.run(
    "INSERT INTO kite_meta VALUES ('schema_version', '11'), ('format_epoch', 'kite-session-accepted-runs-2026-09-15')",
  );
  oldStore.run('PRAGMA user_version=11');
  oldStore.close(false);
  const blocker = acquireKiteSessionStoreMaintenance(databasePath, 'exclusive');
  const release = setTimeout(() => blocker.release(), 400);
  let stopRequested = false;
  const stages: StartupStage[] = [];
  try {
    const owner = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'published-stop',
      shouldStopStartup: () => stopRequested,
      onStoreStartupProgress: (stage) => {
        stages.push(stage);
      },
      assertRetiredStoreWritersStopped: () => ({
        revalidate() {},
        release() {
          stopRequested = true;
        },
      }),
    });
    try {
      expect(stopRequested).toBe(true);
      expect(stages).toContain('waiting_for_store');
      expect(stages.at(-1)).toBe('ready');
      const current = new Database(databasePath, { readonly: true });
      try {
        expect(
          current.query("SELECT value FROM kite_meta WHERE key='schema_version'").get(),
        ).toEqual({
          value: '10',
        });
      } finally {
        current.close(false);
      }
    } finally {
      owner.disposeStorage();
    }
  } finally {
    clearTimeout(release);
    blocker.release();
    rmSync(root, { recursive: true, force: true });
  }
});
