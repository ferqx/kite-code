import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLoadedSqliteEngine,
  initializeSqliteEngine,
  type SqliteEngineObservation,
  verifySqliteEngineAsset,
} from '@kite-ai/agent/sqlite-engine';
import {
  parseSqliteReleaseIdentity,
  terminalSqliteEngineRoot,
} from '@kite-ai/service/sqlite-release-assets';
import { buildTerminalSqliteEngine } from '../../../scripts/release/sqlite-engine';

function verify(observation: SqliteEngineObservation): SqliteEngineObservation {
  const identity = parseSqliteReleaseIdentity({
    driver: 'bun:sqlite',
    linkage: observation.linkage,
    version: observation.version,
    sourceId: observation.sourceId,
  });
  const verified = verifySqliteEngineAsset(observation.selection);
  const linkage = 'library' in verified.manifest ? 'dynamic' : verified.manifest.linkage;
  if (
    observation.qualification !== 'selected' ||
    verified.root !== observation.selection.root ||
    verified.manifestSha256 !== observation.selection.manifestSha256 ||
    linkage !== identity.linkage ||
    verified.manifest.sqlite.version !== identity.version ||
    verified.manifest.sqlite.sourceId !== identity.sourceId
  )
    throw Error('qualified_sqlite_fixture_identity_mismatch');
  return observation;
}

/**
 * File-isolated test owner setup; never creates or warms an original Profile database.
 * After this file's last Database/Store closes, afterAll removes only its owned engine assets.
 * The loaded public selection cannot reset: subsequent files in that same process are unsupported.
 * An external selected engine remains owned by its original preloader and is never removed here.
 */
export async function prepareQualifiedSqliteFixture() {
  const existing = getLoadedSqliteEngine();
  if (existing) {
    const engine = verify(existing);
    console.log(
      JSON.stringify({ stage: 'qualified_sqlite_fixture', ...engine, ownedFixture: false }),
    );
    return Object.freeze({
      engine,
      close() {
        verify(engine);
        console.log(
          JSON.stringify({
            stage: 'qualified_sqlite_fixture_closed',
            confirmed: true,
            ownedFixture: false,
          }),
        );
      },
    });
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-qualified-maintenance-engine-')));
  let closed = false;
  const close = () => {
    if (!closed) {
      rmSync(root, { recursive: true });
      if (existsSync(root)) throw Error('qualified_sqlite_fixture_cleanup_unconfirmed');
      closed = true;
      console.log(
        JSON.stringify({
          stage: 'qualified_sqlite_fixture_closed',
          confirmed: true,
          ownedFixture: true,
        }),
      );
    }
  };
  try {
    chmodSync(root, 0o700);
    const leaf = join(root, 'node_modules/@kite-ai/agent');
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    const built = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve('@kite-ai/agent/sqlite-engine'))],
      outdir: leaf,
      naming: 'sqlite-engine.js',
      target: 'bun',
      packages: 'bundle',
    });
    if (!built.success) throw Error('qualified_sqlite_fixture_leaf_build_failed');
    writeFileSync(
      join(leaf, 'package.json'),
      JSON.stringify({
        name: '@kite-ai/agent',
        type: 'module',
        exports: { './sqlite-engine': './sqlite-engine.js' },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const identity = await buildTerminalSqliteEngine({ root, executable: process.execPath });
    const engine = verify(
      initializeSqliteEngine({
        root: join(root, terminalSqliteEngineRoot),
        manifestSha256: identity.manifestSha256,
      }),
    );
    if (
      engine.version !== identity.version ||
      engine.sourceId !== identity.sourceId ||
      engine.linkage !== identity.linkage
    )
      throw Error('qualified_sqlite_fixture_builder_mismatch');
    console.log(
      JSON.stringify({ stage: 'qualified_sqlite_fixture', ...engine, ownedFixture: true }),
    );
    return Object.freeze({ engine, close });
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'qualified_sqlite_fixture_cleanup_failed');
    }
    throw error;
  }
}
