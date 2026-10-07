import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { canonicalJson } from '../../../src/json';
import { type inspectProfileBackup, inspectProfileRestore } from '../../../src/maintenance';
import { runProfileRestore } from '../../../src/maintenance/restore';
import { openBackupDatabase } from '../../../src/maintenance/sqlite';
import { acquireProfileAccess, selectProfile } from '../../../src/platform/profile';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../src/platform/windows-path-security';
import { openSqliteStore } from '../../../src/sqlite';

let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  if (process.platform === 'win32') qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-cli-maintenance-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let artifacts: ReturnType<typeof createArtifactStore> | undefined;
  try {
    store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'owned',
    });
    await store.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      subjectId: 'owner',
      title: 'original title',
    });
    await store.acceptCommand({
      expectedStoreId: storeId,
      sessionId: 's',
      commandId: 'pending',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'original pending work' },
    });
    artifacts = createArtifactStore({ profile, store });
    const bytes = Buffer.from(`original-${'a'.repeat(17 * 1024 * 1024)}-tail`);
    const media = {
      expectedStoreId: storeId,
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session' as const, id: 's' },
      refId: 'original',
      mediaType: 'application/octet-stream',
    };
    const published = await artifacts.publishStream({
      ...media,
      content: (async function* () {
        for (let index = 0; index < bytes.length; index += 65536)
          yield bytes.subarray(index, index + 65536);
      })(),
    });
    await artifacts.close();
    artifacts = undefined;
    await store.close();
    store = undefined;
    const selected = selectProfile(profile);
    const native = defaultWindowsPathSecurity()!;
    const config = Buffer.from('// original Café e\u0301\r\n{"unknown":"原文🔐",broken}\r\n');
    native.writePrivateFile(join(selected.profilePath, 'config.jsonc'), config);
    native.writePrivateFile(
      join(selected.profilePath, 'credentials'),
      Buffer.from('owned excluded credential fixture'),
    );
    privateDirectory(join(selected.profilePath, 'ui'));
    const records = Array.from({ length: 64 }, (_, index) => {
      const request = {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: `original_${index}`,
        content: 'x'.repeat(150000),
      };
      const { expectedStoreId: _store, commandId: _command, ...publicRequest } = request;
      return {
        intent: {
          scope: { storeId, workspaceId: 'w', sessionId: 's' },
          request,
          target: { kind: 'session', id: 's' },
          subjectId: 'owner',
          bodyDigest: sha(canonicalJson(request)),
          requestDigest: sha(canonicalJson(publicRequest)),
        },
        phase: 'unknown',
      };
    });
    const intents = Buffer.from(`${JSON.stringify({ version: 1, records })}\n`);
    // More than the bounded scope reader's 8MiB limit: maintenance uses its original file pin.
    expect(intents.length).toBeGreaterThan(8 * 1024 * 1024);
    writeFileSync(join(selected.profilePath, 'ui/caller-intents.json'), intents, {
      mode: 0o600,
      flag: 'wx',
    });
    native.verifyFile(join(selected.profilePath, 'ui/caller-intents.json'));
    const preload = join(root, 'selected-engine.ts');
    writeFileSync(
      preload,
      `import {initializeSqliteEngine} from ${JSON.stringify(fileURLToPath(new URL('../../../src/sqlite-engine.ts', import.meta.url)))};initializeSqliteEngine(${JSON.stringify(qualified!.engine.selection)});\n`,
    );
    const scope = ['--data-root', profile.dataRoot, '--profile', profile.profile];
    const argv = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          preload,
          fileURLToPath(new URL('../../../../../apps/cli/host/main.ts', import.meta.url)),
          'maintenance',
          ...args,
        ],
        { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        exit,
        stdout,
        stderr,
        result: exit === 0 ? (JSON.parse(stdout) as Record<string, unknown>) : null,
      };
    };
    return {
      root,
      profile,
      storeId,
      selected,
      bytes,
      hash: published.hash,
      config,
      intents,
      scope,
      argv,
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      await artifacts?.close();
      await store?.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `owned Windows fixture cleanup unconfirmed: ${root}`,
      );
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// Actual Windows only, with no backend/engine availability skip or injected OS policy.
// This is the development CLI; Windows installed launchers and Native bootstrap are separate gates.
test.skipIf(process.platform !== 'win32')(
  'Windows CLI backup/inspect/new-Store restore/status retains complete media and original cold intent without replay',
  async () => {
    const f = await fixture();
    try {
      const source = readFileSync(f.selected.databasePath);
      const sidecars = ['-wal', '-shm'].map((suffix) =>
        existsSync(f.selected.databasePath + suffix)
          ? readFileSync(f.selected.databasePath + suffix)
          : null,
      );
      const original = () => {
        expect(readFileSync(f.selected.databasePath)).toEqual(source);
        for (const [index, suffix] of ['-wal', '-shm'].entries()) {
          expect(existsSync(f.selected.databasePath + suffix)).toBe(sidecars[index] !== null);
          if (sidecars[index])
            expect(readFileSync(f.selected.databasePath + suffix)).toEqual(sidecars[index]!);
        }
      };
      const backup = await f.argv(['backup', ...f.scope, '--destination', join(f.root, 'backups')]);
      expect(backup.exit).toBe(0);
      expect(backup.stderr).toBe('');
      expect(backup.result?.coverage).toMatchObject({ profileComplete: false });
      const selected = backup.result!.backup as Awaited<ReturnType<typeof inspectProfileBackup>>;
      original();
      expect(readFileSync(artifactPath(selected.directory, f.hash))).toEqual(f.bytes);
      expect(readFileSync(join(selected.directory, 'ui/caller-intents.json'))).toEqual(f.intents);
      const pinned = openBackupDatabase(join(selected.directory, 'core.db'));
      try {
        expect(() => renameSync(selected.directory, join(f.root, 'moved-backup'))).toThrow();
        expect(() => writeFileSync(join(selected.directory, 'core.db'), 'replaced')).toThrow();
      } finally {
        pinned.close(true);
      }
      expect(existsSync(join(selected.directory, 'credentials'))).toBe(false);
      expect((await f.argv(['inspect', selected.directory])).exit).toBe(0);
      original();
      const access = acquireProfileAccess(f.profile);
      try {
        expect(
          (
            await f.argv([
              'restore',
              selected.directory,
              ...f.scope,
              '--expected-store',
              f.storeId,
              '--confirm-data-loss',
            ])
          ).exit,
        ).not.toBe(0);
        original();
      } finally {
        access.lock.release();
      }
      const later = new Database(f.selected.databasePath);
      try {
        later.run("UPDATE session SET title='later current title'");
      } finally {
        later.close(true);
      }
      const restored = await f.argv([
        'restore',
        selected.directory,
        ...f.scope,
        '--expected-store',
        f.storeId,
        '--confirm-data-loss',
      ]);
      expect(restored.exit).toBe(0);
      expect(restored.result?.status).toBe('restored');
      expect(restored.result?.storeId).not.toBe(f.storeId);
      const preserved = restored.result!.preservedDirectory as string;
      expect(readFileSync(join(preserved, 'credentials'), 'utf8')).toBe(
        'owned excluded credential fixture',
      );
      expect(existsSync(join(f.selected.profilePath, 'credentials'))).toBe(false);
      expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(f.config);
      expect(readFileSync(join(f.selected.profilePath, 'ui/caller-intents.json'))).toEqual(
        f.intents,
      );
      expect(readFileSync(artifactPath(f.selected.profilePath, f.hash))).toEqual(f.bytes);
      const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
      try {
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        expect((await cold.getSession('s'))?.title).toBe('original title');
        expect(await cold.getCommand('pending')).toMatchObject({
          status: 'needs_review',
          originStoreId: f.storeId,
        });
        let mismatch: unknown;
        try {
          await cold.getSessionLogs({
            expectedStoreId: f.storeId,
            subjectId: 'owner',
            sessionId: 's',
            afterCursor: '0',
          });
        } catch (error) {
          mismatch = error;
        }
        expect((mismatch as { code?: string })?.code).toBe('store_identity_mismatch');
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      } finally {
        await cold.close();
      }
      const status = await f.argv(['status', ...f.scope]);
      expect(status.exit).toBe(0);
      expect(status.result?.restore).toBeNull();
    } finally {
      f.close();
    }
  },
  60000,
);

test.skipIf(process.platform !== 'win32')(
  'Windows CLI requires the exact journal digest for explicit complete/rollback and preserves the corresponding directory',
  async () => {
    for (const decision of ['complete', 'rollback'] as const) {
      const f = await fixture();
      try {
        const created = await f.argv([
          'backup',
          ...f.scope,
          '--destination',
          join(f.root, 'backups'),
        ]);
        expect(created.exit).toBe(0);
        const backup = created.result!.backup as Awaited<ReturnType<typeof inspectProfileBackup>>;
        const later = new Database(f.selected.databasePath);
        try {
          later.run("UPDATE session SET title='later current title'");
        } finally {
          later.close(true);
        }
        let failure: unknown;
        try {
          await runProfileRestore(
            {
              profile: f.profile,
              expectedStoreId: f.storeId,
              backup,
              intent: 'replace_with_selected_backup',
            },
            async (point) => {
              if (point === 'old_directory_moved') throw Error('owned_windows_interrupted_restore');
            },
          );
        } catch (error) {
          failure = error;
        }
        expect((failure as Error)?.message).toBe('owned_windows_interrupted_restore');
        const observed = inspectProfileRestore({ profile: f.profile })!;
        expect(observed.journal.phase).toBe('prepared');
        expect((await f.argv(['status', ...f.scope])).result?.restore).toEqual(observed);
        const args = [
          'reconcile',
          ...f.scope,
          '--restore-id',
          observed.journal.restoreId,
          '--journal-digest',
          '0'.repeat(64),
          '--decision',
          decision,
          '--confirm-data-loss',
        ];
        expect((await f.argv(args)).exit).not.toBe(0);
        expect(inspectProfileRestore({ profile: f.profile })).toEqual(observed);
        args[args.indexOf('--journal-digest') + 1] = observed.digest;
        const result = await f.argv(args);
        expect(result.exit).toBe(0);
        expect(result.result?.status).toBe(decision === 'complete' ? 'restored' : 'rolled_back');
        const expectedStoreId = decision === 'complete' ? observed.journal.newStoreId : f.storeId;
        const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
        try {
          expect((await cold.getMetadata()).storeId).toBe(expectedStoreId);
          expect((await cold.getSession('s'))?.title).toBe(
            decision === 'complete' ? 'original title' : 'later current title',
          );
        } finally {
          await cold.close();
        }
        expect((await f.argv(['status', ...f.scope])).result?.restore).toBeNull();
        expect(
          JSON.parse(readFileSync(join(f.selected.profilePath, 'ui/caller-intents.json'), 'utf8'))
            .records[0].intent.scope.storeId,
        ).toBe(f.storeId);
      } finally {
        f.close();
      }
    }
  },
  120000,
);
