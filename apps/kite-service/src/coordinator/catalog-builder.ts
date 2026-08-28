import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import {
  COORDINATOR_SESSION_METADATA_SCHEMA,
  type CoordinatorCatalogStorageIdentity,
  openCoordinatorCatalog,
} from '@kite-ai/kite-local-runtime/coordinator';
import type {
  SqliteRuntimeMigrationCatalogBuilder,
  SqliteRuntimeMigrationCatalogSession,
} from '@kite-ai/runtime-storage-sqlite';

/**
 * Explicit owner input for the Store migration Catalog adapter. The migration
 * supplies the target path and generation for every build; this adapter never
 * derives a Coordinator path from HOME, cwd, or a legacy Store location.
 */
export interface KiteCoordinatorMigrationCatalogBuilderOptions {
  readonly canonicalKiteHomeRoot: string;
}

/**
 * Build the single Coordinator Catalog used by a Runtime layout migration.
 *
 * The physical schema and path validation remain owned by local-runtime's
 * Coordinator Catalog API. This Service adapter only maps the migration's
 * path-free session metadata, closes the writer, and returns the digest of the
 * resulting file for the migration manifest.
 */
export function createSqliteRuntimeMigrationCatalogBuilder(
  options: KiteCoordinatorMigrationCatalogBuilderOptions,
): SqliteRuntimeMigrationCatalogBuilder {
  assertExactObject(options, ['canonicalKiteHomeRoot']);
  if (typeof options.canonicalKiteHomeRoot !== 'string') {
    throw new TypeError('Coordinator migration Catalog home must be explicit.');
  }
  return Object.freeze({
    build(input: {
      readonly catalogPath: string;
      readonly layoutGeneration: string;
      readonly sessions: readonly SqliteRuntimeMigrationCatalogSession[];
    }): string {
      assertExactObject(input, ['catalogPath', 'layoutGeneration', 'sessions']);
      if (
        typeof input.catalogPath !== 'string' ||
        typeof input.layoutGeneration !== 'string' ||
        !Array.isArray(input.sessions)
      ) {
        throw new TypeError('Coordinator migration Catalog input is invalid.');
      }
      if (input.sessions.length > 100_000) {
        throw new RangeError('Coordinator migration Catalog Session bound is exhausted.');
      }
      const sessions = validateSessions(input.sessions);
      const storage: CoordinatorCatalogStorageIdentity = {
        canonicalKiteHomeRoot: options.canonicalKiteHomeRoot,
        layoutGeneration: input.layoutGeneration,
        catalogPath: input.catalogPath,
        mode: 'initialize_target',
      };
      let catalog: ReturnType<typeof openCoordinatorCatalog> | undefined;
      let ownedTarget: FileIdentity | undefined;
      try {
        catalog = openCoordinatorCatalog(storage);
        ownedTarget = readOwnedTargetIdentity(input.catalogPath);
        for (const session of sessions) catalog.upsertSession(session);
        catalog.close();
        catalog = undefined;
        assertNoSqliteSidecars(input.catalogPath);
        return createHash('sha256').update(readFileSync(input.catalogPath)).digest('hex');
      } catch (error) {
        let failure = error;
        if (catalog) {
          try {
            catalog.close();
          } catch (closeError) {
            failure ??= closeError;
          }
        }
        if (ownedTarget) {
          try {
            removeOwnedTarget(input.catalogPath, ownedTarget);
          } catch (cleanupError) {
            failure ??= cleanupError;
          }
        }
        throw failure;
      }
    },
  });
}

function validateSessions(
  sessions: readonly SqliteRuntimeMigrationCatalogSession[],
): readonly SqliteRuntimeMigrationCatalogSession[] {
  const seen = new Set<string>();
  const validated: SqliteRuntimeMigrationCatalogSession[] = [];
  for (let index = 0; index < sessions.length; index += 1) {
    if (!(index in sessions)) {
      throw new TypeError('Coordinator migration Catalog Session list is sparse.');
    }
    const session = sessions[index];
    const value = COORDINATOR_SESSION_METADATA_SCHEMA.parse(session);
    if (seen.has(value.sessionId)) {
      throw new Error('Coordinator migration Catalog contains a duplicate Session.');
    }
    seen.add(value.sessionId);
    validated.push(value);
  }
  return validated.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function readOwnedTargetIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('Coordinator migration Catalog is not a regular file.');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertNoSqliteSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    try {
      lstatSync(`${path}${suffix}`);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    throw new Error('Coordinator migration Catalog SQLite sidecar remains after close.');
  }
}

function removeOwnedTarget(path: string, identity: FileIdentity): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino
  ) {
    return;
  }
  unlinkSync(path);
}

function assertExactObject(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Coordinator migration Catalog input must be an object.');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError('Coordinator migration Catalog input contains unknown fields.');
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
