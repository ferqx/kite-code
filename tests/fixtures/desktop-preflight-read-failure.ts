import { expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStore, preflightSqliteStore, sqliteStorageAssets } from '@kite-ai/agent/sqlite';
import { prepareDevelopmentDesktopProfile } from '../../scripts/development/unified-desktop';
import { removeTemporaryDirectory, temporaryDirectory } from './test-filesystem';

const [target, code, attempt] = process.argv.slice(2);
if (
  (target !== 'manifest' && target !== 'baseline') ||
  (code !== 'EACCES' && code !== 'EIO') ||
  (attempt !== '1' && attempt !== '2')
)
  throw Error('Invalid desktop preflight fixture arguments.');
const failureAt = Number(attempt);

const dataRoot = temporaryDirectory('kite-development-profile-read-failure-');
const options = { dataRoot, profile: 'development' };
const profile = join(dataRoot, options.profile);
try {
  // Store creation loads the schema in its Worker. This process must first
  // encounter the migration files under the fault injection below.
  const store = await openSqliteStore(options);
  const { storeId } = await store.getMetadata();
  await store.close();
  const manifest = join(profile, 'profile.json');
  const database = join(profile, 'core.db');
  const { readFileSync } = fs;
  const originalDatabase = readFileSync(database);
  const originalManifest = readFileSync(manifest);
  const baseline = fileURLToPath(sqliteStorageAssets().baseline);
  const readFailure = Object.assign(new Error('fixture_read_failed'), { code });
  let manifestReads = 0;
  let baselineFailures = 0;
  let confirmations = 0;
  const read = spyOn(fs, 'readFileSync').mockImplementation(((path, ...args) => {
    const name = path instanceof URL ? fileURLToPath(path) : String(path);
    if (name === manifest) {
      // Simulate an incompatible first observation followed by a peer repair.
      // A format marker rejection leaves the SQL cache cold for the EX recheck.
      if (++manifestReads < failureAt) return '{"formatMajor":2}';
      if (target === 'manifest') throw readFailure;
    }
    if (name === baseline && target === 'baseline') {
      baselineFailures++;
      throw readFailure;
    }
    return (readFileSync as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    await expect(
      prepareDevelopmentDesktopProfile(dataRoot, async () => {
        confirmations++;
        return true;
      }),
    ).rejects.toMatchObject({
      code:
        failureAt === 2
          ? code
          : code === 'EACCES'
            ? 'store_access_denied'
            : 'store_preflight_failed',
    });
  } finally {
    read.mockRestore();
  }

  expect(manifestReads).toBe(failureAt);
  expect(baselineFailures).toBe(target === 'baseline' ? 1 : 0);
  expect(confirmations).toBe(0);
  expect(fs.readdirSync(dataRoot).filter((name) => name.startsWith('development-backup-'))).toEqual(
    [],
  );
  expect(readFileSync(database)).toEqual(originalDatabase);
  expect(readFileSync(manifest)).toEqual(originalManifest);
  expect(await preflightSqliteStore(options)).toMatchObject({ status: 'compatible', storeId });
} finally {
  removeTemporaryDirectory(dataRoot);
}
