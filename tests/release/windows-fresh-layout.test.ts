import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
} from '@kite-ai/kite-local-runtime/service';
import {
  readSqliteActiveLayoutPointer,
  readSqliteRuntimeLayoutManifest,
  resolveSqliteRuntimeLayoutPaths,
} from '@kite-ai/runtime-storage-sqlite';
import { runLocalLayoutMigration } from '../../scripts/release/local-layout-migration';

test('initializes a production-validated fresh layout across native path projections', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-fresh-layout-')));
  try {
    const home = ensureLocalRuntimeServiceHome(
      createKiteHomeIdentity(join(root, 'home'), 'explicit_argument'),
    );
    const result = await runLocalLayoutMigration({
      home,
      sourceStorePath: join(home.root, 'legacy.sqlite'),
      createMigrationNonce: () => 'windows-fresh-layout-test',
    });
    expect(result.status).toBe('initialized');
    if (result.status !== 'initialized') return;
    const layout = resolveSqliteRuntimeLayoutPaths(home.root);
    expect(readSqliteActiveLayoutPointer(layout)?.generation).toBe(result.targetLayoutGeneration);
    expect(
      readSqliteRuntimeLayoutManifest(layout, result.targetLayoutGeneration)?.catalogDigest,
    ).toBe(result.catalogDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
