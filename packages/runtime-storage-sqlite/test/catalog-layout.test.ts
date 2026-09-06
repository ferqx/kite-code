import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSqliteCoordinatorCatalogActive,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  markSqliteCoordinatorCatalogWritten,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteCatalogPath,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '../src';

describe('Coordinator Catalog active-layout write fence', () => {
  test('checks the pre-write digest and marks the shared generation before mutation', () => {
    const fixture = createFixture();
    try {
      expect(
        assertSqliteCoordinatorCatalogActive(
          fixture.layout,
          fixture.generation,
          fixture.catalogPath,
        ).targetWriteState,
      ).toBe('none');

      markSqliteCoordinatorCatalogWritten(fixture.layout, fixture.generation, fixture.catalogPath);
      expect(readSqliteRuntimeMigrationJournal(fixture.layout)?.targetWriteState).toBe('written');

      writeFileSync(fixture.catalogPath, 'post-switch-catalog-write', { mode: 0o600 });
      expect(
        assertSqliteCoordinatorCatalogActive(
          fixture.layout,
          fixture.generation,
          fixture.catalogPath,
        ).targetWriteState,
      ).toBe('written');
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects digest drift and active pointer drift before marking written', () => {
    const digestFixture = createFixture();
    try {
      writeFileSync(digestFixture.catalogPath, 'tampered', { mode: 0o600 });
      expect(() =>
        markSqliteCoordinatorCatalogWritten(
          digestFixture.layout,
          digestFixture.generation,
          digestFixture.catalogPath,
        ),
      ).toThrow('manifest digest');
      expect(readSqliteRuntimeMigrationJournal(digestFixture.layout)?.targetWriteState).toBe(
        'none',
      );
    } finally {
      digestFixture.cleanup();
    }

    const pointerFixture = createFixture();
    try {
      ensureSqliteRuntimeGenerationRoot(pointerFixture.layout, 'generation-2');
      writeSqliteActiveLayoutPointer(pointerFixture.layout, {
        schema: 'kite.runtime-active-layout.v1',
        generation: 'generation-2',
      });
      expect(() =>
        markSqliteCoordinatorCatalogWritten(
          pointerFixture.layout,
          pointerFixture.generation,
          pointerFixture.catalogPath,
        ),
      ).toThrow('incomplete or stale');
      expect(readSqliteRuntimeMigrationJournal(pointerFixture.layout)?.targetWriteState).toBe(
        'none',
      );
    } finally {
      pointerFixture.cleanup();
    }
  });

  test('admits Store 8 Catalog authority only through the explicit production profile', () => {
    const fixture = createFixture('run');
    try {
      expect(() =>
        assertSqliteCoordinatorCatalogActive(
          fixture.layout,
          fixture.generation,
          fixture.catalogPath,
        ),
      ).toThrow('incomplete or stale');
      expect(
        assertSqliteCoordinatorCatalogActive(
          fixture.layout,
          fixture.generation,
          fixture.catalogPath,
          'run',
        ).targetWriteState,
      ).toBe('none');
      markSqliteCoordinatorCatalogWritten(
        fixture.layout,
        fixture.generation,
        fixture.catalogPath,
        'run',
      );
      expect(readSqliteRuntimeMigrationJournal(fixture.layout)?.targetWriteState).toBe('written');
    } finally {
      fixture.cleanup();
    }
  });
});

function createFixture(targetStore?: 'run') {
  const root = mkdtempSync(join(process.cwd(), '.kite-catalog-layout-'));
  const layout = ensureSqliteRuntimeLayoutRoot(join(root, 'home'));
  const generation = 'generation-1';
  ensureSqliteRuntimeGenerationRoot(layout, generation);
  const catalogPath = resolveSqliteCatalogPath(layout, generation);
  const catalogBytes = 'catalog-before-first-write';
  writeFileSync(catalogPath, catalogBytes, { mode: 0o600 });
  const catalogDigest = createHash('sha256').update(catalogBytes).digest('hex');
  const sourceProfile = {
    stateSchemaVersion: 27,
    storeSchemaVersion: targetStore === 'run' ? 7 : 6,
    formatEpoch:
      targetStore === 'run'
        ? 'kite-coordinator-workspace-worker-web-v1-2026-08-28'
        : 'kite-runtime-server-v1-2026-08-26',
  } as const;
  const journal = {
    schema: 'kite.runtime-migration-journal.v1' as const,
    sourceStoreIdentity: 'catalog-layout-source',
    sourceStoreDigest: 'a'.repeat(64),
    sourceProfile,
    targetLayoutGeneration: generation,
    targetCatalogDigest: catalogDigest,
    workspaceStoreDigests: [],
    pointerPhase: 'committed' as const,
    targetWriteState: 'none' as const,
    migrationNonce: 'catalog-layout-nonce',
  };
  const targetProfile =
    targetStore === 'run'
      ? ({
          stateSchemaVersion: 27,
          storeSchemaVersion: 8,
          formatEpoch: 'kite-agent-server-api-v1-2026-08-29',
        } as const)
      : ({
          stateSchemaVersion: 27,
          storeSchemaVersion: 7,
          formatEpoch: 'kite-coordinator-workspace-worker-web-v1-2026-08-28',
        } as const);
  writeSqliteRuntimeLayoutManifest(layout, {
    schema: 'kite.runtime-layout-manifest.v1',
    generation,
    profile: targetProfile,
    catalogDigest,
    workspaceStores: [],
  });
  writeSqliteRuntimeMigrationFence(layout, {
    schema: 'kite.runtime-migration-fence.v1',
    sourceStoreIdentity: journal.sourceStoreIdentity,
    sourceStoreDigest: journal.sourceStoreDigest,
    sourceProfile,
    targetLayoutGeneration: generation,
    migrationNonce: journal.migrationNonce,
    state: 'active',
  });
  writeSqliteRuntimeMigrationJournal(layout, journal);
  writeSqliteActiveLayoutPointer(layout, {
    schema: 'kite.runtime-active-layout.v1',
    generation,
  });
  return {
    root,
    layout,
    generation,
    catalogPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
