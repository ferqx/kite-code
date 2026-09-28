import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  assertKiteHomeStoreSchema,
  assertKiteSessionStore10Schema,
  assertKiteSessionStore12Schema,
  assertKiteSessionStore13Schema,
  assertKiteSessionStoreSchema,
  assertKiteSessionStore11Schema as assertLineageStore11Schema,
  KITE_HOME_STORE_DDL,
  KITE_SESSION_STORE_DDL,
  KITE_SESSION_STORE10_DDL,
  KITE_SESSION_STORE11_DDL,
  KITE_SESSION_STORE12_DDL,
  KITE_SESSION_STORE13_DDL,
} from '../src/kite-home-store';
import {
  KITE_SESSION_STORE_FORMAT_EPOCH,
  KITE_SESSION_STORE_SCHEMA_VERSION,
} from '../src/kite-session-store-format';
import {
  KITE_SESSION_STORE11_DDL as ACCEPTED_RUNS_STORE11_DDL,
  assertKiteSessionStore11Schema as assertAcceptedRunsStore11Schema,
} from '../src/kite-session-store11-conversion';

// Independent locks for every Store format that startup currently accepts. The lineage Store 11
// digest was also checked against a read-only backup of a pre-upgrade database (2026-09-26).
// A new table, column, constraint or index requires a new format epoch and an explicit converter;
// do not regenerate an existing digest from the changed production DDL.
const formats = [
  {
    version: 9,
    epoch: 'kite-home-single-service-v1-2026-08-30',
    ddl: KITE_HOME_STORE_DDL,
    digest: '8038c2bc9e1813cddbee48508b94f0bcd4161f4dbdc1ae199fc3a955c2ffee34',
    assertSchema: assertKiteHomeStoreSchema,
  },
  {
    version: 10,
    epoch: 'kite-session-app-server-2026-09-02',
    ddl: KITE_SESSION_STORE10_DDL,
    digest: '0869bdd3dde2dd55cde239c2cad7815531138c1aae5de88ec54c7acd4bf2ce9b',
    assertSchema: assertKiteSessionStore10Schema,
  },
  {
    version: 11,
    epoch: 'kite-session-accepted-runs-2026-09-15',
    ddl: ACCEPTED_RUNS_STORE11_DDL,
    digest: '058c6deed1070f4bcfe0fe9c13db0eaafc085cd7d3baeef4cd307da573195d41',
    assertSchema: assertAcceptedRunsStore11Schema,
  },
  {
    version: 11,
    epoch: 'kite-session-lineage-2026-09-24',
    ddl: KITE_SESSION_STORE11_DDL,
    digest: 'c508cd380b49fb037a61001a0458f485e1ceaa1e34df79df02f59f4c90b03ad3',
    assertSchema: assertLineageStore11Schema,
  },
  {
    version: 12,
    epoch: 'kite-session-child-approval-2026-09-25',
    ddl: KITE_SESSION_STORE12_DDL,
    digest: '4853ccdad8a13de79a92e26031b485487ee758c9de1334146d272ea666b975c9',
    assertSchema: assertKiteSessionStore12Schema,
  },
  {
    version: 13,
    epoch: 'kite-session-cross-followup-2026-09-25',
    ddl: KITE_SESSION_STORE13_DDL,
    digest: 'd8f310c86768af70eb85ed4562ad92cd94bba8f7e48425f3ab0410cbfbb3c9b9',
    assertSchema: assertKiteSessionStore13Schema,
  },
  {
    version: 14,
    epoch: 'kite-session-history-generation-2026-09-28',
    ddl: KITE_SESSION_STORE_DDL,
    digest: 'f6f46dfec2754afa265a9f26161b45a1507391d1ef98525153005be006e4803a',
    assertSchema: assertKiteSessionStoreSchema,
  },
] as const;

function schemaDigest(database: Database): string {
  const schema = database
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name',
    )
    .all()
    .map((row) => ({
      ...row,
      // SQLite quotes the table name after ALTER TABLE RENAME. It is the same identifier.
      sql: row.sql?.replaceAll(/"([a-z_]+)"/gu, '$1') ?? null,
    }));
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

describe('frozen Store format contracts', () => {
  test('the current writer has a new contract whenever its version or epoch changes', () => {
    const current = formats.at(-1)!;
    expect([KITE_SESSION_STORE_SCHEMA_VERSION, KITE_SESSION_STORE_FORMAT_EPOCH]).toEqual([
      current.version,
      current.epoch,
    ]);
    expect(new Set(formats.map(({ version, epoch }) => `${version}:${epoch}`)).size).toBe(
      formats.length,
    );
  });

  for (const format of formats) {
    test(`preserves Store ${format.version} ${format.epoch} physical schema`, () => {
      const database = new Database(':memory:', { strict: true });
      try {
        for (const statement of format.ddl) database.run(statement);
        database
          .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
          .run('schema_version', String(format.version));
        database
          .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
          .run('format_epoch', format.epoch);
        database.run(`PRAGMA user_version=${format.version}`);
        format.assertSchema(database);
        expect(schemaDigest(database)).toBe(format.digest);
      } finally {
        database.close();
      }
    });
  }
});
