// ── Runtime 事件存储 / Runtime event store ──
// 提供 runtime_events（追加型事件日志）和 runtime_snapshots（可覆盖状态快照）的持久化

import { constants, Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalContextDigestV3 } from '../model/context-checkpoint-v3';
import {
  assertBranchMutationOpaqueCandidateV1,
  type BranchMutationOpaqueCandidateV1,
  createBranchMutationOpaqueCandidateV1,
  type DerivedBranchLifecycleMutationV1,
} from './branch-mutation-v1';
import {
  type BranchCopiedTerminalClosureV1,
  type BranchMutationCompletionV1,
  type BranchMutationReceiptV1,
  decodeBranchCopiedTerminalClosureV1,
  decodeBranchMutationCompletionV1,
  decodeBranchMutationReceiptV1,
  encodeBranchCopiedTerminalClosureV1,
  encodeBranchMutationCompletionV1,
  encodeBranchMutationReceiptV1,
  finalizeBranchCopiedTerminalClosureV1,
  finalizeBranchMutationCompletionV1,
  finalizeBranchMutationReceiptV1,
} from './branch-receipt-v1';
import type { RuntimeEvent } from './events.js';
import {
  assertCanonicalRuntimeEventEnvelopeV24,
  canonicalRuntimeEventEnvelopeBytesV24,
} from './runtime-event-v24';
import {
  createBranchReboundRuntimeStorageFormatV24,
  createLegacyNamedCutProofV1,
  type LegacyNamedCutProofV1,
  type LegacyRuntimeLedgerEvidenceV1,
  migrateLegacyNamedStateV24,
  verifyLegacyNamedCutProofV1,
} from './runtime-storage-v24';
import type { RuntimeState } from './state';

export const RUNTIME_STORE_SCHEMA_VERSION = 2;
const MAX_RUNTIME_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_EVENT_CANONICAL_BYTES = 128 * 1024;
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
  /** Test-only: hide one successful branch COMMIT acknowledgement. */
  faultInjectionBranchCommitAckUnknown?: boolean;
}

export interface BranchMutationAuthorityV1 {
  completion: BranchMutationCompletionV1;
  receipt?: BranchMutationReceiptV1;
  terminalClosure?: BranchCopiedTerminalClosureV1;
}

export type BranchMutationCompletionResolutionV1 =
  | { status: 'already_committed'; authority: BranchMutationAuthorityV1 }
  | { status: 'definitely_not_committed' }
  | { status: 'unknown_or_superseded' }
  | { status: 'resolution_unavailable' }
  | { status: 'collision_or_corruption' };

export type BranchMutationCommitResultV1 =
  | { status: 'committed'; receiptId: string; targetGeneration: number }
  | { status: 'identity_stale' }
  | { status: 'contention_timeout' }
  | { status: 'resource_saturated' }
  | { status: 'transcript_invariant_error' }
  | { status: 'digest_invalid' }
  | {
      status: 'commit_ack_unknown';
      targetThreadId: string;
      targetGeneration: number;
      receiptId: string;
      requestDigest: string;
      candidateDigest: string;
      manifestDigest: string;
      postSnapshotDigest: string;
    };

/** Close the only legal post-COMMIT ACK-unknown path without reissuing the mutation. */
export function branchMutationCommittedV1(
  store: Pick<RuntimeStore, 'resolveBranchMutationCompletionV1'>,
  result: BranchMutationCommitResultV1,
): boolean {
  if (result.status === 'committed') return true;
  if (result.status !== 'commit_ack_unknown') return false;
  return store.resolveBranchMutationCompletionV1(result).status === 'already_committed';
}

export type RuntimeV24MigrationBuildResultV1 =
  | { status: 'in_progress'; processedRows: number; totalRows: number }
  | { status: 'complete'; evidence: LegacyRuntimeLedgerEvidenceV1 }
  | { status: 'stale' };

/** A durable one-shot egress permit nonce was already claimed by another receipt. */
export class RemoteMcpEgressNonceConflictError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super('Remote MCP egress permit nonce was already consumed.', options);
    this.name = 'RemoteMcpEgressNonceConflictError';
  }
}

export class RuntimeRevisionConflictError extends Error {
  constructor(threadId: string, expected: number, actual: number | null) {
    super(
      `Runtime revision conflict for ${threadId}: expected ${expected}, found ${actual ?? 'deleted'}.`,
    );
    this.name = 'RuntimeRevisionConflictError';
  }
}

export interface RuntimeEventMetadata {
  eventId: string;
  revision: number;
  causationId?: string | null;
  occurredAt?: string;
  schemaVersion?: number;
  generation?: number;
  canonicalBytes?: number;
}

export interface RuntimeSnapshotMetadata {
  eventPosition: number;
  stateRevision: number;
  stateChecksum: string;
  schemaVersion: number;
}

export interface RuntimeObservedEventHeadV1 {
  eventPosition: number;
  revision: number;
  eventId: string | null;
}

export interface RuntimeMigrationIdentityV1 {
  generation: number;
  writeEpoch: number;
  format: 'v23_compat' | 'v24_strict';
  lifecycle: 'active' | 'deleted';
  sourceSnapshot: RuntimeSnapshotMetadata;
  observedHead: RuntimeObservedEventHeadV1;
}

export interface RuntimePersistenceIdentityV1 {
  generation: number;
  writeEpoch: number;
  format: 'v23_compat' | 'v24_strict';
  lifecycle: 'active' | 'deleted';
  sourceSnapshot: RuntimeSnapshotMetadata | null;
  observedHead: RuntimeObservedEventHeadV1;
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
  producer_generation?: number;
  canonical_bytes?: number;
}

export interface RuntimeSessionInfo {
  threadId: string;
  name: string;
  updatedAt: number;
  needsSmartName: boolean;
}

export interface RuntimeSessionModelRoute {
  provider: string;
  name: string;
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
    expectedIdentity?: RuntimePersistenceIdentityV1,
  ): RuntimePersistenceIdentityV1;
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
  /** Atomically observe the rolling snapshot identity and full durable event head. */
  loadPersistenceIdentity(threadId: string): RuntimePersistenceIdentityV1;
  /** Exact snapshot+event-head CAS used only to publish a pure legacy migration candidate. */
  compareAndSaveMigratedSnapshot(
    threadId: string,
    identity: RuntimeMigrationIdentityV1,
    candidate: unknown,
    events?: RuntimeEvent[],
    metadata?: RuntimeEventMetadata[],
  ): 'saved' | 'stale';
  /** Advance at most one bounded legacy-ledger migration chunk. */
  advanceRuntimeV24MigrationBuildV1(
    threadId: string,
    identity: RuntimeMigrationIdentityV1,
    maxRows?: number,
  ): RuntimeV24MigrationBuildResultV1;
  /** Persist a named recovery point independently from the rolling snapshot. */
  saveNamedSnapshot(
    threadId: string,
    name: string,
    state: unknown,
    eventPosition?: number,
    expectedIdentity?: RuntimePersistenceIdentityV1,
  ): void;
  /** Load a named recovery point, or null when it is absent/corrupt. */
  loadNamedSnapshot<T = unknown>(threadId: string, name: string): T | null;
  /** Return the last durable event position for a thread. */
  getLastEventPosition(threadId: string): number;
  listSessions(query?: string, limit?: number): RuntimeSessionInfo[];
  setSessionName(threadId: string, name: string): void;
  getSessionModelRoute(threadId: string): RuntimeSessionModelRoute | null;
  setSessionModelRoute(threadId: string, route: RuntimeSessionModelRoute): void;
  deleteSession(threadId: string, expectedIdentity?: RuntimePersistenceIdentityV1): void;
  tryAcquireEffectLease(
    threadId: string,
    effectId: string,
    ownerId: string,
    expiresAtMs: number,
  ): boolean;
  renewEffectLease(
    threadId: string,
    effectId: string,
    ownerId: string,
    expiresAtMs: number,
  ): boolean;
  releaseEffectLease(threadId: string, effectId: string, ownerId: string): void;
  listNamedSnapshots(threadId: string): RuntimeSnapshotEntry[];
  restoreNamedSnapshot(
    threadId: string,
    snapshotId: string,
    candidate?: BranchMutationOpaqueCandidateV1,
  ): boolean;
  forkSession(
    sourceThreadId: string,
    snapshotId: string,
    targetThreadId: string,
    candidate?: BranchMutationOpaqueCandidateV1,
  ): boolean;
  restoreNamedSnapshotV1(
    threadId: string,
    snapshotId: string,
    candidate?: BranchMutationOpaqueCandidateV1,
  ): BranchMutationCommitResultV1;
  forkSessionV1(
    sourceThreadId: string,
    snapshotId: string,
    targetThreadId: string,
    candidate?: BranchMutationOpaqueCandidateV1,
  ): BranchMutationCommitResultV1;
  /** Fork the latest rolling snapshot without modifying the source session. */
  forkCurrentSession(sourceThreadId: string, targetThreadId: string): boolean;
  /** Length-first bounded lookup for immutable branch authority. */
  loadBranchMutationAuthorityV1(
    targetThreadId: string,
    targetGeneration: number,
    receiptId: string,
  ): BranchMutationAuthorityV1 | null;
  /** Resolve an ACK-unknown branch candidate without reissuing its mutation. */
  resolveBranchMutationCompletionV1(input: {
    targetThreadId: string;
    targetGeneration: number;
    receiptId: string;
    requestDigest: string;
    candidateDigest: string;
    manifestDigest: string;
    postSnapshotDigest: string;
  }): BranchMutationCompletionResolutionV1;
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
  producer_generation: number | null;
  canonical_bytes: number | null;
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
  remapEventPosition?: (sourcePosition: number) => number,
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
  if (remapEventPosition) {
    const remapResultMeta = (value: unknown): void => {
      if (!isRecord(value)) return;
      const migration = value.terminalMigration;
      if (isRecord(migration) && typeof migration.originalEventPosition === 'number') {
        migration.originalEventPosition = remapEventPosition(migration.originalEventPosition);
      }
    };
    const calls = isRecord(tools?.calls) ? tools.calls : {};
    for (const call of Object.values(calls)) {
      if (!isRecord(call) || !isRecord(call.result)) continue;
      remapResultMeta(call.result.resultMeta);
    }
    const transcript = isRecord(forkState.transcript) ? forkState.transcript : undefined;
    if (transcript && Array.isArray(transcript.messages)) {
      for (const message of transcript.messages) {
        if (isRecord(message)) remapResultMeta(message.resultMeta);
      }
    }
  }
  return forkState;
}

function rebaseBranchStateV24(
  state: Record<string, unknown>,
  kind: 'verified_named_v24' | 'fork_rebound_v24',
  branchIdentity: string,
  branchMutationReceiptId?: string,
): Record<string, unknown> {
  if (state.schemaVersion !== 24) return state;
  const revision =
    typeof state.revision === 'number' && Number.isSafeInteger(state.revision) ? state.revision : 0;
  const context = isRecord(state.context) ? state.context : undefined;
  if (context) {
    delete context.projectionBaseIdentity;
    delete context.pendingCompaction;
  }
  state.lastAppliedEventId = undefined;
  state.appliedEventIds = [];
  const { storageFormat: _storageFormat, ...canonicalState } = state;
  state.storageFormat = createBranchReboundRuntimeStorageFormatV24({
    kind,
    stateRevision: revision,
    branchIdentity,
    canonicalState: JSON.stringify(canonicalState),
    ...(branchMutationReceiptId ? { branchMutationReceiptId } : {}),
  });
  return state;
}

/**
 * A TUI recovery fork has an intentionally sanitized snapshot. Do not copy
 * the one unfinished request that produced its source interaction into the
 * fork's event history, otherwise TUI transcript replay would recreate the
 * hidden prompt even though the fork's Runtime state is idle.
 */
function isCurrentPendingInteractionRequest(
  sourceState: Record<string, unknown>,
  event: RuntimeEvent,
): boolean {
  const interaction = sourceState.interactions;
  if (!isRecord(interaction) || typeof interaction.kind !== 'string') return false;
  const interactionId = interaction.interactionId;
  if (typeof interactionId !== 'string') return false;
  switch (interaction.kind) {
    case 'awaiting_user_input':
      return event.type === 'user_input.requested' && event.interactionId === interactionId;
    case 'awaiting_tool_approval':
      return event.type === 'approval.requested' && event.interactionId === interactionId;
    case 'awaiting_review':
      return event.type === 'plan.review_requested' && event.interactionId === interactionId;
    case 'awaiting_provider_action':
      return event.type === 'provider.action_required' && event.interactionId === interactionId;
    case 'awaiting_provider_admission':
      return event.type === 'provider.admission_required' && event.interactionId === interactionId;
    case 'awaiting_auto_review':
      return event.type === 'auto_review.requested' && event.reviewId === interactionId;
    default:
      return false;
  }
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
  try {
    db.run(`PRAGMA journal_mode = ${journalMode}`);
  } catch (error) {
    if (journalMode !== 'delete') throw error;
    // Bun may defer release of a just-closed WAL handle until finalization.
    // Force finalizers, checkpoint the now-unowned WAL, then make the one bounded retry.
    Bun.gc(true);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.run('PRAGMA journal_mode = delete');
  }

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
      producer_generation INTEGER,
      canonical_bytes INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      thread_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      model_provider TEXT,
      model_name TEXT,
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
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_effect_leases (
      thread_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, effect_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_thread_fences (
      thread_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      format TEXT NOT NULL DEFAULT 'v23_compat',
      write_epoch INTEGER NOT NULL DEFAULT 0,
      lifecycle TEXT NOT NULL DEFAULT 'active'
    )
  `);
  const preUpgradeFenceColumns = db
    .query<{ name: string }, []>('PRAGMA table_info(runtime_thread_fences)')
    .all()
    .map((entry) => entry.name);
  const upgradingLegacyFenceCatalog =
    !preUpgradeFenceColumns.includes('format') ||
    !preUpgradeFenceColumns.includes('write_epoch') ||
    !preUpgradeFenceColumns.includes('lifecycle');
  for (const [column, definition] of [
    ['format', "TEXT NOT NULL DEFAULT 'v23_compat'"],
    ['write_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ['lifecycle', "TEXT NOT NULL DEFAULT 'active'"],
  ] as const) {
    if (!preUpgradeFenceColumns.includes(column)) {
      db.run(`ALTER TABLE runtime_thread_fences ADD COLUMN ${column} ${definition}`);
    }
  }
  if (upgradingLegacyFenceCatalog) {
    db.transaction(() => {
      const legacyFences = db
        .query<{ thread_id: string }, []>('SELECT thread_id FROM runtime_thread_fences')
        .all();
      for (const { thread_id: threadId } of legacyFences) {
        const activeAuthority = db
          .query<{ count: number }, [string, string]>(
            `SELECT
               (SELECT COUNT(*) FROM runtime_sessions WHERE thread_id = ?) +
               (SELECT COUNT(*) FROM runtime_snapshots WHERE thread_id = ?) AS count`,
          )
          .get(threadId, threadId)?.count;
        const otherAuthority = db
          .query<{ count: number }, [string, string, string, string, string]>(
            `SELECT
               (SELECT COUNT(*) FROM runtime_events WHERE thread_id = ?) +
               (SELECT COUNT(*) FROM runtime_named_snapshots WHERE thread_id = ?) +
               (SELECT COUNT(*) FROM runtime_file_preimages WHERE thread_id = ?) +
               (SELECT COUNT(*) FROM runtime_effect_leases WHERE thread_id = ?) +
               (SELECT COUNT(*) FROM runtime_mcp_egress_nonces WHERE thread_id = ?) AS count`,
          )
          .get(threadId, threadId, threadId, threadId, threadId)?.count;
        if (!activeAuthority && otherAuthority) {
          throw new Error(
            `Runtime fence '${threadId}' has orphaned legacy authority and cannot be classified.`,
          );
        }
        db.run(
          `UPDATE runtime_thread_fences
              SET format = 'v23_compat', write_epoch = 1, lifecycle = ?
            WHERE thread_id = ?`,
          [activeAuthority ? 'active' : 'deleted', threadId],
        );
      }
    })();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_fence_catalog_version (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      catalog_version INTEGER NOT NULL
    )
  `);
  db.run(
    'INSERT OR IGNORE INTO runtime_fence_catalog_version (singleton, catalog_version) VALUES (1, 1)',
  );
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_thread_fence_catalog_after_insert
    AFTER INSERT ON runtime_thread_fences
    BEGIN
      UPDATE runtime_fence_catalog_version
         SET catalog_version = catalog_version + 1
       WHERE singleton = 1;
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_thread_fence_catalog_after_update
    AFTER UPDATE OF generation, format, write_epoch, lifecycle ON runtime_thread_fences
    BEGIN
      UPDATE runtime_fence_catalog_version
         SET catalog_version = catalog_version + 1
       WHERE singleton = 1;
      UPDATE runtime_fence_ledger
         SET catalog_version = catalog_version + 1
       WHERE singleton = 1;
    END
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_fence_ledger (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      fence_count INTEGER NOT NULL,
      fence_bytes INTEGER NOT NULL,
      catalog_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('active', 'saturated_legacy'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_fence_ledger_build (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      store_format_version INTEGER NOT NULL,
      expected_catalog_version INTEGER NOT NULL DEFAULT 1,
      expected_count INTEGER NOT NULL,
      expected_max_rowid INTEGER NOT NULL,
      processed_count INTEGER NOT NULL,
      processed_bytes INTEGER NOT NULL,
      progress_rowid INTEGER NOT NULL,
      progress_checksum TEXT NOT NULL
    )
  `);
  const fenceBuildColumns = db
    .query<{ name: string }, []>('PRAGMA table_info(runtime_fence_ledger_build)')
    .all()
    .map((entry) => entry.name);
  if (!fenceBuildColumns.includes('expected_catalog_version')) {
    db.run(
      'ALTER TABLE runtime_fence_ledger_build ADD COLUMN expected_catalog_version INTEGER NOT NULL DEFAULT 1',
    );
  }
  type FenceBuildRow = {
    store_format_version: number;
    expected_catalog_version: number;
    expected_count: number;
    expected_max_rowid: number;
    processed_count: number;
    processed_bytes: number;
    progress_rowid: number;
    progress_checksum: string;
  };
  const fenceLedgerInstalled = db
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_fence_ledger')
    .get()?.count;
  if (fenceLedgerInstalled === 0) {
    const catalogVersion = db
      .query<{ catalog_version: number }, []>(
        'SELECT catalog_version FROM runtime_fence_catalog_version WHERE singleton = 1',
      )
      .get()?.catalog_version;
    if (!catalogVersion) {
      db.close();
      throw new Error('Runtime fence catalog version is unavailable.');
    }
    const basis = db
      .query<{ count: number; max_rowid: number }, []>(
        'SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS max_rowid FROM runtime_thread_fences',
      )
      .get() ?? { count: 0, max_rowid: 0 };
    const initialChecksum = canonicalContextDigestV3('runtime-fence-ledger-build:v1', {
      storeFormatVersion: RUNTIME_STORE_SCHEMA_VERSION,
      expectedCatalogVersion: catalogVersion,
      expectedCount: basis.count,
      expectedMaxRowid: basis.max_rowid,
      processedCount: 0,
      processedBytes: 0,
      progressRowid: 0,
      previousChecksum: 'initial',
    });
    db.run(
      `INSERT OR IGNORE INTO runtime_fence_ledger_build
         (singleton, store_format_version, expected_catalog_version, expected_count, expected_max_rowid,
          processed_count, processed_bytes, progress_rowid, progress_checksum)
       VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?)`,
      [RUNTIME_STORE_SCHEMA_VERSION, catalogVersion, basis.count, basis.max_rowid, initialChecksum],
    );
    for (;;) {
      const build = db
        .query<FenceBuildRow, []>('SELECT * FROM runtime_fence_ledger_build WHERE singleton = 1')
        .get();
      if (!build) break;
      if (build.store_format_version !== RUNTIME_STORE_SCHEMA_VERSION) {
        db.close();
        throw new Error('Runtime fence ledger build store epoch is stale.');
      }
      const rows = db
        .query<
          {
            rowid: number;
            thread_id: string;
            generation: number;
            format: string;
            write_epoch: number;
            lifecycle: string;
          },
          [number, number]
        >(
          'SELECT rowid, thread_id, generation, format, write_epoch, lifecycle FROM runtime_thread_fences WHERE rowid > ? AND rowid <= ? ORDER BY rowid ASC LIMIT 4096',
        )
        .all(build.progress_rowid, build.expected_max_rowid);
      if (rows.length === 0) {
        if (build.processed_count !== build.expected_count) {
          db.close();
          throw new Error('Runtime fence ledger build catalog basis changed.');
        }
        const status =
          build.processed_count > 1_048_576 || build.processed_bytes > 256 * 1024 * 1024
            ? 'saturated_legacy'
            : 'active';
        db.transaction(() => {
          const currentBasis = db
            .query<{ count: number; max_rowid: number }, []>(
              'SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS max_rowid FROM runtime_thread_fences',
            )
            .get();
          const currentCatalogVersion = db
            .query<{ catalog_version: number }, []>(
              'SELECT catalog_version FROM runtime_fence_catalog_version WHERE singleton = 1',
            )
            .get()?.catalog_version;
          if (
            !currentBasis ||
            currentCatalogVersion !== build.expected_catalog_version ||
            currentBasis.count !== build.expected_count ||
            currentBasis.max_rowid !== build.expected_max_rowid
          ) {
            throw new Error('Runtime fence ledger build catalog basis changed.');
          }
          db.run(
            `INSERT INTO runtime_fence_ledger
               (singleton, fence_count, fence_bytes, catalog_version, status)
             VALUES (1, ?, ?, ?, ?)`,
            [build.processed_count, build.processed_bytes, build.expected_catalog_version, status],
          );
          db.run('DELETE FROM runtime_fence_ledger_build WHERE singleton = 1');
        })();
        break;
      }
      let processedBytes = build.processed_bytes;
      let progressChecksum = build.progress_checksum;
      for (const row of rows) {
        const rowBytes = Buffer.byteLength(row.thread_id, 'utf8') + 64;
        if (rowBytes > 256) {
          db.close();
          throw new Error('Runtime fence catalog contains an oversized legacy row.');
        }
        processedBytes += rowBytes;
        progressChecksum = canonicalContextDigestV3('runtime-fence-ledger-build-row:v1', {
          previousChecksum: progressChecksum,
          rowid: row.rowid,
          threadId: row.thread_id,
          generation: row.generation,
          format: row.format,
          writeEpoch: row.write_epoch,
          lifecycle: row.lifecycle,
          rowBytes,
        });
      }
      const nextCount = build.processed_count + rows.length;
      const nextRowid = rows.at(-1)!.rowid;
      const updated = db.transaction(() => {
        const currentBasis = db
          .query<{ count: number; max_rowid: number }, []>(
            'SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS max_rowid FROM runtime_thread_fences',
          )
          .get();
        const currentCatalogVersion = db
          .query<{ catalog_version: number }, []>(
            'SELECT catalog_version FROM runtime_fence_catalog_version WHERE singleton = 1',
          )
          .get()?.catalog_version;
        if (
          !currentBasis ||
          currentCatalogVersion !== build.expected_catalog_version ||
          currentBasis.count !== build.expected_count ||
          currentBasis.max_rowid !== build.expected_max_rowid
        ) {
          throw new Error('Runtime fence ledger build catalog basis changed.');
        }
        return db
          .query(
            `UPDATE runtime_fence_ledger_build
                SET processed_count = ?, processed_bytes = ?, progress_rowid = ?, progress_checksum = ?
              WHERE singleton = 1 AND progress_checksum = ?`,
          )
          .run(nextCount, processedBytes, nextRowid, progressChecksum, build.progress_checksum);
      })();
      if (updated.changes !== 1) {
        db.close();
        throw new Error('Runtime fence ledger build progress CAS failed.');
      }
    }
  }
  const fenceActual = db
    .query<{ count: number; bytes: number; oversized: number }, []>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(length(CAST(thread_id AS BLOB)) + 64), 0) AS bytes,
              COALESCE(SUM(CASE WHEN length(CAST(thread_id AS BLOB)) + 64 > 256 THEN 1 ELSE 0 END), 0) AS oversized
         FROM runtime_thread_fences`,
    )
    .get() ?? { count: 0, bytes: 0, oversized: 0 };
  if (fenceActual.oversized > 0) {
    db.close();
    throw new Error('Runtime fence catalog contains an oversized legacy row.');
  }
  const fenceStatus =
    fenceActual.count > 1_048_576 || fenceActual.bytes > 256 * 1024 * 1024
      ? 'saturated_legacy'
      : 'active';
  const installedFenceLedger = db
    .query<{ fence_count: number; fence_bytes: number; status: string }, []>(
      'SELECT fence_count, fence_bytes, status FROM runtime_fence_ledger WHERE singleton = 1',
    )
    .get();
  if (
    !installedFenceLedger ||
    installedFenceLedger.fence_count !== fenceActual.count ||
    installedFenceLedger.fence_bytes !== fenceActual.bytes ||
    installedFenceLedger.status !== fenceStatus
  ) {
    db.close();
    throw new Error('Runtime fence ledger does not match its retained catalog.');
  }
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_thread_fence_quota_before_insert
    BEFORE INSERT ON runtime_thread_fences
    BEGIN
      SELECT CASE
        WHEN length(CAST(NEW.thread_id AS BLOB)) + 64 > 256
          THEN RAISE(ABORT, 'runtime_fence_row_oversized')
        WHEN (SELECT status FROM runtime_fence_ledger WHERE singleton = 1) <> 'active'
          OR (SELECT fence_count FROM runtime_fence_ledger WHERE singleton = 1) >= 1048576
          OR (SELECT fence_bytes FROM runtime_fence_ledger WHERE singleton = 1)
             + length(CAST(NEW.thread_id AS BLOB)) + 64 > 268435456
          THEN RAISE(ABORT, 'resource_saturated')
      END;
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_thread_fence_ledger_after_insert
    AFTER INSERT ON runtime_thread_fences
    BEGIN
      UPDATE runtime_fence_ledger
         SET fence_count = fence_count + 1,
             fence_bytes = fence_bytes + length(CAST(NEW.thread_id AS BLOB)) + 64,
             catalog_version = catalog_version + 1
       WHERE singleton = 1;
    END
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_branch_mutation_receipts (
      target_thread_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      canonical_blob BLOB NOT NULL,
      receipt_checksum BLOB NOT NULL CHECK(length(receipt_checksum) = 32),
      canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes = length(canonical_blob) AND canonical_bytes <= 16384),
      PRIMARY KEY (target_thread_id, target_generation, receipt_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_branch_mutation_completions (
      target_thread_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      canonical_blob BLOB NOT NULL,
      completion_checksum BLOB NOT NULL CHECK(length(completion_checksum) = 32),
      canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes = length(canonical_blob) AND canonical_bytes <= 1024),
      PRIMARY KEY (target_thread_id, target_generation, receipt_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_branch_copied_terminal_closures (
      target_thread_id TEXT NOT NULL,
      target_generation INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      canonical_blob BLOB NOT NULL,
      closure_checksum BLOB NOT NULL CHECK(length(closure_checksum) = 32),
      canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes = length(canonical_blob) AND canonical_bytes <= 786432),
      PRIMARY KEY (target_thread_id, target_generation, receipt_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_branch_receipt_refs (
      target_thread_id TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_owner_id TEXT NOT NULL,
      PRIMARY KEY (target_thread_id, receipt_id, ref_kind, ref_owner_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_branch_ledgers (
      target_thread_id TEXT PRIMARY KEY,
      receipt_count INTEGER NOT NULL DEFAULT 0,
      receipt_bytes INTEGER NOT NULL DEFAULT 0,
      closure_count INTEGER NOT NULL DEFAULT 0,
      closure_bytes INTEGER NOT NULL DEFAULT 0,
      completion_count INTEGER NOT NULL DEFAULT 0,
      completion_bytes INTEGER NOT NULL DEFAULT 0,
      ledger_version INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_v24_migration_builds (
      thread_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      write_epoch INTEGER NOT NULL,
      source_snapshot_checksum TEXT NOT NULL,
      source_snapshot_revision INTEGER NOT NULL,
      source_snapshot_position INTEGER NOT NULL,
      source_head_position INTEGER NOT NULL,
      source_head_revision INTEGER NOT NULL,
      source_head_event_id TEXT,
      source_event_count INTEGER NOT NULL,
      source_event_bytes INTEGER NOT NULL,
      named_catalog_count INTEGER NOT NULL,
      named_catalog_bytes INTEGER NOT NULL,
      named_catalog_digest TEXT NOT NULL,
      named_catalog_version INTEGER NOT NULL DEFAULT 1,
      processed_rows INTEGER NOT NULL DEFAULT 0,
      processed_bytes INTEGER NOT NULL DEFAULT 0,
      progress_position INTEGER NOT NULL DEFAULT 0,
      progress_digest TEXT NOT NULL,
      build_checksum TEXT NOT NULL
    )
  `);
  const migrationBuildColumns = db
    .query<{ name: string }, []>('PRAGMA table_info(runtime_v24_migration_builds)')
    .all()
    .map((entry) => entry.name);
  if (!migrationBuildColumns.includes('named_catalog_version')) {
    db.run(
      'ALTER TABLE runtime_v24_migration_builds ADD COLUMN named_catalog_version INTEGER NOT NULL DEFAULT 1',
    );
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_named_catalog_versions (
      thread_id TEXT PRIMARY KEY,
      catalog_version INTEGER NOT NULL
    )
  `);
  db.run(`
    INSERT OR IGNORE INTO runtime_named_catalog_versions (thread_id, catalog_version)
    SELECT DISTINCT thread_id, 1 FROM runtime_named_snapshots
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_legacy_named_cut_proof_builds (
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      named_catalog_version INTEGER NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('verified_metadata_prefix', 'legacy_unverified')),
      canonical_blob BLOB NOT NULL,
      proof_checksum BLOB NOT NULL CHECK(length(proof_checksum) = 32),
      PRIMARY KEY (thread_id, name)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_legacy_named_cut_proofs (
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      named_catalog_version INTEGER NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('verified_metadata_prefix', 'legacy_unverified')),
      canonical_blob BLOB NOT NULL,
      proof_checksum BLOB NOT NULL CHECK(length(proof_checksum) = 32),
      PRIMARY KEY (thread_id, name)
    )
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_named_catalog_after_insert
    AFTER INSERT ON runtime_named_snapshots
    BEGIN
      INSERT INTO runtime_named_catalog_versions (thread_id, catalog_version)
      VALUES (NEW.thread_id, 1)
      ON CONFLICT(thread_id) DO UPDATE SET catalog_version = catalog_version + 1;
      DELETE FROM runtime_legacy_named_cut_proofs
       WHERE thread_id = NEW.thread_id AND name = NEW.name;
      DELETE FROM runtime_legacy_named_cut_proof_builds WHERE thread_id = NEW.thread_id;
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_named_catalog_after_update
    AFTER UPDATE ON runtime_named_snapshots
    BEGIN
      INSERT INTO runtime_named_catalog_versions (thread_id, catalog_version)
      VALUES (NEW.thread_id, 1)
      ON CONFLICT(thread_id) DO UPDATE SET catalog_version = catalog_version + 1;
      DELETE FROM runtime_legacy_named_cut_proofs
       WHERE thread_id = NEW.thread_id AND name = NEW.name;
      DELETE FROM runtime_legacy_named_cut_proof_builds WHERE thread_id = NEW.thread_id;
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS runtime_named_catalog_after_delete
    AFTER DELETE ON runtime_named_snapshots
    BEGIN
      INSERT INTO runtime_named_catalog_versions (thread_id, catalog_version)
      VALUES (OLD.thread_id, 1)
      ON CONFLICT(thread_id) DO UPDATE SET catalog_version = catalog_version + 1;
      DELETE FROM runtime_legacy_named_cut_proofs
       WHERE thread_id = OLD.thread_id AND name = OLD.name;
      DELETE FROM runtime_legacy_named_cut_proof_builds WHERE thread_id = OLD.thread_id;
    END
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_event_ledgers (
      thread_id TEXT PRIMARY KEY,
      source_event_count INTEGER NOT NULL,
      source_event_bytes INTEGER NOT NULL,
      source_raw_event_digest TEXT NOT NULL,
      named_catalog_count INTEGER NOT NULL,
      named_catalog_bytes INTEGER NOT NULL,
      named_catalog_digest TEXT NOT NULL,
      tail_start_position INTEGER NOT NULL DEFAULT 0,
      tail_event_count INTEGER NOT NULL DEFAULT 0,
      tail_event_bytes INTEGER NOT NULL DEFAULT 0,
      ledger_version INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Additive metadata upgrades for stores created before runtime tracing was added.
  for (const [table, column, definition] of [
    ['runtime_events', 'event_id', 'TEXT'],
    ['runtime_events', 'revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_events', 'causation_id', 'TEXT'],
    ['runtime_events', 'occurred_at', 'TEXT'],
    ['runtime_events', 'producer_generation', 'INTEGER'],
    ['runtime_events', 'canonical_bytes', 'INTEGER'],
    ['runtime_snapshots', 'event_position', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_snapshots', 'state_revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_snapshots', 'state_checksum', "TEXT NOT NULL DEFAULT ''"],
    ['runtime_snapshots', 'schema_version', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_sessions', 'model_provider', 'TEXT'],
    ['runtime_sessions', 'model_name', 'TEXT'],
    ['runtime_file_preimages', 'post_hash', 'TEXT'],
    ['runtime_file_preimages', 'post_existed', 'INTEGER'],
    ['runtime_thread_fences', 'format', "TEXT NOT NULL DEFAULT 'v23_compat'"],
    ['runtime_thread_fences', 'write_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_thread_fences', 'lifecycle', "TEXT NOT NULL DEFAULT 'active'"],
    ['runtime_event_ledgers', 'tail_start_position', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_event_ledgers', 'tail_event_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['runtime_event_ledgers', 'tail_event_bytes', 'INTEGER NOT NULL DEFAULT 0'],
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
    'INSERT OR IGNORE INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at, producer_generation, canonical_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertMcpEgressNonce = db.query(
    'INSERT INTO runtime_mcp_egress_nonces (thread_id, nonce_digest, invocation_id, receipt_digest, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteExpiredMcpEgressNonces = db.query(
    'DELETE FROM runtime_mcp_egress_nonces WHERE expires_at <= ?',
  );
  const insertForkEvent = db.query(
    'INSERT INTO runtime_events (thread_id, event_json, event_id, revision, causation_id, occurred_at, producer_generation, canonical_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectEvents = db.query<EventRow, [string, number]>(
    'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, producer_generation, canonical_bytes, created_at FROM runtime_events WHERE thread_id = ? AND id > ? ORDER BY id ASC',
  );
  const selectAllEvents = db.query<EventRow, [string]>(
    'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, producer_generation, canonical_bytes, created_at FROM runtime_events WHERE thread_id = ? ORDER BY id ASC',
  );
  const selectStrictBranchEvents = db.query<EventRow, [string, number, number]>(
    'SELECT id, thread_id, event_json, event_id, revision, causation_id, occurred_at, producer_generation, canonical_bytes, created_at FROM runtime_events WHERE thread_id = ? AND id <= ? AND revision > ? ORDER BY id ASC',
  );
  const selectLastEventHead = db.query<Pick<EventRow, 'id' | 'revision' | 'event_id'>, [string]>(
    'SELECT id, revision, event_id FROM runtime_events WHERE thread_id = ? ORDER BY id DESC LIMIT 1',
  );
  const upsertSnapshot = db.query(
    'INSERT OR REPLACE INTO runtime_snapshots (thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())',
  );
  const selectSnapshot = db.query<SnapshotRow, [string]>(
    'SELECT thread_id, state_json, event_position, state_revision, state_checksum, schema_version, created_at FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const selectSnapshotLength = db.query<{ bytes: number }, [string]>(
    'SELECT length(CAST(state_json AS BLOB)) AS bytes FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const selectSnapshotRevision = db.query<{ state_revision: number }, [string]>(
    'SELECT state_revision FROM runtime_snapshots WHERE thread_id = ?',
  );
  const selectSnapshotMetadata = db.query<
    Omit<SnapshotRow, 'thread_id' | 'state_json' | 'created_at'>,
    [string]
  >(
    'SELECT event_position, state_revision, state_checksum, schema_version FROM runtime_snapshots WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const insertThreadFence = db.query(
    "INSERT OR IGNORE INTO runtime_thread_fences (thread_id, generation, format, write_epoch, lifecycle) VALUES (?, 1, 'v23_compat', 0, 'active')",
  );
  const insertFreshStrictThreadFence = db.query(
    "INSERT INTO runtime_thread_fences (thread_id, generation, format, write_epoch, lifecycle) VALUES (?, 1, 'v24_strict', 1, 'active')",
  );
  const selectThreadFence = db.query<
    {
      generation: number;
      format: 'v23_compat' | 'v24_strict';
      write_epoch: number;
      lifecycle: 'active' | 'deleted';
    },
    [string]
  >(
    'SELECT generation, format, write_epoch, lifecycle FROM runtime_thread_fences WHERE thread_id = ?',
  );
  const incrementThreadFence = db.query(
    "UPDATE runtime_thread_fences SET generation = generation + 1, write_epoch = write_epoch + 1, lifecycle = 'active' WHERE thread_id = ?",
  );
  const incrementThreadWriteEpoch = db.query(
    'UPDATE runtime_thread_fences SET write_epoch = write_epoch + 1 WHERE thread_id = ?',
  );
  const setThreadFenceStrict = db.query(
    "UPDATE runtime_thread_fences SET format = 'v24_strict', lifecycle = 'active' WHERE thread_id = ?",
  );
  const deleteThreadFenceCas = db.query(
    "UPDATE runtime_thread_fences SET generation = generation + 1, write_epoch = write_epoch + 1, lifecycle = 'deleted' WHERE thread_id = ? AND generation = ? AND format = ? AND write_epoch = ? AND lifecycle = 'active'",
  );
  const replaceThreadFenceCas = db.query(
    "UPDATE runtime_thread_fences SET generation = generation + 1, format = 'v24_strict', write_epoch = write_epoch + 1, lifecycle = 'active' WHERE thread_id = ? AND generation = ? AND format = ? AND write_epoch = ? AND lifecycle = ?",
  );
  const directChanges = (): number =>
    db.query<{ count: number }, []>('SELECT changes() AS count').get()?.count ?? 0;
  const insertBranchReceipt = db.query(
    'INSERT INTO runtime_branch_mutation_receipts (target_thread_id, target_generation, receipt_id, canonical_blob, receipt_checksum, canonical_bytes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertBranchCompletion = db.query(
    'INSERT INTO runtime_branch_mutation_completions (target_thread_id, target_generation, receipt_id, canonical_blob, completion_checksum, canonical_bytes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertBranchClosure = db.query(
    'INSERT INTO runtime_branch_copied_terminal_closures (target_thread_id, target_generation, receipt_id, canonical_blob, closure_checksum, canonical_bytes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertBranchReceiptRef = db.query(
    'INSERT INTO runtime_branch_receipt_refs (target_thread_id, receipt_id, ref_kind, ref_owner_id) VALUES (?, ?, ?, ?)',
  );
  const insertBranchLedger = db.query(
    'INSERT OR IGNORE INTO runtime_branch_ledgers (target_thread_id) VALUES (?)',
  );
  const selectBranchLedger = db.query<
    {
      receipt_count: number;
      receipt_bytes: number;
      closure_count: number;
      closure_bytes: number;
      completion_count: number;
      completion_bytes: number;
      ledger_version: number;
    },
    [string]
  >(
    'SELECT receipt_count, receipt_bytes, closure_count, closure_bytes, completion_count, completion_bytes, ledger_version FROM runtime_branch_ledgers WHERE target_thread_id = ?',
  );
  const updateBranchLedger = db.query(
    'UPDATE runtime_branch_ledgers SET receipt_count = ?, receipt_bytes = ?, closure_count = ?, closure_bytes = ?, completion_count = ?, completion_bytes = ?, ledger_version = ledger_version + 1 WHERE target_thread_id = ? AND ledger_version = ?',
  );
  const deleteBranchReceipts = db.query(
    'DELETE FROM runtime_branch_mutation_receipts WHERE target_thread_id = ?',
  );
  const deleteBranchCompletions = db.query(
    'DELETE FROM runtime_branch_mutation_completions WHERE target_thread_id = ?',
  );
  const deleteBranchClosures = db.query(
    'DELETE FROM runtime_branch_copied_terminal_closures WHERE target_thread_id = ?',
  );
  const deleteBranchReceiptRefs = db.query(
    'DELETE FROM runtime_branch_receipt_refs WHERE target_thread_id = ?',
  );
  const deleteBranchLedger = db.query(
    'DELETE FROM runtime_branch_ledgers WHERE target_thread_id = ?',
  );
  const selectBranchAuthorityLengths = db.query<
    {
      completion_bytes: number;
      completion_blob_length: number;
      receipt_bytes: number | null;
      receipt_blob_length: number | null;
      closure_bytes: number | null;
      closure_blob_length: number | null;
    },
    [string, number, string]
  >(
    `SELECT
       c.canonical_bytes AS completion_bytes,
       length(c.canonical_blob) AS completion_blob_length,
       r.canonical_bytes AS receipt_bytes,
       length(r.canonical_blob) AS receipt_blob_length,
       x.canonical_bytes AS closure_bytes,
       length(x.canonical_blob) AS closure_blob_length
     FROM runtime_branch_mutation_completions c
     LEFT JOIN runtime_branch_mutation_receipts r
       ON r.target_thread_id = c.target_thread_id
      AND r.target_generation = c.target_generation
      AND r.receipt_id = c.receipt_id
     LEFT JOIN runtime_branch_copied_terminal_closures x
       ON x.target_thread_id = c.target_thread_id
      AND x.target_generation = c.target_generation
      AND x.receipt_id = c.receipt_id
     WHERE c.target_thread_id = ? AND c.target_generation = ? AND c.receipt_id = ?`,
  );
  const selectBranchAuthorityBlobs = db.query<
    {
      completion_blob: Uint8Array;
      completion_checksum: Uint8Array;
      receipt_blob: Uint8Array | null;
      receipt_checksum: Uint8Array | null;
      closure_blob: Uint8Array | null;
      closure_checksum: Uint8Array | null;
    },
    [string, number, string]
  >(
    `SELECT
       c.canonical_blob AS completion_blob,
       c.completion_checksum AS completion_checksum,
       r.canonical_blob AS receipt_blob,
       r.receipt_checksum AS receipt_checksum,
       x.canonical_blob AS closure_blob,
       x.closure_checksum AS closure_checksum
     FROM runtime_branch_mutation_completions c
     LEFT JOIN runtime_branch_mutation_receipts r
       ON r.target_thread_id = c.target_thread_id
      AND r.target_generation = c.target_generation
      AND r.receipt_id = c.receipt_id
     LEFT JOIN runtime_branch_copied_terminal_closures x
       ON x.target_thread_id = c.target_thread_id
      AND x.target_generation = c.target_generation
      AND x.receipt_id = c.receipt_id
     WHERE c.target_thread_id = ? AND c.target_generation = ? AND c.receipt_id = ?`,
  );
  const selectBranchLedgerActuals = db.query<
    {
      receipt_count: number;
      receipt_bytes: number;
      closure_count: number;
      closure_bytes: number;
      completion_count: number;
      completion_bytes: number;
      ledger_version: number;
      actual_receipt_count: number;
      actual_receipt_bytes: number;
      actual_closure_count: number;
      actual_closure_bytes: number;
      actual_completion_count: number;
      actual_completion_bytes: number;
    },
    [string]
  >(
    `SELECT l.receipt_count, l.receipt_bytes, l.closure_count, l.closure_bytes,
            l.completion_count, l.completion_bytes, l.ledger_version,
            (SELECT COUNT(*) FROM runtime_branch_mutation_receipts r WHERE r.target_thread_id = l.target_thread_id) AS actual_receipt_count,
            COALESCE((SELECT SUM(r.canonical_bytes) FROM runtime_branch_mutation_receipts r WHERE r.target_thread_id = l.target_thread_id), 0) AS actual_receipt_bytes,
            (SELECT COUNT(*) FROM runtime_branch_copied_terminal_closures x WHERE x.target_thread_id = l.target_thread_id) AS actual_closure_count,
            COALESCE((SELECT SUM(x.canonical_bytes) FROM runtime_branch_copied_terminal_closures x WHERE x.target_thread_id = l.target_thread_id), 0) AS actual_closure_bytes,
            (SELECT COUNT(*) FROM runtime_branch_mutation_completions c WHERE c.target_thread_id = l.target_thread_id) AS actual_completion_count,
            COALESCE((SELECT SUM(c.canonical_bytes) FROM runtime_branch_mutation_completions c WHERE c.target_thread_id = l.target_thread_id), 0) AS actual_completion_bytes
       FROM runtime_branch_ledgers l WHERE l.target_thread_id = ?`,
  );
  const selectBranchReceiptRefCount = db.query<{ count: number }, [string, string]>(
    'SELECT COUNT(*) AS count FROM runtime_branch_receipt_refs WHERE target_thread_id = ? AND receipt_id = ?',
  );
  type MigrationBuildRow = {
    thread_id: string;
    generation: number;
    write_epoch: number;
    source_snapshot_checksum: string;
    source_snapshot_revision: number;
    source_snapshot_position: number;
    source_head_position: number;
    source_head_revision: number;
    source_head_event_id: string | null;
    source_event_count: number;
    source_event_bytes: number;
    named_catalog_count: number;
    named_catalog_bytes: number;
    named_catalog_digest: string;
    named_catalog_version: number;
    processed_rows: number;
    processed_bytes: number;
    progress_position: number;
    progress_digest: string;
    build_checksum: string;
  };
  const selectMigrationBuild = db.query<MigrationBuildRow, [string]>(
    'SELECT * FROM runtime_v24_migration_builds WHERE thread_id = ?',
  );
  const insertMigrationBuild = db.query(
    `INSERT INTO runtime_v24_migration_builds (
       thread_id, generation, write_epoch, source_snapshot_checksum,
       source_snapshot_revision, source_snapshot_position, source_head_position,
       source_head_revision, source_head_event_id, source_event_count, source_event_bytes,
       named_catalog_count, named_catalog_bytes, named_catalog_digest, named_catalog_version,
       processed_rows, processed_bytes, progress_position, progress_digest, build_checksum
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  );
  const updateMigrationBuild = db.query(
    `UPDATE runtime_v24_migration_builds
        SET processed_rows = ?, processed_bytes = ?, progress_position = ?,
            progress_digest = ?, build_checksum = ?
      WHERE thread_id = ? AND build_checksum = ?`,
  );
  const deleteMigrationBuild = db.query(
    'DELETE FROM runtime_v24_migration_builds WHERE thread_id = ?',
  );
  const selectMigrationEventBasis = db.query<{ count: number; bytes: number }, [string]>(
    'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes FROM runtime_events WHERE thread_id = ?',
  );
  const selectMigrationEventChunk = db.query<
    {
      id: number;
      event_json: string;
      event_id: string | null;
      revision: number;
      causation_id: string | null;
      occurred_at: string | null;
      producer_generation: number | null;
      canonical_bytes: number | null;
      created_at: number;
    },
    [string, number, number]
  >(
    `SELECT id, event_json, event_id, revision, causation_id, occurred_at,
            producer_generation, canonical_bytes, created_at
       FROM runtime_events WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
  );
  const selectMigrationNamedBasis = db.query<{ count: number; bytes: number }, [string]>(
    'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(state_json AS BLOB)) + 16), 0) AS bytes FROM runtime_named_snapshots WHERE thread_id = ?',
  );
  const selectMigrationNamedRows = db.query<
    { name: string; event_position: number; state_json: string; created_at: number },
    [string]
  >(
    'SELECT name, event_position, state_json, created_at FROM runtime_named_snapshots WHERE thread_id = ? ORDER BY name ASC',
  );
  const selectMigrationNamedProofChunk = db.query<
    { name: string; event_position: number; state_json: string; created_at: number },
    [string, number]
  >(
    `SELECT n.name, n.event_position, n.state_json, n.created_at
       FROM runtime_named_snapshots n
       LEFT JOIN runtime_legacy_named_cut_proof_builds p
         ON p.thread_id = n.thread_id AND p.name = n.name
      WHERE n.thread_id = ? AND p.name IS NULL
      ORDER BY n.name ASC LIMIT ?`,
  );
  const countMigrationNamedProofBuilds = db.query<{ count: number }, [string, number]>(
    'SELECT COUNT(*) AS count FROM runtime_legacy_named_cut_proof_builds WHERE thread_id = ? AND named_catalog_version = ?',
  );
  const insertMigrationNamedProofBuild = db.query(
    `INSERT OR IGNORE INTO runtime_legacy_named_cut_proof_builds
       (thread_id, name, named_catalog_version, classification, canonical_blob, proof_checksum)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectLegacyNamedProof = db.query<
    {
      named_catalog_version: number;
      classification: LegacyNamedCutProofV1['classification'];
      canonical_blob: Uint8Array;
      proof_checksum: Uint8Array;
    },
    [string, string]
  >(
    'SELECT named_catalog_version, classification, canonical_blob, proof_checksum FROM runtime_legacy_named_cut_proofs WHERE thread_id = ? AND name = ?',
  );
  const promoteMigrationNamedProofs = db.query(
    `INSERT INTO runtime_legacy_named_cut_proofs
       (thread_id, name, named_catalog_version, classification, canonical_blob, proof_checksum)
     SELECT thread_id, name, named_catalog_version, classification, canonical_blob, proof_checksum
       FROM runtime_legacy_named_cut_proof_builds WHERE thread_id = ?`,
  );
  const deleteMigrationNamedProofBuilds = db.query(
    'DELETE FROM runtime_legacy_named_cut_proof_builds WHERE thread_id = ?',
  );
  const insertRuntimeEventLedger = db.query(
    `INSERT INTO runtime_event_ledgers (
       thread_id, source_event_count, source_event_bytes, source_raw_event_digest,
       named_catalog_count, named_catalog_bytes, named_catalog_digest,
       tail_start_position, tail_event_count, tail_event_bytes, ledger_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const insertEmptyRuntimeEventLedger = db.query(
    `INSERT OR IGNORE INTO runtime_event_ledgers (
       thread_id, source_event_count, source_event_bytes, source_raw_event_digest,
       named_catalog_count, named_catalog_bytes, named_catalog_digest,
       tail_start_position, tail_event_count, tail_event_bytes, ledger_version
     ) VALUES (?, 0, 0, ?, 0, 0, ?, ?, 0, 0, 1)`,
  );
  const selectRuntimeEventTailLedger = db.query<
    {
      tail_start_position: number;
      tail_event_count: number;
      tail_event_bytes: number;
      ledger_version: number;
    },
    [string]
  >(
    'SELECT tail_start_position, tail_event_count, tail_event_bytes, ledger_version FROM runtime_event_ledgers WHERE thread_id = ?',
  );
  const selectRuntimeEventTailActual = db.query<{ count: number; bytes: number }, [string, number]>(
    'SELECT COUNT(*) AS count, COALESCE(SUM(canonical_bytes), 0) AS bytes FROM runtime_events WHERE thread_id = ? AND id > ?',
  );
  const updateRuntimeEventTailLedger = db.query(
    `UPDATE runtime_event_ledgers
        SET tail_event_count = ?, tail_event_bytes = ?, ledger_version = ledger_version + 1
      WHERE thread_id = ? AND ledger_version = ?`,
  );
  const deleteRuntimeEventLedger = db.query(
    'DELETE FROM runtime_event_ledgers WHERE thread_id = ?',
  );
  const deleteExpiredEffectLease = db.query(
    'DELETE FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND expires_at_ms <= ?',
  );
  const insertEffectLease = db.query(
    'INSERT OR IGNORE INTO runtime_effect_leases (thread_id, effect_id, owner_id, expires_at_ms) VALUES (?, ?, ?, ?)',
  );
  const selectEffectLeaseOwner = db.query<{ owner_id: string }, [string, string]>(
    'SELECT owner_id FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ?',
  );
  const renewEffectLease = db.query(
    'UPDATE runtime_effect_leases SET expires_at_ms = ? WHERE thread_id = ? AND effect_id = ? AND owner_id = ?',
  );
  const releaseEffectLease = db.query(
    'DELETE FROM runtime_effect_leases WHERE thread_id = ? AND effect_id = ? AND owner_id = ?',
  );
  const deleteEffectLeasesForThread = db.query(
    'DELETE FROM runtime_effect_leases WHERE thread_id = ?',
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
  const selectNamedSnapshotLength = db.query<{ bytes: number }, [string, string]>(
    'SELECT length(CAST(state_json AS BLOB)) AS bytes FROM runtime_named_snapshots WHERE thread_id = ? AND name = ?',
  );
  const selectNamedSnapshotsForFork = db.query<
    {
      name: string;
      event_position: number;
      state_json: string;
      created_at: number;
    },
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
  const selectSessionModelRoute = db.query<
    { model_provider: string | null; model_name: string | null },
    [string]
  >('SELECT model_provider, model_name FROM runtime_sessions WHERE thread_id = ?');
  const updateSessionModelRoute = db.query(
    'UPDATE runtime_sessions SET model_provider = ?, model_name = ?, updated_at = unixepoch() WHERE thread_id = ?',
  );
  const listSessions = db.query<
    {
      thread_id: string;
      name: string;
      updated_at: number;
      first_message: string | null;
    },
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
    selectStrictBranchEvents,
    selectLastEventHead,
    upsertSnapshot,
    selectSnapshot,
    selectSnapshotLength,
    selectSnapshotMetadata,
    upsertNamedSnapshot,
    insertForkNamedSnapshot,
    selectNamedSnapshot,
    selectNamedSnapshotLength,
    selectNamedSnapshotsForFork,
    selectLastEventPosition,
    upsertSession,
    setSessionName,
    selectSessionModelRoute,
    updateSessionModelRoute,
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
    selectSnapshotRevision,
    insertThreadFence,
    insertFreshStrictThreadFence,
    selectThreadFence,
    incrementThreadFence,
    incrementThreadWriteEpoch,
    setThreadFenceStrict,
    deleteThreadFenceCas,
    replaceThreadFenceCas,
    insertBranchReceipt,
    insertBranchCompletion,
    insertBranchClosure,
    insertBranchReceiptRef,
    insertBranchLedger,
    selectBranchLedger,
    updateBranchLedger,
    deleteBranchReceipts,
    deleteBranchCompletions,
    deleteBranchClosures,
    deleteBranchReceiptRefs,
    deleteBranchLedger,
    selectBranchAuthorityLengths,
    selectBranchAuthorityBlobs,
    selectBranchLedgerActuals,
    selectBranchReceiptRefCount,
    selectMigrationBuild,
    insertMigrationBuild,
    updateMigrationBuild,
    deleteMigrationBuild,
    selectMigrationEventBasis,
    selectMigrationEventChunk,
    selectMigrationNamedBasis,
    selectMigrationNamedRows,
    selectMigrationNamedProofChunk,
    countMigrationNamedProofBuilds,
    insertMigrationNamedProofBuild,
    selectLegacyNamedProof,
    promoteMigrationNamedProofs,
    deleteMigrationNamedProofBuilds,
    insertRuntimeEventLedger,
    insertEmptyRuntimeEventLedger,
    selectRuntimeEventTailLedger,
    selectRuntimeEventTailActual,
    updateRuntimeEventTailLedger,
    deleteRuntimeEventLedger,
    deleteExpiredEffectLease,
    insertEffectLease,
    selectEffectLeaseOwner,
    renewEffectLease,
    releaseEffectLease,
    deleteEffectLeasesForThread,
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

  const observedEventHead = (threadId: string): RuntimeObservedEventHeadV1 => {
    const head = selectLastEventHead.get(threadId);
    return head
      ? {
          eventPosition: head.id,
          revision: head.revision,
          eventId: head.event_id,
        }
      : { eventPosition: 0, revision: 0, eventId: null };
  };

  const snapshotMetadata = (threadId: string): RuntimeSnapshotMetadata | null => {
    const snapshot = selectSnapshotMetadata.get(threadId);
    return snapshot
      ? {
          eventPosition: snapshot.event_position,
          stateRevision: snapshot.state_revision,
          stateChecksum: snapshot.state_checksum,
          schemaVersion: snapshot.schema_version,
        }
      : null;
  };

  const threadFence = (threadId: string) => {
    const actual = db
      .query<{ count: number; bytes: number }, []>(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(thread_id AS BLOB)) + 64), 0) AS bytes
           FROM runtime_thread_fences`,
      )
      .get();
    const ledger = db
      .query<{ fence_count: number; fence_bytes: number }, []>(
        'SELECT fence_count, fence_bytes FROM runtime_fence_ledger WHERE singleton = 1',
      )
      .get();
    if (
      !actual ||
      !ledger ||
      actual.count !== ledger.fence_count ||
      actual.bytes !== ledger.fence_bytes
    ) {
      throw new Error('Runtime fence ledger does not match its retained catalog.');
    }
    const existing = selectThreadFence.get(threadId);
    if (existing) return existing;
    insertThreadFence.run(threadId);
    return (
      selectThreadFence.get(threadId) ?? {
        generation: 1,
        format: 'v23_compat' as const,
        write_epoch: 0,
        lifecycle: 'active' as const,
      }
    );
  };

  const advanceThreadGeneration = (threadId: string): number => {
    insertThreadFence.run(threadId);
    incrementThreadFence.run(threadId);
    return selectThreadFence.get(threadId)?.generation ?? 2;
  };

  const persistenceIdentity = (threadId: string): RuntimePersistenceIdentityV1 => {
    const fence = threadFence(threadId);
    return {
      generation: fence.generation,
      writeEpoch: fence.write_epoch,
      format: fence.format,
      lifecycle: fence.lifecycle,
      sourceSnapshot: snapshotMetadata(threadId),
      observedHead: observedEventHead(threadId),
    };
  };

  const persistenceIdentityIfRetained = (threadId: string): RuntimePersistenceIdentityV1 | null => {
    const fence = selectThreadFence.get(threadId);
    return fence
      ? {
          generation: fence.generation,
          writeEpoch: fence.write_epoch,
          format: fence.format,
          lifecycle: fence.lifecycle,
          sourceSnapshot: snapshotMetadata(threadId),
          observedHead: observedEventHead(threadId),
        }
      : null;
  };

  const hasAnyThreadAuthority = (threadId: string): boolean =>
    Boolean(
      db
        .query<{ count: number }, [string, string, string, string, string, string, string]>(
          `SELECT
             (SELECT COUNT(*) FROM runtime_sessions WHERE thread_id = ?) +
             (SELECT COUNT(*) FROM runtime_snapshots WHERE thread_id = ?) +
             (SELECT COUNT(*) FROM runtime_events WHERE thread_id = ?) +
             (SELECT COUNT(*) FROM runtime_named_snapshots WHERE thread_id = ?) +
             (SELECT COUNT(*) FROM runtime_file_preimages WHERE thread_id = ?) +
             (SELECT COUNT(*) FROM runtime_branch_mutation_completions WHERE target_thread_id = ?) +
             (SELECT COUNT(*) FROM runtime_branch_mutation_receipts WHERE target_thread_id = ?) AS count`,
        )
        .get(threadId, threadId, threadId, threadId, threadId, threadId, threadId)?.count,
    );

  const sameSnapshotIdentity = (
    left: RuntimeSnapshotMetadata | null,
    right: RuntimeSnapshotMetadata | null,
  ): boolean =>
    left === null || right === null
      ? left === right
      : left.eventPosition === right.eventPosition &&
        left.stateRevision === right.stateRevision &&
        left.stateChecksum === right.stateChecksum &&
        left.schemaVersion === right.schemaVersion;

  const sameObservedHead = (
    left: RuntimeObservedEventHeadV1,
    right: RuntimeObservedEventHeadV1,
  ): boolean =>
    left.eventPosition === right.eventPosition &&
    left.revision === right.revision &&
    left.eventId === right.eventId;

  const samePersistenceIdentity = (
    left: RuntimePersistenceIdentityV1,
    right: RuntimePersistenceIdentityV1,
  ): boolean =>
    left.generation === right.generation &&
    left.writeEpoch === right.writeEpoch &&
    left.format === right.format &&
    left.lifecycle === right.lifecycle &&
    sameSnapshotIdentity(left.sourceSnapshot, right.sourceSnapshot) &&
    sameObservedHead(left.observedHead, right.observedHead);

  const digestBytes = (domain: string, value: string | Uint8Array): string =>
    createHash('sha256').update(`${domain}\0`).update(value).digest('hex');

  const migrationBuildChecksum = (
    row: Omit<MigrationBuildRow, 'thread_id' | 'build_checksum'>,
  ): string => canonicalContextDigestV3('runtime-v24-migration-build:v1', row);

  const namedCatalogBasis = (threadId: string) => {
    const basis = selectMigrationNamedBasis.get(threadId) ?? { count: 0, bytes: 0 };
    if (basis.count > 50_000 || basis.bytes > 96 * 1024 * 1024) {
      throw new Error('resource_saturated');
    }
    let digest = digestBytes('legacy-runtime-named-catalog:v1', 'empty');
    for (const row of selectMigrationNamedRows.all(threadId)) {
      digest = digestBytes(
        'legacy-runtime-named-catalog-row:v1',
        `${digest}\0${row.name}\0${row.event_position}\0${row.created_at}\0${row.state_json}`,
      );
    }
    const catalogVersion =
      db
        .query<{ catalog_version: number }, [string]>(
          'SELECT catalog_version FROM runtime_named_catalog_versions WHERE thread_id = ?',
        )
        .get(threadId)?.catalog_version ?? 0;
    return { ...basis, digest, catalogVersion };
  };

  const migrationEvidence = (build: MigrationBuildRow): LegacyRuntimeLedgerEvidenceV1 => ({
    version: 1,
    sourceEventCount: build.source_event_count,
    sourceEventBytes: build.source_event_bytes,
    sourceRawEventDigest: build.progress_digest,
    namedCatalogCount: build.named_catalog_count,
    namedCatalogBytes: build.named_catalog_bytes,
    namedCatalogDigest: build.named_catalog_digest,
    namedCatalogVersion: build.named_catalog_version,
  });

  const encodeLegacyNamedProof = (proof: LegacyNamedCutProofV1): Buffer =>
    Buffer.from(JSON.stringify(proof), 'utf8');

  const decodeLegacyNamedProof = (
    row: ReturnType<typeof selectLegacyNamedProof.get>,
  ): LegacyNamedCutProofV1 | null => {
    if (!row || row.canonical_blob.byteLength > 4096) return null;
    try {
      const proof = JSON.parse(
        Buffer.from(row.canonical_blob).toString('utf8'),
      ) as LegacyNamedCutProofV1;
      return row.classification === proof.classification &&
        Buffer.from(row.proof_checksum).toString('hex') === proof.proofChecksum &&
        verifyLegacyNamedCutProofV1(proof)
        ? proof
        : null;
    } catch {
      return null;
    }
  };

  const loadVerifiedLegacyNamedProof = (
    threadId: string,
    name: string,
    eventPosition: number,
  ): { proof: LegacyNamedCutProofV1; catalogVersion: number; blobDigest: string } | null => {
    const row = selectLegacyNamedProof.get(threadId, name);
    const proof = decodeLegacyNamedProof(row);
    const catalogVersion = db
      .query<{ catalog_version: number }, [string]>(
        'SELECT catalog_version FROM runtime_named_catalog_versions WHERE thread_id = ?',
      )
      .get(threadId)?.catalog_version;
    if (
      !row ||
      !proof ||
      proof.classification !== 'verified_metadata_prefix' ||
      proof.threadId !== threadId ||
      proof.name !== name ||
      proof.eventPosition !== eventPosition ||
      catalogVersion !== row.named_catalog_version
    ) {
      return null;
    }
    return {
      proof,
      catalogVersion,
      blobDigest: digestBytes('legacy-named-cut-proof-blob:v1', row.canonical_blob),
    };
  };

  const buildLegacyNamedProof = (
    threadId: string,
    row: { name: string; event_position: number; state_json: string; created_at: number },
    catalogVersion: number,
    expectedGeneration: number,
  ): LegacyNamedCutProofV1 => {
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(row.state_json) as unknown;
      if (isRecord(value)) parsed = value;
    } catch {
      parsed = null;
    }
    const prefix = selectMigrationEventChunk
      .all(threadId, 0, 50_000)
      .filter((event) => event.id <= row.event_position);
    let prefixDigest = digestBytes('legacy-named-metadata-prefix:v1', 'empty');
    let prefixBytes = 0;
    let previousRevision = 0;
    let metadataVerified = true;
    for (const event of prefix) {
      const rawBytes = Buffer.byteLength(event.event_json, 'utf8');
      prefixBytes += rawBytes;
      try {
        if (
          !event.event_id ||
          event.revision !== previousRevision + 1 ||
          !event.occurred_at ||
          event.producer_generation !== expectedGeneration ||
          !Number.isSafeInteger(event.canonical_bytes) ||
          (event.canonical_bytes ?? 0) < 1
        ) {
          throw new Error('incomplete metadata prefix');
        }
        const envelope = {
          schemaVersion: 24 as const,
          threadId,
          generation: event.producer_generation,
          revision: event.revision,
          eventId: event.event_id,
          causationId: event.causation_id,
          occurredAt: event.occurred_at,
          payload: JSON.parse(event.event_json) as RuntimeEvent,
        };
        assertCanonicalRuntimeEventEnvelopeV24(envelope);
        if (
          Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8') !==
          event.canonical_bytes
        ) {
          throw new Error('canonical byte mismatch');
        }
      } catch {
        metadataVerified = false;
      }
      previousRevision = event.revision;
      prefixDigest = digestBytes(
        'legacy-named-metadata-prefix-row:v1',
        `${prefixDigest}\0${event.id}\0${event.event_id ?? ''}\0${event.revision}\0${rawBytes}\0${event.event_json}`,
      );
    }
    const classification: LegacyNamedCutProofV1['classification'] =
      parsed?.schemaVersion === 23 &&
      row.event_position <= (selectLastEventPosition.get(threadId)?.id ?? 0) &&
      metadataVerified
        ? 'verified_metadata_prefix'
        : 'legacy_unverified';
    return createLegacyNamedCutProofV1({
      threadId,
      name: row.name,
      eventPosition: row.event_position,
      classification,
      evidence: {
        namedCatalogVersion: catalogVersion,
        createdAt: row.created_at,
        stateBytes: Buffer.byteLength(row.state_json, 'utf8'),
        stateDigest: digestBytes('legacy-named-state:v1', row.state_json),
        prefixCount: prefix.length,
        prefixBytes,
        prefixDigest,
      },
    });
  };

  const nextBranchReceiptId = (
    requestDigest: string,
    candidate: BranchMutationOpaqueCandidateV1,
  ): string =>
    canonicalContextDigestV3('branch-mutation-receipt-id:v1', {
      nonce: candidate.nonceHex,
      requestDigest,
    });

  let lastBranchMutationResultV1: BranchMutationCommitResultV1 = {
    status: 'transcript_invariant_error',
  };
  const classifyBranchMutationFailureV1 = (error: unknown): BranchMutationCommitResultV1 => {
    if (error instanceof RuntimeRevisionConflictError) return { status: 'identity_stale' };
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('contention_timeout') || message.includes('SQLITE_BUSY')) {
      return { status: 'contention_timeout' };
    }
    if (message.includes('resource_saturated')) return { status: 'resource_saturated' };
    if (
      message.includes('checksum') ||
      message.includes('collision') ||
      message.includes('corrupt') ||
      message.includes('canonical')
    ) {
      return { status: 'digest_invalid' };
    }
    return { status: 'transcript_invariant_error' };
  };
  const branchCommitAckUnknownV1 = (
    completion: BranchMutationCompletionV1,
  ): BranchMutationCommitResultV1 => ({
    status: 'commit_ack_unknown',
    targetThreadId: completion.targetThreadId,
    targetGeneration: completion.targetGeneration,
    receiptId: completion.receiptId,
    requestDigest: completion.requestDigest,
    candidateDigest: completion.candidateDigest,
    manifestDigest: completion.manifestDigest,
    postSnapshotDigest: completion.postSnapshotDigest,
  });

  const runBranchImmediateV1 = <T>(work: (assertWithinDeadline: () => void) => T): T => {
    const startedAt = performance.now();
    const assertWithinDeadline = () => {
      if (performance.now() - startedAt >= 250) {
        throw new Error('contention_timeout');
      }
    };
    db.run('PRAGMA busy_timeout = 250');
    try {
      assertWithinDeadline();
      const transaction = db.transaction(() => {
        assertWithinDeadline();
        const result = work(assertWithinDeadline);
        assertWithinDeadline();
        return result;
      });
      return transaction.immediate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('database is locked') ||
        message.includes('SQLITE_BUSY') ||
        message.includes('contention_timeout')
      ) {
        throw new Error('contention_timeout', { cause: error });
      }
      throw error;
    } finally {
      db.run('PRAGMA busy_timeout = 5000');
    }
  };

  const persistBranchLifecycleEvents = (
    threadId: string,
    events: readonly RuntimeEvent[],
    metadata: readonly RuntimeEventMetadata[],
  ): number => {
    let eventPosition = 0;
    if (events.length !== metadata.length) {
      throw new Error('Branch mutation requires exact event envelope metadata.');
    }
    for (const [index, event] of events.entries()) {
      const entry = metadata[index]!;
      assertV24Metadata(threadId, entry.generation ?? -1, event, entry);
      claimMcpEgressNonce(threadId, event);
      const inserted = insertEventWithMetadata.run(
        threadId,
        JSON.stringify(event),
        entry.eventId,
        entry.revision,
        entry.causationId ?? null,
        entry.occurredAt ?? new Date(0).toISOString(),
        entry.generation ?? null,
        entry.canonicalBytes ?? null,
      );
      if (inserted.changes !== 1) {
        throw new Error(`Branch mutation event '${entry.eventId}' was already persisted.`);
      }
      eventPosition = Number(inserted.lastInsertRowid);
    }
    return eventPosition;
  };

  const persistBranchMutationAuthority = (derived: DerivedBranchLifecycleMutationV1): void => {
    const { completionChecksum, ...completionBody } = derived.completion;
    if (
      finalizeBranchMutationCompletionV1(completionBody).completionChecksum !== completionChecksum
    ) {
      throw new Error('Branch completion checksum mismatch.');
    }
    const completionBytes = encodeBranchMutationCompletionV1(derived.completion);
    let receiptBytes: Buffer | undefined;
    if (derived.receipt) {
      const { receiptChecksum, ...receiptBody } = derived.receipt;
      if (finalizeBranchMutationReceiptV1(receiptBody).receiptChecksum !== receiptChecksum) {
        throw new Error('Branch receipt checksum mismatch.');
      }
      receiptBytes = encodeBranchMutationReceiptV1(derived.receipt);
    }
    let closureBytes: Buffer | undefined;
    if (derived.terminalClosure) {
      const { closureChecksum, ...closureBody } = derived.terminalClosure;
      if (
        finalizeBranchCopiedTerminalClosureV1(closureBody).closureChecksum !== closureChecksum ||
        derived.receipt?.terminalClosure.kind !== 'copied' ||
        derived.receipt.terminalClosure.closureChecksum !== closureChecksum
      ) {
        throw new Error('Branch copied-terminal closure checksum mismatch.');
      }
      closureBytes = encodeBranchCopiedTerminalClosureV1(closureBody);
    }
    if (derived.receipt?.manifest.kind === 'settled_detach' && !closureBytes) {
      throw new Error('Settled branch detach requires one copied-terminal closure.');
    }
    if (derived.receipt?.manifest.kind === 'in_flight_quartet' && closureBytes) {
      throw new Error('In-flight branch quartet cannot carry a copied-terminal closure.');
    }
    insertBranchLedger.run(derived.completion.targetThreadId);
    const ledger = selectBranchLedgerActuals.get(derived.completion.targetThreadId);
    if (!ledger) throw new Error('Branch mutation ledger is unavailable.');
    if (
      ledger.receipt_count !== ledger.actual_receipt_count ||
      ledger.receipt_bytes !== ledger.actual_receipt_bytes ||
      ledger.closure_count !== ledger.actual_closure_count ||
      ledger.closure_bytes !== ledger.actual_closure_bytes ||
      ledger.completion_count !== ledger.actual_completion_count ||
      ledger.completion_bytes !== ledger.actual_completion_bytes
    ) {
      throw new Error('Branch mutation ledger counters are corrupt.');
    }
    const next = {
      receiptCount: ledger.receipt_count + (receiptBytes ? 1 : 0),
      receiptBytes: ledger.receipt_bytes + (receiptBytes?.length ?? 0),
      closureCount: ledger.closure_count + (closureBytes ? 1 : 0),
      closureBytes: ledger.closure_bytes + (closureBytes?.length ?? 0),
      completionCount: ledger.completion_count + 1,
      completionBytes: ledger.completion_bytes + completionBytes.length,
    };
    if (
      next.receiptCount > 1024 ||
      next.receiptBytes > 16 * 1024 * 1024 ||
      next.closureCount > 1024 ||
      next.closureBytes > 96 * 1024 * 1024 ||
      next.completionCount > 1024 ||
      next.completionBytes > 1024 * 1024
    ) {
      throw new Error('resource_saturated');
    }
    if (receiptBytes && derived.receipt) {
      insertBranchReceipt.run(
        derived.receipt.targetThreadId,
        derived.receipt.targetGeneration,
        derived.receipt.receiptId,
        receiptBytes,
        Buffer.from(derived.receipt.receiptChecksum, 'hex'),
        receiptBytes.length,
      );
      insertBranchReceiptRef.run(
        derived.receipt.targetThreadId,
        derived.receipt.receiptId,
        'rolling_snapshot',
        derived.receipt.targetThreadId,
      );
    }
    if (closureBytes && derived.terminalClosure) {
      insertBranchClosure.run(
        derived.terminalClosure.targetThreadId,
        derived.terminalClosure.targetGeneration,
        derived.terminalClosure.branchMutationReceiptId,
        closureBytes,
        Buffer.from(derived.terminalClosure.closureChecksum, 'hex'),
        closureBytes.length,
      );
    }
    insertBranchCompletion.run(
      derived.completion.targetThreadId,
      derived.completion.targetGeneration,
      derived.completion.receiptId,
      completionBytes,
      Buffer.from(completionChecksum, 'hex'),
      completionBytes.length,
    );
    const updated = updateBranchLedger.run(
      next.receiptCount,
      next.receiptBytes,
      next.closureCount,
      next.closureBytes,
      next.completionCount,
      next.completionBytes,
      derived.completion.targetThreadId,
      ledger.ledger_version,
    );
    if (updated.changes !== 1) throw new Error('Branch mutation ledger CAS conflict.');
  };

  const assertV24Metadata = (
    threadId: string,
    generation: number,
    event: RuntimeEvent,
    entry: RuntimeEventMetadata | undefined,
  ): void => {
    if (entry?.schemaVersion !== 24 || entry.generation !== generation || !entry.occurredAt) {
      throw new Error('Schema-v24 persistence requires complete canonical metadata.');
    }
    const envelope = {
      schemaVersion: 24,
      generation,
      threadId,
      eventId: entry.eventId,
      revision: entry.revision,
      causationId: entry.causationId ?? null,
      occurredAt: entry.occurredAt,
      payload: event,
    } as const;
    assertCanonicalRuntimeEventEnvelopeV24(envelope);
    const canonicalBytes = Buffer.byteLength(
      canonicalRuntimeEventEnvelopeBytesV24(envelope),
      'utf8',
    );
    if (canonicalBytes > MAX_RUNTIME_EVENT_CANONICAL_BYTES) {
      throw new Error('resource_saturated: canonical runtime event exceeds 128KiB');
    }
    if (entry.canonicalBytes !== canonicalBytes) {
      throw new Error('Schema-v24 canonical event byte count mismatch.');
    }
  };

  const planRuntimeEventTailLedger = (
    threadId: string,
    addedCanonicalBytes: readonly number[],
  ): { count: number; bytes: number; version: number } => {
    const head = observedEventHead(threadId);
    insertEmptyRuntimeEventLedger.run(
      threadId,
      digestBytes('runtime-event-tail-empty:v1', threadId),
      digestBytes('runtime-named-catalog-empty:v1', threadId),
      head.eventPosition,
    );
    const ledger = selectRuntimeEventTailLedger.get(threadId);
    if (!ledger) throw new Error('Runtime event tail ledger is unavailable.');
    const actual = selectRuntimeEventTailActual.get(threadId, ledger.tail_start_position) ?? {
      count: 0,
      bytes: 0,
    };
    if (actual.count !== ledger.tail_event_count || actual.bytes !== ledger.tail_event_bytes) {
      throw new Error('Runtime event tail ledger does not match retained rows.');
    }
    const count = actual.count + addedCanonicalBytes.length;
    const bytes = actual.bytes + addedCanonicalBytes.reduce((sum, value) => sum + value, 0);
    if (count > 50_000 || bytes > 64 * 1024 * 1024) throw new Error('resource_saturated');
    return { count, bytes, version: ledger.ledger_version };
  };

  const commitRuntimeEventTailLedger = (
    threadId: string,
    plan: { count: number; bytes: number; version: number },
  ): void => {
    if (
      updateRuntimeEventTailLedger.run(plan.count, plan.bytes, threadId, plan.version).changes !== 1
    ) {
      throw new Error('Runtime event tail ledger CAS conflict.');
    }
  };

  const strictStoredEventEnvelopes = (
    threadId: string,
    throughPosition: number,
    ledgerBaseRevision: number,
  ): import('./runtime-event-v24').RuntimeEventEnvelopeV24[] => {
    const basis = db
      .query<{ count: number; bytes: number }, [string, number, number]>(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes
           FROM runtime_events
          WHERE thread_id = ? AND id <= ? AND revision > ?`,
      )
      .get(threadId, throughPosition, ledgerBaseRevision) ?? { count: 0, bytes: 0 };
    if (basis.count > 50_000 || basis.bytes > 64 * 1024 * 1024) {
      throw new Error('resource_saturated: strict branch event basis exceeds its bound');
    }
    return selectStrictBranchEvents
      .all(threadId, throughPosition, ledgerBaseRevision)
      .map((row) => ({
        id: row.id,
        thread_id: row.thread_id,
        event: JSON.parse(row.event_json) as RuntimeEvent,
        created_at: row.created_at,
        ...(row.event_id ? { event_id: row.event_id } : {}),
        revision: row.revision,
        ...(row.causation_id ? { causation_id: row.causation_id } : {}),
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
        ...(row.producer_generation != null
          ? { producer_generation: row.producer_generation }
          : {}),
        ...(row.canonical_bytes != null ? { canonical_bytes: row.canonical_bytes } : {}),
      }))
      .map((entry) => {
        if (
          !entry.event_id ||
          !entry.revision ||
          !entry.occurred_at ||
          !entry.producer_generation
        ) {
          throw new Error('Strict branch source contains a metadata-incomplete event.');
        }
        const envelope = {
          schemaVersion: 24 as const,
          threadId,
          generation: entry.producer_generation,
          eventId: entry.event_id,
          revision: entry.revision,
          causationId: entry.causation_id ?? null,
          occurredAt: entry.occurred_at,
          payload: entry.event,
        };
        assertCanonicalRuntimeEventEnvelopeV24(envelope);
        return envelope;
      });
  };

  const loadBranchAuthority = (
    targetThreadId: string,
    targetGeneration: number,
    receiptId: string,
  ): BranchMutationAuthorityV1 | null =>
    db.transaction(() => {
      if (
        !targetThreadId ||
        !Number.isSafeInteger(targetGeneration) ||
        targetGeneration < 1 ||
        !/^[a-f0-9]{64}$/.test(receiptId)
      ) {
        return null;
      }
      const ledger = selectBranchLedgerActuals.get(targetThreadId);
      if (!ledger) return null;
      if (
        ledger.receipt_count !== ledger.actual_receipt_count ||
        ledger.receipt_bytes !== ledger.actual_receipt_bytes ||
        ledger.closure_count !== ledger.actual_closure_count ||
        ledger.closure_bytes !== ledger.actual_closure_bytes ||
        ledger.completion_count !== ledger.actual_completion_count ||
        ledger.completion_bytes !== ledger.actual_completion_bytes
      ) {
        throw new Error('Branch authority ledger counters are corrupt.');
      }
      const lengths = selectBranchAuthorityLengths.get(targetThreadId, targetGeneration, receiptId);
      if (!lengths) return null;
      if (
        lengths.completion_bytes !== lengths.completion_blob_length ||
        lengths.completion_bytes < 2 ||
        lengths.completion_bytes > 1024 ||
        lengths.receipt_bytes !== lengths.receipt_blob_length ||
        (lengths.receipt_bytes != null &&
          (lengths.receipt_bytes < 2 || lengths.receipt_bytes > 16 * 1024)) ||
        lengths.closure_bytes !== lengths.closure_blob_length ||
        (lengths.closure_bytes != null &&
          (lengths.closure_bytes < 7 || lengths.closure_bytes > 768 * 1024))
      ) {
        throw new Error('Branch authority row length is corrupt.');
      }
      const rows = selectBranchAuthorityBlobs.get(targetThreadId, targetGeneration, receiptId);
      if (!rows) throw new Error('Branch authority disappeared after its length gate.');
      const completion = decodeBranchMutationCompletionV1(rows.completion_blob);
      if (
        Buffer.from(rows.completion_checksum).toString('hex') !== completion.completionChecksum ||
        completion.targetThreadId !== targetThreadId ||
        completion.targetGeneration !== targetGeneration ||
        completion.receiptId !== receiptId
      ) {
        throw new Error('Branch completion row identity is corrupt.');
      }
      const receipt = rows.receipt_blob
        ? decodeBranchMutationReceiptV1(rows.receipt_blob)
        : undefined;
      if (
        receipt &&
        (Buffer.from(rows.receipt_checksum ?? []).toString('hex') !== receipt.receiptChecksum ||
          receipt.targetThreadId !== targetThreadId ||
          receipt.targetGeneration !== targetGeneration ||
          receipt.receiptId !== receiptId ||
          selectBranchReceiptRefCount.get(targetThreadId, receiptId)?.count !== 1)
      ) {
        throw new Error('Branch receipt row identity or reference is corrupt.');
      }
      const terminalClosure = rows.closure_blob
        ? decodeBranchCopiedTerminalClosureV1(
            rows.closure_blob,
            Buffer.from(rows.closure_checksum ?? []).toString('hex'),
          )
        : undefined;
      if (
        terminalClosure &&
        (terminalClosure.targetThreadId !== targetThreadId ||
          terminalClosure.targetGeneration !== targetGeneration ||
          terminalClosure.branchMutationReceiptId !== receiptId)
      ) {
        throw new Error('Branch copied-terminal closure identity is corrupt.');
      }
      if (
        receipt?.manifest.kind === 'settled_detach'
          ? !terminalClosure ||
            receipt.terminalClosure.kind !== 'copied' ||
            receipt.terminalClosure.closureChecksum !== terminalClosure.closureChecksum
          : Boolean(terminalClosure)
      ) {
        throw new Error('Branch receipt/closure co-retention is corrupt.');
      }
      return {
        completion,
        ...(receipt ? { receipt } : {}),
        ...(terminalClosure ? { terminalClosure } : {}),
      };
    })();

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
          const currentSnapshot = snapshotMetadata(threadId);
          const fence = threadFence(threadId);
          const generation = fence.generation;
          if (fence.lifecycle !== 'active') {
            throw new RuntimeRevisionConflictError(threadId, fence.generation, null);
          }
          if (
            (fence.format === 'v24_strict' || (currentSnapshot?.schemaVersion ?? 0) >= 24) &&
            metadata?.length !== events.length
          ) {
            throw new Error('Schema-v24 cutover rejects metadata-less append.');
          }
          const eventLedgerPlan =
            fence.format === 'v24_strict' || (currentSnapshot?.schemaVersion ?? 0) >= 24
              ? planRuntimeEventTailLedger(
                  threadId,
                  (metadata ?? []).map((entry) => entry.canonicalBytes ?? 0),
                )
              : null;
          upsertSession.run(threadId);
          for (const [index, event] of events.entries()) {
            claimMcpEgressNonce(threadId, event);
            const entry = metadata?.[index];
            if (fence.format === 'v24_strict' || (currentSnapshot?.schemaVersion ?? 0) >= 24) {
              assertV24Metadata(threadId, generation, event, entry);
            }
            if (entry) {
              insertEventWithMetadata.run(
                threadId,
                JSON.stringify(event),
                entry.eventId,
                entry.revision,
                entry.causationId ?? null,
                entry.occurredAt ?? new Date().toISOString(),
                entry.generation ?? null,
                entry.canonicalBytes ?? null,
              );
            } else {
              insertEvent.run(threadId, JSON.stringify(event));
            }
          }
          if (eventLedgerPlan) commitRuntimeEventTailLedger(threadId, eventLedgerPlan);
          incrementThreadWriteEpoch.run(threadId);
        })();
      } catch (e) {
        if (
          e instanceof RemoteMcpEgressNonceConflictError ||
          e instanceof RuntimeRevisionConflictError
        )
          throw e;
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
      expectedIdentity?: RuntimePersistenceIdentityV1,
    ): RuntimePersistenceIdentityV1 {
      if (isClosed) {
        throw new Error(`RuntimeStore is closed for thread ${threadId}.`);
      }
      try {
        return db.transaction(() => {
          const state = nextState as {
            revision?: number;
            schemaVersion?: number;
          };
          const schemaVersion = state.schemaVersion ?? 0;
          const actualIdentity = persistenceIdentity(threadId);
          if (expectedIdentity) {
            if (
              actualIdentity.generation !== expectedIdentity.generation ||
              actualIdentity.writeEpoch !== expectedIdentity.writeEpoch ||
              actualIdentity.format !== expectedIdentity.format ||
              actualIdentity.lifecycle !== expectedIdentity.lifecycle ||
              !sameSnapshotIdentity(
                actualIdentity.sourceSnapshot,
                expectedIdentity.sourceSnapshot,
              ) ||
              !sameObservedHead(actualIdentity.observedHead, expectedIdentity.observedHead)
            ) {
              throw new RuntimeRevisionConflictError(
                threadId,
                expectedIdentity.observedHead.revision,
                actualIdentity.observedHead.revision,
              );
            }
          } else if (schemaVersion >= 22) {
            throw new RuntimeRevisionConflictError(
              threadId,
              state.revision ?? 0,
              actualIdentity.sourceSnapshot?.stateRevision ?? null,
            );
          }

          if (schemaVersion >= 22) {
            if (!metadata || metadata.length !== events.length) {
              throw new Error('Schema-v22 persistence requires metadata for every event.');
            }
            const expectedBaseRevision =
              schemaVersion >= 24
                ? Math.max(
                    actualIdentity.observedHead.revision,
                    actualIdentity.sourceSnapshot?.stateRevision ?? 0,
                  )
                : actualIdentity.observedHead.revision;
            const eventIds = new Set<string>();
            for (const [index, entry] of metadata.entries()) {
              if (
                !entry.eventId ||
                eventIds.has(entry.eventId) ||
                entry.revision !== expectedBaseRevision + index + 1
              ) {
                throw new Error(
                  'Schema-v22 event metadata must have unique ids and contiguous revisions.',
                );
              }
              eventIds.add(entry.eventId);
              if (schemaVersion >= 24) {
                assertV24Metadata(threadId, actualIdentity.generation, events[index]!, entry);
              }
            }
            const expectedNextRevision = expectedBaseRevision + events.length;
            if (state.revision !== expectedNextRevision) {
              throw new RuntimeRevisionConflictError(
                threadId,
                expectedNextRevision,
                state.revision ?? null,
              );
            }
          }
          const firstRevision = metadata?.[0]?.revision;
          if (firstRevision != null && schemaVersion < 22) {
            const expectedRevision = firstRevision - 1;
            const actualRevision = selectSnapshotRevision.get(threadId)?.state_revision ?? null;
            if (
              (actualRevision == null && expectedRevision !== 0) ||
              (actualRevision != null && actualRevision !== expectedRevision)
            ) {
              throw new RuntimeRevisionConflictError(threadId, expectedRevision, actualRevision);
            }
          }
          upsertSession.run(threadId);
          const eventLedgerPlan =
            schemaVersion >= 24 && actualIdentity.format === 'v24_strict'
              ? planRuntimeEventTailLedger(
                  threadId,
                  (metadata ?? []).map((entry) => entry.canonicalBytes ?? 0),
                )
              : null;
          for (const [index, event] of events.entries()) {
            claimMcpEgressNonce(threadId, event);
            const entry = metadata?.[index];
            if (entry) {
              const inserted = insertEventWithMetadata.run(
                threadId,
                JSON.stringify(event),
                entry.eventId,
                entry.revision,
                entry.causationId ?? null,
                entry.occurredAt ?? new Date().toISOString(),
                entry.generation ?? null,
                entry.canonicalBytes ?? null,
              );
              if (schemaVersion >= 22 && inserted.changes !== 1) {
                throw new Error(`Schema-v22 event '${entry.eventId}' was already persisted.`);
              }
            } else {
              insertEvent.run(threadId, JSON.stringify(event));
            }
          }
          if (eventLedgerPlan) commitRuntimeEventTailLedger(threadId, eventLedgerPlan);
          const serialized = JSON.stringify(nextState);
          if (Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_SNAPSHOT_BYTES) {
            throw new Error('resource_saturated: rolling snapshot exceeds 32MiB');
          }
          const nextHead = observedEventHead(threadId);
          const nextMetadata: RuntimeSnapshotMetadata = {
            eventPosition: nextHead.eventPosition,
            stateRevision: state.revision ?? 0,
            stateChecksum: checksum(serialized),
            schemaVersion,
          };
          if (
            schemaVersion >= 22 &&
            snapshotMetadata &&
            !sameSnapshotIdentity(snapshotMetadata, nextMetadata)
          ) {
            throw new Error(
              'Schema-v22 snapshot metadata override does not match committed state.',
            );
          }
          upsertSnapshot.run(
            threadId,
            serialized,
            snapshotMetadata?.eventPosition ?? nextMetadata.eventPosition,
            snapshotMetadata?.stateRevision ?? nextMetadata.stateRevision,
            snapshotMetadata?.stateChecksum ?? nextMetadata.stateChecksum,
            snapshotMetadata?.schemaVersion ?? nextMetadata.schemaVersion,
          );
          if (schemaVersion >= 24) setThreadFenceStrict.run(threadId);
          incrementThreadWriteEpoch.run(threadId);
          return persistenceIdentity(threadId);
        })();
      } catch (e) {
        if (
          e instanceof RemoteMcpEgressNonceConflictError ||
          e instanceof RuntimeRevisionConflictError
        )
          throw e;
        throw new Error(
          `Failed to appendEventsAndSnapshot for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    tryAcquireEffectLease(threadId, effectId, ownerId, expiresAtMs): boolean {
      if (isClosed) return false;
      return db.transaction(() => {
        deleteExpiredEffectLease.run(threadId, effectId, Date.now());
        insertEffectLease.run(threadId, effectId, ownerId, expiresAtMs);
        return selectEffectLeaseOwner.get(threadId, effectId)?.owner_id === ownerId;
      })();
    },

    renewEffectLease(threadId, effectId, ownerId, expiresAtMs): boolean {
      if (isClosed) return false;
      renewEffectLease.run(expiresAtMs, threadId, effectId, ownerId);
      return selectEffectLeaseOwner.get(threadId, effectId)?.owner_id === ownerId;
    },

    releaseEffectLease(threadId, effectId, ownerId): void {
      if (isClosed) return;
      releaseEffectLease.run(threadId, effectId, ownerId);
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
        ...(row.producer_generation != null
          ? { producer_generation: row.producer_generation }
          : {}),
        ...(row.canonical_bytes != null ? { canonical_bytes: row.canonical_bytes } : {}),
      }));
    },

    saveSnapshot(threadId: string, state: unknown): void {
      if (isClosed) return;
      try {
        db.transaction(() => {
          const serialized = JSON.stringify(state);
          if (Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_SNAPSHOT_BYTES) {
            throw new Error('resource_saturated: rolling snapshot exceeds 32MiB');
          }
          const snapshot = state as {
            revision?: number;
            schemaVersion?: number;
          };
          if ((snapshot.schemaVersion ?? 0) >= 22) {
            const identity = persistenceIdentity(threadId);
            if (
              identity.lifecycle !== 'active' ||
              identity.sourceSnapshot !== null ||
              identity.observedHead.eventPosition !== 0 ||
              snapshot.revision !== 0
            ) {
              throw new Error(
                'Schema-v22 rolling snapshots require an exact persistence identity.',
              );
            }
          }
          upsertSnapshot.run(
            threadId,
            serialized,
            selectLastEventPosition.get(threadId)?.id ?? 0,
            snapshot.revision ?? 0,
            checksum(serialized),
            snapshot.schemaVersion ?? 0,
          );
          if ((snapshot.schemaVersion ?? 0) >= 24) setThreadFenceStrict.run(threadId);
          incrementThreadWriteEpoch.run(threadId);
        })();
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
      const length = selectSnapshotLength.get(threadId);
      if (length && length.bytes > MAX_RUNTIME_SNAPSHOT_BYTES) return null;
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

    loadPersistenceIdentity(threadId: string): RuntimePersistenceIdentityV1 {
      if (isClosed) {
        return {
          generation: 0,
          writeEpoch: 0,
          format: 'v23_compat',
          lifecycle: 'deleted',
          sourceSnapshot: null,
          observedHead: { eventPosition: 0, revision: 0, eventId: null },
        };
      }
      return db.transaction(() => persistenceIdentity(threadId))();
    },

    advanceRuntimeV24MigrationBuildV1(
      threadId: string,
      identity: RuntimeMigrationIdentityV1,
      maxRows = 4096,
    ): RuntimeV24MigrationBuildResultV1 {
      if (
        isClosed ||
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > 4096 ||
        identity.format !== 'v23_compat' ||
        identity.lifecycle !== 'active'
      ) {
        return { status: 'stale' };
      }
      const actual = persistenceIdentity(threadId);
      if (!samePersistenceIdentity(actual, identity)) return { status: 'stale' };
      const eventBasis = selectMigrationEventBasis.get(threadId) ?? { count: 0, bytes: 0 };
      if (eventBasis.count > 50_000 || eventBasis.bytes > 64 * 1024 * 1024) {
        throw new Error('resource_saturated');
      }
      const namedBasis = namedCatalogBasis(threadId);
      let build = selectMigrationBuild.get(threadId);
      const sourceMatches =
        build &&
        build.generation === identity.generation &&
        build.write_epoch === identity.writeEpoch &&
        build.source_snapshot_checksum === identity.sourceSnapshot.stateChecksum &&
        build.source_snapshot_revision === identity.sourceSnapshot.stateRevision &&
        build.source_snapshot_position === identity.sourceSnapshot.eventPosition &&
        build.source_head_position === identity.observedHead.eventPosition &&
        build.source_head_revision === identity.observedHead.revision &&
        build.source_head_event_id === identity.observedHead.eventId &&
        build.source_event_count === eventBasis.count &&
        build.source_event_bytes === eventBasis.bytes &&
        build.named_catalog_count === namedBasis.count &&
        build.named_catalog_bytes === namedBasis.bytes &&
        build.named_catalog_digest === namedBasis.digest &&
        build.named_catalog_version === namedBasis.catalogVersion;
      if (build && !sourceMatches) {
        db.transaction(() => {
          deleteMigrationNamedProofBuilds.run(threadId);
          deleteMigrationBuild.run(threadId);
        })();
        return { status: 'stale' };
      }
      if (!build) {
        const progressDigest = digestBytes('legacy-runtime-raw-events:v1', 'empty');
        const body = {
          generation: identity.generation,
          write_epoch: identity.writeEpoch,
          source_snapshot_checksum: identity.sourceSnapshot.stateChecksum,
          source_snapshot_revision: identity.sourceSnapshot.stateRevision,
          source_snapshot_position: identity.sourceSnapshot.eventPosition,
          source_head_position: identity.observedHead.eventPosition,
          source_head_revision: identity.observedHead.revision,
          source_head_event_id: identity.observedHead.eventId,
          source_event_count: eventBasis.count,
          source_event_bytes: eventBasis.bytes,
          named_catalog_count: namedBasis.count,
          named_catalog_bytes: namedBasis.bytes,
          named_catalog_digest: namedBasis.digest,
          named_catalog_version: namedBasis.catalogVersion,
          processed_rows: 0,
          processed_bytes: 0,
          progress_position: 0,
          progress_digest: progressDigest,
        };
        const buildChecksum = migrationBuildChecksum(body);
        try {
          db.transaction(() => {
            if (!samePersistenceIdentity(persistenceIdentity(threadId), identity)) {
              throw new RuntimeRevisionConflictError(
                threadId,
                identity.observedHead.revision,
                observedEventHead(threadId).revision,
              );
            }
            insertMigrationBuild.run(
              threadId,
              identity.generation,
              identity.writeEpoch,
              identity.sourceSnapshot.stateChecksum,
              identity.sourceSnapshot.stateRevision,
              identity.sourceSnapshot.eventPosition,
              identity.observedHead.eventPosition,
              identity.observedHead.revision,
              identity.observedHead.eventId,
              eventBasis.count,
              eventBasis.bytes,
              namedBasis.count,
              namedBasis.bytes,
              namedBasis.digest,
              namedBasis.catalogVersion,
              progressDigest,
              buildChecksum,
            );
          })();
        } catch {
          return { status: 'stale' };
        }
        build = selectMigrationBuild.get(threadId);
        if (!build) return { status: 'stale' };
      }
      if (
        migrationBuildChecksum({
          generation: build.generation,
          write_epoch: build.write_epoch,
          source_snapshot_checksum: build.source_snapshot_checksum,
          source_snapshot_revision: build.source_snapshot_revision,
          source_snapshot_position: build.source_snapshot_position,
          source_head_position: build.source_head_position,
          source_head_revision: build.source_head_revision,
          source_head_event_id: build.source_head_event_id,
          source_event_count: build.source_event_count,
          source_event_bytes: build.source_event_bytes,
          named_catalog_count: build.named_catalog_count,
          named_catalog_bytes: build.named_catalog_bytes,
          named_catalog_digest: build.named_catalog_digest,
          named_catalog_version: build.named_catalog_version,
          processed_rows: build.processed_rows,
          processed_bytes: build.processed_bytes,
          progress_position: build.progress_position,
          progress_digest: build.progress_digest,
        }) !== build.build_checksum
      ) {
        throw new Error('Runtime v24 migration build checksum is corrupt.');
      }
      if (build.processed_rows === build.source_event_count) {
        const builtNamedCount =
          countMigrationNamedProofBuilds.get(threadId, build.named_catalog_version)?.count ?? 0;
        if (builtNamedCount === build.named_catalog_count) {
          return { status: 'complete', evidence: migrationEvidence(build) };
        }
        const namedChunk = selectMigrationNamedProofChunk.all(threadId, maxRows);
        if (namedChunk.length === 0) {
          throw new Error('Runtime named proof build has an incomplete catalog gap.');
        }
        const proofs = namedChunk.map((row) =>
          buildLegacyNamedProof(threadId, row, build!.named_catalog_version, build!.generation),
        );
        try {
          db.transaction(() => {
            if (
              !samePersistenceIdentity(persistenceIdentity(threadId), identity) ||
              namedCatalogBasis(threadId).catalogVersion !== build!.named_catalog_version ||
              selectMigrationBuild.get(threadId)?.build_checksum !== build!.build_checksum
            ) {
              throw new RuntimeRevisionConflictError(
                threadId,
                identity.observedHead.revision,
                observedEventHead(threadId).revision,
              );
            }
            for (const proof of proofs) {
              const blob = encodeLegacyNamedProof(proof);
              if (blob.byteLength > 4096) throw new Error('Legacy named proof exceeds 4KiB.');
              insertMigrationNamedProofBuild.run(
                threadId,
                proof.name,
                build!.named_catalog_version,
                proof.classification,
                blob,
                Buffer.from(proof.proofChecksum, 'hex'),
              );
            }
          })();
        } catch {
          return { status: 'stale' };
        }
        const processedNamed =
          countMigrationNamedProofBuilds.get(threadId, build.named_catalog_version)?.count ?? 0;
        return processedNamed === build.named_catalog_count
          ? { status: 'complete', evidence: migrationEvidence(build) }
          : {
              status: 'in_progress',
              processedRows: build.processed_rows + processedNamed,
              totalRows: build.source_event_count + build.named_catalog_count,
            };
      }
      const chunk = selectMigrationEventChunk.all(threadId, build.progress_position, maxRows);
      if (chunk.length === 0) throw new Error('Runtime v24 migration build has an incomplete gap.');
      let progressDigest = build.progress_digest;
      let processedBytes = build.processed_bytes;
      for (const row of chunk) {
        const rawBytes = Buffer.byteLength(row.event_json, 'utf8');
        processedBytes += rawBytes;
        progressDigest = digestBytes(
          'legacy-runtime-raw-event-row:v1',
          `${progressDigest}\0${row.id}\0${rawBytes}\0${row.event_json}\0${JSON.stringify({
            eventId: row.event_id,
            revision: row.revision,
            causationId: row.causation_id,
            occurredAt: row.occurred_at,
            producerGeneration: row.producer_generation,
            canonicalBytes: row.canonical_bytes,
            createdAt: row.created_at,
          })}`,
        );
      }
      const processedRows = build.processed_rows + chunk.length;
      const progressPosition = chunk.at(-1)!.id;
      const nextBody = {
        generation: build.generation,
        write_epoch: build.write_epoch,
        source_snapshot_checksum: build.source_snapshot_checksum,
        source_snapshot_revision: build.source_snapshot_revision,
        source_snapshot_position: build.source_snapshot_position,
        source_head_position: build.source_head_position,
        source_head_revision: build.source_head_revision,
        source_head_event_id: build.source_head_event_id,
        source_event_count: build.source_event_count,
        source_event_bytes: build.source_event_bytes,
        named_catalog_count: build.named_catalog_count,
        named_catalog_bytes: build.named_catalog_bytes,
        named_catalog_digest: build.named_catalog_digest,
        named_catalog_version: build.named_catalog_version,
        processed_rows: processedRows,
        processed_bytes: processedBytes,
        progress_position: progressPosition,
        progress_digest: progressDigest,
      };
      const nextChecksum = migrationBuildChecksum(nextBody);
      try {
        db.transaction(() => {
          if (!samePersistenceIdentity(persistenceIdentity(threadId), identity)) {
            throw new RuntimeRevisionConflictError(
              threadId,
              identity.observedHead.revision,
              observedEventHead(threadId).revision,
            );
          }
          const updated = updateMigrationBuild.run(
            processedRows,
            processedBytes,
            progressPosition,
            progressDigest,
            nextChecksum,
            threadId,
            build!.build_checksum,
          );
          if (updated.changes !== 1) throw new Error('Runtime v24 migration build CAS conflict.');
        })();
      } catch {
        return { status: 'stale' };
      }
      const nextBuild = selectMigrationBuild.get(threadId);
      if (!nextBuild) return { status: 'stale' };
      return processedRows === nextBuild.source_event_count
        ? nextBuild.named_catalog_count === 0
          ? { status: 'complete', evidence: migrationEvidence(nextBuild) }
          : {
              status: 'in_progress',
              processedRows,
              totalRows: nextBuild.source_event_count + nextBuild.named_catalog_count,
            }
        : {
            status: 'in_progress',
            processedRows,
            totalRows: nextBuild.source_event_count + nextBuild.named_catalog_count,
          };
    },

    compareAndSaveMigratedSnapshot(
      threadId: string,
      identity: RuntimeMigrationIdentityV1,
      candidate: unknown,
      events: RuntimeEvent[] = [],
      metadata: RuntimeEventMetadata[] = [],
    ): 'saved' | 'stale' {
      if (isClosed) return 'stale';
      return db.transaction(() => {
        const actualIdentity = persistenceIdentity(threadId);
        if (
          actualIdentity.generation !== identity.generation ||
          actualIdentity.writeEpoch !== identity.writeEpoch ||
          actualIdentity.format !== identity.format ||
          actualIdentity.lifecycle !== identity.lifecycle ||
          !sameSnapshotIdentity(actualIdentity.sourceSnapshot, identity.sourceSnapshot) ||
          !sameObservedHead(actualIdentity.observedHead, identity.observedHead)
        ) {
          return 'stale';
        }
        if (events.length !== metadata.length) {
          throw new Error('Migration closure events require exact envelope metadata.');
        }
        const candidateState = candidate as { revision?: number; schemaVersion?: number };
        const migrationBuild = selectMigrationBuild.get(threadId);
        if ((candidateState.schemaVersion ?? 0) >= 24 && actualIdentity.format === 'v23_compat') {
          const currentNamedBasis = namedCatalogBasis(threadId);
          const namedProofCount = migrationBuild
            ? (countMigrationNamedProofBuilds.get(threadId, migrationBuild.named_catalog_version)
                ?.count ?? 0)
            : -1;
          if (
            !migrationBuild ||
            migrationBuild.processed_rows !== migrationBuild.source_event_count ||
            migrationBuild.processed_bytes !== migrationBuild.source_event_bytes ||
            migrationBuild.generation !== actualIdentity.generation ||
            migrationBuild.write_epoch !== actualIdentity.writeEpoch ||
            migrationBuild.source_snapshot_checksum !==
              actualIdentity.sourceSnapshot?.stateChecksum ||
            migrationBuild.source_head_position !== actualIdentity.observedHead.eventPosition ||
            migrationBuild.source_head_revision !== actualIdentity.observedHead.revision ||
            migrationBuild.source_head_event_id !== actualIdentity.observedHead.eventId ||
            migrationBuild.named_catalog_count !== currentNamedBasis.count ||
            migrationBuild.named_catalog_bytes !== currentNamedBasis.bytes ||
            migrationBuild.named_catalog_digest !== currentNamedBasis.digest ||
            migrationBuild.named_catalog_version !== currentNamedBasis.catalogVersion ||
            namedProofCount !== migrationBuild.named_catalog_count ||
            migrationBuildChecksum({
              generation: migrationBuild.generation,
              write_epoch: migrationBuild.write_epoch,
              source_snapshot_checksum: migrationBuild.source_snapshot_checksum,
              source_snapshot_revision: migrationBuild.source_snapshot_revision,
              source_snapshot_position: migrationBuild.source_snapshot_position,
              source_head_position: migrationBuild.source_head_position,
              source_head_revision: migrationBuild.source_head_revision,
              source_head_event_id: migrationBuild.source_head_event_id,
              source_event_count: migrationBuild.source_event_count,
              source_event_bytes: migrationBuild.source_event_bytes,
              named_catalog_count: migrationBuild.named_catalog_count,
              named_catalog_bytes: migrationBuild.named_catalog_bytes,
              named_catalog_digest: migrationBuild.named_catalog_digest,
              named_catalog_version: migrationBuild.named_catalog_version,
              processed_rows: migrationBuild.processed_rows,
              processed_bytes: migrationBuild.processed_bytes,
              progress_position: migrationBuild.progress_position,
              progress_digest: migrationBuild.progress_digest,
            }) !== migrationBuild.build_checksum
          ) {
            throw new Error('Runtime v24 cutover requires one completed exact-source build.');
          }
          const storage = (candidate as { storageFormat?: RuntimeState['storageFormat'] })
            .storageFormat;
          if (
            storage?.format !== 'v24_strict' ||
            storage.ledgerBase.kind !== 'migrated_v23' ||
            storage.ledgerBase.legacyEvidenceDigest !==
              digestBytes(
                'legacy-runtime-ledger-evidence:v1',
                JSON.stringify(migrationEvidence(migrationBuild)),
              )
          ) {
            throw new Error('Runtime v24 candidate lacks its streamed legacy evidence binding.');
          }
        }
        const eventIds = new Set<string>();
        for (const [index, event] of events.entries()) {
          const entry = metadata[index]!;
          if (
            !entry.eventId ||
            eventIds.has(entry.eventId) ||
            entry.revision !== actualIdentity.observedHead.revision + index + 1
          ) {
            throw new Error('Migration closure events must have unique contiguous revisions.');
          }
          eventIds.add(entry.eventId);
          if ((candidateState.schemaVersion ?? 0) >= 24) {
            assertV24Metadata(threadId, actualIdentity.generation, event, entry);
          }
          claimMcpEgressNonce(threadId, event);
          const inserted = insertEventWithMetadata.run(
            threadId,
            JSON.stringify(event),
            entry.eventId,
            entry.revision,
            entry.causationId ?? null,
            entry.occurredAt ?? new Date(0).toISOString(),
            entry.generation ?? null,
            entry.canonicalBytes ?? null,
          );
          if (inserted.changes !== 1) {
            throw new Error(`Migration closure event '${entry.eventId}' was already persisted.`);
          }
        }
        const serialized = JSON.stringify(candidate);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_SNAPSHOT_BYTES) {
          throw new Error('resource_saturated: migrated snapshot exceeds 32MiB');
        }
        const state = candidateState;
        const nextHead = observedEventHead(threadId);
        if (state.revision !== nextHead.revision) {
          throw new RuntimeRevisionConflictError(
            threadId,
            nextHead.revision,
            state.revision ?? null,
          );
        }
        upsertSnapshot.run(
          threadId,
          serialized,
          nextHead.eventPosition,
          state.revision ?? 0,
          checksum(serialized),
          state.schemaVersion ?? 0,
        );
        if ((state.schemaVersion ?? 0) >= 24 && actualIdentity.format === 'v23_compat') {
          if (!migrationBuild) throw new Error('Runtime v24 migration build disappeared.');
          insertRuntimeEventLedger.run(
            threadId,
            migrationBuild.source_event_count,
            migrationBuild.source_event_bytes,
            migrationBuild.progress_digest,
            migrationBuild.named_catalog_count,
            migrationBuild.named_catalog_bytes,
            migrationBuild.named_catalog_digest,
            migrationBuild.source_head_position,
            metadata.length,
            metadata.reduce((sum, entry) => sum + (entry.canonicalBytes ?? 0), 0),
          );
          promoteMigrationNamedProofs.run(threadId);
          deleteMigrationNamedProofBuilds.run(threadId);
          deleteMigrationBuild.run(threadId);
        }
        if ((state.schemaVersion ?? 0) >= 24) setThreadFenceStrict.run(threadId);
        incrementThreadWriteEpoch.run(threadId);
        return 'saved';
      })();
    },

    saveNamedSnapshot(
      threadId: string,
      name: string,
      state: unknown,
      eventPosition?: number,
      expectedIdentity?: RuntimePersistenceIdentityV1,
    ): void {
      if (isClosed) return;
      try {
        db.transaction(() => {
          const actualIdentity = persistenceIdentity(threadId);
          if (actualIdentity.lifecycle !== 'active') {
            throw new RuntimeRevisionConflictError(threadId, actualIdentity.generation, null);
          }
          if (actualIdentity.format === 'v24_strict') {
            if (
              !expectedIdentity ||
              actualIdentity.generation !== expectedIdentity.generation ||
              actualIdentity.writeEpoch !== expectedIdentity.writeEpoch ||
              actualIdentity.format !== expectedIdentity.format ||
              actualIdentity.lifecycle !== expectedIdentity.lifecycle ||
              !sameSnapshotIdentity(
                actualIdentity.sourceSnapshot,
                expectedIdentity.sourceSnapshot,
              ) ||
              !sameObservedHead(actualIdentity.observedHead, expectedIdentity.observedHead)
            ) {
              throw new RuntimeRevisionConflictError(
                threadId,
                expectedIdentity?.observedHead.revision ?? -1,
                actualIdentity.observedHead.revision,
              );
            }
          }
          const position = eventPosition ?? selectLastEventPosition.get(threadId)?.id ?? 0;
          const serialized = JSON.stringify(state);
          if (Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_SNAPSHOT_BYTES) {
            throw new Error('resource_saturated: named snapshot exceeds 32MiB');
          }
          upsertNamedSnapshot.run(threadId, name, position, serialized);
          incrementThreadWriteEpoch.run(threadId);
        })();
      } catch (e) {
        if (e instanceof RuntimeRevisionConflictError) throw e;
        throw new Error(
          `Failed to save named snapshot ${name} for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    loadNamedSnapshot<T = unknown>(threadId: string, name: string): T | null {
      if (isClosed) return null;
      const length = selectNamedSnapshotLength.get(threadId, name);
      if (length && length.bytes > MAX_RUNTIME_SNAPSHOT_BYTES) return null;
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

    getSessionModelRoute(threadId: string): RuntimeSessionModelRoute | null {
      if (isClosed) return null;
      const row = selectSessionModelRoute.get(threadId);
      if (!row?.model_provider || !row.model_name) return null;
      return { provider: row.model_provider, name: row.model_name };
    },

    setSessionModelRoute(threadId: string, route: RuntimeSessionModelRoute): void {
      if (isClosed || !threadId || !route.provider.trim() || !route.name.trim()) return;
      upsertSession.run(threadId);
      updateSessionModelRoute.run(route.provider.trim(), route.name.trim(), threadId);
    },

    deleteSession(threadId: string, expectedIdentity?: RuntimePersistenceIdentityV1): void {
      if (isClosed) return;
      db.transaction(() => {
        const actualIdentity = persistenceIdentity(threadId);
        if (
          actualIdentity.lifecycle !== 'active' ||
          (actualIdentity.format === 'v24_strict' &&
            (!expectedIdentity ||
              actualIdentity.generation !== expectedIdentity.generation ||
              actualIdentity.writeEpoch !== expectedIdentity.writeEpoch ||
              actualIdentity.format !== expectedIdentity.format ||
              actualIdentity.lifecycle !== expectedIdentity.lifecycle ||
              !sameSnapshotIdentity(
                actualIdentity.sourceSnapshot,
                expectedIdentity.sourceSnapshot,
              ) ||
              !sameObservedHead(actualIdentity.observedHead, expectedIdentity.observedHead)))
        ) {
          throw new RuntimeRevisionConflictError(
            threadId,
            expectedIdentity?.observedHead.revision ?? actualIdentity.observedHead.revision,
            actualIdentity.lifecycle === 'deleted' ? null : actualIdentity.observedHead.revision,
          );
        }
        if (
          !Number.isSafeInteger(actualIdentity.generation + 1) ||
          !Number.isSafeInteger(actualIdentity.writeEpoch + 1)
        )
          throw new Error('Runtime thread fence overflow.');
        deleteThreadFenceCas.run(
          threadId,
          actualIdentity.generation,
          actualIdentity.format,
          actualIdentity.writeEpoch,
        );
        if (directChanges() !== 1) {
          throw new RuntimeRevisionConflictError(
            threadId,
            actualIdentity.observedHead.revision,
            observedEventHead(threadId).revision,
          );
        }
        deleteEvents.run(threadId);
        deleteSnapshot.run(threadId);
        deleteNamedSnapshots.run(threadId);
        deleteFilePreimages.run(threadId);
        deleteEffectLeasesForThread.run(threadId);
        deleteBranchReceipts.run(threadId);
        deleteBranchCompletions.run(threadId);
        deleteBranchClosures.run(threadId);
        deleteBranchReceiptRefs.run(threadId);
        deleteBranchLedger.run(threadId);
        deleteMigrationBuild.run(threadId);
        deleteRuntimeEventLedger.run(threadId);
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
      return {
        snapshotId: row.name,
        eventPosition: row.event_position,
        createdAt: row.created_at,
      };
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

    restoreNamedSnapshot(
      threadId: string,
      snapshotId: string,
      opaqueCandidate?: BranchMutationOpaqueCandidateV1,
    ): boolean {
      lastBranchMutationResultV1 = { status: 'transcript_invariant_error' };
      if (isClosed) return false;
      if (selectMigrationBuild.get(threadId)) return false;
      const selectedLength = selectNamedSnapshotLength.get(threadId, snapshotId);
      if (selectedLength && selectedLength.bytes > MAX_RUNTIME_SNAPSHOT_BYTES) {
        lastBranchMutationResultV1 = { status: 'resource_saturated' };
        return false;
      }
      const selectedRow = selectNamedSnapshot.get(threadId, snapshotId);
      const selectedEntry = selectNamedSnapshotEntry.get(threadId, snapshotId);
      if (!selectedRow || !selectedEntry) return false;
      let selectedSnapshot: Record<string, unknown>;
      try {
        const parsed = JSON.parse(selectedRow.state_json) as unknown;
        if (!isRecord(parsed)) return false;
        selectedSnapshot = parsed;
      } catch {
        return false;
      }
      let selectedProofAuthority: ReturnType<typeof loadVerifiedLegacyNamedProof> = null;
      if (
        selectedSnapshot.schemaVersion !== 24 &&
        persistenceIdentity(threadId).format === 'v24_strict'
      ) {
        selectedProofAuthority = loadVerifiedLegacyNamedProof(
          threadId,
          snapshotId,
          selectedEntry.event_position,
        );
        if (!selectedProofAuthority) return false;
        try {
          selectedSnapshot = migrateLegacyNamedStateV24({
            state: selectedSnapshot,
            proof: selectedProofAuthority.proof,
          });
        } catch {
          return false;
        }
      }
      if (selectedSnapshot.schemaVersion === 24) {
        const candidate = opaqueCandidate ?? createBranchMutationOpaqueCandidateV1();
        try {
          assertBranchMutationOpaqueCandidateV1(candidate);
        } catch {
          lastBranchMutationResultV1 = { status: 'digest_invalid' };
          return false;
        }
        if (selectMigrationBuild.get(threadId)) return false;
        const expectedIdentity = persistenceIdentity(threadId);
        if (
          expectedIdentity.lifecycle !== 'active' ||
          !Number.isSafeInteger(expectedIdentity.generation + 1) ||
          !Number.isSafeInteger(expectedIdentity.writeEpoch + 1)
        ) {
          return false;
        }
        const targetGeneration = expectedIdentity.generation + 1;
        const selectedCutDigest = canonicalContextDigestV3('branch-selected-cut:v1', {
          threadId,
          snapshotId,
          state: selectedSnapshot,
        });
        const request = {
          kind: 'rewind',
          threadId,
          snapshotId,
          expectedIdentity,
          selectedCutDigest,
        } as const;
        const requestDigest = canonicalContextDigestV3('branch-mutation-request:v1', request);
        const receiptId = nextBranchReceiptId(requestDigest, candidate);
        let selectedSourceEnvelopes: ReturnType<typeof strictStoredEventEnvelopes>;
        try {
          selectedSourceEnvelopes = strictStoredEventEnvelopes(
            threadId,
            selectedEntry.event_position,
            isRecord(selectedSnapshot.storageFormat) &&
              isRecord(selectedSnapshot.storageFormat.ledgerBase) &&
              typeof selectedSnapshot.storageFormat.ledgerBase.baseRevision === 'number'
              ? selectedSnapshot.storageFormat.ledgerBase.baseRevision
              : 0,
          );
        } catch {
          return false;
        }
        let branchBase = rebaseBranchStateV24(
          structuredClone(selectedSnapshot),
          'verified_named_v24',
          `${threadId}:${targetGeneration}:${selectedCutDigest}`,
          receiptId,
        );
        let derived: DerivedBranchLifecycleMutationV1;
        try {
          derived = candidate.derive({
            state: branchBase as unknown as RuntimeState,
            reason: 'rewind',
            receiptId,
            sourceThreadId: threadId,
            targetThreadId: threadId,
            sourceGeneration: expectedIdentity.generation,
            targetGeneration,
            selectedCutDigest,
            requestDigest,
            selectedSourceEnvelopes,
            occurredAt: candidate.occurredAt,
          });
        } catch {
          return false;
        }
        try {
          const committed = runBranchImmediateV1((assertWithinDeadline) => {
            const atomicIdentity = persistenceIdentity(threadId);
            const atomicRow = selectNamedSnapshot.get(threadId, snapshotId);
            const atomicEntry = selectNamedSnapshotEntry.get(threadId, snapshotId);
            const atomicProofAuthority = selectedProofAuthority
              ? loadVerifiedLegacyNamedProof(threadId, snapshotId, selectedEntry.event_position)
              : null;
            if (
              !samePersistenceIdentity(atomicIdentity, expectedIdentity) ||
              atomicRow?.state_json !== selectedRow.state_json ||
              atomicEntry?.event_position !== selectedEntry.event_position ||
              (selectedProofAuthority !== null &&
                (atomicProofAuthority === null ||
                  atomicProofAuthority.catalogVersion !== selectedProofAuthority.catalogVersion ||
                  atomicProofAuthority.blobDigest !== selectedProofAuthority.blobDigest))
            ) {
              throw new RuntimeRevisionConflictError(
                threadId,
                expectedIdentity.observedHead.revision,
                atomicIdentity.observedHead.revision,
              );
            }
            replaceThreadFenceCas.run(
              threadId,
              expectedIdentity.generation,
              expectedIdentity.format,
              expectedIdentity.writeEpoch,
              expectedIdentity.lifecycle,
            );
            if (directChanges() !== 1) {
              throw new RuntimeRevisionConflictError(
                threadId,
                expectedIdentity.observedHead.revision,
                observedEventHead(threadId).revision,
              );
            }
            deleteEvents.run(threadId);
            deleteSnapshot.run(threadId);
            deleteNamedSnapshots.run(threadId);
            deleteFilePreimages.run(threadId);
            deleteEffectLeasesForThread.run(threadId);
            deleteMigrationBuild.run(threadId);
            deleteRuntimeEventLedger.run(threadId);
            const eventLedgerPlan = planRuntimeEventTailLedger(
              threadId,
              derived.metadata.map((entry) => entry.canonicalBytes ?? 0),
            );
            const targetPosition = persistBranchLifecycleEvents(
              threadId,
              derived.events,
              derived.metadata,
            );
            commitRuntimeEventTailLedger(threadId, eventLedgerPlan);
            persistBranchMutationAuthority(derived);
            branchBase = rebaseBranchStateV24(
              structuredClone(selectedSnapshot),
              'verified_named_v24',
              `${threadId}:${targetGeneration}:${selectedCutDigest}`,
              receiptId,
            );
            insertForkNamedSnapshot.run(
              threadId,
              snapshotId,
              0,
              JSON.stringify(branchBase),
              selectedEntry.created_at,
            );
            const serialized = JSON.stringify(derived.state);
            upsertSnapshot.run(
              threadId,
              serialized,
              targetPosition,
              derived.state.revision,
              checksum(serialized),
              24,
            );
            upsertSession.run(threadId);
            assertWithinDeadline();
            return true;
          });
          lastBranchMutationResultV1 = options.faultInjectionBranchCommitAckUnknown
            ? branchCommitAckUnknownV1(derived.completion)
            : { status: 'committed', receiptId, targetGeneration };
          return options.faultInjectionBranchCommitAckUnknown ? false : committed;
        } catch (error) {
          lastBranchMutationResultV1 = classifyBranchMutationFailureV1(error);
          return false;
        }
      }
      if (persistenceIdentity(threadId).format === 'v24_strict') {
        // A strict fence can never be downgraded to a legacy writer format.
        // Legacy named cuts remain read-only until they carry a migrated cut proof.
        return false;
      }
      return db.transaction(() => {
        const namedRow = selectNamedSnapshot.get(threadId, snapshotId);
        const entry = selectNamedSnapshotEntry.get(threadId, snapshotId);
        if (!namedRow || !entry) return false;
        let snapshot = selectedSnapshot;
        const generation = advanceThreadGeneration(threadId);
        deleteEventsAfter.run(threadId, entry.event_position);
        deleteNamedSnapshotsAfter.run(threadId, entry.event_position);
        // ADR-0042 §4：文件原像随恢复点一同截断（调用方应在此之前完成文件恢复）
        deleteFilePreimagesAfter.run(threadId, entry.event_position);
        snapshot = rebaseBranchStateV24(
          snapshot,
          'verified_named_v24',
          `${threadId}:${generation}:${snapshotId}:${entry.event_position}`,
        );
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
        return true;
      })();
    },

    forkSession(
      sourceThreadId: string,
      snapshotId: string,
      targetThreadId: string,
      opaqueCandidate?: BranchMutationOpaqueCandidateV1,
    ): boolean {
      lastBranchMutationResultV1 = { status: 'transcript_invariant_error' };
      if (isClosed) return false;
      if (selectMigrationBuild.get(sourceThreadId) || selectMigrationBuild.get(targetThreadId)) {
        return false;
      }
      const rolling =
        snapshotId === '__runtime_current__'
          ? store.loadSnapshotRecord<Record<string, unknown>>(sourceThreadId)
          : null;
      const loadedSnapshot = rolling?.state ?? store.loadNamedSnapshot(sourceThreadId, snapshotId);
      if (!isRecord(loadedSnapshot)) return false;
      const rawSnapshot = loadedSnapshot;
      let snapshot = loadedSnapshot;
      const position =
        rolling?.metadata.eventPosition ??
        listNamedSnapshots.all(sourceThreadId).find((entry) => entry.name === snapshotId)
          ?.event_position ??
        0;
      let selectedProofAuthority: ReturnType<typeof loadVerifiedLegacyNamedProof> = null;
      if (
        snapshotId !== '__runtime_current__' &&
        snapshot.schemaVersion !== 24 &&
        persistenceIdentity(sourceThreadId).format === 'v24_strict'
      ) {
        selectedProofAuthority = loadVerifiedLegacyNamedProof(sourceThreadId, snapshotId, position);
        if (!selectedProofAuthority) return false;
        try {
          snapshot = migrateLegacyNamedStateV24({
            state: snapshot,
            proof: selectedProofAuthority.proof,
          });
        } catch {
          return false;
        }
      }
      if (snapshot.schemaVersion === 24) {
        const candidate = opaqueCandidate ?? createBranchMutationOpaqueCandidateV1();
        try {
          assertBranchMutationOpaqueCandidateV1(candidate);
        } catch {
          lastBranchMutationResultV1 = { status: 'digest_invalid' };
          return false;
        }
        if (selectMigrationBuild.get(sourceThreadId) || selectMigrationBuild.get(targetThreadId)) {
          return false;
        }
        const expectedSourceIdentity = persistenceIdentity(sourceThreadId);
        const expectedTargetIdentity = persistenceIdentityIfRetained(targetThreadId);
        if (
          expectedSourceIdentity.lifecycle !== 'active' ||
          (expectedTargetIdentity != null &&
            (!Number.isSafeInteger(expectedTargetIdentity.generation + 1) ||
              !Number.isSafeInteger(expectedTargetIdentity.writeEpoch + 1)))
        ) {
          return false;
        }
        const targetGeneration = expectedTargetIdentity ? expectedTargetIdentity.generation + 1 : 1;
        const selectedCutDigest = canonicalContextDigestV3('branch-selected-cut:v1', {
          sourceThreadId,
          snapshotId,
          state: snapshot,
        });
        const request = {
          kind: 'fork',
          sourceThreadId,
          targetThreadId,
          snapshotId,
          expectedSourceIdentity,
          expectedTargetIdentity,
          selectedCutDigest,
        } as const;
        const requestDigest = canonicalContextDigestV3('branch-mutation-request:v1', request);
        const receiptId = nextBranchReceiptId(requestDigest, candidate);
        let selectedSourceEnvelopes: ReturnType<typeof strictStoredEventEnvelopes>;
        try {
          selectedSourceEnvelopes = strictStoredEventEnvelopes(
            sourceThreadId,
            position,
            isRecord(snapshot.storageFormat) &&
              isRecord(snapshot.storageFormat.ledgerBase) &&
              typeof snapshot.storageFormat.ledgerBase.baseRevision === 'number'
              ? snapshot.storageFormat.ledgerBase.baseRevision
              : 0,
          );
        } catch {
          return false;
        }
        const branchBase = rebaseBranchStateV24(
          rebindForkState(snapshot, targetThreadId),
          'fork_rebound_v24',
          `${sourceThreadId}:${targetThreadId}:${targetGeneration}:${selectedCutDigest}`,
          receiptId,
        );
        let derived: DerivedBranchLifecycleMutationV1;
        try {
          derived = candidate.derive({
            state: branchBase as unknown as RuntimeState,
            reason: 'fork',
            receiptId,
            sourceThreadId,
            targetThreadId,
            sourceGeneration: expectedSourceIdentity.generation,
            targetGeneration,
            selectedCutDigest,
            requestDigest,
            selectedSourceEnvelopes,
            occurredAt: candidate.occurredAt,
          });
        } catch {
          return false;
        }
        const sourceModelRoute = store.getSessionModelRoute(sourceThreadId);
        try {
          runBranchImmediateV1((assertWithinDeadline) => {
            const atomicSourceIdentity = persistenceIdentity(sourceThreadId);
            const atomicTargetIdentity = persistenceIdentityIfRetained(targetThreadId);
            const atomicSelected =
              snapshotId === '__runtime_current__'
                ? store.loadSnapshotRecord<Record<string, unknown>>(sourceThreadId)?.state
                : store.loadNamedSnapshot<Record<string, unknown>>(sourceThreadId, snapshotId);
            const atomicProofAuthority = selectedProofAuthority
              ? loadVerifiedLegacyNamedProof(sourceThreadId, snapshotId, position)
              : null;
            if (
              !samePersistenceIdentity(atomicSourceIdentity, expectedSourceIdentity) ||
              (atomicTargetIdentity === null || expectedTargetIdentity === null
                ? atomicTargetIdentity !== expectedTargetIdentity
                : !samePersistenceIdentity(atomicTargetIdentity, expectedTargetIdentity)) ||
              !isRecord(atomicSelected) ||
              JSON.stringify(atomicSelected) !== JSON.stringify(rawSnapshot) ||
              (selectedProofAuthority !== null &&
                (atomicProofAuthority === null ||
                  atomicProofAuthority.catalogVersion !== selectedProofAuthority.catalogVersion ||
                  atomicProofAuthority.blobDigest !== selectedProofAuthority.blobDigest))
            ) {
              throw new RuntimeRevisionConflictError(
                targetThreadId,
                expectedTargetIdentity?.observedHead.revision ?? 0,
                atomicTargetIdentity?.observedHead.revision ?? 0,
              );
            }
            if (expectedTargetIdentity) {
              replaceThreadFenceCas.run(
                targetThreadId,
                expectedTargetIdentity.generation,
                expectedTargetIdentity.format,
                expectedTargetIdentity.writeEpoch,
                expectedTargetIdentity.lifecycle,
              );
              if (directChanges() !== 1) {
                throw new RuntimeRevisionConflictError(
                  targetThreadId,
                  expectedTargetIdentity.observedHead.revision,
                  observedEventHead(targetThreadId).revision,
                );
              }
            } else {
              if (hasAnyThreadAuthority(targetThreadId)) {
                throw new RuntimeRevisionConflictError(targetThreadId, 0, 0);
              }
              insertFreshStrictThreadFence.run(targetThreadId);
              if (directChanges() !== 1) {
                throw new RuntimeRevisionConflictError(targetThreadId, 0, 0);
              }
            }
            deleteEvents.run(targetThreadId);
            deleteSnapshot.run(targetThreadId);
            deleteNamedSnapshots.run(targetThreadId);
            deleteFilePreimages.run(targetThreadId);
            deleteEffectLeasesForThread.run(targetThreadId);
            deleteBranchReceipts.run(targetThreadId);
            deleteBranchCompletions.run(targetThreadId);
            deleteBranchClosures.run(targetThreadId);
            deleteBranchReceiptRefs.run(targetThreadId);
            deleteBranchLedger.run(targetThreadId);
            deleteMigrationBuild.run(targetThreadId);
            deleteRuntimeEventLedger.run(targetThreadId);
            deleteSession.run(targetThreadId);
            upsertSession.run(targetThreadId);
            if (sourceModelRoute) {
              updateSessionModelRoute.run(
                sourceModelRoute.provider,
                sourceModelRoute.name,
                targetThreadId,
              );
            }
            const eventLedgerPlan = planRuntimeEventTailLedger(
              targetThreadId,
              derived.metadata.map((entry) => entry.canonicalBytes ?? 0),
            );
            const targetPosition = persistBranchLifecycleEvents(
              targetThreadId,
              derived.events,
              derived.metadata,
            );
            commitRuntimeEventTailLedger(targetThreadId, eventLedgerPlan);
            persistBranchMutationAuthority(derived);
            const serialized = JSON.stringify(derived.state);
            upsertSnapshot.run(
              targetThreadId,
              serialized,
              targetPosition,
              derived.state.revision,
              checksum(serialized),
              24,
            );
            insertForkNamedSnapshot.run(
              targetThreadId,
              snapshotId === '__runtime_current__' ? 'fork-base' : snapshotId,
              0,
              JSON.stringify(branchBase),
              Math.floor(Date.now() / 1000),
            );
            assertWithinDeadline();
          });
        } catch (error) {
          lastBranchMutationResultV1 = classifyBranchMutationFailureV1(error);
          return false;
        }
        lastBranchMutationResultV1 = options.faultInjectionBranchCommitAckUnknown
          ? branchCommitAckUnknownV1(derived.completion)
          : { status: 'committed', receiptId, targetGeneration };
        return !options.faultInjectionBranchCommitAckUnknown;
      }
      if (persistenceIdentity(sourceThreadId).format === 'v24_strict') {
        // Historical cuts without a migrated LegacyNamedCutProof remain read-only.
        // Never fall through to the legacy copying writer after strict cutover.
        lastBranchMutationResultV1 = { status: 'transcript_invariant_error' };
        return false;
      }
      let sourceEvents: StoredEvent[];
      try {
        sourceEvents = store
          .loadEventsStrict(sourceThreadId)
          .filter(
            (entry) =>
              entry.id <= position &&
              (snapshotId !== '__runtime_current__' ||
                !isCurrentPendingInteractionRequest(snapshot, entry.event)),
          );
      } catch {
        return false;
      }
      const sourceNamedSnapshots = selectNamedSnapshotsForFork.all(sourceThreadId, position);
      const sourceFilePreimages = selectFilePreimagesForFork.all(sourceThreadId, position);
      const sourceModelRoute = store.getSessionModelRoute(sourceThreadId);
      try {
        db.transaction(() => {
          const atomicSourceRolling =
            store.loadSnapshotRecord<Record<string, unknown>>(sourceThreadId);
          const atomicSelected =
            snapshotId === '__runtime_current__'
              ? atomicSourceRolling?.state
              : store.loadNamedSnapshot<Record<string, unknown>>(sourceThreadId, snapshotId);
          if (
            !isRecord(atomicSelected) ||
            JSON.stringify(atomicSelected) !== JSON.stringify(snapshot)
          ) {
            throw new Error('Fork source snapshot changed before guard join.');
          }
          const targetGeneration = advanceThreadGeneration(targetThreadId);
          deleteEvents.run(targetThreadId);
          deleteSnapshot.run(targetThreadId);
          deleteNamedSnapshots.run(targetThreadId);
          deleteFilePreimages.run(targetThreadId);
          deleteSession.run(targetThreadId);
          upsertSession.run(targetThreadId);
          if (sourceModelRoute) {
            updateSessionModelRoute.run(
              sourceModelRoute.provider,
              sourceModelRoute.name,
              targetThreadId,
            );
          }
          const positionMap = new Map<number, number>();
          for (const entry of sourceEvents) {
            const inserted = insertForkEvent.run(
              targetThreadId,
              JSON.stringify(entry.event),
              entry.event_id ?? null,
              entry.revision ?? 0,
              entry.causation_id ?? null,
              entry.occurred_at ?? null,
              entry.producer_generation ?? null,
              entry.canonical_bytes ?? null,
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
          let forkState = rebindForkState(snapshot, targetThreadId, remapPosition);
          const copiedHead = sourceEvents.at(-1);
          const copiedEventIds = new Set(
            sourceEvents.flatMap((entry) => (entry.event_id ? [entry.event_id] : [])),
          );
          forkState = {
            ...forkState,
            revision: copiedHead?.revision ?? 0,
            ...(copiedHead?.event_id
              ? { lastAppliedEventId: copiedHead.event_id }
              : { lastAppliedEventId: undefined }),
            appliedEventIds: Array.isArray(forkState.appliedEventIds)
              ? forkState.appliedEventIds.filter(
                  (eventId): eventId is string =>
                    typeof eventId === 'string' && copiedEventIds.has(eventId),
                )
              : [],
          };
          forkState = rebaseBranchStateV24(
            forkState,
            'fork_rebound_v24',
            `${sourceThreadId}:${targetThreadId}:${targetGeneration}:${position}`,
          );
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
          const state = forkState as {
            revision?: number;
            schemaVersion?: number;
          };
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
              const namedState = rebaseBranchStateV24(
                rebindForkState(
                  JSON.parse(namedSnapshot.state_json) as Record<string, unknown>,
                  targetThreadId,
                  remapPosition,
                ),
                'fork_rebound_v24',
                `${sourceThreadId}:${targetThreadId}:${targetGeneration}:${namedSnapshot.name}`,
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
      } catch {
        return false;
      }
      return true;
    },

    forkCurrentSession(sourceThreadId: string, targetThreadId: string): boolean {
      // Keep the source's canonical pending interaction intact. The reserved
      // selector is private to this implementation and reuses the same
      // atomic event/snapshot copy path as named rewind forks.
      return store.forkSession(sourceThreadId, '__runtime_current__', targetThreadId);
    },

    restoreNamedSnapshotV1(
      threadId: string,
      snapshotId: string,
      candidate?: BranchMutationOpaqueCandidateV1,
    ): BranchMutationCommitResultV1 {
      store.restoreNamedSnapshot(threadId, snapshotId, candidate);
      return lastBranchMutationResultV1;
    },

    forkSessionV1(
      sourceThreadId: string,
      snapshotId: string,
      targetThreadId: string,
      candidate?: BranchMutationOpaqueCandidateV1,
    ): BranchMutationCommitResultV1 {
      store.forkSession(sourceThreadId, snapshotId, targetThreadId, candidate);
      return lastBranchMutationResultV1;
    },

    loadBranchMutationAuthorityV1(
      targetThreadId: string,
      targetGeneration: number,
      receiptId: string,
    ): BranchMutationAuthorityV1 | null {
      if (isClosed) return null;
      return loadBranchAuthority(targetThreadId, targetGeneration, receiptId);
    },

    resolveBranchMutationCompletionV1(input): BranchMutationCompletionResolutionV1 {
      if (isClosed) return { status: 'resolution_unavailable' };
      try {
        return db.transaction(() => {
          const fence = selectThreadFence.get(input.targetThreadId);
          if (
            !fence ||
            fence.generation !== input.targetGeneration ||
            fence.format !== 'v24_strict' ||
            fence.lifecycle !== 'active'
          ) {
            return { status: 'unknown_or_superseded' } as const;
          }
          const authority = loadBranchAuthority(
            input.targetThreadId,
            input.targetGeneration,
            input.receiptId,
          );
          if (!authority) return { status: 'definitely_not_committed' } as const;
          const completion = authority.completion;
          if (
            completion.requestDigest !== input.requestDigest ||
            completion.candidateDigest !== input.candidateDigest ||
            completion.manifestDigest !== input.manifestDigest ||
            completion.postSnapshotDigest !== input.postSnapshotDigest
          ) {
            return { status: 'collision_or_corruption' } as const;
          }
          return { status: 'already_committed', authority } as const;
        })();
      } catch {
        return { status: 'collision_or_corruption' };
      }
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
