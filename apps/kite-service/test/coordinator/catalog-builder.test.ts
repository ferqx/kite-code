import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoordinatorCatalog } from '@kite-ai/kite-local-runtime/coordinator';
import { createSqliteRuntimeMigrationCatalogBuilder } from '../../src/coordinator/catalog-builder';

function fixture(): { readonly root: string; readonly generation: string; readonly path: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-catalog-builder-')));
  const generation = 'generation-1';
  const path = join(root, 'layouts', generation, 'catalog.sqlite');
  mkdirSync(join(root, 'layouts', generation), { recursive: true, mode: 0o700 });
  return { root, generation, path };
}

describe('Coordinator migration Catalog builder', () => {
  test('builds the explicit active-layout target and returns its file digest', () => {
    const testFixture = fixture();
    try {
      const builder = createSqliteRuntimeMigrationCatalogBuilder({
        canonicalKiteHomeRoot: testFixture.root,
      });
      const sessions = [
        {
          sessionId: 'session-a',
          workerScopeId: 'worker-scope-a',
          directoryRevision: '1',
          updatedAt: '2026-08-29T00:00:00.000Z',
          tombstone: false,
        },
        {
          sessionId: 'session-b',
          workerScopeId: 'worker-scope-b',
          directoryRevision: '2',
          updatedAt: '2026-08-29T00:00:01.000Z',
          tombstone: false,
        },
      ] as const;
      const digest = builder.build({
        catalogPath: testFixture.path,
        layoutGeneration: testFixture.generation,
        sessions,
      });

      expect(digest).toBe(
        createHash('sha256').update(readFileSync(testFixture.path)).digest('hex'),
      );
      expect(lstatSync(testFixture.path).isFile()).toBe(true);

      const catalog = openCoordinatorCatalog({
        canonicalKiteHomeRoot: testFixture.root,
        layoutGeneration: testFixture.generation,
        catalogPath: testFixture.path,
        mode: 'open_active',
        beforeWrite: () => undefined,
      });
      try {
        expect(catalog.listSessions()).toEqual(sessions);
      } finally {
        catalog.close();
      }
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });

  test('rejects a target outside the explicit layout identity', () => {
    const testFixture = fixture();
    try {
      const builder = createSqliteRuntimeMigrationCatalogBuilder({
        canonicalKiteHomeRoot: testFixture.root,
      });
      expect(() =>
        builder.build({
          catalogPath: join(testFixture.root, 'catalog.sqlite'),
          layoutGeneration: testFixture.generation,
          sessions: [],
        }),
      ).toThrow(/layout identity/u);
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });

  test('rejects duplicate or unknown Session metadata before creating a target', () => {
    const testFixture = fixture();
    try {
      const builder = createSqliteRuntimeMigrationCatalogBuilder({
        canonicalKiteHomeRoot: testFixture.root,
      });
      const session = {
        sessionId: 'session-a',
        workerScopeId: 'worker-scope-a',
        directoryRevision: '1',
        updatedAt: '2026-08-29T00:00:00.000Z',
        tombstone: false,
      } as const;
      expect(() =>
        builder.build({
          catalogPath: testFixture.path,
          layoutGeneration: testFixture.generation,
          sessions: [session, session],
        }),
      ).toThrow('duplicate');
      expect(() => readFileSync(testFixture.path)).toThrow();

      const unknown = { ...session, canonicalPath: '/private/workspace' } as never;
      expect(() =>
        builder.build({
          catalogPath: testFixture.path,
          layoutGeneration: testFixture.generation,
          sessions: [unknown],
        }),
      ).toThrow(/unrecognized|unknown/iu);
      expect(() => readFileSync(testFixture.path)).toThrow();
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });

  test('never reuses or truncates an existing target and keeps it byte-identical', () => {
    const testFixture = fixture();
    try {
      const builder = createSqliteRuntimeMigrationCatalogBuilder({
        canonicalKiteHomeRoot: testFixture.root,
      });
      const digest = builder.build({
        catalogPath: testFixture.path,
        layoutGeneration: testFixture.generation,
        sessions: [],
      });
      const digestText = digest as string;
      const bytes = readFileSync(testFixture.path);
      expect(() =>
        builder.build({
          catalogPath: testFixture.path,
          layoutGeneration: testFixture.generation,
          sessions: [],
        }),
      ).toThrow('target must be absent');
      expect(createHash('sha256').update(readFileSync(testFixture.path)).digest('hex')).toEqual(
        digestText,
      );
      expect(readFileSync(testFixture.path)).toEqual(bytes);
      expect(lstatSync(testFixture.path).nlink).toBe(1);
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });
});
