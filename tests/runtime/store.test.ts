// ── RuntimeStore 持久化测试 / RuntimeStore persistence tests ──
// 验证 createRuntimeStore 的事件日志与快照的完整持久化链路

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxPreparationIntentDigestV1 } from '../../src/core/capabilities/sandbox-preparation-evidence.js';
import type { RuntimeEvent } from '../../src/core/runtime/events.js';
import { classifyFailure } from '../../src/core/runtime/failures.js';
import { reduceRuntimeState } from '../../src/core/runtime/reducer.js';
import { createInitialRuntimeState } from '../../src/core/runtime/state.js';
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
import {
  CURRENT_TEST_PLAN_IDENTITY,
  CURRENT_TEST_PLAN_REVIEW_FACTS,
} from '../helpers/current-plan';

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
    name: 'shell_execute',
    result: {
      ok: exitCode === 0,
      command: 'echo hello',
      exitCode,
      stdout: 'hello',
      stderr: '',
    },
  } as RuntimeEvent;
}

function currentSnapshot(
  threadId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = createInitialRuntimeState({
    threadId,
    userId: 'store-test-user',
    workspace: '/workspace',
  });
  const session =
    typeof extra.session === 'object' && extra.session !== null
      ? { ...base.session, ...(extra.session as Record<string, unknown>) }
      : base.session;
  return { ...base, ...extra, session };
}

function pendingSandboxSnapshot(threadId: string): {
  state: ReturnType<typeof createInitialRuntimeState>;
  events: RuntimeEvent[];
} {
  const recordedAt = new Date().toISOString();
  const intentBody = {
    attempt: 1,
    toolCallId: 'sandbox-tool',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'shell-r1',
    canonicalWorkspace: '/workspace',
    effectiveEffectsDigest: 'effects',
    admissionDigest: 'admission',
    preparationDigest: 'preparation',
    commandDigest: 'command',
    executionBoundaryDigest: 'boundary',
    resourceSemantics: 'allocating' as const,
  };
  const events: RuntimeEvent[] = [
    {
      type: 'capability.invocation_recorded',
      invocationId: 'sandbox-invocation',
      toolCallId: intentBody.toolCallId,
      capabilityId: intentBody.capabilityId,
      capabilityRevision: intentBody.capabilityRevision,
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      admissionDigest: intentBody.admissionDigest,
      effectiveEffectsDigest: intentBody.effectiveEffectsDigest,
      effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
      receiptRequirement: 'effect_receipt',
      retryEligibility: 'none',
      recordedAt,
    },
    {
      type: 'capability.execution_started',
      invocationId: 'sandbox-invocation',
      startedAt: recordedAt,
      attempt: 1,
    },
    {
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: 'sandbox-invocation',
      ...intentBody,
      intentDigest: sandboxPreparationIntentDigestV1(intentBody),
      recordedAt,
    },
  ];
  let state = createInitialRuntimeState({
    threadId,
    userId: 'store-test-user',
    workspace: '/workspace',
  });
  for (const event of events) state = reduceRuntimeState(state, event);
  return { state, events };
}

function pendingSubagentSnapshot(threadId: string) {
  const state = createInitialRuntimeState({
    threadId,
    userId: 'store-test-user',
    workspace: '/workspace',
  });
  state.capabilities.invocations['subagent-invocation'] = {
    invocationId: 'subagent-invocation',
    toolCallId: 'task-call',
    capabilityId: 'builtin:task',
    capabilityRevision: '1'.repeat(64),
    argumentsDigest: '2'.repeat(64),
    authorizationDigest: '3'.repeat(64),
    admissionDigest: '4'.repeat(64),
    effectiveEffectsDigest: '5'.repeat(64),
    receiptRequirement: 'control_receipt',
    status: 'running',
    recordedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    attemptsStarted: 1,
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-private',
      taskArtifact: {
        artifactId: `pa_${'6'.repeat(64)}`,
        kind: 'subagent_task',
        integrityIdentifier: `hmac-sha256:${'7'.repeat(64)}`,
        byteLength: 256,
      },
      dispatchIntentDigest: `sha256:${'8'.repeat(64)}`,
      status: 'handle_recorded',
      recordedAt: new Date().toISOString(),
      handleArtifact: {
        artifactId: `pa_${'9'.repeat(64)}`,
        kind: 'subagent_handle',
        integrityIdentifier: `hmac-sha256:${'a'.repeat(64)}`,
        byteLength: 512,
      },
      handleIntegrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
      handleRecordedAt: new Date().toISOString(),
    },
  };
  return state;
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

  // 验证仅内存模式也能正常工作 / Verify in-memory mode works correctly
  test('works with :memory: database', () => {
    const store = createRuntimeStore(':memory:');
    const event = makeEvent({
      type: 'tool.queued',
      toolCallId: 'mem-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    store.appendEvents('thread-mem', [event]);
    const loaded = store.loadEventsStrict('thread-mem');
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

  test('rejects an unmarked RuntimeStore without moving or rewriting it', () => {
    const db = new Database(dbPath);
    db.run(
      'CREATE TABLE runtime_events (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at INTEGER)',
    );
    db.run(
      'INSERT INTO runtime_events (thread_id, event_json, created_at) VALUES (\'legacy-runtime\', \'{"type":"user.message_appended","messageId":"m","content":"hello"}\', 100)',
    );
    db.close();

    expect(() => createRuntimeStore(dbPath)).toThrow('Runtime format is incompatible');
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.legacy`)).toBe(false);
  });

  test('rejects an unmarked RuntimeStore whose schema exists only in WAL without rewriting it', () => {
    const legacy = new Database(dbPath);
    legacy.run('PRAGMA journal_mode = WAL');
    legacy.run('PRAGMA wal_autocheckpoint = 0');
    legacy.run(
      'CREATE TABLE runtime_events (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, event_json TEXT NOT NULL)',
    );
    legacy.run(
      `INSERT INTO runtime_events (thread_id, event_json) VALUES ('legacy-wal', '{"type":"tool.execution_ready","toolCallId":"shell"}')`,
    );
    const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = new Map(paths.map((path) => [path, digest(path)]));

    expect(() => createRuntimeStore(dbPath)).toThrow('Runtime format is incompatible');
    expect(new Map(paths.map((path) => [path, digest(path)]))).toEqual(before);
    expect(
      legacy
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_store_meta'",
        )
        .get()?.count,
    ).toBe(0);
    legacy.close();
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

describe('appendEvents + loadEventsStrict round-trip', () => {
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

    const loaded = store.loadEventsStrict('thread-a');
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
      makeEvent({
        type: 'tool.queued',
        toolCallId: 'call-1',
        name: 'read_file',
        args: { path: 'README.md' },
      }),
      makeEvent({ type: 'tool.started', toolCallId: 'call-1' }),
      makeToolFinishedEvent('call-1', 0),
    ];
    store.appendEvents('thread-b', events);

    const loaded = store.loadEventsStrict('thread-b');
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
    const loaded = store.loadEventsStrict('thread-subagent-events').map((entry) => entry.event);

    expect(loaded).toEqual(events);
  });

  // 验证不同线程的事件相互隔离 / Verify events are isolated by thread_id
  test('isolates events by thread_id', () => {
    store.appendEvents('thread-1', [makeEvent({ toolCallId: 'a' })]);
    store.appendEvents('thread-2', [makeEvent({ toolCallId: 'b' })]);

    const t1 = store.loadEventsStrict('thread-1');
    const t2 = store.loadEventsStrict('thread-2');

    expect(t1.length).toBe(1);
    expect(t1[0]!.thread_id).toBe('thread-1');
    expect(t2.length).toBe(1);
    expect(t2[0]!.thread_id).toBe('thread-2');
  });

  // 验证追加事件时序——新追加的事件应在后续查询中可见 / Verify new events appended after a read are visible
  test('newly appended events appear in subsequent load', () => {
    store.appendEvents('thread-c', [makeEvent({ toolCallId: 'first' })]);
    expect(store.loadEventsStrict('thread-c').length).toBe(1);

    store.appendEvents('thread-c', [makeEvent({ toolCallId: 'second' })]);
    expect(store.loadEventsStrict('thread-c').length).toBe(2);
  });
});

describe('loadEventsStrict with since parameter', () => {
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
    const all = store.loadEventsStrict('thread-d');
    expect(all.length).toBe(3);
    const firstId = all[0]!.id;

    // 从第 1 个 ID 之后加载，应返回剩余 2 个 / Load since first ID, should return remaining 2
    const since = store.loadEventsStrict('thread-d', firstId);
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
    const all = store.loadEventsStrict('thread-e');
    const maxId = all[all.length - 1]!.id;

    const result = store.loadEventsStrict('thread-e', maxId + 100);
    expect(result).toEqual([]);
  });

  // 验证不存在线程 + since 仍然返回空数组 / Verify unknown thread + since returns empty
  test('returns empty array for unknown thread with since', () => {
    const result = store.loadEventsStrict('nonexistent', 0);
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
    expect(store.loadEventsStrict('thread-f').length).toBe(1);

    store.close();

    // close 后写入不应抛异常 / After close, writes should not throw
    expect(() =>
      store.appendEvents('thread-f', [makeEvent({ toolCallId: 'after-close' })]),
    ).not.toThrow();
  });

  // 验证 close 后加载事件返回空数组 / Verify loadEventsStrict returns empty after close
  test('loadEventsStrict returns empty array after close', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-runtime-store-'));
    const store = createRuntimeStore(join(tmpDir, 'runtime.db'));
    store.appendEvents('thread-g', [makeEvent({ toolCallId: 'pre-close' })]);

    store.close();

    const result = store.loadEventsStrict('thread-g');
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
    expect(store.loadEventsStrict('thread-j')).toEqual([]);
  });

  // 验证包含所有 event 类型的写入都可完整读回 / Verify all event types survive round-trip
  test('round-trips all RuntimeEvent discriminated union variants', () => {
    const events: RuntimeEvent[] = [
      { type: 'tool.queued', toolCallId: 'c1', name: 'read', args: {} },
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
        failure: classifyFailure('tool_runtime_error', 'command not found'),
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
        ...CURRENT_TEST_PLAN_REVIEW_FACTS,
        plan: { name: 'p1' } as unknown as AgentPlan,
        planSummary: 'summary',
      },
      {
        type: 'plan.approved',
        interactionId: 'i2',
        toolCallId: 'c5',
        ...CURRENT_TEST_PLAN_IDENTITY,
        executionMode: 'auto',
      },
      {
        type: 'plan.revision_requested',
        interactionId: 'i2',
        toolCallId: 'c5',
        ...CURRENT_TEST_PLAN_IDENTITY,
        feedback: 'change it',
      },
      {
        type: 'approval.requested',
        interactionId: 'i3',
        toolCallId: 'c6',
        approval: { toolName: 'shell' } as unknown as ToolApprovalPayload,
      },
      {
        type: 'approval.granted',
        interactionId: 'i3',
        toolCallId: 'c6',
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
    const loaded = store.loadEventsStrict('thread-k');

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

    const loaded = store.loadEventsStrict('thread-null');
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
    const loaded = s2.loadEventsStrict('thread-p');
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
    const ids1 = s1.loadEventsStrict('thread-r').map((e) => e.id);
    s1.close();

    const s2 = createRuntimeStore(dbPath);
    s2.appendEvents('thread-r', [makeEvent({ toolCallId: 'batch2' })]);
    const all = s2.loadEventsStrict('thread-r');
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
    expect(store.loadEventsStrict('thread-iso-a').length).toBe(1);
    expect(store.loadEventsStrict('thread-iso-a')[0]!.thread_id).toBe('thread-iso-a');
    expect(store.loadSnapshot<{ version: number }>('thread-iso-a')!.version).toBe(1);

    // thread-iso-b only sees its own data
    expect(store.loadEventsStrict('thread-iso-b').length).toBe(1);
    expect(store.loadEventsStrict('thread-iso-b')[0]!.thread_id).toBe('thread-iso-b');
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

    const loaded = store.loadEventsStrict('thread-large');
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

    const loaded = store.loadEventsStrict('thread-special');
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
    const idsAfterFirst = store.loadEventsStrict('thread-seq').map((e) => e.id);

    // Empty batch should not affect auto-increment
    store.appendEvents('thread-seq', []);
    store.appendEvents('thread-seq', []);

    store.appendEvents('thread-seq', [makeEvent({ toolCallId: 'second' })]);
    const all = store.loadEventsStrict('thread-seq');
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
    store.saveNamedSnapshot(
      'rewindable',
      'before-change',
      currentSnapshot('rewindable', { stage: 'before' }),
    );
    store.appendEvents('rewindable', [makeEvent({ toolCallId: 'after-rewind' })]);

    expect(position).toBeGreaterThan(0);
    expect(store.loadNamedSnapshot<{ stage: string }>('rewindable', 'before-change')).toMatchObject(
      { stage: 'before' },
    );
    expect(store.getLastEventPosition('rewindable')).toBeGreaterThan(position);
    store.close();
  });

  test('restoreNamedSnapshot truncates later events and restores the saved state', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind', [makeEvent({ toolCallId: 'before' })]);
    store.saveNamedSnapshot('rewind', 'safe', currentSnapshot('rewind', { testVersion: 1 }));
    store.appendEvents('rewind', [makeEvent({ toolCallId: 'after' })]);

    expect(store.restoreNamedSnapshot('rewind', 'safe')).toBe(true);
    expect(store.loadSnapshot<{ testVersion: number }>('rewind')?.testVersion).toBe(1);
    expect(store.loadEventsStrict('rewind')).toHaveLength(1);
    store.close();
  });

  test('restoreNamedSnapshot validates thread ownership before truncating events', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind-owner', [makeEvent({ toolCallId: 'before' })]);
    store.saveNamedSnapshot(
      'rewind-owner',
      'cross-thread',
      currentSnapshot('other-thread', { testVersion: 1 }),
    );
    store.appendEvents('rewind-owner', [makeEvent({ toolCallId: 'after' })]);

    expect(store.restoreNamedSnapshot('rewind-owner', 'cross-thread')).toBe(false);
    expect(store.loadEventsStrict('rewind-owner')).toHaveLength(2);
    expect(store.loadSnapshot('rewind-owner')).toBeNull();
    store.close();
  });

  test('restoreNamedSnapshot removes recovery points beyond the restored position', () => {
    const store = createRuntimeStore(dbPath);
    store.appendEvents('rewind-prune', [makeEvent({ toolCallId: 'first' })]);
    store.saveNamedSnapshot(
      'rewind-prune',
      'first',
      currentSnapshot('rewind-prune', { testVersion: 1 }),
    );
    store.appendEvents('rewind-prune', [makeEvent({ toolCallId: 'second' })]);
    store.saveNamedSnapshot(
      'rewind-prune',
      'second',
      currentSnapshot('rewind-prune', { testVersion: 2 }),
    );

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
    store.saveNamedSnapshot(
      'rewind-preview',
      'after-first',
      currentSnapshot('rewind-preview', { testVersion: 1 }),
    );
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
    store.saveNamedSnapshot(
      'source',
      'safe',
      currentSnapshot('source', {
        session: { threadId: 'source', userId: 'u', workspace: '/workspace' },
      }),
    );

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
      calls: {},
      queue: [],
      active: [],
    });
    expect(fork.capabilities).toEqual(
      expect.objectContaining({ bindings: {}, disclosures: {}, loadedCapabilities: {} }),
    );
    expect(fork.providerAdmission).toEqual({ pending: [], waivers: {} });
    expect(fork.suspendedSubagents).toEqual({});
    expect(store.loadEventsStrict('fork')).toHaveLength(1);
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
    const sourceState = currentSnapshot('source', {
      session: { threadId: 'source' },
    }) as unknown as ReturnType<typeof createInitialRuntimeState>;
    sourceState.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId: 'model-1',
      name: 'shell_execute',
      args: {},
      status: 'awaiting_approval',
      createdAtTurnId: sourceState.turn.turnId,
    };
    sourceState.tools.queue.push('shell-1');
    sourceState.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-1',
      toolCallId: 'shell-1',
      approval,
    };
    store.saveSnapshot('source', sourceState);

    expect(store.forkCurrentSession('source', 'recovery')).toBe(true);
    expect(store.loadEventsStrict('source').map((entry) => entry.event.type)).toEqual([
      'tool.queued',
      'approval.requested',
    ]);
    expect(store.loadEventsStrict('recovery').map((entry) => entry.event.type)).toEqual([
      'tool.queued',
    ]);
    expect(
      store.loadSnapshot<{ session: { threadId: string }; interactions: unknown }>('recovery'),
    ).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'recovery' }),
        interactions: { kind: 'idle' },
      }),
    );
    store.close();
  });

  test('forks cannot copy or race source-owned pending sandbox cleanup authority', () => {
    const store = createRuntimeStore(dbPath);
    const pending = pendingSandboxSnapshot('sandbox-source');
    store.appendEvents('sandbox-source', pending.events);
    store.saveSnapshot('sandbox-source', pending.state);
    store.saveNamedSnapshot('sandbox-source', 'pending', pending.state);

    expect(store.forkCurrentSession('sandbox-source', 'current-fork')).toBe(false);
    expect(store.forkSession('sandbox-source', 'pending', 'named-fork')).toBe(false);
    expect(store.loadSnapshot('current-fork')).toBeNull();
    expect(store.loadSnapshot('named-fork')).toBeNull();
    expect(
      store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>('sandbox-source')
        ?.capabilities.invocations['sandbox-invocation']?.sandboxPreparationIntent,
    ).toBeDefined();
    store.close();
  });

  test('forks reject pending Subagent Provider authority before creating the target', () => {
    const store = createRuntimeStore(dbPath);
    const pending = pendingSubagentSnapshot('subagent-source');
    store.saveSnapshot('subagent-source', pending);
    store.saveNamedSnapshot('subagent-source', 'pending-subagent', pending);

    expect(store.forkCurrentSession('subagent-source', 'current-subagent-fork')).toBe(false);
    expect(store.forkSession('subagent-source', 'pending-subagent', 'named-subagent-fork')).toBe(
      false,
    );
    expect(store.loadSnapshot('current-subagent-fork')).toBeNull();
    expect(store.loadSnapshot('named-subagent-fork')).toBeNull();
    expect(
      store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>('subagent-source')
        ?.capabilities.invocations['subagent-invocation']?.subagentProviderLifecycle?.status,
    ).toBe('handle_recorded');

    const lifecycle =
      pending.capabilities.invocations['subagent-invocation']!.subagentProviderLifecycle!;
    Object.assign(lifecycle, {
      status: 'cleanup_completed',
      observationStatus: 'completed',
      observedAt: new Date().toISOString(),
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupStartedAt: new Date().toISOString(),
      cleanupConfirmed: true,
      cleanupCompletedAt: new Date().toISOString(),
    });
    store.saveSnapshot('subagent-source', pending);
    store.saveNamedSnapshot('subagent-source', 'terminal-subagent', pending);
    expect(store.forkCurrentSession('subagent-source', 'terminal-current-fork')).toBe(true);
    expect(store.forkSession('subagent-source', 'terminal-subagent', 'terminal-named-fork')).toBe(
      true,
    );
    for (const target of ['terminal-current-fork', 'terminal-named-fork']) {
      expect(
        store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>(target)?.capabilities
          .invocations['subagent-invocation']?.subagentProviderLifecycle,
      ).toBeUndefined();
    }
    expect(
      store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>('subagent-source')
        ?.capabilities.invocations['subagent-invocation']?.subagentProviderLifecycle?.status,
    ).toBe('cleanup_completed');
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
    store.saveNamedSnapshot(
      'metadata-source',
      'safe',
      currentSnapshot('metadata-source', {
        session: { threadId: 'metadata-source' },
        revision: 7,
      }),
    );
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
    store.saveNamedSnapshot(
      'rewind-source',
      'checkpoint-1',
      currentSnapshot('rewind-source', {
        session: { threadId: 'rewind-source' },
        testVersion: 1,
      }),
    );
    store.appendEvents('rewind-source', [
      {
        type: 'user.message_appended',
        messageId: 'message-2',
        content: 'second turn',
      },
    ]);
    store.recordFilePreimage('rewind-source', 'notes.md', 'v1\n', true);
    store.recordFilePostimage('rewind-source', 'notes.md', 'hash-v2', true);
    store.saveNamedSnapshot(
      'rewind-source',
      'checkpoint-2',
      currentSnapshot('rewind-source', {
        session: { threadId: 'rewind-source' },
        testVersion: 2,
      }),
    );

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
      store.loadSnapshot<{ session: { threadId: string }; testVersion: number }>(
        'rewind-fork-again',
      ),
    ).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'rewind-fork-again' }),
        testVersion: 1,
      }),
    );
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
    store.saveNamedSnapshot(
      'preimg-trunc',
      'cp',
      currentSnapshot('preimg-trunc', { testVersion: 1 }),
    );
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
    store.saveNamedSnapshot('preimg-fork', 'cp', currentSnapshot('preimg-fork'));
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
});
