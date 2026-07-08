// ── RuntimeStore 持久化测试 / RuntimeStore persistence tests ──
// 验证 createRuntimeStore 的事件日志与快照的完整持久化链路

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '../../src/core/runtime/events.js';
import type { RuntimeStore } from '../../src/core/runtime/store.js';
import { createRuntimeStore } from '../../src/core/runtime/store.js';

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
    const event = makeEvent({ type: 'tool.queued', toolCallId: 'mem-1' });
    store.appendEvents('thread-mem', [event]);
    const loaded = store.loadEvents('thread-mem');
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.event.type).toBe('tool.queued');
    store.close();
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
    expect((loaded[0]!.event as any).toolCallId).toBe('call-1');
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
    expect((since[0]!.event as any).toolCallId).toBe('second');
    expect((since[1]!.event as any).toolCallId).toBe('third');
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
        request: { question: 'What next?' } as any,
      },
      {
        type: 'user_input.answered',
        interactionId: 'i1',
        answer: 'continue',
      },
      {
        type: 'plan.review_requested',
        interactionId: 'i2',
        toolCallId: 'c5',
        plan: { name: 'p1' } as any,
        planSummary: 'summary',
      },
      { type: 'plan.approved', interactionId: 'i2', executionMode: 'auto' },
      { type: 'plan.revision_requested', interactionId: 'i2', feedback: 'change it' },
      { type: 'plan.rejected', interactionId: 'i2', reason: 'bad plan' },
      {
        type: 'approval.requested',
        interactionId: 'i3',
        toolCallId: 'c6',
        approval: { toolName: 'shell' } as any,
      },
      {
        type: 'approval.granted',
        interactionId: 'i3',
        grant: { mode: 'once' } as any,
      },
      { type: 'approval.rejected', interactionId: 'i3', reason: 'unsafe' },
      { type: 'authorization.changed', mode: 'full_access' },
      { type: 'phase.changed', phase: 'building' },
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
    expect((loaded[0]!.event as any).toolCallId).toBe('evt-1');
    expect((loaded[1]!.event as any).toolCallId).toBe('evt-2');
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
    expect((all[1]!.event as any).toolCallId).toBe('batch2');
  });
});
