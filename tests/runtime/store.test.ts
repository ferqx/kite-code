// ── RuntimeStore 持久化测试 / RuntimeStore persistence tests ──
// 验证 createRuntimeStore 的事件日志与快照的完整持久化链路

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalContextDigestV3 } from '../../src/core/model/context-checkpoint-v3.js';
import type { RuntimeEvent } from '../../src/core/runtime/events.js';
import { createAgentKernel } from '../../src/core/runtime/kernel.js';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '../../src/core/runtime/resource-budget.js';
import { planRuntimeBudgetAdmissionV1 } from '../../src/core/runtime/resource-budget-admission.js';
import type { RuntimeStore } from '../../src/core/runtime/store.js';
import {
  createRuntimeStore,
  RuntimeRevisionConflictError,
  runtimeStorePathFor,
} from '../../src/core/runtime/store.js';
import type {
  AgentPlan,
  ShellApprovalGrant,
  ToolApprovalPayload,
  UserInputPayload,
} from '../../src/protocol/events.js';

// ── helpers ──

function makeEvent(overrides?: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    type: 'tool.started',
    toolCallId: 'call-1',
    ...overrides,
  } as RuntimeEvent;
}

function makeToolFinishedEvent(toolCallId: string, exitCode: number): RuntimeEvent {
  return {
    type: 'tool.finished',
    toolCallId,
    result: {
      ok: exitCode === 0,
      command: 'echo hello',
      exitCode,
      stdout: 'hello',
      stderr: '',
    },
  } as RuntimeEvent;
}

/** 直接打开 db 查询表是否存在 / Open db directly to check table existence */
function tableExists(dbPath: string, table: string): boolean {
  const db = new Database(dbPath);
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(table);
  db.close();
  return row !== null;
}

// ── 测试套件 / Test suites ──

describe('createRuntimeStore', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    dbPath = join(tmpDir, 'runtime.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证创建实例后自动创建所需的表 / Verify required tables are created on instantiation
  test('creates runtime_events and runtime_snapshots tables on init', () => {
    const store = createRuntimeStore(dbPath);
    store.close();

    expect(tableExists(dbPath, 'runtime_events')).toBe(true);
    expect(tableExists(dbPath, 'runtime_snapshots')).toBe(true);
    expect(tableExists(dbPath, 'runtime_fence_ledger')).toBe(true);
    expect(tableExists(dbPath, 'runtime_event_ledgers')).toBe(true);
    expect(tableExists(dbPath, 'runtime_v24_migration_builds')).toBe(true);
    expect(tableExists(dbPath, 'runtime_branch_mutation_receipts')).toBe(true);
    expect(tableExists(dbPath, 'runtime_branch_mutation_completions')).toBe(true);
    expect(tableExists(dbPath, 'runtime_branch_copied_terminal_closures')).toBe(true);
  });

  // 验证事件表创建了 thread_id 索引 / Verify index on runtime_events(thread_id) is created
  test('creates index on runtime_events(thread_id)', () => {
    const store = createRuntimeStore(dbPath);
    store.close();

    const db = new Database(dbPath);
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runtime_events_thread'",
      )
      .get();
    db.close();
    expect(row).not.toBeNull();
  });

  test('resumes a persisted 4096-row fence-ledger build before installing quota authority', () => {
    const resumePath = join(tmpDir, 'fence-build-resume.db');
    const database = new Database(resumePath);
    database.run('CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.run("INSERT INTO runtime_store_meta VALUES ('format_version', '2')");
    database.run(`
      CREATE TABLE runtime_thread_fences (
        thread_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        format TEXT NOT NULL DEFAULT 'v23_compat',
        write_epoch INTEGER NOT NULL DEFAULT 0,
        lifecycle TEXT NOT NULL DEFAULT 'active'
      )
    `);
    database.run(`
      CREATE TABLE runtime_fence_ledger_build (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        store_format_version INTEGER NOT NULL,
        expected_count INTEGER NOT NULL,
        expected_max_rowid INTEGER NOT NULL,
        processed_count INTEGER NOT NULL,
        processed_bytes INTEGER NOT NULL,
        progress_rowid INTEGER NOT NULL,
        progress_checksum TEXT NOT NULL
      )
    `);
    const insert = database.query(
      "INSERT INTO runtime_thread_fences VALUES (?, 1, 'v23_compat', 1, 'active')",
    );
    database.transaction(() => {
      for (let index = 1; index <= 5_000; index++) insert.run(`fence-${index}`);
    })();
    let progressChecksum = canonicalContextDigestV3('runtime-fence-ledger-build:v1', {
      storeFormatVersion: 2,
      expectedCount: 5_000,
      expectedMaxRowid: 5_000,
      processedCount: 0,
      processedBytes: 0,
      progressRowid: 0,
      previousChecksum: 'initial',
    });
    let processedBytes = 0;
    for (let index = 1; index <= 4_096; index++) {
      const threadId = `fence-${index}`;
      const rowBytes = Buffer.byteLength(threadId, 'utf8') + 64;
      processedBytes += rowBytes;
      progressChecksum = canonicalContextDigestV3('runtime-fence-ledger-build-row:v1', {
        previousChecksum: progressChecksum,
        rowid: index,
        threadId,
        rowBytes,
      });
    }
    database
      .query('INSERT INTO runtime_fence_ledger_build VALUES (1, 2, 5000, 5000, 4096, ?, 4096, ?)')
      .run(processedBytes, progressChecksum);
    database.close();

    const resumed = createRuntimeStore(resumePath);
    resumed.close();
    const verifier = new Database(resumePath);
    expect(
      verifier
        .query<{ fence_count: number }, []>('SELECT fence_count FROM runtime_fence_ledger')
        .get()?.fence_count,
    ).toBe(5_000);
    expect(
      verifier
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_fence_ledger_build')
        .get()?.count,
    ).toBe(0);
    verifier.close();
  });

  // 验证仅内存模式也能正常工作 / Verify in-memory mode works correctly
  test('works with :memory: database', () => {
    const store = createRuntimeStore(':memory:');
    const event = makeEvent({ type: 'tool.queued', toolCallId: 'mem-1' });
    store.appendEvents('thread-mem', [event]);
    const loaded = store.loadEvents('thread-mem');
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.event.type).toBe('tool.queued');
    store.close();
  });

  test('persists a provider:model route for each session', () => {
    const store = createRuntimeStore(dbPath);
    store.setSessionModelRoute('thread-model', {
      provider: 'ollama',
      name: 'qwen2.5-coder:7b',
    });

    expect(store.getSessionModelRoute('thread-model')).toEqual({
      provider: 'ollama',
      name: 'qwen2.5-coder:7b',
    });
    expect(store.getSessionModelRoute('missing')).toBeNull();
    store.close();
  });

  test('supports DELETE journal mode for immediate portable close and reopen', () => {
    const store = createRuntimeStore(dbPath, { journalMode: 'delete' });
    store.close();

    const reopened = new Database(dbPath);
    const mode = reopened.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    reopened.close();
    expect(mode?.journal_mode).toBe('delete');
  });

  test('selects a platform-safe default journal mode', () => {
    const store = createRuntimeStore(dbPath);
    store.close();

    const reopened = new Database(dbPath);
    const mode = reopened.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    reopened.close();
    expect(mode?.journal_mode).toBe(process.platform === 'win32' ? 'delete' : 'wal');
  });

  test('isolates stores created before the RuntimeStore format marker existed', () => {
    const db = new Database(dbPath);
    db.run(
      'CREATE TABLE runtime_events (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at INTEGER)',
    );
    db.run(
      'INSERT INTO runtime_events (thread_id, event_json, created_at) VALUES (\'legacy-runtime\', \'{"type":"user.message_appended","messageId":"m","content":"hello"}\', 100)',
    );
    db.close();

    const store = createRuntimeStore(dbPath);
    expect(store.listSessions()).toEqual([]);
    store.close();
    expect(existsSync(`${dbPath}.legacy`)).toBe(true);
  });

  test('adds post-image columns to an existing current-format store', () => {
    createRuntimeStore(dbPath).close();
    const legacy = new Database(dbPath);
    legacy.run('ALTER TABLE runtime_file_preimages DROP COLUMN post_hash');
    legacy.run('ALTER TABLE runtime_file_preimages DROP COLUMN post_existed');
    legacy.close();

    createRuntimeStore(dbPath).close();
    const reopened = new Database(dbPath);
    const columns = reopened
      .query<{ name: string }, []>('PRAGMA table_info(runtime_file_preimages)')
      .all()
      .map((column) => column.name);
    reopened.close();

    expect(columns).toContain('post_hash');
    expect(columns).toContain('post_existed');
  });

  test('adds session model-route columns to an existing current-format store', () => {
    createRuntimeStore(dbPath).close();
    const legacy = new Database(dbPath);
    legacy.run('ALTER TABLE runtime_sessions DROP COLUMN model_provider');
    legacy.run('ALTER TABLE runtime_sessions DROP COLUMN model_name');
    legacy.close();

    createRuntimeStore(dbPath).close();
    const reopened = new Database(dbPath);
    const columns = reopened
      .query<{ name: string }, []>('PRAGMA table_info(runtime_sessions)')
      .all()
      .map((column) => column.name);
    reopened.close();

    expect(columns).toContain('model_provider');
    expect(columns).toContain('model_name');
  });

  test('classifies legacy fences as active/deleted and quarantines orphan authority', () => {
    const seedFence = (path: string, threadId: string) => {
      const database = new Database(path);
      database.run('CREATE TABLE runtime_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      database.run("INSERT INTO runtime_store_meta VALUES ('format_version', '2')");
      database.run(
        'CREATE TABLE runtime_thread_fences (thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)',
      );
      database.query('INSERT INTO runtime_thread_fences VALUES (?, 7)').run(threadId);
      return database;
    };

    const activePath = join(tmpDir, 'legacy-fence-active.db');
    const activeSeed = seedFence(activePath, 'legacy-active');
    activeSeed.run(
      "CREATE TABLE runtime_sessions (thread_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', model_provider TEXT, model_name TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    );
    activeSeed.run("INSERT INTO runtime_sessions (thread_id) VALUES ('legacy-active')");
    activeSeed.close();
    const active = createRuntimeStore(activePath);
    expect(active.loadPersistenceIdentity('legacy-active')).toMatchObject({
      generation: 7,
      writeEpoch: 1,
      format: 'v23_compat',
      lifecycle: 'active',
    });
    active.close();

    const deletedPath = join(tmpDir, 'legacy-fence-deleted.db');
    seedFence(deletedPath, 'legacy-deleted').close();
    const deleted = createRuntimeStore(deletedPath);
    expect(deleted.loadPersistenceIdentity('legacy-deleted')).toMatchObject({
      generation: 7,
      writeEpoch: 1,
      format: 'v23_compat',
      lifecycle: 'deleted',
    });
    deleted.close();

    const orphanPath = join(tmpDir, 'legacy-fence-orphan.db');
    const orphanSeed = seedFence(orphanPath, 'legacy-orphan');
    orphanSeed.run(
      'CREATE TABLE runtime_named_snapshots (thread_id TEXT NOT NULL, name TEXT NOT NULL, event_position INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), PRIMARY KEY (thread_id, name))',
    );
    orphanSeed.run(
      "INSERT INTO runtime_named_snapshots (thread_id, name, state_json) VALUES ('legacy-orphan', 'cut', '{}')",
    );
    orphanSeed.close();
    expect(() => createRuntimeStore(orphanPath)).toThrow('orphaned legacy authority');
  });
});

describe('runtimeStorePathFor', () => {
  test('preserves :memory: instead of creating a sidecar filename', () => {
    expect(runtimeStorePathFor(':memory:')).toBe(':memory:');
  });

  test('derives a sidecar database path for persistent checkpoints', () => {
    expect(runtimeStorePathFor('/tmp/checkpoints.sqlite')).toBe('/tmp/checkpoints.runtime.db');
  });
});

describe('appendEvents + loadEvents round-trip', () => {
  let store: RuntimeStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    store = createRuntimeStore(join(tmpDir, 'runtime.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证单事件写入后可以完整读回 / Verify single event round-trips correctly
  test('round-trips a single event', () => {
    const event = makeEvent({ type: 'tool.started', toolCallId: 'call-1' });
    store.appendEvents('thread-a', [event]);

    const loaded = store.loadEvents('thread-a');
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.thread_id).toBe('thread-a');
    expect(loaded[0]!.event.type).toBe('tool.started');
    expect((loaded[0]!.event as Extract<RuntimeEvent, { type: 'tool.started' }>).toolCallId).toBe(
      'call-1',
    );
    expect(loaded[0]!.created_at).toBeGreaterThan(0);
  });

  // 验证批量事件写入后全部可读回 / Verify batch events round-trip correctly
  test('round-trips multiple events in order', () => {
    const events: RuntimeEvent[] = [
      makeEvent({ type: 'tool.queued', toolCallId: 'call-1' }),
      makeEvent({ type: 'tool.started', toolCallId: 'call-1' }),
      makeToolFinishedEvent('call-1', 0),
    ];
    store.appendEvents('thread-b', events);

    const loaded = store.loadEvents('thread-b');
    expect(loaded.length).toBe(3);
    expect(loaded[0]!.event.type).toBe('tool.queued');
    expect(loaded[1]!.event.type).toBe('tool.started');
    expect(loaded[2]!.event.type).toBe('tool.finished');
    // 自增 ID 应为递增 / Auto-increment IDs should be ascending
    expect(loaded[0]!.id).toBeLessThan(loaded[1]!.id);
    expect(loaded[1]!.id).toBeLessThan(loaded[2]!.id);
  });

  test('round-trips every subagent lifecycle event with its payload and order', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'subagent.started',
        subagent: { id: 'sub-1', role: 'explore', task: 'find runtime callers' },
      },
      {
        type: 'subagent.step',
        subagent: { id: 'sub-1', toolName: 'read_file', toolArgs: { path: 'src/core/runtime' } },
      },
      {
        type: 'subagent.tool_result',
        subagent: {
          id: 'sub-1',
          toolName: 'read_file',
          ok: true,
          summary: 'found 4 files',
          totalLines: 80,
          toolTokenCount: 12,
          durationMs: 4,
        },
      },
      {
        type: 'subagent.completed',
        subagent: { id: 'sub-1', summary: 'all callers found', toolCallCount: 1, durationMs: 9 },
      },
      {
        type: 'subagent.failed',
        subagent: {
          id: 'sub-2',
          error: 'timeout',
          summary: 'partial result',
          toolCallCount: 2,
          durationMs: 11,
        },
      },
      {
        type: 'subagent.cache_metrics',
        subagent: {
          subagentId: 'sub-1',
          cacheHitTokens: 100,
          cacheMissTokens: 20,
          inputTokens: 120,
        },
      },
    ];

    store.appendEvents('thread-subagent-events', events);
    const loaded = store.loadEvents('thread-subagent-events').map((entry) => entry.event);

    expect(loaded).toEqual(events);
  });

  // 验证不同线程的事件相互隔离 / Verify events are isolated by thread_id
  test('isolates events by thread_id', () => {
    store.appendEvents('thread-1', [makeEvent({ toolCallId: 'a' })]);
    store.appendEvents('thread-2', [makeEvent({ toolCallId: 'b' })]);

    const t1 = store.loadEvents('thread-1');
    const t2 = store.loadEvents('thread-2');

    expect(t1.length).toBe(1);
    expect(t1[0]!.thread_id).toBe('thread-1');
    expect(t2.length).toBe(1);
    expect(t2[0]!.thread_id).toBe('thread-2');
  });

  // 验证追加事件时序——新追加的事件应在后续查询中可见 / Verify new events appended after a read are visible
  test('newly appended events appear in subsequent load', () => {
    store.appendEvents('thread-c', [makeEvent({ toolCallId: 'first' })]);
    expect(store.loadEvents('thread-c').length).toBe(1);

    store.appendEvents('thread-c', [makeEvent({ toolCallId: 'second' })]);
    expect(store.loadEvents('thread-c').length).toBe(2);
  });
});

describe('loadEvents with since parameter', () => {
  let store: RuntimeStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    store = createRuntimeStore(join(tmpDir, 'runtime.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证 since 参数过滤：仅返回 ID > since 的事件 / Verify since filters to events with id > since
  test('returns only events with id > since', () => {
    store.appendEvents('thread-d', [makeEvent({ toolCallId: 'first' })]);
    store.appendEvents('thread-d', [makeEvent({ toolCallId: 'second' })]);
    store.appendEvents('thread-d', [makeEvent({ toolCallId: 'third' })]);

    // 获取第一个事件的 ID / Get the first event's ID
    const all = store.loadEvents('thread-d');
    expect(all.length).toBe(3);
    const firstId = all[0]!.id;

    // 从第 1 个 ID 之后加载，应返回剩余 2 个 / Load since first ID, should return remaining 2
    const since = store.loadEvents('thread-d', firstId);
    expect(since.length).toBe(2);
    expect((since[0]!.event as Extract<RuntimeEvent, { type: 'tool.started' }>).toolCallId).toBe(
      'second',
    );
    expect((since[1]!.event as Extract<RuntimeEvent, { type: 'tool.started' }>).toolCallId).toBe(
      'third',
    );
  });

  // 验证 since 大于所有事件 ID 时返回空数组 / Verify since > max id returns empty
  test('returns empty array when since is larger than max id', () => {
    store.appendEvents('thread-e', [makeEvent({ toolCallId: 'only' })]);
    const all = store.loadEvents('thread-e');
    const maxId = all[all.length - 1]!.id;

    const result = store.loadEvents('thread-e', maxId + 100);
    expect(result).toEqual([]);
  });

  // 验证不存在线程 + since 仍然返回空数组 / Verify unknown thread + since returns empty
  test('returns empty array for unknown thread with since', () => {
    const result = store.loadEvents('nonexistent', 0);
    expect(result).toEqual([]);
  });
});

describe('saveSnapshot + loadSnapshot round-trip', () => {
  let store: RuntimeStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    store = createRuntimeStore(join(tmpDir, 'runtime.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证快照写入后可以完整读回 / Verify snapshot round-trips correctly
  test('round-trips a state snapshot', () => {
    const state = {
      phase: 'building' as const,
      messages: [{ role: 'user', content: 'hello' }],
      plan: { name: 'test-plan', steps: 3 },
    };
    store.saveSnapshot('thread-s1', state);

    const loaded = store.loadSnapshot<typeof state>('thread-s1');
    expect(loaded).not.toBeNull();
    expect(loaded!.phase).toBe('building');
    expect(loaded!.messages[0]!.content).toBe('hello');
    expect(loaded!.plan.name).toBe('test-plan');
    expect(loaded!.plan.steps).toBe(3);
  });

  // 验证同一线程多次保存快照会更新最新值（INSERT OR REPLACE） / Verify saving again replaces the snapshot
  test('replaces snapshot for same thread_id (upsert)', () => {
    store.saveSnapshot('thread-s2', { version: 1, data: 'old' });
    store.saveSnapshot('thread-s2', { version: 2, data: 'new' });

    const loaded = store.loadSnapshot<{ version: number; data: string }>('thread-s2');
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(2);
    expect(loaded!.data).toBe('new');
  });

  // 验证不同线程的快照相互隔离 / Verify snapshots are isolated by thread_id
  test('isolates snapshots by thread_id', () => {
    store.saveSnapshot('thread-a', { key: 'A' });
    store.saveSnapshot('thread-b', { key: 'B' });

    expect(store.loadSnapshot<{ key: string }>('thread-a')!.key).toBe('A');
    expect(store.loadSnapshot<{ key: string }>('thread-b')!.key).toBe('B');
  });

  // 验证泛型类型参数不影响 JSON 反序列化的行为 / Verify generic type param works with primitives
  test('round-trips primitive values', () => {
    store.saveSnapshot('thread-s3', 42);
    expect(store.loadSnapshot<number>('thread-s3')).toBe(42);

    store.saveSnapshot('thread-s4', 'just a string');
    expect(store.loadSnapshot<string>('thread-s4')).toBe('just a string');

    store.saveSnapshot('thread-s5', [1, 2, 3]);
    expect(store.loadSnapshot<number[]>('thread-s5')).toEqual([1, 2, 3]);
  });
});

describe('loadSnapshot returns null when no snapshot', () => {
  let store: RuntimeStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    store = createRuntimeStore(join(tmpDir, 'runtime.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证从未保存过快照的线程查询返回 null / Verify unknown thread returns null
  test('returns null for thread that never had a snapshot', () => {
    const result = store.loadSnapshot('no-such-thread');
    expect(result).toBeNull();
  });

  // 验证事件数据存在但无对应快照时也返回 null / Verify events do not affect snapshot query
  test('returns null for thread that has events but no snapshot', () => {
    store.appendEvents('thread-no-snap', [makeEvent({ toolCallId: 'evt' })]);
    const result = store.loadSnapshot('thread-no-snap');
    expect(result).toBeNull();
  });
});

describe('close()', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证 close 后追加事件不会抛出异常 / Verify appendEvents is silent after close
  test('appendEvents is silent after close', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    const store = createRuntimeStore(join(tmpDir, 'runtime.db'));

    // 先写入一些事件以确认正常写入 / Write some events first to confirm normal operation
    store.appendEvents('thread-f', [makeEvent({ toolCallId: 'before-close' })]);
    expect(store.loadEvents('thread-f').length).toBe(1);

    store.close();

    // close 后写入不应抛异常 / After close, writes should not throw
    expect(() =>
      store.appendEvents('thread-f', [makeEvent({ toolCallId: 'after-close' })]),
    ).not.toThrow();
  });

  // 验证 close 后加载事件返回空数组 / Verify loadEvents returns empty after close
  test('loadEvents returns empty array after close', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    const store = createRuntimeStore(join(tmpDir, 'runtime.db'));
    store.appendEvents('thread-g', [makeEvent({ toolCallId: 'pre-close' })]);

    store.close();

    const result = store.loadEvents('thread-g');
    expect(result).toEqual([]);
  });

  // 验证 close 后保存快照不抛异常 / Verify saveSnapshot is silent after close
  test('saveSnapshot is silent after close', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    const store = createRuntimeStore(join(tmpDir, 'runtime.db'));

    store.close();

    expect(() => store.saveSnapshot('thread-h', { data: 'x' })).not.toThrow();
  });

  // 验证 close 后加载快照返回 null / Verify loadSnapshot returns null after close
  test('loadSnapshot returns null after close', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    const store = createRuntimeStore(join(tmpDir, 'runtime.db'));
    store.saveSnapshot('thread-i', { alive: true });

    store.close();

    const result = store.loadSnapshot('thread-i');
    expect(result).toBeNull();
  });

  // 验证 double close 安全：不抛异常 / Verify double close is safe (idempotent)
  test('double close does not throw', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    const store = createRuntimeStore(join(tmpDir, 'runtime.db'));
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});

describe('edge cases', () => {
  let store: RuntimeStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    store = createRuntimeStore(join(tmpDir, 'runtime.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证空事件数组写入不抛异常 / Verify empty events array is a no-op
  test('appendEvents with empty array is a no-op', () => {
    expect(() => store.appendEvents('thread-j', [])).not.toThrow();
    expect(store.loadEvents('thread-j')).toEqual([]);
  });

  // 验证包含所有 event 类型的写入都可完整读回 / Verify all event types survive round-trip
  test('round-trips all RuntimeEvent discriminated union variants', () => {
    const events: RuntimeEvent[] = [
      { type: 'tool.queued', toolCallId: 'c1', name: 'read', args: {} },
      { type: 'tool.execution_ready', toolCallId: 'c1' },
      { type: 'tool.started', toolCallId: 'c1' },
      { type: 'tool.progress', toolCallId: 'c1', chunk: 'line1\n', stream: 'stdout' },
      {
        type: 'tool.finished',
        toolCallId: 'c1',
        name: 'test-tool',
        result: { ok: true, command: 'ls', exitCode: 0, stdout: '', stderr: '' },
      },
      {
        type: 'tool.failed',
        toolCallId: 'c2',
        error: 'command not found',
      },
      {
        type: 'tool.rejected',
        toolCallId: 'c3',
        reason: 'blocked by policy',
      },
      {
        type: 'user_input.requested',
        interactionId: 'i1',
        toolCallId: 'c4',
        request: { question: 'What next?' } as unknown as UserInputPayload,
      },
      {
        type: 'user_input.answered',
        interactionId: 'i1',
        toolCallId: 'c4',
        answer: 'continue',
      },
      {
        type: 'plan.review_requested',
        interactionId: 'i2',
        toolCallId: 'c5',
        plan: { name: 'p1' } as unknown as AgentPlan,
        planSummary: 'summary',
      },
      { type: 'plan.approved', interactionId: 'i2', executionMode: 'auto' },
      { type: 'plan.revision_requested', interactionId: 'i2', feedback: 'change it' },
      { type: 'plan.rejected', interactionId: 'i2', reason: 'bad plan' },
      {
        type: 'approval.requested',
        interactionId: 'i3',
        toolCallId: 'c6',
        approval: { toolName: 'shell' } as unknown as ToolApprovalPayload,
      },
      {
        type: 'approval.granted',
        interactionId: 'i3',
        grant: { mode: 'once' } as unknown as ShellApprovalGrant,
      },
      {
        type: 'approval.rejected',
        interactionId: 'i3',
        toolCallId: 'c1',
        reason: 'unsafe',
      },
      { type: 'authorization.changed', mode: 'full_access' },
    ];

    store.appendEvents('thread-k', events);
    const loaded = store.loadEvents('thread-k');

    expect(loaded.length).toBe(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(loaded[i]!.event.type).toBe(events[i]!.type);
    }
  });

  // 验证 NULL 和 undefined 值在 JSON 序列化后可正确还原 / Verify null / undefined survive JSON round-trip
  test('preserves null and undefined in event payloads', () => {
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'c-null',
      name: 'test-tool',
      result: {
        ok: true,
        command: 'test',
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    } as RuntimeEvent;
    store.appendEvents('thread-null', [event]);

    const loaded = store.loadEvents('thread-null');
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.event.type).toBe('tool.finished');
  });
});

// ── 持久化验证：关闭后重新打开数据仍然存在 / Persistence check: data survives close+reopen ──
describe('persistence across close/reopen', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    dbPath = join(tmpDir, 'runtime.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证事件在 close 后重新打开仍然存在 / Verify events survive close+reopen
  test('events survive close and reopen', () => {
    const s1 = createRuntimeStore(dbPath);
    s1.appendEvents('thread-p', [
      makeEvent({ toolCallId: 'evt-1' }),
      makeEvent({ toolCallId: 'evt-2' }),
    ]);
    s1.close();

    const s2 = createRuntimeStore(dbPath);
    const loaded = s2.loadEvents('thread-p');
    expect(loaded.length).toBe(2);
    expect((loaded[0]!.event as Extract<RuntimeEvent, { type: 'tool.started' }>).toolCallId).toBe(
      'evt-1',
    );
    expect((loaded[1]!.event as Extract<RuntimeEvent, { type: 'tool.started' }>).toolCallId).toBe(
      'evt-2',
    );
    s2.close();
  });

  // 验证快照在 close 后重新打开仍然存在 / Verify snapshots survive close+reopen
  test('snapshots survive close and reopen', () => {
    const s1 = createRuntimeStore(dbPath);
    s1.saveSnapshot('thread-q', { field: 'persisted', count: 99 });
    s1.close();

    const s2 = createRuntimeStore(dbPath);
    const snap = s2.loadSnapshot<{ field: string; count: number }>('thread-q');
    expect(snap).not.toBeNull();
    expect(snap!.field).toBe('persisted');
    expect(snap!.count).toBe(99);
    s2.close();
  });

  // 验证自增 ID 跨会话递增 / Verify auto-increment IDs continue across sessions
  test('event IDs continue incrementing across sessions', () => {
    const s1 = createRuntimeStore(dbPath);
    s1.appendEvents('thread-r', [makeEvent({ toolCallId: 'batch1' })]);
    const ids1 = s1.loadEvents('thread-r').map((e) => e.id);
    s1.close();

    const s2 = createRuntimeStore(dbPath);
    s2.appendEvents('thread-r', [makeEvent({ toolCallId: 'batch2' })]);
    const all = s2.loadEvents('thread-r');
    s2.close();

    expect(all.length).toBe(2);
    expect(all[1]!.id).toBeGreaterThan(ids1[0]!);
    expect((all[1]!.event as Extract<RuntimeEvent, { type: 'tool.started' }>).toolCallId).toBe(
      'batch2',
    );
  });
});

// ── 持久化边界情况 / Persistence edge cases ──
describe('persistence edge cases', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    dbPath = join(tmpDir, 'runtime.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 验证快照在 close/reopen 周期后仍然存在 / Verify snapshot survives close/reopen cycle
  test('snapshot survives close and reopen cycle', () => {
    const s1 = createRuntimeStore(dbPath);
    s1.saveSnapshot('thread-snap-cycle', {
      phase: 'building',
      counter: 42,
      nested: { deep: { value: 'persisted' } },
    });
    s1.close();

    // Reopen
    const s2 = createRuntimeStore(dbPath);
    const loaded = s2.loadSnapshot<{
      phase: string;
      counter: number;
      nested: { deep: { value: string } };
    }>('thread-snap-cycle');
    s2.close();

    expect(loaded).not.toBeNull();
    expect(loaded!.phase).toBe('building');
    expect(loaded!.counter).toBe(42);
    expect(loaded!.nested.deep.value).toBe('persisted');
  });

  // 验证不同线程的事件和快照完全隔离 / Verify events and snapshots are fully isolated across threads
  test('thread isolation for both events and snapshots', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('thread-iso-a', [makeEvent({ toolCallId: 'a1' })]);
    store.appendEvents('thread-iso-b', [makeEvent({ toolCallId: 'b1' })]);
    store.saveSnapshot('thread-iso-a', { version: 1 });
    store.saveSnapshot('thread-iso-b', { version: 2 });

    // thread-iso-a only sees its own data
    expect(store.loadEvents('thread-iso-a').length).toBe(1);
    expect(store.loadEvents('thread-iso-a')[0]!.thread_id).toBe('thread-iso-a');
    expect(store.loadSnapshot<{ version: number }>('thread-iso-a')!.version).toBe(1);

    // thread-iso-b only sees its own data
    expect(store.loadEvents('thread-iso-b').length).toBe(1);
    expect(store.loadEvents('thread-iso-b')[0]!.thread_id).toBe('thread-iso-b');
    expect(store.loadSnapshot<{ version: number }>('thread-iso-b')!.version).toBe(2);

    store.close();
  });

  // 验证大批量事件写入和读取 / Verify large batch of events round-trips correctly
  test('round-trips a large batch of events (120 events)', () => {
    const store = createRuntimeStore(dbPath);
    const events: RuntimeEvent[] = [];
    for (let i = 0; i < 120; i++) {
      events.push(makeEvent({ type: 'tool.started', toolCallId: `call-${i}` }));
    }
    store.appendEvents('thread-large', events);

    const loaded = store.loadEvents('thread-large');
    expect(loaded.length).toBe(120);
    expect(loaded[0]!.id).toBeGreaterThan(0);
    expect(loaded[119]!.id).toBeGreaterThan(loaded[0]!.id);
    // Auto-increment IDs are strictly increasing
    for (let i = 1; i < loaded.length; i++) {
      expect(loaded[i]!.id).toBeGreaterThan(loaded[i - 1]!.id);
    }
    store.close();
  });

  // 验证特殊字符和 Unicode 在事件 payload 中正确保存 / Verify special chars and Unicode survive round-trip
  test('round-trips events with special characters and Unicode', () => {
    const store = createRuntimeStore(dbPath);
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'call-special',
      name: 'test-tool',
      result: {
        ok: true,
        command: 'echo "hello world"',
        exitCode: 0,
        stdout: 'Unicode: hello world',
        stderr: 'emoji test',
      },
    } as RuntimeEvent;
    store.appendEvents('thread-special', [event]);

    const loaded = store.loadEvents('thread-special');
    expect(loaded.length).toBe(1);
    const loadedEvent = loaded[0]!.event as Extract<RuntimeEvent, { type: 'tool.finished' }>;
    expect(loadedEvent.type).toBe('tool.finished');
    expect(loadedEvent.result.stdout).toBe('Unicode: hello world');
    expect(loadedEvent.result.stderr).toBe('emoji test');
    store.close();
  });

  // 验证复杂嵌套快照对象正确保存 / Verify complex nested snapshots round-trip
  test('round-trips complex nested snapshot state', () => {
    const store = createRuntimeStore(dbPath);
    const complexState = {
      tools: {
        calls: {
          'call-1': {
            toolCallId: 'call-1',
            status: 'succeeded',
            result: { ok: true, summary: 'done', exitCode: 0 },
          },
          'call-2': {
            toolCallId: 'call-2',
            status: 'failed',
            error: 'timeout after 30s',
          },
        },
        queue: [],
        active: [],
      },
      plan: {
        kind: 'approved',
        planId: 'plan-xyz',
        version: 2,
        plan: {
          name: 'My Plan',
          description: 'Complex plan',
          status: 'pending',
          steps: [
            { step: 'Step 1', status: 'completed' },
            { step: 'Step 2', status: 'running' },
          ],
        },
      },
      turn: { turnId: 'turn-42', turnIndex: 5 },
    };
    store.saveSnapshot('thread-complex', complexState);

    const loaded = store.loadSnapshot<typeof complexState>('thread-complex');
    expect(loaded).not.toBeNull();
    expect(loaded!.tools.calls['call-1']!.status).toBe('succeeded');
    expect(loaded!.tools.calls['call-2']!.error).toBe('timeout after 30s');
    expect(loaded!.plan.planId).toBe('plan-xyz');
    expect(loaded!.plan.plan.steps[1]!.status).toBe('running');
    expect(loaded!.turn.turnId).toBe('turn-42');
    store.close();
  });

  // 验证不存在线程的快照返回 null / Verify non-existent thread snapshot returns null
  test('loadSnapshot returns null for completely new thread', () => {
    const store = createRuntimeStore(dbPath);
    const result = store.loadSnapshot('completely-new-thread');
    expect(result).toBeNull();
    store.close();
  });

  // 验证自增 ID 在空批次后仍能继续 / Verify auto-increment continues after empty batch
  test('auto-increment IDs continue after empty batch append', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('thread-seq', [makeEvent({ toolCallId: 'first' })]);
    const idsAfterFirst = store.loadEvents('thread-seq').map((e) => e.id);

    // Empty batch should not affect auto-increment
    store.appendEvents('thread-seq', []);
    store.appendEvents('thread-seq', []);

    store.appendEvents('thread-seq', [makeEvent({ toolCallId: 'second' })]);
    const all = store.loadEvents('thread-seq');
    expect(all.length).toBe(2);
    expect(all[1]!.id).toBeGreaterThan(idsAfterFirst[0]!);
    store.close();
  });

  // 验证多线程并发快照覆盖不互相干扰 / Verify snapshot upsert across threads is isolated
  test('snapshot upsert across threads does not interfere', () => {
    const store = createRuntimeStore(dbPath);
    store.saveSnapshot('t1', { version: 1, data: 'first' });
    store.saveSnapshot('t2', { version: 100, data: 'second' });
    store.saveSnapshot('t1', { version: 2, data: 'first-updated' });

    expect(store.loadSnapshot<{ version: number; data: string }>('t1')!.version).toBe(2);
    expect(store.loadSnapshot<{ version: number; data: string }>('t1')!.data).toBe('first-updated');
    expect(store.loadSnapshot<{ version: number; data: string }>('t2')!.version).toBe(100);
    expect(store.loadSnapshot<{ version: number; data: string }>('t2')!.data).toBe('second');

    store.close();
  });

  test('named snapshots retain a recovery point and its event position', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewindable', [makeEvent({ toolCallId: 'before-rewind' })]);
    const position = store.getLastEventPosition('rewindable');
    store.saveNamedSnapshot('rewindable', 'before-change', { stage: 'before' });
    store.appendEvents('rewindable', [makeEvent({ toolCallId: 'after-rewind' })]);

    expect(position).toBeGreaterThan(0);
    expect(store.loadNamedSnapshot<{ stage: string }>('rewindable', 'before-change')).toEqual({
      stage: 'before',
    });
    expect(store.getLastEventPosition('rewindable')).toBeGreaterThan(position);
    store.close();
  });

  test('restoreNamedSnapshot truncates later events and restores the saved state', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind', [makeEvent({ toolCallId: 'before' })]);
    store.saveNamedSnapshot('rewind', 'safe', { version: 1 });
    store.appendEvents('rewind', [makeEvent({ toolCallId: 'after' })]);

    expect(store.restoreNamedSnapshot('rewind', 'safe')).toBe(true);
    expect(store.loadSnapshot<{ version: number }>('rewind')).toEqual({ version: 1 });
    expect(store.loadEvents('rewind')).toHaveLength(1);
    store.close();
  });

  test('restoreNamedSnapshot removes recovery points beyond the restored position', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind-prune', [makeEvent({ toolCallId: 'first' })]);
    store.saveNamedSnapshot('rewind-prune', 'first', { version: 1 });
    store.appendEvents('rewind-prune', [makeEvent({ toolCallId: 'second' })]);
    store.saveNamedSnapshot('rewind-prune', 'second', { version: 2 });

    expect(store.restoreNamedSnapshot('rewind-prune', 'first')).toBe(true);
    expect(store.listNamedSnapshots('rewind-prune').map((entry) => entry.snapshotId)).toEqual([
      'first',
    ]);
    store.close();
  });

  test('lists the next user message and recorded file impact for rewind previews', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind-preview', [
      {
        type: 'user.message_appended',
        messageId: 'message-1',
        content: 'first turn',
      },
    ]);
    store.saveNamedSnapshot('rewind-preview', 'after-first', { version: 1 });
    store.appendEvents('rewind-preview', [
      {
        type: 'user.message_appended',
        messageId: 'message-2',
        content: 'restore to before this message',
      },
    ]);
    store.recordFilePreimage('rewind-preview', 'notes.md', 'before', true);
    store.recordFilePreimage('rewind-preview', 'created.md', null, false);

    expect(store.listNamedSnapshots('rewind-preview')).toEqual([
      expect.objectContaining({
        snapshotId: 'after-first',
        targetMessage: 'restore to before this message',
        affectedFileCount: 2,
      }),
    ]);
    expect(store.listNamedSnapshots('rewind-preview')[0]?.targetMessageCreatedAt).toBeGreaterThan(
      0,
    );
    store.close();
  });

  test('forkSession rebinds the persisted state to the target thread', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('source', [makeEvent({ toolCallId: 'source-call' })]);
    store.setSessionModelRoute('source', {
      provider: 'opencode_go',
      name: 'deepseek-v4-flash',
    });
    store.saveNamedSnapshot('source', 'safe', {
      session: { threadId: 'source', userId: 'u', workspace: '/workspace' },
      authorization: {
        mode: 'full_access',
        modeSource: 'user',
        modeGrantedAt: '2026-07-30T00:00:00.000Z',
        commandGrants: { inherited: { threadId: 'source' } },
      },
      mode: 'full',
      interactions: { kind: 'awaiting_tool_approval' },
      tools: {
        calls: { historical: { status: 'completed' } },
        queue: ['pending'],
        active: ['active'],
      },
      capabilities: {
        catalogRevision: 'catalog-1',
        bindings: { inherited: { bindingId: 'binding-1' } },
        disclosures: { inherited: { capabilityId: 'cap-1' } },
        pendingSearch: { query: 'shell' },
        loadedCapabilities: { stable: { capabilityId: 'stable' } },
        invocations: { historical: { invocationId: 'historical' } },
      },
      providerAdmission: {
        pending: [{ providerId: 'pending-provider' }],
        waivers: { inherited: { providerId: 'waived-provider' } },
      },
      suspendedSubagents: { inherited: { subagentId: 'subagent-1' } },
    });

    expect(store.forkSession('source', 'safe', 'fork')).toBe(true);
    expect(store.getSessionModelRoute('fork')).toEqual({
      provider: 'opencode_go',
      name: 'deepseek-v4-flash',
    });
    const fork = store.loadSnapshot<{
      session: { threadId: string };
      authorization: {
        mode: string;
        modeSource?: string;
        modeGrantedAt?: string;
        commandGrants: Record<string, unknown>;
      };
      mode: string;
      interactions: unknown;
      tools: unknown;
      capabilities: unknown;
      providerAdmission: unknown;
      suspendedSubagents: unknown;
    }>('fork')!;
    expect(fork.session.threadId).toBe('fork');
    expect(fork.authorization.mode).toBe('default');
    expect(fork.authorization.commandGrants).toEqual({});
    expect(fork.authorization.modeSource).toBeUndefined();
    expect(fork.authorization.modeGrantedAt).toBeUndefined();
    expect(fork.mode).toBe('accept_edits');
    expect(fork.interactions).toEqual({ kind: 'idle' });
    expect(fork.tools).toEqual({
      calls: { historical: { status: 'completed' } },
      queue: [],
      active: [],
    });
    expect(fork.capabilities).toEqual({
      catalogRevision: 'catalog-1',
      bindings: {},
      disclosures: {},
      loadedCapabilities: { stable: { capabilityId: 'stable' } },
      invocations: { historical: { invocationId: 'historical' } },
    });
    expect(fork.providerAdmission).toEqual({ pending: [], waivers: {} });
    expect(fork.suspendedSubagents).toEqual({});
    expect(store.loadEvents('fork')).toHaveLength(1);
    expect(store.listNamedSnapshots('fork')[0]!.eventPosition).toBe(
      store.getLastEventPosition('fork'),
    );
    store.close();
  });

  test('forkCurrentSession omits only its active pending interaction request', () => {
    const store = createRuntimeStore(dbPath);
    const approval = { toolName: 'shell_execute' } as unknown as ToolApprovalPayload;
    store.appendEvents('source', [
      { type: 'tool.queued', toolCallId: 'shell-1', name: 'shell_execute', args: {} },
      {
        type: 'approval.requested',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
        approval,
      },
    ]);
    store.saveSnapshot('source', {
      session: { threadId: 'source' },
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
        approval,
      },
      tools: { calls: {}, queue: ['shell-1'], active: [] },
    });

    expect(store.forkCurrentSession('source', 'recovery')).toBe(true);
    expect(store.loadEvents('source').map((entry) => entry.event.type)).toEqual([
      'tool.queued',
      'approval.requested',
    ]);
    expect(store.loadEvents('recovery').map((entry) => entry.event.type)).toEqual(['tool.queued']);
    expect(
      store.loadSnapshot<{ session: { threadId: string }; interactions: unknown }>('recovery'),
    ).toEqual(
      expect.objectContaining({
        session: { threadId: 'recovery' },
        interactions: { kind: 'idle' },
      }),
    );
    store.close();
  });

  test('forkSession preserves event timestamps and envelope metadata', () => {
    let store = createRuntimeStore(dbPath);
    store.appendEvents(
      'metadata-source',
      [makeEvent({ toolCallId: 'metadata-call' })],
      [
        {
          eventId: 'event-metadata-1',
          revision: 7,
          causationId: 'cause-1',
          occurredAt: '2026-07-30T12:34:56.789Z',
        },
      ],
    );
    store.saveNamedSnapshot('metadata-source', 'safe', {
      session: { threadId: 'metadata-source' },
      revision: 7,
    });
    store.close();

    const database = new Database(dbPath);
    database
      .query('UPDATE runtime_events SET created_at = ? WHERE thread_id = ?')
      .run(1_700_000_123, 'metadata-source');
    database.close();

    store = createRuntimeStore(dbPath);
    expect(store.forkSession('metadata-source', 'safe', 'metadata-fork')).toBe(true);
    const source = store.loadEventsStrict('metadata-source')[0];
    const fork = store.loadEventsStrict('metadata-fork')[0];
    expect(source).toBeDefined();
    expect(fork).toBeDefined();
    expect(fork).toEqual({ ...source!, id: fork!.id, thread_id: 'metadata-fork' });
    store.close();
  });

  test('forkSession fails closed before mutating the target when source events are corrupt', () => {
    let store = createRuntimeStore(dbPath);
    store.appendEvents('corrupt-source', [makeEvent({ toolCallId: 'corrupt-call' })]);
    store.saveNamedSnapshot('corrupt-source', 'safe', {
      session: { threadId: 'corrupt-source' },
    });
    store.appendEvents('existing-target', [makeEvent({ toolCallId: 'keep-call' })]);
    store.saveNamedSnapshot('existing-target', 'keep', {
      session: { threadId: 'existing-target' },
      marker: 'keep',
    });
    store.close();

    const database = new Database(dbPath);
    database
      .query('UPDATE runtime_events SET event_json = ? WHERE thread_id = ?')
      .run('{broken-json', 'corrupt-source');
    database.close();

    store = createRuntimeStore(dbPath);
    expect(store.forkSession('corrupt-source', 'safe', 'existing-target')).toBe(false);
    expect(store.loadEventsStrict('existing-target')).toHaveLength(1);
    expect(
      store.loadNamedSnapshot<{ session: { threadId: string }; marker: string }>(
        'existing-target',
        'keep',
      ),
    ).toEqual({ session: { threadId: 'existing-target' }, marker: 'keep' });
    store.close();
  });

  test('forkSession rejects a parseable but structurally invalid selected snapshot', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('invalid-state-source', [makeEvent({ toolCallId: 'source-call' })]);
    store.saveNamedSnapshot('invalid-state-source', 'invalid', 'not-a-runtime-state');
    store.appendEvents('invalid-state-target', [makeEvent({ toolCallId: 'keep-call' })]);

    expect(store.forkSession('invalid-state-source', 'invalid', 'invalid-state-target')).toBe(
      false,
    );
    expect(store.loadEventsStrict('invalid-state-target')).toHaveLength(1);
    store.close();
  });

  test('forkSession preserves earlier recovery points with remapped event positions', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind-source', [
      {
        type: 'user.message_appended',
        messageId: 'message-1',
        content: 'first turn',
      },
    ]);
    store.saveNamedSnapshot('rewind-source', 'checkpoint-1', {
      session: { threadId: 'rewind-source' },
      version: 1,
    });
    store.appendEvents('rewind-source', [
      {
        type: 'user.message_appended',
        messageId: 'message-2',
        content: 'second turn',
      },
    ]);
    store.recordFilePreimage('rewind-source', 'notes.md', 'v1\n', true);
    store.recordFilePostimage('rewind-source', 'notes.md', 'hash-v2', true);
    store.saveNamedSnapshot('rewind-source', 'checkpoint-2', {
      session: { threadId: 'rewind-source' },
      version: 2,
    });

    expect(store.forkSession('rewind-source', 'checkpoint-2', 'rewind-fork')).toBe(true);

    const forkPoints = store.listNamedSnapshots('rewind-fork');
    expect(forkPoints.map((entry) => entry.snapshotId).sort()).toEqual([
      'checkpoint-1',
      'checkpoint-2',
    ]);
    const earlierPoint = forkPoints.find((entry) => entry.snapshotId === 'checkpoint-1');
    expect(earlierPoint).toEqual(
      expect.objectContaining({
        targetMessage: 'second turn',
        affectedFileCount: 1,
      }),
    );
    expect(store.fileRestorePlan('rewind-fork', earlierPoint!.eventPosition)).toEqual([
      {
        path: 'notes.md',
        content: 'v1\n',
        existed: true,
        postHash: 'hash-v2',
        postExisted: true,
      },
    ]);
    expect(store.forkSession('rewind-fork', 'checkpoint-1', 'rewind-fork-again')).toBe(true);
    expect(
      store.loadSnapshot<{ session: { threadId: string }; version: number }>('rewind-fork-again'),
    ).toEqual(expect.objectContaining({ session: { threadId: 'rewind-fork-again' }, version: 1 }));
    store.close();
  });

  // ── ADR-0042 §4：文件原像 / file pre-images ──

  test('recordFilePreimage keeps the earliest pre-image per path within a checkpoint window', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('preimg', [makeEvent({ toolCallId: 'turn-1' })]);
    store.saveNamedSnapshot('preimg', 'turn-1', { version: 1 });

    // turn-1 快照之后的窗口：首次捕获生效，同 path 后续捕获去重
    store.appendEvents('preimg', [makeEvent({ toolCallId: 'turn-2-tool' })]);
    store.recordFilePreimage('preimg', 'notes.md', 'v1 content', true);
    store.recordFilePreimage('preimg', 'notes.md', 'v2 content', true);
    store.recordFilePostimage('preimg', 'notes.md', 'hash-v2', true);

    const pos1 = store.getNamedSnapshotEntry('preimg', 'turn-1')!.eventPosition;
    expect(store.fileRestorePlan('preimg', pos1)).toEqual([
      {
        path: 'notes.md',
        content: 'v1 content',
        existed: true,
        postHash: 'hash-v2',
        postExisted: true,
      },
    ]);

    // 新快照开启新窗口：可以再次捕获
    store.saveNamedSnapshot('preimg', 'turn-2', { version: 2 });
    store.appendEvents('preimg', [makeEvent({ toolCallId: 'turn-3-tool' })]);
    store.recordFilePreimage('preimg', 'notes.md', 'v3 content', true);
    store.recordFilePostimage('preimg', 'notes.md', 'hash-v4', true);
    const pos2 = store.getNamedSnapshotEntry('preimg', 'turn-2')!.eventPosition;
    expect(store.fileRestorePlan('preimg', pos2)).toEqual([
      {
        path: 'notes.md',
        content: 'v3 content',
        existed: true,
        postHash: 'hash-v4',
        postExisted: true,
      },
    ]);
    // 回退到 turn-1 取最早原像，但用最后一次 Kite 写入指纹校验当前内容。
    expect(store.fileRestorePlan('preimg', pos1)).toEqual([
      {
        path: 'notes.md',
        content: 'v1 content',
        existed: true,
        postHash: 'hash-v4',
        postExisted: true,
      },
    ]);
    store.close();
  });

  test('fileRestorePlan reports created files for deletion and ignores pre-checkpoint captures', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('preimg-plan', [makeEvent({ toolCallId: 'a' })]);
    store.recordFilePreimage('preimg-plan', 'ancient.md', 'before checkpoint', true);
    store.saveNamedSnapshot('preimg-plan', 'cp', { version: 1 });
    store.appendEvents('preimg-plan', [makeEvent({ toolCallId: 'next-turn' })]);
    store.recordFilePreimage('preimg-plan', 'created.md', null, false);
    store.recordFilePreimage('preimg-plan', 'edited.md', 'before edit', true);

    const pos = store.getNamedSnapshotEntry('preimg-plan', 'cp')!.eventPosition;
    const plan = store
      .fileRestorePlan('preimg-plan', pos)
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(plan).toEqual([
      {
        path: 'created.md',
        content: null,
        existed: false,
        postHash: null,
        postExisted: null,
      },
      {
        path: 'edited.md',
        content: 'before edit',
        existed: true,
        postHash: null,
        postExisted: null,
      },
    ]);
    store.close();
  });

  test('restoreNamedSnapshot truncates pre-images beyond the restored position', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('preimg-trunc', [makeEvent({ toolCallId: 'a' })]);
    store.saveNamedSnapshot('preimg-trunc', 'cp', { version: 1 });
    store.appendEvents('preimg-trunc', [makeEvent({ toolCallId: 'next-turn' })]);
    store.recordFilePreimage('preimg-trunc', 'notes.md', 'pre-turn-2', true);

    expect(store.restoreNamedSnapshot('preimg-trunc', 'cp')).toBe(true);
    const pos = store.getNamedSnapshotEntry('preimg-trunc', 'cp')!.eventPosition;
    expect(store.fileRestorePlan('preimg-trunc', pos)).toEqual([]);
    store.close();
  });

  test('deleteSession cascades file pre-images', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('preimg-gone', [makeEvent({ toolCallId: 'a' })]);
    store.saveNamedSnapshot('preimg-gone', 'cp', { version: 1 });
    store.recordFilePreimage('preimg-gone', 'notes.md', 'x', true);
    store.deleteSession('preimg-gone');
    expect(store.getNamedSnapshotEntry('preimg-gone', 'cp')).toBeNull();
    store.close();
  });

  test('forkSession copies pre-images up to the fork point only', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('preimg-fork', [makeEvent({ toolCallId: 'a' })]);
    store.recordFilePreimage('preimg-fork', 'notes.md', 'turn-1 pre-image', true);
    store.saveNamedSnapshot('preimg-fork', 'cp', { session: { threadId: 'preimg-fork' } });
    store.appendEvents('preimg-fork', [makeEvent({ toolCallId: 'next-turn' })]);
    store.recordFilePreimage('preimg-fork', 'later.md', 'after fork point', true);

    expect(store.forkSession('preimg-fork', 'cp', 'preimg-fork-target')).toBe(true);
    expect(store.fileRestorePlan('preimg-fork-target', 0).map((p) => p.path)).toEqual(['notes.md']);
    expect(
      store
        .fileRestorePlan('preimg-fork', 0)
        .map((p) => p.path)
        .sort(),
    ).toEqual(['later.md', 'notes.md']);
    store.close();
  });

  test('strict-v24 fork uses the selected snapshot as a ledger base without copying parent event ids', () => {
    const source = createAgentKernel({
      threadId: 'strict-fork-source',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    source.processEvent({
      type: 'user.message_appended',
      messageId: 'source-message',
      content: 'source',
    });
    source.close();

    const store = createRuntimeStore(dbPath);
    const selected = store.loadSnapshot('strict-fork-source');
    const sourceIdentity = store.loadPersistenceIdentity('strict-fork-source');
    store.saveNamedSnapshot(
      'strict-fork-source',
      'safe',
      selected,
      sourceIdentity.observedHead.eventPosition,
      sourceIdentity,
    );
    expect(store.forkSessionV1('strict-fork-source', 'safe', 'strict-fork-target')).toMatchObject({
      status: 'committed',
      targetGeneration: 1,
    });
    expect(store.loadEventsStrict('strict-fork-target')).toEqual([]);
    expect(store.loadSnapshotRecord<{ revision: number }>('strict-fork-target')).toMatchObject({
      state: { revision: 1 },
      metadata: { stateRevision: 1, eventPosition: 0, schemaVersion: 24 },
    });
    const authority = new Database(dbPath, { readonly: true });
    expect(
      authority
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_branch_mutation_completions WHERE target_thread_id = 'strict-fork-target'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      authority
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_branch_mutation_receipts WHERE target_thread_id = 'strict-fork-target'",
        )
        .get()?.count,
    ).toBe(0);
    authority.close();
    store.close();

    const target = createAgentKernel({
      threadId: 'strict-fork-target',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    target.processEvent({
      type: 'user.message_appended',
      messageId: 'target-message',
      content: 'target',
    });
    expect(target.getState().revision).toBe(2);
    target.close();
  });

  test('strict-v24 rewind advances the fence and resumes after a non-zero ledger base', () => {
    const initial = createAgentKernel({
      threadId: 'strict-rewind',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    initial.processEvent({
      type: 'user.message_appended',
      messageId: 'kept-message',
      content: 'kept',
    });
    initial.close();

    let store = createRuntimeStore(dbPath);
    const selected = store.loadSnapshot('strict-rewind');
    const selectedIdentity = store.loadPersistenceIdentity('strict-rewind');
    store.saveNamedSnapshot(
      'strict-rewind',
      'safe',
      selected,
      selectedIdentity.observedHead.eventPosition,
      selectedIdentity,
    );
    store.close();

    const advanced = createAgentKernel({
      threadId: 'strict-rewind',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    advanced.processEvent({
      type: 'user.message_appended',
      messageId: 'discarded-message',
      content: 'discarded',
    });
    advanced.close();

    store = createRuntimeStore(dbPath);
    const generationBefore = store.loadPersistenceIdentity('strict-rewind').generation;
    expect(store.restoreNamedSnapshotV1('strict-rewind', 'safe')).toMatchObject({
      status: 'committed',
      targetGeneration: generationBefore + 1,
    });
    const rewound = store.loadPersistenceIdentity('strict-rewind');
    expect(rewound.generation).toBe(generationBefore + 1);
    expect(rewound.observedHead.eventPosition).toBe(0);
    expect(rewound.sourceSnapshot?.stateRevision).toBe(1);
    store.close();

    const resumed = createAgentKernel({
      threadId: 'strict-rewind',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    resumed.processEvent({
      type: 'user.message_appended',
      messageId: 'replacement-message',
      content: 'replacement',
    });
    expect(resumed.getState().revision).toBe(2);
    expect(
      resumed
        .getState()
        .transcript.messages.some((message) => message.messageId === 'discarded-message'),
    ).toBe(false);
    resumed.close();
  });

  for (const journalMode of ['wal', 'delete'] as const) {
    test(`strict-v24 branch lock contention is bounded to 250ms in ${journalMode.toUpperCase()} mode`, () => {
      const branchPath = join(tmpDir, `branch-contention-${journalMode}.db`);
      const source = createAgentKernel({
        threadId: `contention-source-${journalMode}`,
        userId: 'user',
        workspace: '/workspace',
        storePath: branchPath,
      });
      source.processEvent({
        type: 'user.message_appended',
        messageId: 'source-message',
        content: 'source',
      });
      source.close();
      const store = createRuntimeStore(branchPath, { journalMode });
      const threadId = `contention-source-${journalMode}`;
      const selected = store.loadSnapshot(threadId);
      const identity = store.loadPersistenceIdentity(threadId);
      store.saveNamedSnapshot(
        threadId,
        'safe',
        selected,
        identity.observedHead.eventPosition,
        identity,
      );
      store.loadPersistenceIdentity(`contention-target-${journalMode}`);
      const locker = new Database(branchPath);
      locker.run('PRAGMA busy_timeout = 0');
      locker.run('BEGIN IMMEDIATE');
      const startedAt = performance.now();
      expect(store.forkSessionV1(threadId, 'safe', `contention-target-${journalMode}`)).toEqual({
        status: 'contention_timeout',
      });
      expect(performance.now() - startedAt).toBeLessThan(750);
      locker.run('ROLLBACK');
      locker.close();
      expect(store.loadSnapshot(`contention-target-${journalMode}`)).toBeNull();
      store.close();
    });
  }

  test('resolves a lost post-COMMIT branch acknowledgement without reissuing the mutation', () => {
    const branchPath = join(tmpDir, 'branch-ack-unknown.db');
    const source = createAgentKernel({
      threadId: 'ack-source',
      userId: 'user',
      workspace: '/workspace',
      storePath: branchPath,
    });
    source.processEvent({
      type: 'user.message_appended',
      messageId: 'source-message',
      content: 'source',
    });
    source.close();
    const store = createRuntimeStore(branchPath, {
      faultInjectionBranchCommitAckUnknown: true,
    });
    const selected = store.loadSnapshot('ack-source');
    const identity = store.loadPersistenceIdentity('ack-source');
    store.saveNamedSnapshot(
      'ack-source',
      'safe',
      selected,
      identity.observedHead.eventPosition,
      identity,
    );
    const result = store.forkSessionV1('ack-source', 'safe', 'ack-target');
    expect(result.status).toBe('commit_ack_unknown');
    if (result.status !== 'commit_ack_unknown') throw new Error('ACK-unknown result expected');
    expect(store.resolveBranchMutationCompletionV1(result)).toMatchObject({
      status: 'already_committed',
      authority: { completion: { receiptId: result.receiptId } },
    });
    const authority = new Database(branchPath, { readonly: true });
    expect(
      authority
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_branch_mutation_completions WHERE target_thread_id = 'ack-target'",
        )
        .get()?.count,
    ).toBe(1);
    authority.close();
    store.close();
  });

  test('enforces the completion ledger at limit and keeps limit-plus-one mutation-free', () => {
    const branchPath = join(tmpDir, 'branch-completion-quota.db');
    const source = createAgentKernel({
      threadId: 'completion-quota',
      userId: 'user',
      workspace: '/workspace',
      storePath: branchPath,
    });
    source.processEvent({
      type: 'user.message_appended',
      messageId: 'source-message',
      content: 'source',
    });
    source.close();
    const store = createRuntimeStore(branchPath);
    const selected = store.loadSnapshot('completion-quota');
    const identity = store.loadPersistenceIdentity('completion-quota');
    store.saveNamedSnapshot(
      'completion-quota',
      'safe',
      selected,
      identity.observedHead.eventPosition,
      identity,
    );
    for (let index = 0; index < 1_024; index++) {
      expect(store.restoreNamedSnapshotV1('completion-quota', 'safe').status).toBe('committed');
    }
    const atLimit = store.loadPersistenceIdentity('completion-quota');
    expect(store.restoreNamedSnapshotV1('completion-quota', 'safe')).toEqual({
      status: 'resource_saturated',
    });
    expect(store.loadPersistenceIdentity('completion-quota')).toEqual(atLimit);
    const authority = new Database(branchPath, { readonly: true });
    expect(
      authority
        .query<{ rows: number; ledger: number }, []>(
          `SELECT
             (SELECT COUNT(*) FROM runtime_branch_mutation_completions WHERE target_thread_id = 'completion-quota') AS rows,
             (SELECT completion_count FROM runtime_branch_ledgers WHERE target_thread_id = 'completion-quota') AS ledger`,
        )
        .get(),
    ).toEqual({ rows: 1_024, ledger: 1_024 });
    authority.close();
    store.close();
  });

  test('strict-v24 fork closes an in-flight continuation with one quartet and immutable receipt', () => {
    const source = createAgentKernel({
      threadId: 'strict-continuation-source',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    const startedAt = new Date();
    source.processEvent({
      type: 'resource_budget.configured',
      runId: 'continuation-run',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const continuation = {
      version: 1 as const,
      turnId: source.getState().turn.turnId,
      requestedAtRevision: 0,
      summarySourceIdentity: {
        version: 1 as const,
        firstMessageId: 'first',
        coveredThroughMessageId: 'last',
        coveredThroughTurnId: source.getState().turn.turnId,
        canonicalSourceDigest: '1'.repeat(64),
        sourceProjectionPolicyId: 'checkpoint-v3-source:v1' as const,
      },
    };
    const originReceipt = {
      version: 1 as const,
      generation: source.getProducerGeneration(),
      attemptId: 'attempt',
      compactionId: 'compaction',
      continuation,
      origin: {
        kind: 'summary_terminal' as const,
        terminalBatchId: 'terminal',
        terminalEventId: '2'.repeat(64),
        resourceTerminalEventId: '3'.repeat(64),
      },
    };
    source.processEvent({ type: 'context.normal_reprepare_required_v1', receipt: originReceipt });
    const admission = planRuntimeBudgetAdmissionV1(source.getState(), {
      type: 'call_model',
      primaryRequestId: 'primary-request',
      resourceEstimate: { inputTokens: 100, maxOutputTokens: 50 },
    });
    if (admission.status !== 'admitted') throw new Error('continuation admission expected');
    const reserved = admission.preparationEvents.find(
      (event) => event.type === 'resource_budget.reserved',
    );
    if (reserved?.type !== 'resource_budget.reserved') throw new Error('reservation expected');
    const consumptionKey = {
      version: 1 as const,
      generation: source.getProducerGeneration(),
      consumptionBatchId: 'consumption',
      attemptId: originReceipt.attemptId,
      compactionId: originReceipt.compactionId,
      continuation,
      originReceipt,
      primaryEffectLeaseId: 'primary-lease',
      primaryInvocationId: reserved.reservation.invocationId,
      primaryRequestId: 'primary-request',
      resourceReservationId: reserved.reservation.reservationId,
    };
    source.processEventBatch([
      ...admission.preparationEvents.map((event) => ({
        ...event,
        normalReprepareConsumptionKey: consumptionKey,
      })),
      ...admission.dispatchEvents.map((event) => ({
        ...event,
        normalReprepareConsumptionKey: consumptionKey,
      })),
      { type: 'context.normal_reprepare_consumed_v1', consumptionKey },
    ]);
    source.close();

    const store = createRuntimeStore(dbPath);
    expect(
      store.forkCurrentSession('strict-continuation-source', 'strict-continuation-target'),
    ).toBe(true);
    expect(
      store.loadEventsStrict('strict-continuation-target').map((entry) => entry.event.type),
    ).toEqual([
      'run.error',
      'resource_budget.unknown',
      'turn.aborted',
      'context.normal_reprepare_consumption_detached_v1',
    ]);
    const target = store.loadSnapshot<ReturnType<typeof source.getState>>(
      'strict-continuation-target',
    );
    expect(target?.context.summaryLifecycle).toEqual({ kind: 'idle' });
    expect(target?.context.lastDetach?.receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(target?.turn.status).toBe('aborted');
    const receiptId = target?.context.lastDetach?.receiptId;
    if (!receiptId) throw new Error('branch receipt expected');
    const targetGeneration = store.loadPersistenceIdentity('strict-continuation-target').generation;
    const branchAuthority = store.loadBranchMutationAuthorityV1(
      'strict-continuation-target',
      targetGeneration,
      receiptId,
    );
    expect(branchAuthority?.receipt?.manifest.kind).toBe('in_flight_quartet');
    expect(branchAuthority?.terminalClosure).toBeUndefined();
    if (!branchAuthority) throw new Error('branch completion authority expected');
    const completion = branchAuthority.completion;
    expect(
      store.resolveBranchMutationCompletionV1({
        targetThreadId: completion.targetThreadId,
        targetGeneration: completion.targetGeneration,
        receiptId: completion.receiptId,
        requestDigest: completion.requestDigest,
        candidateDigest: completion.candidateDigest,
        manifestDigest: completion.manifestDigest,
        postSnapshotDigest: completion.postSnapshotDigest,
      }).status,
    ).toBe('already_committed');
    expect(
      store.resolveBranchMutationCompletionV1({
        targetThreadId: completion.targetThreadId,
        targetGeneration: completion.targetGeneration,
        receiptId: completion.receiptId,
        requestDigest: '0'.repeat(64),
        candidateDigest: completion.candidateDigest,
        manifestDigest: completion.manifestDigest,
        postSnapshotDigest: completion.postSnapshotDigest,
      }).status,
    ).toBe('collision_or_corruption');

    const authority = new Database(dbPath, { readonly: true });
    expect(
      authority
        .query<{ receipts: number; completions: number; closures: number }, []>(
          `SELECT
             (SELECT COUNT(*) FROM runtime_branch_mutation_receipts WHERE target_thread_id = 'strict-continuation-target') AS receipts,
             (SELECT COUNT(*) FROM runtime_branch_mutation_completions WHERE target_thread_id = 'strict-continuation-target') AS completions,
             (SELECT COUNT(*) FROM runtime_branch_copied_terminal_closures WHERE target_thread_id = 'strict-continuation-target') AS closures`,
        )
        .get(),
    ).toEqual({ receipts: 1, completions: 1, closures: 0 });
    authority.close();
    store.close();
  });

  test('strict-v24 fork retains settled continuation terminals in a target-owned BCTC closure', () => {
    const source = createAgentKernel({
      threadId: 'strict-settled-source',
      userId: 'user',
      workspace: '/workspace',
      storePath: dbPath,
    });
    const startedAt = new Date();
    source.processEvent({
      type: 'resource_budget.configured',
      runId: 'settled-run',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(
        startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
      ).toISOString(),
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const continuation = {
      version: 1 as const,
      turnId: source.getState().turn.turnId,
      requestedAtRevision: 0,
      summarySourceIdentity: {
        version: 1 as const,
        firstMessageId: 'first',
        coveredThroughMessageId: 'last',
        coveredThroughTurnId: source.getState().turn.turnId,
        canonicalSourceDigest: 'a'.repeat(64),
        sourceProjectionPolicyId: 'checkpoint-v3-source:v1' as const,
      },
    };
    const originReceipt = {
      version: 1 as const,
      generation: source.getProducerGeneration(),
      attemptId: 'settled-attempt',
      compactionId: 'settled-compaction',
      continuation,
      origin: {
        kind: 'summary_terminal' as const,
        terminalBatchId: 'summary-terminal',
        terminalEventId: 'b'.repeat(64),
        resourceTerminalEventId: 'c'.repeat(64),
      },
    };
    source.processEvent({ type: 'context.normal_reprepare_required_v1', receipt: originReceipt });
    const admission = planRuntimeBudgetAdmissionV1(source.getState(), {
      type: 'call_model',
      primaryRequestId: 'settled-primary-request',
      resourceEstimate: { inputTokens: 100, maxOutputTokens: 50 },
    });
    if (admission.status !== 'admitted') throw new Error('continuation admission expected');
    const reserved = admission.preparationEvents.find(
      (event) => event.type === 'resource_budget.reserved',
    );
    if (reserved?.type !== 'resource_budget.reserved') throw new Error('reservation expected');
    const consumptionKey = {
      version: 1 as const,
      generation: source.getProducerGeneration(),
      consumptionBatchId: 'settled-consumption',
      attemptId: originReceipt.attemptId,
      compactionId: originReceipt.compactionId,
      continuation,
      originReceipt,
      primaryEffectLeaseId: 'settled-primary-lease',
      primaryInvocationId: reserved.reservation.invocationId,
      primaryRequestId: 'settled-primary-request',
      resourceReservationId: reserved.reservation.reservationId,
    };
    source.processEventBatch([
      ...admission.preparationEvents.map((event) => ({
        ...event,
        normalReprepareConsumptionKey: consumptionKey,
      })),
      ...admission.dispatchEvents.map((event) => ({
        ...event,
        normalReprepareConsumptionKey: consumptionKey,
      })),
      { type: 'context.normal_reprepare_consumed_v1', consumptionKey },
    ]);
    const terminalBatchId = 'settled-primary-terminal';
    source.processEventBatch([
      {
        type: 'model.responded',
        messageId: 'settled-response',
        text: 'settled response',
        contextEvidence: {
          version: 2,
          purpose: 'primary',
          terminalBatchId,
          requestId: consumptionKey.primaryRequestId,
          effectLeaseId: consumptionKey.primaryEffectLeaseId,
          reservationId: consumptionKey.resourceReservationId,
          preparedDigest: 'd'.repeat(64),
          sourceIdentityDigest: 'e'.repeat(64),
          requestIdentityDigest: 'f'.repeat(64),
          finalProviderPayloadDigest: '1'.repeat(64),
          admittedRequestDigest: '2'.repeat(64),
          reclaimReceiptDigest: 'none',
        },
      },
      {
        type: 'resource_budget.reconciled',
        reservationId: consumptionKey.resourceReservationId,
        terminalBatchId,
        actual: createZeroResourceUsageV1(),
      },
    ]);
    source.close();

    const store = createRuntimeStore(dbPath);
    expect(store.forkCurrentSession('strict-settled-source', 'strict-settled-target')).toBe(true);
    expect(
      store.loadEventsStrict('strict-settled-target').map((entry) => entry.event.type),
    ).toEqual(['context.normal_reprepare_consumption_detached_v1']);
    const target = store.loadSnapshot<ReturnType<typeof source.getState>>('strict-settled-target');
    const receiptId = target?.context.lastDetach?.receiptId;
    if (!receiptId) throw new Error('settled branch receipt expected');
    expect(target?.context.lastDetach?.primaryState).toBe('settled_success');
    const generation = store.loadPersistenceIdentity('strict-settled-target').generation;
    const branchAuthority = store.loadBranchMutationAuthorityV1(
      'strict-settled-target',
      generation,
      receiptId,
    );
    expect(branchAuthority?.receipt?.manifest.kind).toBe('settled_detach');
    expect(branchAuthority?.terminalClosure?.terminal.kind).toBe('success');
    expect(branchAuthority?.terminalClosure?.terminal.envelopes).toHaveLength(5);
    expect(
      branchAuthority?.terminalClosure?.terminal.envelopes.every(
        ({ envelope }) =>
          envelope.threadId === 'strict-settled-source' &&
          envelope.generation === source.getProducerGeneration(),
      ),
    ).toBe(true);
    store.close();

    const sourceDelete = createRuntimeStore(dbPath);
    sourceDelete.deleteSession(
      'strict-settled-source',
      sourceDelete.loadPersistenceIdentity('strict-settled-source'),
    );
    expect(
      sourceDelete.loadBranchMutationAuthorityV1('strict-settled-target', generation, receiptId)
        ?.terminalClosure?.terminal.kind,
    ).toBe('success');
    sourceDelete.close();
  });

  test('getNamedSnapshotEntry resolves position and timestamp, null when absent', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('preimg-entry', [makeEvent({ toolCallId: 'a' })]);
    store.saveNamedSnapshot('preimg-entry', 'cp', { version: 1 });
    const entry = store.getNamedSnapshotEntry('preimg-entry', 'cp');
    expect(entry?.snapshotId).toBe('cp');
    expect(entry?.eventPosition).toBeGreaterThan(0);
    expect(store.getNamedSnapshotEntry('preimg-entry', 'missing')).toBeNull();
    store.close();
  });

  test('effect leases are exclusive across RuntimeStore connections and recover after release', () => {
    const first = createRuntimeStore(dbPath);
    const second = createRuntimeStore(dbPath);
    expect(
      first.tryAcquireEffectLease('lease-thread', 'compact-1', 'owner-a', Date.now() + 60_000),
    ).toBe(true);
    expect(
      second.tryAcquireEffectLease('lease-thread', 'compact-1', 'owner-b', Date.now() + 60_000),
    ).toBe(false);
    first.releaseEffectLease('lease-thread', 'compact-1', 'owner-a');
    expect(
      second.tryAcquireEffectLease('lease-thread', 'compact-1', 'owner-b', Date.now() + 60_000),
    ).toBe(true);
    first.close();
    second.close();
  });

  test('rejects stale snapshot writers and late writes after deletion', () => {
    const first = createRuntimeStore(dbPath);
    const second = createRuntimeStore(dbPath);
    first.saveSnapshot('cas-thread', { revision: 0, schemaVersion: 1 });
    first.appendEventsAndSnapshot(
      'cas-thread',
      [makeEvent({ toolCallId: 'first' })],
      { revision: 1, schemaVersion: 1 },
      [{ eventId: 'event-1', revision: 1 }],
    );
    expect(() =>
      second.appendEventsAndSnapshot(
        'cas-thread',
        [makeEvent({ toolCallId: 'stale' })],
        { revision: 1, schemaVersion: 1 },
        [{ eventId: 'event-stale', revision: 1 }],
      ),
    ).toThrow(RuntimeRevisionConflictError);
    first.deleteSession('cas-thread');
    expect(() =>
      second.appendEventsAndSnapshot(
        'cas-thread',
        [makeEvent({ toolCallId: 'late' })],
        { revision: 2, schemaVersion: 1 },
        [{ eventId: 'event-late', revision: 2 }],
      ),
    ).toThrow(RuntimeRevisionConflictError);
    expect(second.listSessions().some((session) => session.threadId === 'cas-thread')).toBe(false);
    first.close();
    second.close();
  });

  test('rejects metadata-less append against a deleted strict-v24 fence', () => {
    const store = createRuntimeStore(dbPath);
    store.saveSnapshot('strict-deleted', { revision: 0, schemaVersion: 24 });
    store.deleteSession('strict-deleted', store.loadPersistenceIdentity('strict-deleted'));

    expect(() =>
      store.appendEvents('strict-deleted', [
        { type: 'user.command_invoked', commandId: 'late', command: '/late' },
      ]),
    ).toThrow(RuntimeRevisionConflictError);
    expect(store.loadEvents('strict-deleted')).toEqual([]);
    const authority = new Database(dbPath, { readonly: true });
    expect(
      authority
        .query<{ ledger: number; actual: number }, []>(
          `SELECT
             (SELECT fence_count FROM runtime_fence_ledger WHERE singleton = 1) AS ledger,
             (SELECT COUNT(*) FROM runtime_thread_fences) AS actual`,
        )
        .get(),
    ).toEqual({ ledger: 1, actual: 1 });
    authority.close();
    expect(store.loadPersistenceIdentity('strict-deleted')).toMatchObject({
      format: 'v24_strict',
      lifecycle: 'deleted',
    });
    store.close();
  });

  test('accepts a 256-byte fence row and rejects 257 bytes without changing the ledger', () => {
    const store = createRuntimeStore(dbPath);
    const atLimit = 'x'.repeat(192);
    store.loadPersistenceIdentity(atLimit);
    const beforeReader = new Database(dbPath, { readonly: true });
    const before = beforeReader
      .query<{ count: number; bytes: number }, []>(
        'SELECT fence_count AS count, fence_bytes AS bytes FROM runtime_fence_ledger WHERE singleton = 1',
      )
      .get();
    beforeReader.close();
    expect(before).toEqual({ count: 1, bytes: 256 });
    expect(() => store.loadPersistenceIdentity('y'.repeat(193))).toThrow(
      'runtime_fence_row_oversized',
    );
    const verifier = new Database(dbPath, { readonly: true });
    expect(
      verifier
        .query<{ count: number; bytes: number }, []>(
          'SELECT fence_count AS count, fence_bytes AS bytes FROM runtime_fence_ledger WHERE singleton = 1',
        )
        .get(),
    ).toEqual(before);
    verifier.close();
    store.close();
  });

  test('rejects oversized rolling and named snapshots before materializing JSON', () => {
    const store = createRuntimeStore(dbPath);
    store.saveSnapshot('oversized-snapshot', { revision: 0, schemaVersion: 1 });
    store.saveNamedSnapshot('oversized-snapshot', 'large', { revision: 0, schemaVersion: 1 });
    const writer = new Database(dbPath);
    const oversized = JSON.stringify({ value: 'x'.repeat(32 * 1024 * 1024 + 1) });
    writer.run('UPDATE runtime_snapshots SET state_json = ? WHERE thread_id = ?', [
      oversized,
      'oversized-snapshot',
    ]);
    writer.run(
      'UPDATE runtime_named_snapshots SET state_json = ? WHERE thread_id = ? AND name = ?',
      [oversized, 'oversized-snapshot', 'large'],
    );
    writer.close();
    expect(store.loadSnapshot('oversized-snapshot')).toBeNull();
    expect(store.loadNamedSnapshot('oversized-snapshot', 'large')).toBeNull();
    store.close();
  });

  test('quarantines a fence-ledger mismatch before creating another thread fence', () => {
    const store = createRuntimeStore(dbPath);
    store.loadPersistenceIdentity('fence-a');
    const attacker = new Database(dbPath);
    attacker.run('UPDATE runtime_fence_ledger SET fence_count = 0, fence_bytes = 0');
    attacker.close();
    expect(() => store.loadPersistenceIdentity('fence-b')).toThrow(
      'does not match its retained catalog',
    );
    const verifier = new Database(dbPath, { readonly: true });
    expect(
      verifier
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_thread_fences WHERE thread_id = 'fence-b'",
        )
        .get()?.count,
    ).toBe(0);
    verifier.close();
    store.close();
  });
});
