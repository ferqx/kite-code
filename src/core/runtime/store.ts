// ── Runtime 事件存储 / Runtime event store ──
// 提供 runtime_events（追加型事件日志）和 runtime_snapshots（可覆盖状态快照）的持久化

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeEvent } from './events.js';

/** 事件日志条目 — 从 runtime_events 表加载时使用 */
export interface StoredEvent {
  /** 自增 ID */
  id: number;
  /** 线程 ID */
  thread_id: string;
  /** JSON 序列化后的 RuntimeEvent */
  event: RuntimeEvent;
  /** Unix 时间戳（秒） */
  created_at: number;
}

export interface RuntimeSessionInfo {
  threadId: string;
  name: string;
  updatedAt: number;
  needsSmartName: boolean;
}

export interface RuntimeSnapshotEntry {
  snapshotId: string;
  eventPosition: number;
  createdAt: number;
}

/** Derive the runtime sidecar path without turning SQLite's memory sentinel into a file. */
export function runtimeStorePathFor(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return checkpointPath.replace(/\.sqlite$/, '') + '.runtime.db';
}

/** RuntimeStore 接口 / Runtime store interface */
export interface RuntimeStore {
  /** 批量追加事件（事务写入）/ Append events in a transaction */
  appendEvents(threadId: string, events: RuntimeEvent[]): void;
  /** 批量追加事件并同时写入快照（单一事务原子写入）/ Append events and save snapshot in a single atomic transaction */
  appendEventsAndSnapshot(threadId: string, events: RuntimeEvent[], nextState: unknown): void;
  /** 加载线程事件，可选从某个 ID 之后开始 / Load events, optionally since a given id */
  loadEvents(threadId: string, since?: number): StoredEvent[];
  /** 保存状态快照（INSERT OR REPLACE）/ Save a state snapshot */
  saveSnapshot(threadId: string, state: unknown): void;
  /** 加载最新状态快照 / Load the latest state snapshot */
  loadSnapshot<T = unknown>(threadId: string): T | null;
  /** Persist a named recovery point independently from the rolling snapshot. */
  saveNamedSnapshot(threadId: string, name: string, state: unknown, eventPosition?: number): void;
  /** Load a named recovery point, or null when it is absent/corrupt. */
  loadNamedSnapshot<T = unknown>(threadId: string, name: string): T | null;
  /** Return the last durable event position for a thread. */
  getLastEventPosition(threadId: string): number;
  listSessions(query?: string, limit?: number): RuntimeSessionInfo[];
  setSessionName(threadId: string, name: string): void;
  deleteSession(threadId: string): void;
  listNamedSnapshots(threadId: string): RuntimeSnapshotEntry[];
  restoreNamedSnapshot(threadId: string, snapshotId: string): boolean;
  forkSession(sourceThreadId: string, snapshotId: string, targetThreadId: string): boolean;
  /** 关闭数据库连接 / Close the database */
  close(): void;
}

/** event 表行数据类型 / Event table row data type */
interface EventRow {
  id: number;
  thread_id: string;
  event_json: string;
  created_at: number;
}

/** snapshot 表行数据类型 / Snapshot table row data type */
interface SnapshotRow {
  thread_id: string;
  state_json: string;
  created_at: number;
}

/**
 * 创建 RuntimeStore 实例 / Create a RuntimeStore instance.
 *
 * @param dbPath SQLite 数据库路径（可使用 ':memory:'）
 * @returns RuntimeStore 实例
 */
export function createRuntimeStore(dbPath: string): RuntimeStore {
  // 确保父目录存在 / Ensure parent directory exists
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  let isClosed = false;

  // WAL 模式提升并发读写性能 / WAL mode improves concurrent read/write performance
  db.run('PRAGMA journal_mode = wal');
  // 多会话并发写入时避免 SQLITE_BUSY / Avoid SQLITE_BUSY under concurrent multi-session writes
  db.run('PRAGMA busy_timeout = 5000');

  // 建表 / Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  TEXT    NOT NULL,
      event_json TEXT    NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      thread_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // Upgrade pre-metadata RuntimeStore files without touching legacy Graph
  // checkpoints.  The first event timestamp is sufficient for a recoverable
  // list entry; subsequent appends maintain the normal updated_at value.
  db.run(`
    INSERT OR IGNORE INTO runtime_sessions (thread_id, name, updated_at)
    SELECT thread_id, '', MAX(created_at)
    FROM runtime_events
    GROUP BY thread_id
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_named_snapshots (
      thread_id      TEXT    NOT NULL,
      name           TEXT    NOT NULL,
      event_position INTEGER NOT NULL DEFAULT 0,
      state_json     TEXT    NOT NULL,
      created_at     INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (thread_id, name)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_snapshots (
      thread_id  TEXT    PRIMARY KEY,
      state_json TEXT    NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // 索引加速按 thread_id 查询 / Index for thread_id lookups
  db.run('CREATE INDEX IF NOT EXISTS idx_runtime_events_thread ON runtime_events(thread_id)');

  // 预编译 SQL / Prepare cached statements
  const insertEvent = db.query('INSERT INTO runtime_events (thread_id, event_json) VALUES (?, ?)');
  const selectEvents = db.query<EventRow, [string, number]>(
    'SELECT id, thread_id, event_json, created_at FROM runtime_events WHERE thread_id = ? AND id > ? ORDER BY id ASC',
  );
  const selectAllEvents = db.query<EventRow, [string]>(
    'SELECT id, thread_id, event_json, created_at FROM runtime_events WHERE thread_id = ? ORDER BY id ASC',
  );
  const upsertSnapshot = db.query(
    'INSERT OR REPLACE INTO runtime_snapshots (thread_id, state_json, created_at) VALUES (?, ?, unixepoch())',
  );
  const selectSnapshot = db.query<SnapshotRow, [string]>(
    'SELECT thread_id, state_json, created_at FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const upsertNamedSnapshot = db.query(
    'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, created_at) VALUES (?, ?, ?, ?, unixepoch())',
  );
  const selectNamedSnapshot = db.query<{ state_json: string }, [string, string]>(
    'SELECT state_json FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
  );
  const selectLastEventPosition = db.query<{ id: number | null }, [string]>(
    'SELECT MAX(id) AS id FROM runtime_events WHERE thread_id = ?',
  );
  const upsertSession = db.query(
    "INSERT INTO runtime_sessions (thread_id, name, updated_at) VALUES (?, '', unixepoch()) ON CONFLICT(thread_id) DO UPDATE SET updated_at = unixepoch()",
  );
  const setSessionName = db.query(
    'UPDATE runtime_sessions SET name = ?, updated_at = unixepoch() WHERE thread_id = ?',
  );
  const listSessions = db.query<
    { thread_id: string; name: string; updated_at: number; first_message: string | null },
    [number]
  >(
    `SELECT s.thread_id, s.name, s.updated_at,
      (SELECT json_extract(e.event_json, '$.content') FROM runtime_events e
       WHERE e.thread_id = s.thread_id AND json_extract(e.event_json, '$.type') = 'user.message_appended'
       ORDER BY e.id ASC LIMIT 1) AS first_message
     FROM runtime_sessions s
     ORDER BY s.updated_at DESC LIMIT ?`,
  );
  const deleteEvents = db.query('DELETE FROM runtime_events WHERE thread_id = ?');
  const deleteEventsAfter = db.query('DELETE FROM runtime_events WHERE thread_id = ? AND id > ?');
  const deleteSnapshot = db.query('DELETE FROM runtime_snapshots WHERE thread_id = ?');
  const deleteNamedSnapshots = db.query('DELETE FROM runtime_named_snapshots WHERE thread_id = ?');
  const deleteNamedSnapshotsAfter = db.query(
    'DELETE FROM runtime_named_snapshots WHERE thread_id = ? AND event_position > ?',
  );
  const deleteSession = db.query('DELETE FROM runtime_sessions WHERE thread_id = ?');
  const listNamedSnapshots = db.query<
    { name: string; event_position: number; created_at: number },
    [string]
  >(
    'SELECT name, event_position, created_at FROM runtime_named_snapshots WHERE thread_id = ? ORDER BY created_at DESC, name DESC',
  );

  const store: RuntimeStore = {
    appendEvents(threadId: string, events: RuntimeEvent[]): void {
      if (isClosed) return;
      if (events.length === 0) return;

      try {
        db.transaction(() => {
          upsertSession.run(threadId);
          for (const event of events) {
            insertEvent.run(threadId, JSON.stringify(event));
          }
        })();
      } catch (e) {
        throw new Error(
          `Failed to append events for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    appendEventsAndSnapshot(threadId: string, events: RuntimeEvent[], nextState: unknown): void {
      if (isClosed) return;
      try {
        db.transaction(() => {
          upsertSession.run(threadId);
          for (const event of events) {
            insertEvent.run(threadId, JSON.stringify(event));
          }
          upsertSnapshot.run(threadId, JSON.stringify(nextState));
        })();
      } catch (e) {
        throw new Error(
          `Failed to appendEventsAndSnapshot for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    loadEvents(threadId: string, since?: number): StoredEvent[] {
      if (isClosed) return [];
      const rows =
        since != null ? selectEvents.all(threadId, since) : selectAllEvents.all(threadId);

      const events: StoredEvent[] = [];
      for (const row of rows) {
        try {
          events.push({
            id: row.id,
            thread_id: row.thread_id,
            event: JSON.parse(row.event_json) as RuntimeEvent,
            created_at: row.created_at,
          });
        } catch {
          // 跳过无法解析的事件行（数据损坏）/ Skip unparseable event rows (corrupted data)
        }
      }
      return events;
    },

    saveSnapshot(threadId: string, state: unknown): void {
      if (isClosed) return;
      try {
        upsertSnapshot.run(threadId, JSON.stringify(state));
      } catch (e) {
        throw new Error(
          `Failed to save snapshot for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    loadSnapshot<T = unknown>(threadId: string): T | null {
      if (isClosed) return null;
      const row = selectSnapshot.get(threadId);
      if (!row) return null;
      try {
        return JSON.parse(row.state_json) as T;
      } catch {
        // 快照数据损坏时返回 null / Return null on corrupted snapshot data
        return null;
      }
    },

    saveNamedSnapshot(
      threadId: string,
      name: string,
      state: unknown,
      eventPosition?: number,
    ): void {
      if (isClosed) return;
      try {
        const position = eventPosition ?? selectLastEventPosition.get(threadId)?.id ?? 0;
        upsertNamedSnapshot.run(threadId, name, position, JSON.stringify(state));
      } catch (e) {
        throw new Error(
          `Failed to save named snapshot ${name} for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    loadNamedSnapshot<T = unknown>(threadId: string, name: string): T | null {
      if (isClosed) return null;
      const row = selectNamedSnapshot.get(threadId, name);
      if (!row) return null;
      try {
        return JSON.parse(row.state_json) as T;
      } catch {
        return null;
      }
    },

    getLastEventPosition(threadId: string): number {
      if (isClosed) return 0;
      return selectLastEventPosition.get(threadId)?.id ?? 0;
    },

    listSessions(query = '', limit = 50): RuntimeSessionInfo[] {
      if (isClosed) return [];
      const needle = query.trim().toLowerCase();
      return listSessions
        .all(needle ? Math.max(limit, 200) : limit)
        .filter(
          (row) =>
            !needle ||
            row.name.toLowerCase().includes(needle) ||
            (row.first_message ?? '').toLowerCase().includes(needle),
        )
        .slice(0, limit)
        .map((row) => ({
          threadId: row.thread_id,
          name: row.name || row.first_message || row.thread_id,
          updatedAt: row.updated_at,
          needsSmartName: !row.name,
        }));
    },

    setSessionName(threadId: string, name: string): void {
      if (isClosed) return;
      upsertSession.run(threadId);
      setSessionName.run(name, threadId);
    },

    deleteSession(threadId: string): void {
      if (isClosed) return;
      db.transaction(() => {
        deleteEvents.run(threadId);
        deleteSnapshot.run(threadId);
        deleteNamedSnapshots.run(threadId);
        deleteSession.run(threadId);
      })();
    },

    listNamedSnapshots(threadId: string): RuntimeSnapshotEntry[] {
      if (isClosed) return [];
      return listNamedSnapshots.all(threadId).map((row) => ({
        snapshotId: row.name,
        eventPosition: row.event_position,
        createdAt: row.created_at,
      }));
    },

    restoreNamedSnapshot(threadId: string, snapshotId: string): boolean {
      if (isClosed) return false;
      const snapshot = store.loadNamedSnapshot(threadId, snapshotId);
      const entry = listNamedSnapshots.all(threadId).find((item) => item.name === snapshotId);
      if (!snapshot || !entry) return false;
      db.transaction(() => {
        deleteEventsAfter.run(threadId, entry.event_position);
        deleteNamedSnapshotsAfter.run(threadId, entry.event_position);
        upsertSnapshot.run(threadId, JSON.stringify(snapshot));
        upsertSession.run(threadId);
      })();
      return true;
    },

    forkSession(sourceThreadId: string, snapshotId: string, targetThreadId: string): boolean {
      if (isClosed) return false;
      const snapshot = store.loadNamedSnapshot<Record<string, unknown>>(sourceThreadId, snapshotId);
      if (!snapshot) return false;
      const sourceEvents = store.loadEvents(sourceThreadId);
      const position =
        listNamedSnapshots.all(sourceThreadId).find((entry) => entry.name === snapshotId)
          ?.event_position ?? 0;
      const events = sourceEvents
        .filter((entry) => entry.id <= position)
        .map((entry) => entry.event);
      const forkState = structuredClone(snapshot);
      const session = forkState.session as Record<string, unknown> | undefined;
      if (session) session.threadId = targetThreadId;
      const authorization = forkState.authorization as Record<string, unknown> | undefined;
      if (authorization) authorization.commandGrants = {};
      db.transaction(() => {
        deleteEvents.run(targetThreadId);
        deleteSnapshot.run(targetThreadId);
        deleteNamedSnapshots.run(targetThreadId);
        deleteSession.run(targetThreadId);
        upsertSession.run(targetThreadId);
        for (const event of events) insertEvent.run(targetThreadId, JSON.stringify(event));
        const targetPosition = selectLastEventPosition.get(targetThreadId)?.id ?? 0;
        upsertSnapshot.run(targetThreadId, JSON.stringify(forkState));
        upsertNamedSnapshot.run(
          targetThreadId,
          snapshotId,
          targetPosition,
          JSON.stringify(forkState),
        );
      })();
      return true;
    },

    close(): void {
      if (isClosed) return;
      isClosed = true;
      try {
        db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best-effort */
      }
      db.close();
    },
  };

  return store;
}
