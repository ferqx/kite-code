import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeKiteHomeStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../../src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../../src/kite-session-maintenance';
import { createKiteSessionStoreCandidate } from '../../src/kite-session-store-candidate';
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-candidate-')));
  const sources = [10, 9, 11].map((version, index) => {
    const parent = join(root, `source-${index}`);
    mkdirSync(parent, { mode: 0o700 });
    const databasePath = join(parent, version === 9 ? 'kite.sqlite' : 'kite-session.sqlite');
    const database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    if (version === 9) initializeKiteHomeStoreSchema(database);
    else if (version === 10) initializeKiteSessionStoreIfNeeded(database);
    else {
      for (const sql of KITE_SESSION_STORE11_DDL) database.run(sql);
      database.run(
        "INSERT INTO kite_meta VALUES ('schema_version', '11'), ('format_epoch', 'kite-session-accepted-runs-2026-09-15')",
      );
      database.run('PRAGMA user_version=11');
    }
    database
      .query(
        `INSERT INTO workspaces(workspace_id, canonical_path, workspace_identity_digest, project_id, workspace_digest, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Fixture', 1, 1)`,
      )
      .run(
        `workspace-${index}`,
        `/workspace/${index}`,
        `sha256:${String(index).repeat(64)}`,
        `project-${index}`,
        `digest-${index}`,
      );
    database.close(false);
    return {
      databasePath,
      maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
    };
  });
  const migrationDirectory = join(root, 'migration');
  mkdirSync(migrationDirectory, { mode: 0o700 });
  return {
    root,
    sources,
    migrationDirectory,
    [Symbol.dispose]() {
      for (const source of sources) source.maintenance.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('private known-format candidate preparation', () => {
  test('converts and merges known layouts while preserving the immutable source backups', () => {
    using data = fixture();
    const before = data.sources.map((source) => readFileSync(source.databasePath));
    let validationCalls = 0;
    const candidate = createKiteSessionStoreCandidate({
      ...data,
      codec,
      isSettledState: () => true,
      nowMs: 500,
      validate: () => {
        validationCalls++;
      },
    });
    expect(candidate.manifest.tables.workspaces?.rows).toBe(3);
    expect(candidate.backups.map((backup) => backup.manifest.capture.schemaVersion)).toEqual([
      10, 9, 11,
    ]);
    expect(validationCalls).toBe(5);
    for (const [index, source] of data.sources.entries()) {
      expect(readFileSync(source.databasePath)).toEqual(before[index]!);
      expect(() => acquireKiteSessionStoreMaintenance(source.databasePath, 'shared')).toThrow();
    }
    using database = new Database(candidate.databasePath, { readonly: true });
    expect(database.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
  });

  test('failure in merged production validation never publishes or modifies an original', () => {
    using data = fixture();
    const before = data.sources.map((source) => readFileSync(source.databasePath));
    expect(() =>
      createKiteSessionStoreCandidate({
        ...data,
        codec,
        isSettledState: () => true,
        nowMs: 500,
        validate(database) {
          if (
            database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM workspaces').get()
              ?.count === 3
          )
            throw new Error('invalid relation');
        },
      }),
    ).toThrow('invalid relation');
    for (const [index, source] of data.sources.entries())
      expect(readFileSync(source.databasePath)).toEqual(before[index]!);
  });
});
