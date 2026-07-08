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

/** RuntimeStore 接口 / Runtime store interface */
export interface RuntimeStore {
  /** 批量追加事件（事务写入）/ Append events in a transaction */
  appendEvents(threadId: string, events: RuntimeEvent[]): void;
  /** 加载线程事件，可选从某个 ID 之后开始 / Load events, optionally since a given id */
  loadEvents(threadId: string, since?: number): StoredEvent[];
  /** 保存状态快照（INSERT OR REPLACE）/ Save a state snapshot */
  saveSnapshot(threadId: string, state: unknown): void;
  /** 加载最新状态快照 / Load the latest state snapshot */
  loadSnapshot<T = unknown>(threadId: string): T | null;
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

  const store: RuntimeStore = {
    appendEvents(threadId: string, events: RuntimeEvent[]): void {
      if (isClosed) return;
      if (events.length === 0) return;

      try {
        db.transaction(() => {
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
