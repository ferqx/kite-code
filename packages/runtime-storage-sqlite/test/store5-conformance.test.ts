import { describe, expect, test } from 'bun:test';
import {
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
} from '../src/sqlite-store';
import {
  createIsolatedStore5ConformanceV1,
  mapState25ToState26ConformanceV1,
  STORE5_DDL_V1,
} from '../src/store5-conformance';

describe('RAV1-05 isolated State26/Store5 conformance', () => {
  test('maps State25 without changing the source object', () => {
    const source = {
      schemaVersion: 25,
      formatEpoch: 'kite-runtime-2026-08-18',
      session: { id: 's1' },
    };
    const target = mapState25ToState26ConformanceV1({
      state: source,
      projectIdentity: 'project:p1',
    });
    expect(target.schemaVersion).toBe(26);
    expect(target.rav1.sourceSchemaVersion).toBe(25);
    expect(source.schemaVersion).toBe(25);
    expect(target.state).toEqual(source);
  });
  test('exposes target DDL only through an explicit isolated constructor', () => {
    const target = createIsolatedStore5ConformanceV1({
      databasePath: ':memory:',
      conformanceOnly: true,
    });
    expect(target.storeSchemaVersion).toBe(5);
    expect(target.ddl).toEqual(STORE5_DDL_V1);
  });
  test('keeps production truth on State25/Store4/current epoch before cutover', () => {
    expect(SQLITE_RUNTIME_STATE_SCHEMA_VERSION).toBe(25);
    expect(SQLITE_RUNTIME_STORE_SCHEMA_VERSION).toBe(4);
    expect(SQLITE_RUNTIME_FORMAT_EPOCH).toBe('kite-runtime-2026-08-18');
  });
});
