/** Exact upstream identities reviewed for the release WAL-reset fix; not a minimum-version rule. */
export const reviewedSqliteSources = Object.freeze({
  '3.51.3': '2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618',
  '3.53.4': '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc',
});

export interface SqliteReleaseIdentity {
  readonly driver: 'bun:sqlite' | 'node:sqlite';
  readonly linkage: 'dynamic' | 'builtin';
  readonly version: string;
  readonly sourceId: string;
}

/** Pure closed metadata. The producer and launcher independently measure the selected binary. */
export function parseSqliteReleaseIdentity(value: unknown): SqliteReleaseIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('sqlite_release_identity_invalid');
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(',') !== 'driver,linkage,sourceId,version' ||
    !['bun:sqlite', 'node:sqlite'].includes(String(raw.driver)) ||
    !['dynamic', 'builtin'].includes(String(raw.linkage)) ||
    (raw.driver === 'node:sqlite' && raw.linkage !== 'builtin') ||
    typeof raw.version !== 'string' ||
    !Object.hasOwn(reviewedSqliteSources, raw.version) ||
    raw.sourceId !== reviewedSqliteSources[raw.version as keyof typeof reviewedSqliteSources]
  )
    throw Error('sqlite_release_identity_invalid');
  return Object.freeze({
    driver: raw.driver as SqliteReleaseIdentity['driver'],
    linkage: raw.linkage as SqliteReleaseIdentity['linkage'],
    version: raw.version,
    sourceId: raw.sourceId as string,
  });
}

export function assertSqliteReleaseIdentity(
  expected: SqliteReleaseIdentity,
  actual: { version: string; sourceId: string },
): void {
  const selected = parseSqliteReleaseIdentity(expected);
  if (selected.version !== actual.version || selected.sourceId !== actual.sourceId)
    throw Error('sqlite_release_identity_mismatch');
}

export const terminalSqliteEngineRoot = 'node_modules/@kite-ai/agent/storage/engine';
