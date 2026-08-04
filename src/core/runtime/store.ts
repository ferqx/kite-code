// ── Runtime 事件存储 / Runtime event store ──
// 提供 runtime_events（追加型事件日志）和 runtime_snapshots（可覆盖状态快照）的持久化

import { constants, Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeEvent } from './events.js';

export const RUNTIME_STORE_SCHEMA_VERSION = 2;
export type RuntimeJournalMode = 'wal' | 'delete';

export function defaultRuntimeJournalMode(): RuntimeJournalMode {
  return process.platform === 'win32' ? 'delete' : 'wal';
}

export interface RuntimeStoreOptions {
  /**
   * WAL is the normal production mode. Bun currently keeps WAL files locked
   * after close on Windows, so DELETE is the safe platform default there.
   */
  journalMode?: RuntimeJournalMode;
  /** Test-only SQLite page ceiling used to inject deterministic SQLITE_FULL writes. */
  faultInjectionMaxPageCount?: number;
}

/** A durable one-shot egress permit nonce was already claimed by another receipt. */
export class RemoteMcpEgressNonceConflictError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super('Remote MCP egress permit nonce was already consumed.', options);
    this.name = 'RemoteMcpEgressNonceConflictError';
  }
}

export interface RuntimeEventMetadata {
  eventId: string;
  revision: number;
  causationId?: string;
  occurredAt?: string;
}

export interface RuntimeSnapshotMetadata {
  eventPosition: number;
  stateRevision: number;
  stateChecksum: string;
  schemaVersion: number;
}

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
  event_id?: string;
  revision?: number;
  causation_id?: string;
  occurred_at?: string;
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
  /** First user message after this recovery point, used to describe its boundary. */
  targetMessage?: string;
  /** Persisted event timestamp for the boundary message (Unix seconds). */
  targetMessageCreatedAt?: number;
  /** Number of recorded file paths that would be affected by a code rewind. */
  affectedFileCount?: number;
}

/** Derive the runtime sidecar path without turning SQLite's memory sentinel into a file. */
export function runtimeStorePathFor(checkpointPath: string): string {
  if (checkpointPath === ':memory:') return ':memory:';
  return `${checkpointPath.replace(/\.sqlite$/, '')}.runtime.db`;
}

/** RuntimeStore 接口 / Runtime store interface */
export interface RuntimeStore {
  /** 批量追加事件（事务写入）/ Append events in a transaction */
  appendEvents(threadId: string, events: RuntimeEvent[], metadata?: RuntimeEventMetadata[]): void;
  /** 批量追加事件并同时写入快照（单一事务原子写入）/ Append events and save snapshot in a single atomic transaction */
  appendEventsAndSnapshot(
    threadId: string,
    events: RuntimeEvent[],
    nextState: unknown,
    metadata?: RuntimeEventMetadata[],
    snapshotMetadata?: RuntimeSnapshotMetadata,
  ): void;
  /** 加载线程事件，可选从某个 ID 之后开始 / Load events, optionally since a given id */
  loadEvents(threadId: string, since?: number): StoredEvent[];
  /** Strict event loading for recovery paths; corrupted rows are surfaced. */
  loadEventsStrict(threadId: string, since?: number): StoredEvent[];
  /** 保存状态快照（INSERT OR REPLACE）/ Save a state snapshot */
  saveSnapshot(threadId: string, state: unknown): void;
  /** 加载最新状态快照 / Load the latest state snapshot */
  loadSnapshot<T = unknown>(threadId: string): T | null;
  loadSnapshotRecord<T = unknown>(
    threadId: string,
  ): { state: T; metadata: RuntimeSnapshotMetadata } | null;
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
  /** Resolve a named recovery point entry (position + timestamp), or null when absent. */
  getNamedSnapshotEntry(threadId: string, snapshotId: string): RuntimeSnapshotEntry | null;
  /**
   * 记录写入前文件原像（ADR-0042 §4）。best-effort：同一检查点窗口（上一次
   * turn 快照之后）内按 path 去重，失败静默，绝不影响工具执行。
   * Record a file pre-image before a write (ADR-0042 §4). Best-effort: deduped
   * per path within a checkpoint window (since the last turn snapshot);
   * failures never break tool execution.
   */
  recordFilePreimage(
    threadId: string,
    path: string,
    content: string | null,
    existed: boolean,
  ): void;
  /**
   * 记录同一检查点窗口内该 path 最近一次成功写入后的内容指纹。
   * Record the latest post-write fingerprint for conflict-safe rewind.
   */
  recordFilePostimage(
    threadId: string,
    path: string,
    contentHash: string | null,
    existed: boolean,
  ): void;
  /** 计算回退到某事件位置时的文件恢复计划 / Compute the file restore plan for rewinding to an event position. */
  fileRestorePlan(
    threadId: string,
    eventPosition: number,
  ): Array<{
    path: string;
    content: string | null;
    existed: boolean;
    postHash: string | null;
    postExisted: boolean | null;
  }>;
  /** 关闭数据库连接 / Close the database */
  close(): void;
}

/** event 表行数据类型 / Event table row data type */
interface EventRow {
  id: number;
  thread_id: string;
  event_json: string;
  created_at: number;
  event_id: string | null;
  revision: number;
  causation_id: string | null;
  occurred_at: string | null;
}

/** snapshot 表行数据类型 / Snapshot table row data type */
interface SnapshotRow {
  thread_id: string;
  state_json: string;
  created_at: number;
  event_position: number;
  state_revision: number;
  state_checksum: string;
  schema_version: number;
}

function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rebindForkState(
  sourceState: Record<string, unknown>,
  targetThreadId: string,
): Record<string, unknown> {
  const forkState = structuredClone(sourceState);
  const session = forkState.session as Record<string, unknown> | undefined;
  if (session) session.threadId = targetThreadId;

  const authorization = forkState.authorization as Record<string, unknown> | undefined;
  if (authorization) {
    authorization.mode = 'default';
    authorization.commandGrants = {};
    delete authorization.modeSource;
    delete authorization.modeGrantedAt;
  }
  if (forkState.mode === 'full') forkState.mode = 'accept_edits';

  const capabilities = forkState.capabilities as Record<string, unknown> | undefined;
  if (capabilities) {
    capabilities.bindings = {};
    capabilities.disclosures = {};
    delete capabilities.pendingSearch;
  }

  const providerAdmission = forkState.providerAdmission as Record<string, unknown> | undefined;
  if (providerAdmission) {
    providerAdmission.pending = [];
    providerAdmission.waivers = {};
  }

  if ('interactions' in forkState) forkState.interactions = { kind: 'idle' };
  const tools = forkState.tools as Record<string, unknown> | undefined;
  if (tools) {
    tools.queue = [];
    tools.active = [];
  }
  if ('suspendedSubagents' in forkState) forkState.suspendedSubagents = {};
  return forkState;
}

/**
 * 创建 RuntimeStore 实例 / Create a RuntimeStore instance.
 *
 * @param dbPath SQLite 数据库路径（可使用 ':memory:'）
 * @returns RuntimeStore 实例
 */
export function createRuntimeStore(
  dbPath: string,
  options: RuntimeStoreOptions = {},
): RuntimeStore {
  // 确保父目录存在 / Ensure parent directory exists
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
    quarantineLegacyRuntimeStore(dbPath);
  }

  const db = new Database(dbPath);
  let isClosed = false;
  const journalMode = options.journalMode ?? defaultRuntimeJournalMode();

  // Install the bounded lock wait before any pragma or schema write that can
  // contend with another RuntimeStore connection.
  db.run('PRAGMA busy_timeout = 5000');
  // WAL improves concurrency; Windows uses DELETE until Bun releases WAL file locks reliably.
  db.run(`PRAGMA journal_mode = ${journalMode}`);

  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_store_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run("INSERT OR IGNORE INTO runtime_store_meta (key, value) VALUES ('format_version', ?)", [
    String(RUNTIME_STORE_SCHEMA_VERSION),
  ]);
  const formatVersion = db
    .query<{ value: string }, []>(
      "SELECT value FROM runtime_store_meta WHERE key = 'format_version'",
    )
    .get();
  if (!formatVersion || Number(formatVersion.value) !== RUNTIME_STORE_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `RuntimeStore format ${formatVersion?.value ?? 'missing'} is incompatible with ${RUNTIME_STORE_SCHEMA_VERSION}.`,
    );
  }

  // 建表 / Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  TEXT    NOT NULL,
      event_json TEXT    NOT NULL,
      event_id   TEXT,
      revision   INTEGER NOT NULL DEFAULT 0,
      causation_id TEXT,
      occurred_at TEXT,
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
      event_position INTEGER NOT NULL DEFAULT 0,
      state_revision INTEGER NOT NULL DEFAULT 0,
      state_checksum TEXT NOT NULL DEFAULT '',
      schema_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  // 文件写入前原像（ADR-0042 §4）：/rewind 回退检查点时用于恢复工作区文件。
  // event_position 记录捕获时刻的最近事件位置；回退到位置 N 时，每个 path 取
  // event_position > N 的最早一行即为检查点时刻的文件状态（existed=0 表示当时
  // 文件不存在，恢复动作为删除）。
  // File pre-images captured before tool writes (ADR-0042 §4); used to restore
  // workspace files when /rewind reverts to a recovery point.
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_file_preimages (
      thread_id      TEXT    NOT NULL,
      path           TEXT    NOT NULL,
      event_position INTEGER NOT NULL DEFAULT 0,
      content        TEXT,
      existed        INTEGER NOT NULL DEFAULT 1,
      post_hash      TEXT,
      post_existed   INTEGER,
      created_at     INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (thread_id, path, event_position)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_mcp_egress_nonces (
      thread_id     TEXT NOT NULL,
      nonce_digest  TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      created_at    INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (nonce_digest)
    )
  `);

  // Additive metadata upgrades for stores created before runtime tracing was added.
  for (const [table, column, definition] of [
    ['runtime_events', 'event_id', 'TEXT'],
    ['runtime_events', 'revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_events', 'causation_id', 'TEXT'],
    ['runtime_events', 'occurred_at', 'TEXT'],
    ['runtime_snapshots', 'event_position', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_snapshots', 'state_revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_snapshots', 'state_checksum', "TEXT NOT NULL DEFAULT ''"],
    ['runtime_snapshots', 'schema_version', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_file_preimages', 'post_hash', 'TEXT'],
    ['runtime_file_preimages', 'post_existed', 'INTEGER'],
  ] as const) {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((entry) => entry.name);
    if (!columns.includes(column))
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_event_id ON runtime_events(thread_id, event_id) WHERE event_id IS NOT NULL',
  );

  // 索引加速按 thread_id 查询 / Index for thread_id lookups
  db.run('CREATE INDEX IF NOT EXISTS idx_runtime_events_thread ON runtime_events(thread_id)');
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_runtime_file_preimages_position ON runtime_file_preimages(thread_id, event_position)',
  );
  if (options.faultInjectionMaxPageCount != null) {
    if (
      !Number.isInteger(options.faultInjectionMaxPageCount) ||
      options.faultInjectionMaxPageCount <= 0
    ) {
      db.close();
      throw new Error('faultInjectionMaxPageCount must be a positive integer');
    }
    db.run(`PRAGMA max_page_count = ${options.faultInjectionMaxPageCount}`);
  }

  // 预编译 SQL / Prepare cached statements
  const insertEvent = db.query('INSERT INTO runtime_events (thread_id, event_json) VALUES (?, ?)');
  const insertEventWithMetadata = db.query(
    'INSERT OR IGNORE INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertMcpEgressNonce = db.query(
    'INSERT INTO runtime_mcp_egress_nonces (thread_id, nonce_digest, invocation_id, receipt_digest, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteExpiredMcpEgressNonces = db.query(
    'DELETE FROM runtime_mcp_egress_nonces WHERE expires_at <= ?',
  );
  const insertForkEvent = db.query(
    'INSERT INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectEvents = db.query<EventRow, [string, number]>(
    'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at FROM runtime_events WHERE thread_id = ? AND id > ? ORDER BY id ASC',
  );
  const selectAllEvents = db.query<EventRow, [string]>(
    'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, created_at FROM runtime_events WHERE thread_id = ? ORDER BY id ASC',
  );
  const upsertSnapshot = db.query(
    'INSERT OR REPLACE INTO runtime_snapshots (thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())',
  );
  const selectSnapshot = db.query<SnapshotRow, [string]>(
    'SELECT thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const upsertNamedSnapshot = db.query(
    'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, created_at) VALUES (?, ?, ?, ?, unixepoch())',
  );
  const insertForkNamedSnapshot = db.query(
    'INSERT OR REPLACE INTO runtime_named_snapshots (thread_id, name, event_position, state_json, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectNamedSnapshot = db.query<{ state_json: string }, [string, string]>(
    'SELECT state_json FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
  );
  const selectNamedSnapshotsForFork = db.query<
    { name: string; event_position: number; state_json: string; created_at: number },
    [string, number]
  >(
    'SELECT name, event_position, state_json, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND event_position <= ? ORDER BY event_position ASC, name ASC',
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
  const insertFilePreimage = db.query(
    'INSERT OR REPLACE INTO runtime_file_preimages (thread_id, path, event_position, content, existed) VALUES (?, ?, ?, ?, ?)',
  );
  const selectFilePreimageInWindow = db.query<{ path: string }, [string, string, number]>(
    'SELECT path FROM runtime_file_preimages WHERE thread_id = ? AND path = ? AND event_position > ? LIMIT 1',
  );
  const updateFilePostimageInWindow = db.query(
    `UPDATE runtime_file_preimages
     SET post_hash = ?, post_existed = ?
     WHERE rowid = (
       SELECT rowid
       FROM runtime_file_preimages
       WHERE thread_id = ? AND path = ? AND event_position > ?
       ORDER BY event_position DESC
       LIMIT 1
     )`,
  );
  const selectLatestSnapshotPosition = db.query<{ event_position: number | null }, [string]>(
    'SELECT MAX(event_position) AS event_position FROM runtime_named_snapshots WHERE thread_id = ?',
  );
  const selectNamedSnapshotEntry = db.query<
    { name: string; event_position: number; created_at: number },
    [string, string]
  >(
    'SELECT name, event_position, created_at FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
  );
  const selectFileRestorePlan = db.query<
    {
      path: string;
      content: string | null;
      existed: number;
      post_hash: string | null;
      post_existed: number | null;
    },
    [string, number]
  >(
    `WITH bounds AS (
       SELECT thread_id, path,
              MIN(event_position) AS min_position,
              MAX(event_position) AS max_position
       FROM runtime_file_preimages
       WHERE thread_id = ? AND event_position > ?
       GROUP BY thread_id, path
     )
     SELECT first.path AS path,
            first.content AS content,
            first.existed AS existed,
            last.post_hash AS post_hash,
            last.post_existed AS post_existed
     FROM bounds
     JOIN runtime_file_preimages first
       ON first.thread_id = bounds.thread_id
      AND first.path = bounds.path
      AND first.event_position = bounds.min_position
     JOIN runtime_file_preimages last
       ON last.thread_id = bounds.thread_id
      AND last.path = bounds.path
      AND last.event_position = bounds.max_position`,
  );
  const deleteFilePreimages = db.query('DELETE FROM runtime_file_preimages WHERE thread_id = ?');
  const deleteFilePreimagesAfter = db.query(
    'DELETE FROM runtime_file_preimages WHERE thread_id = ? AND event_position > ?',
  );
  const selectFilePreimagesForFork = db.query<
    {
      path: string;
      event_position: number;
      content: string | null;
      existed: number;
      post_hash: string | null;
      post_existed: number | null;
      created_at: number;
    },
    [string, number]
  >(
    `SELECT path, event_position, content, existed, post_hash, post_existed, created_at
     FROM runtime_file_preimages
     WHERE thread_id = ? AND event_position <= ?
     ORDER BY event_position ASC, path ASC`,
  );
  const insertForkFilePreimage = db.query(
    `INSERT OR REPLACE INTO runtime_file_preimages
       (thread_id, path, event_position, content, existed, post_hash, post_existed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteSession = db.query('DELETE FROM runtime_sessions WHERE thread_id = ?');
  const listNamedSnapshots = db.query<
    {
      name: string;
      event_position: number;
      created_at: number;
      target_message: string | null;
      target_message_created_at: number | null;
      affected_file_count: number;
    },
    [string]
  >(
    `SELECT s.name, s.event_position, s.created_at,
       (SELECT json_extract(e.event_json, '$.content')
        FROM runtime_events e
        WHERE e.thread_id = s.thread_id
          AND e.id > s.event_position
          AND json_extract(e.event_json, '$.type') = 'user.message_appended'
        ORDER BY e.id ASC LIMIT 1) AS target_message,
       (SELECT e.created_at
        FROM runtime_events e
        WHERE e.thread_id = s.thread_id
          AND e.id > s.event_position
          AND json_extract(e.event_json, '$.type') = 'user.message_appended'
        ORDER BY e.id ASC LIMIT 1) AS target_message_created_at,
       (SELECT COUNT(DISTINCT p.path)
        FROM runtime_file_preimages p
        WHERE p.thread_id = s.thread_id
          AND p.event_position > s.event_position) AS affected_file_count
     FROM runtime_named_snapshots s
     WHERE s.thread_id = ?
     ORDER BY s.created_at DESC, s.name DESC`,
  );
  const statements = [
    insertEvent,
    insertEventWithMetadata,
    insertMcpEgressNonce,
    deleteExpiredMcpEgressNonces,
    insertForkEvent,
    selectEvents,
    selectAllEvents,
    upsertSnapshot,
    selectSnapshot,
    upsertNamedSnapshot,
    insertForkNamedSnapshot,
    selectNamedSnapshot,
    selectNamedSnapshotsForFork,
    selectLastEventPosition,
    upsertSession,
    setSessionName,
    listSessions,
    deleteEvents,
    deleteEventsAfter,
    deleteSnapshot,
    deleteNamedSnapshots,
    deleteNamedSnapshotsAfter,
    insertFilePreimage,
    selectFilePreimageInWindow,
    updateFilePostimageInWindow,
    selectLatestSnapshotPosition,
    selectNamedSnapshotEntry,
    selectFileRestorePlan,
    deleteFilePreimages,
    deleteFilePreimagesAfter,
    selectFilePreimagesForFork,
    insertForkFilePreimage,
    deleteSession,
    listNamedSnapshots,
  ] as const;

  const claimMcpEgressNonce = (threadId: string, event: RuntimeEvent): void => {
    if (
      event.type !== 'mcp.egress_decided' ||
      !event.decision.admitted ||
      event.decision.reason !== 'permit_consumed' ||
      !event.decision.nonceDigest ||
      !event.decision.permitExpiresAt
    ) {
      return;
    }
    deleteExpiredMcpEgressNonces.run(event.decision.decidedAt);
    try {
      insertMcpEgressNonce.run(
        threadId,
        event.decision.nonceDigest,
        event.decision.invocationId,
        event.decision.receiptDigest,
        event.decision.permitExpiresAt,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('runtime_mcp_egress_nonces.nonce_digest') ||
        message.includes('UNIQUE constraint failed: runtime_mcp_egress_nonces')
      ) {
        throw new RemoteMcpEgressNonceConflictError({ cause: error });
      }
      throw error;
    }
  };

  const store: RuntimeStore = {
    appendEvents(
      threadId: string,
      events: RuntimeEvent[],
      metadata?: RuntimeEventMetadata[],
    ): void {
      if (isClosed) return;
      if (events.length === 0) return;

      try {
        db.transaction(() => {
          upsertSession.run(threadId);
          for (const [index, event] of events.entries()) {
            claimMcpEgressNonce(threadId, event);
            const entry = metadata?.[index];
            if (entry) {
              insertEventWithMetadata.run(
                threadId,
                JSON.stringify(event),
                entry.eventId,
                entry.revision,
                entry.causationId ?? null,
                entry.occurredAt ?? new Date().toISOString(),
              );
            } else {
              insertEvent.run(threadId, JSON.stringify(event));
            }
          }
        })();
      } catch (e) {
        if (e instanceof RemoteMcpEgressNonceConflictError) throw e;
        throw new Error(
          `Failed to append events for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    appendEventsAndSnapshot(
      threadId: string,
      events: RuntimeEvent[],
      nextState: unknown,
      metadata?: RuntimeEventMetadata[],
      snapshotMetadata?: RuntimeSnapshotMetadata,
    ): void {
      if (isClosed) return;
      try {
        db.transaction(() => {
          upsertSession.run(threadId);
          for (const [index, event] of events.entries()) {
            claimMcpEgressNonce(threadId, event);
            const entry = metadata?.[index];
            if (entry) {
              insertEventWithMetadata.run(
                threadId,
                JSON.stringify(event),
                entry.eventId,
                entry.revision,
                entry.causationId ?? null,
                entry.occurredAt ?? new Date().toISOString(),
              );
            } else {
              insertEvent.run(threadId, JSON.stringify(event));
            }
          }
          const serialized = JSON.stringify(nextState);
          const state = nextState as { revision?: number; schemaVersion?: number };
          upsertSnapshot.run(
            threadId,
            serialized,
            snapshotMetadata?.eventPosition ?? selectLastEventPosition.get(threadId)?.id ?? 0,
            snapshotMetadata?.stateRevision ?? state.revision ?? 0,
            snapshotMetadata?.stateChecksum ?? checksum(serialized),
            snapshotMetadata?.schemaVersion ?? state.schemaVersion ?? 0,
          );
        })();
      } catch (e) {
        if (e instanceof RemoteMcpEgressNonceConflictError) throw e;
        throw new Error(
          `Failed to appendEventsAndSnapshot for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    loadEvents(threadId: string, since?: number): StoredEvent[] {
      try {
        return store.loadEventsStrict(threadId, since);
      } catch {
        return [];
      }
    },

    loadEventsStrict(threadId: string, since?: number): StoredEvent[] {
      if (isClosed) return [];
      const rows =
        since != null ? selectEvents.all(threadId, since) : selectAllEvents.all(threadId);

      return rows.map((row) => ({
        id: row.id,
        thread_id: row.thread_id,
        event: JSON.parse(row.event_json) as RuntimeEvent,
        created_at: row.created_at,
        ...(row.event_id ? { event_id: row.event_id } : {}),
        revision: row.revision,
        ...(row.causation_id ? { causation_id: row.causation_id } : {}),
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
      }));
    },

    saveSnapshot(threadId: string, state: unknown): void {
      if (isClosed) return;
      try {
        const serialized = JSON.stringify(state);
        const snapshot = state as { revision?: number; schemaVersion?: number };
        upsertSnapshot.run(
          threadId,
          serialized,
          selectLastEventPosition.get(threadId)?.id ?? 0,
          snapshot.revision ?? 0,
          checksum(serialized),
          snapshot.schemaVersion ?? 0,
        );
      } catch (e) {
        throw new Error(
          `Failed to save snapshot for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    loadSnapshot<T = unknown>(threadId: string): T | null {
      return store.loadSnapshotRecord<T>(threadId)?.state ?? null;
    },

    loadSnapshotRecord<T = unknown>(
      threadId: string,
    ): { state: T; metadata: RuntimeSnapshotMetadata } | null {
      if (isClosed) return null;
      const row = selectSnapshot.get(threadId);
      if (!row) return null;
      try {
        const state = JSON.parse(row.state_json) as T;
        if (row.state_checksum && checksum(row.state_json) !== row.state_checksum) return null;
        return {
          state,
          metadata: {
            eventPosition: row.event_position,
            stateRevision: row.state_revision,
            stateChecksum: row.state_checksum,
            schemaVersion: row.schema_version,
          },
        };
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
        deleteFilePreimages.run(threadId);
        deleteSession.run(threadId);
      })();
    },

    listNamedSnapshots(threadId: string): RuntimeSnapshotEntry[] {
      if (isClosed) return [];
      return listNamedSnapshots.all(threadId).map((row) => ({
        snapshotId: row.name,
        eventPosition: row.event_position,
        createdAt: row.created_at,
        targetMessage: row.target_message ?? undefined,
        targetMessageCreatedAt: row.target_message_created_at ?? undefined,
        affectedFileCount: row.affected_file_count,
      }));
    },

    getNamedSnapshotEntry(threadId: string, snapshotId: string): RuntimeSnapshotEntry | null {
      if (isClosed) return null;
      const row = selectNamedSnapshotEntry.get(threadId, snapshotId);
      if (!row) return null;
      return { snapshotId: row.name, eventPosition: row.event_position, createdAt: row.created_at };
    },

    recordFilePreimage(
      threadId: string,
      path: string,
      content: string | null,
      existed: boolean,
    ): void {
      if (isClosed || !threadId || !path) return;
      try {
        // 同一检查点窗口（上一个 turn 快照之后）内每个 path 只记录最早一份原像：
        // 它才是检查点时刻的文件状态，后续覆写的原像对回退无意义。
        const boundary = selectLatestSnapshotPosition.get(threadId)?.event_position ?? -1;
        if (selectFilePreimageInWindow.get(threadId, path, boundary)) return;
        const position = selectLastEventPosition.get(threadId)?.id ?? 0;
        insertFilePreimage.run(threadId, path, position, content, existed ? 1 : 0);
      } catch {
        // best-effort：原像记录失败绝不影响工具执行
        // best-effort: pre-image capture failure must never break tool execution
      }
    },

    recordFilePostimage(
      threadId: string,
      path: string,
      contentHash: string | null,
      existed: boolean,
    ): void {
      if (isClosed || !threadId || !path) return;
      try {
        const boundary = selectLatestSnapshotPosition.get(threadId)?.event_position ?? -1;
        updateFilePostimageInWindow.run(contentHash, existed ? 1 : 0, threadId, path, boundary);
      } catch {
        // best-effort：后像指纹记录失败不得影响工具执行
        // best-effort: post-image capture failure must never break tool execution
      }
    },

    fileRestorePlan(
      threadId: string,
      eventPosition: number,
    ): Array<{
      path: string;
      content: string | null;
      existed: boolean;
      postHash: string | null;
      postExisted: boolean | null;
    }> {
      if (isClosed) return [];
      return selectFileRestorePlan.all(threadId, eventPosition).map((row) => ({
        path: row.path,
        content: row.content,
        existed: row.existed === 1,
        postHash: row.post_hash,
        postExisted: row.post_existed == null ? null : row.post_existed === 1,
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
        // ADR-0042 §4：文件原像随恢复点一同截断（调用方应在此之前完成文件恢复）
        deleteFilePreimagesAfter.run(threadId, entry.event_position);
        const serialized = JSON.stringify(snapshot);
        const state = snapshot as { revision?: number; schemaVersion?: number };
        upsertSnapshot.run(
          threadId,
          serialized,
          entry.event_position,
          state.revision ?? 0,
          checksum(serialized),
          state.schemaVersion ?? 0,
        );
        upsertSession.run(threadId);
      })();
      return true;
    },

    forkSession(sourceThreadId: string, snapshotId: string, targetThreadId: string): boolean {
      if (isClosed) return false;
      const snapshot = store.loadNamedSnapshot(sourceThreadId, snapshotId);
      if (!isRecord(snapshot)) return false;
      const position =
        listNamedSnapshots.all(sourceThreadId).find((entry) => entry.name === snapshotId)
          ?.event_position ?? 0;
      let sourceEvents: StoredEvent[];
      try {
        sourceEvents = store
          .loadEventsStrict(sourceThreadId)
          .filter((entry) => entry.id <= position);
      } catch {
        return false;
      }
      const sourceNamedSnapshots = selectNamedSnapshotsForFork.all(sourceThreadId, position);
      const sourceFilePreimages = selectFilePreimagesForFork.all(sourceThreadId, position);
      const forkState = rebindForkState(snapshot, targetThreadId);
      db.transaction(() => {
        deleteEvents.run(targetThreadId);
        deleteSnapshot.run(targetThreadId);
        deleteNamedSnapshots.run(targetThreadId);
        deleteFilePreimages.run(targetThreadId);
        deleteSession.run(targetThreadId);
        upsertSession.run(targetThreadId);
        const positionMap = new Map<number, number>();
        for (const entry of sourceEvents) {
          const inserted = insertForkEvent.run(
            targetThreadId,
            JSON.stringify(entry.event),
            entry.event_id ?? null,
            entry.revision ?? 0,
            entry.causation_id ?? null,
            entry.occurred_at ?? null,
            entry.created_at,
          );
          positionMap.set(entry.id, Number(inserted.lastInsertRowid));
        }
        const remapPosition = (sourcePosition: number): number => {
          let targetPosition = 0;
          for (const entry of sourceEvents) {
            if (entry.id > sourcePosition) break;
            targetPosition = positionMap.get(entry.id) ?? targetPosition;
          }
          return targetPosition;
        };
        for (const preimage of sourceFilePreimages) {
          insertForkFilePreimage.run(
            targetThreadId,
            preimage.path,
            remapPosition(preimage.event_position),
            preimage.content,
            preimage.existed,
            preimage.post_hash,
            preimage.post_existed,
            preimage.created_at,
          );
        }
        const targetPosition = remapPosition(position);
        const serialized = JSON.stringify(forkState);
        const state = forkState as { revision?: number; schemaVersion?: number };
        upsertSnapshot.run(
          targetThreadId,
          serialized,
          targetPosition,
          state.revision ?? 0,
          checksum(serialized),
          state.schemaVersion ?? 0,
        );
        for (const namedSnapshot of sourceNamedSnapshots) {
          try {
            const namedState = rebindForkState(
              JSON.parse(namedSnapshot.state_json) as Record<string, unknown>,
              targetThreadId,
            );
            insertForkNamedSnapshot.run(
              targetThreadId,
              namedSnapshot.name,
              remapPosition(namedSnapshot.event_position),
              JSON.stringify(namedState),
              namedSnapshot.created_at,
            );
          } catch {
            // Earlier corrupt recovery points are omitted; the selected point was validated above.
          }
        }
      })();
      return true;
    },

    close(): void {
      if (isClosed) return;
      isClosed = true;
      for (const statement of statements) statement.finalize();
      if (journalMode === 'wal') {
        try {
          db.fileControl('main', constants.SQLITE_FCNTL_PERSIST_WAL, 0);
        } catch {
          /* best-effort WAL persistence cleanup */
        }
        try {
          db.run('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          /* best-effort WAL checkpoint */
        }
      }
      db.close();
    },
  };

  return store;
}

/**
 * 隔离没有新格式标记的旧 RuntimeStore，避免把旧快照静默恢复成新状态。
 * Quarantine an unmarked legacy RuntimeStore instead of silently restoring it.
 */
function quarantineLegacyRuntimeStore(dbPath: string): void {
  if (!existsSync(dbPath)) return;

  const database = new Database(dbPath);
  try {
    const hasLegacyRuntimeTable = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('runtime_events', 'runtime_snapshots', 'runtime_named_snapshots')",
      )
      .get()?.count;
    const hasFormatMarker = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_store_meta'",
      )
      .get()?.count;
    if (!hasLegacyRuntimeTable || hasFormatMarker) return;
  } finally {
    database.close();
  }

  const legacyPath = `${dbPath}.legacy`;
  if (existsSync(legacyPath)) {
    renameSync(legacyPath, `${legacyPath}.${Date.now()}`);
  }
  renameSync(dbPath, legacyPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) renameSync(sidecar, `${legacyPath}${suffix}`);
  }
}
