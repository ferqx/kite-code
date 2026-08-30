import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKiteHomeRuntimeStorage, SQLITE_RUNTIME_RUN_FORMAT_EPOCH } from '../src';

type Event = { readonly type: string };
type State = {
  readonly revision: number;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <Loaded>(json: string) => JSON.parse(json) as Loaded,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 27 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  rebindForkState: (state: State) => state,
  isCurrentPendingInteractionRequest: () => false,
};

describe('physical Kite Home Runtime Store owner', () => {
  test('creates and reopens only canonical kite.sqlite with WAL companions', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-home-store-')));
    const path = join(root, 'kite.sqlite');
    try {
      const first = openKiteHomeRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        stateSchemaVersion: 27,
        formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      });
      expect(readdirSync(root).every((name) => /^kite\.sqlite(?:-(?:wal|shm))?$/u.test(name))).toBe(
        true,
      );
      expect(
        first.database
          .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key = 'schema_version'")
          .get()?.value,
      ).toBe('9');
      first.close();

      const reopened = openKiteHomeRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        stateSchemaVersion: 27,
        formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      });
      expect(reopened.storage.storeSchemaVersion).toBe(9);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects alternate basenames, symlinks and permissive existing files', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-home-store-invalid-')));
    try {
      expect(() =>
        openKiteHomeRuntimeStorage<Event, State>({
          databasePath: join(root, 'checkpoints.sqlite'),
          codec,
          stateSchemaVersion: 27,
          formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
        }),
      ).toThrow('kite.sqlite');

      const target = join(root, 'target');
      writeFileSync(target, '', { mode: 0o600 });
      symlinkSync(target, join(root, 'kite.sqlite'));
      expect(() =>
        openKiteHomeRuntimeStorage<Event, State>({
          databasePath: join(root, 'kite.sqlite'),
          codec,
          stateSchemaVersion: 27,
          formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
        }),
      ).toThrow('symlink');
      rmSync(join(root, 'kite.sqlite'));

      writeFileSync(join(root, 'kite.sqlite'), '', { mode: 0o644 });
      chmodSync(join(root, 'kite.sqlite'), 0o644);
      if (process.platform !== 'win32') {
        expect(() =>
          openKiteHomeRuntimeStorage<Event, State>({
            databasePath: join(root, 'kite.sqlite'),
            codec,
            stateSchemaVersion: 27,
            formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
          }),
        ).toThrow('owner-only');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
