import { Database } from 'bun:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import type { SessionMetadataPort } from '@kite/runtime-host/storage';

export interface SessionTokenStatsV1 {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly totalTokens: number;
}

export interface SqliteSessionMetadataInputV1 {
  readonly databasePath: string;
  readonly journalMode: 'wal' | 'delete';
  readonly assertCanOpen: (databasePath: string) => void;
}

interface SessionTokenStatsRowV1 {
  thread_id: string;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  total_tokens: number;
}

/** Fail-closed preflight for the App-only metadata database. */
export function assertSqliteSessionMetadataCanOpenV1(databasePath: string): void {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return;
  if (lstatSync(databasePath).isSymbolicLink()) {
    throw new Error('Session metadata database must not be a symlink.');
  }
  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((entry) => entry.name);
    if (tables.length === 0) return;
    if (tables.length !== 1 || tables[0] !== 'session_stats') {
      throw new Error('Session metadata database contains non-metadata tables.');
    }
    const columns = database
      .query<{ name: string }, []>('PRAGMA table_info(session_stats)')
      .all()
      .map((entry) => entry.name);
    const expected = [
      'thread_id',
      'cache_hit_tokens',
      'cache_miss_tokens',
      'total_tokens',
      'updated_at',
    ];
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => column !== expected[index])
    ) {
      throw new Error('Session metadata database schema is incompatible.');
    }
  } finally {
    database.close();
  }
}

/**
 * Explicit App-projection metadata port. It preserves the existing
 * `session_stats` table and long-lived connection behavior without exposing a
 * raw SQLite handle to TUI, CLI, Kernel, or Host.
 */
export function createSqliteSessionTokenStatsV1(
  input: SqliteSessionMetadataInputV1,
): SessionMetadataPort<SessionTokenStatsV1> {
  let database: Database | null = null;

  const resolveDatabase = (): Database => {
    if (database) return database;
    input.assertCanOpen(input.databasePath);
    const opened = new Database(input.databasePath);
    try {
      opened.run('pragma busy_timeout = 5000');
      opened.run(`pragma journal_mode = ${input.journalMode}`);
      opened.run(`create table if not exists session_stats (
        thread_id text primary key not null,
        cache_hit_tokens integer not null default 0,
        cache_miss_tokens integer not null default 0,
        total_tokens integer not null default 0,
        updated_at text not null default (datetime('now')))`);
      database = opened;
      return opened;
    } catch (error) {
      opened.close();
      throw error;
    }
  };

  return {
    save(sessionId, value): void {
      resolveDatabase().run(
        `insert or replace into session_stats
           (thread_id, cache_hit_tokens, cache_miss_tokens, total_tokens, updated_at)
         values (?, ?, ?, ?, datetime('now'))`,
        [sessionId, value.cacheHitTokens, value.cacheMissTokens, value.totalTokens],
      );
    },
    loadAll(): readonly { sessionId: string; value: SessionTokenStatsV1 }[] {
      return resolveDatabase()
        .query<SessionTokenStatsRowV1, []>(
          `select thread_id, cache_hit_tokens, cache_miss_tokens, total_tokens from session_stats`,
        )
        .all()
        .map((row) => ({
          sessionId: row.thread_id,
          value: {
            cacheHitTokens: row.cache_hit_tokens,
            cacheMissTokens: row.cache_miss_tokens,
            totalTokens: row.total_tokens,
          },
        }));
    },
    close(): void {
      if (!database) return;
      database.close();
      database = null;
    },
  };
}
