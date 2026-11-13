import {
  getLoadedSqliteEngine,
  initializeDefaultSqliteEngine,
  type SqliteEngineObservation,
  verifySqliteEngineAsset,
} from '@kite-ai/agent/sqlite-engine';
import { parseSqliteReleaseIdentity } from '@kite-ai/service/sqlite-release-assets';

function verify(observation: SqliteEngineObservation): SqliteEngineObservation {
  const identity = parseSqliteReleaseIdentity({
    driver: 'node-api:sqlite',
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

/** Test against the exact prepared Node-API SQLite selection, without opening a Profile. */
export async function prepareQualifiedSqliteFixture() {
  const observed = getLoadedSqliteEngine() ?? initializeDefaultSqliteEngine();
  if (observed.qualification !== 'selected') throw Error('qualified_sqlite_fixture_missing');
  const engine = verify(observed);
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
