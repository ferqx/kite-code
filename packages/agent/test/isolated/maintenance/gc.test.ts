import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runSelectedMaintenance } from '../../../../../apps/cli/host/maintenance';
import { parseCLIArguments } from '../../../../../apps/cli/src/arguments';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { artifactPath } from '../../../src/artifacts-files';
import { collectProfileGarbage, createProfileBackup } from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

let selected: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>>;
beforeAll(async () => {
  selected = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => selected?.close());
async function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-gc-')),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId,
    path = selectProfile(profile).profilePath;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'w',
  });
  await store.createSession({
    expectedStoreId: storeId,
    subjectId: 'user',
    workspaceId: 'w',
    sessionId: 's',
    commandId: 'create',
    title: 's',
  });
  const put = (text: string) => {
    const bytes = Buffer.from(text),
      hash = createHash('sha256').update(bytes).digest('hex'),
      file = artifactPath(path, hash);
    mkdirSync(join(path, 'blobs', hash.slice(0, 2)), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o400 });
    return { bytes, hash, file };
  };
  const referenced = put('referenced original'),
    orphan = put('unregistered immutable');
  await store.registerArtifact({
    expectedStoreId: storeId,
    refId: 'ref',
    hash: referenced.hash,
    size: String(referenced.bytes.length),
    sessionId: 's',
    subjectId: 'user',
    scope: { kind: 'session', id: 's' },
    mediaType: 'text/plain',
  });
  return { root, profile, store, storeId, path, referenced, orphan };
}
test.skipIf(process.platform === 'win32')(
  'explicit GC respects live/backup exclusion, grace, exact Store and retained references through the actual CLI entry',
  async () => {
    const f = await fixture();
    const originalNow = Date.now;
    try {
      expect(
        await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }).catch(
          (e) => e,
        ),
      ).toMatchObject({ code: 'owner_busy' });
      expect(existsSync(f.orphan.file)).toBe(true);
      await f.store.close();
      const core = readFileSync(join(f.path, 'core.db'));
      await expect(
        collectProfileGarbage({ profile: f.profile, expectedStoreId: 'foreign' }),
      ).rejects.toThrow('store_identity_mismatch');
      const recent = await collectProfileGarbage({
        profile: f.profile,
        expectedStoreId: f.storeId,
      });
      expect(recent).toMatchObject({ removedFiles: 0, retainedReferenced: 1, retainedRecent: 1 });
      const backup = await createProfileBackup({
        profile: f.profile,
        destinationRoot: join(f.root, 'backups'),
      });
      expect(existsSync(artifactPath(backup.directory, f.referenced.hash))).toBe(true);
      const now = originalNow();
      Date.now = () => now + 8 * 86400000; // Advance only the maintenance clock; filesystem timestamps stay real.
      const args = parseCLIArguments([
        'maintenance',
        'gc',
        '--data-root',
        f.profile.dataRoot,
        '--profile',
        f.profile.profile,
        '--expected-store',
        f.storeId,
      ]);
      if (args.kind !== 'maintenance') throw Error('GC parser');
      const lines: string[] = [];
      expect(
        await runSelectedMaintenance({ arguments: args, write: (line) => lines.push(line) }),
      ).toBe(0);
      expect(JSON.parse(lines[0]!).gc).toMatchObject({
        outcome: 'collected',
        removedFiles: 1,
        retainedReferenced: 1,
        removedBytes: String(f.orphan.bytes.length),
      });
      expect(existsSync(f.orphan.file)).toBe(false);
      expect(readFileSync(f.referenced.file)).toEqual(f.referenced.bytes);
      expect(readFileSync(artifactPath(backup.directory, f.referenced.hash))).toEqual(
        f.referenced.bytes,
      );
      expect(readFileSync(join(f.path, 'core.db'))).toEqual(core);
    } finally {
      Date.now = originalNow;
      await f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform === 'win32')(
  'GC rejects hostile private entries before deleting candidates and a cancelled invocation publishes no completed result',
  async () => {
    const f = await fixture();
    const originalNow = Date.now;
    try {
      await f.store.close();
      const now = originalNow();
      Date.now = () => now + 8 * 86400000;
      const outside = join(f.root, 'outside');
      writeFileSync(outside, 'untouched');
      const prefix = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0')).find(
        (n) => !existsSync(join(f.path, 'blobs', n)),
      )!;
      const link = join(f.path, 'blobs', prefix);
      symlinkSync(f.root, link);
      await expect(
        collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).rejects.toThrow();
      expect(existsSync(f.orphan.file)).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
      rmSync(link);
      await expect(
        collectProfileGarbage({
          profile: f.profile,
          expectedStoreId: f.storeId,
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow();
      expect(existsSync(f.orphan.file)).toBe(true);
      expect(() =>
        parseCLIArguments([
          'maintenance',
          'gc',
          '--data-root',
          f.profile.dataRoot,
          '--profile',
          'test',
          '--expected-store',
          f.storeId,
          '--grace-period-ms',
          '0',
        ]),
      ).toThrow('maintenance_gc_grace_invalid');
    } finally {
      Date.now = originalNow;
      await f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
