import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterEach, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "@langchain/langgraph-checkpoint";
import { BunSqliteSaver } from "../src/core/persistence/checkpoint";

// 验证 BunSqliteSaver 的 checkpoint 持久化与读取功能 / Verify BunSqliteSaver checkpoint persistence and readback
describe("BunSqliteSaver", () => {
  // 验证 checkpoint 写入后可通过同一 thread_id 完整读取数据 / Verify checkpoint can be fully read back after write via same thread_id
  test("persists and reads a checkpoint tuple", async () => {
    const dbPath = join(tmpdir(), "openpx-langgraph-checkpoint-test.sqlite");
    rmSync(dbPath, { force: true });

    const saver = new BunSqliteSaver(dbPath);
    const checkpoint: Checkpoint = {
      v: 4,
      id: "checkpoint-1",
      ts: new Date("2026-04-23T00:00:00.000Z").toISOString(),
      channel_values: { task: "write file" },
      channel_versions: { task: 1 },
      versions_seen: {},
    };

    // 写入 checkpoint 并获取返回的下一个配置 / Put checkpoint and get next config
    const nextConfig = await saver.put(
      { configurable: { thread_id: "thread-a" } },
      checkpoint,
      { source: "input", step: 0, parents: {} },
    );
    saver.close();

    // 重新打开数据库实例读取已持久化的 checkpoint / Reopen database instance to read persisted checkpoint
    const restored = new BunSqliteSaver(dbPath);
    const tuple = await restored.getTuple({
      configurable: { thread_id: "thread-a" },
    });

    // 检查写入后返回的 checkpoint ID 正确 / Verify checkpoint ID returned after write
    expect(nextConfig.configurable?.checkpoint_id).toBe("checkpoint-1");
    // 检查读取回的 channel 数据与写入时一致 / Verify channel data read back matches what was written
    expect(tuple?.checkpoint.channel_values.task).toBe("write file");
    restored.close();
  });
});

describe("listCheckpoints", () => {
  let saver: BunSqliteSaver;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openpx-test-"));
    saver = new BunSqliteSaver(join(tmpDir, "checkpoints.db"));
    saver.setup();
  });

  afterEach(() => {
    saver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for unknown thread", async () => {
    const entries = await saver.listCheckpoints("nonexistent-thread");
    expect(entries).toEqual([]);
  });

  it("returns checkpoint entries with first human message", async () => {
    const threadId = "test-thread-1";
    const checkpoint: any = {
      v: 4,
      id: "cp-1",
      ts: new Date().toISOString(),
      channel_values: {
        messages: [
          { lc_id: ["langchain", "messages", "HumanMessage"], content: "Hello, world! This is a test message." },
          { lc_id: ["langchain", "messages", "AIMessage"], content: "Hi there!" },
        ],
      },
      channel_versions: {},
      versions_seen: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-1" } },
      checkpoint,
      { source: "loop", step: 0, parents: {} },
    );

    const entries = await saver.listCheckpoints(threadId);
    expect(entries.length).toBe(1);
    expect(entries[0].checkpointId).toBe("cp-1");
    expect(entries[0].firstUserMessage).toContain("Hello, world!");
  });

  it("truncates long messages to 60 chars", async () => {
    const threadId = "test-thread-2";
    const longMsg = "A".repeat(200);
    const checkpoint: any = {
      v: 4,
      id: "cp-l",
      ts: new Date().toISOString(),
      channel_values: {
        messages: [{ lc_id: ["langchain", "messages", "HumanMessage"], content: longMsg }],
      },
      channel_versions: {},
      versions_seen: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-l" } },
      checkpoint,
      { source: "loop", step: 0, parents: {} },
    );

    const entries = await saver.listCheckpoints(threadId);
    expect(entries[0].firstUserMessage.length).toBeLessThanOrEqual(60);
  });

  it("returns entries in reverse chronological order", async () => {
    const threadId = "test-thread-order";
    for (let i = 0; i < 3; i++) {
      const cp: any = {
        v: 4,
        id: `cp-order-${i}`,
        ts: new Date().toISOString(),
        channel_values: { messages: [{ lc_id: ["langchain", "messages", "HumanMessage"], content: `Msg ${i}` }] },
        channel_versions: {},
        versions_seen: {},
      };
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_id: `cp-order-${i}` } },
        cp,
        { source: "loop", step: i, parents: {} },
      );
    }
    const entries = await saver.listCheckpoints(threadId, 10);
    expect(entries[0].checkpointId).toBe("cp-order-2"); // most recent first
    expect(entries[2].checkpointId).toBe("cp-order-0");
  });

  it("handles checkpoints with no messages without crashing", async () => {
    const threadId = "test-thread-no-msgs";
    const checkpoint: any = {
      v: 4,
      id: "cp-no-msgs",
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-no-msgs" } },
      checkpoint,
      { source: "loop", step: 0, parents: {} },
    );

    const entries = await saver.listCheckpoints(threadId);
    expect(entries.length).toBe(1);
    expect(entries[0].checkpointId).toBe("cp-no-msgs");
    expect(entries[0].firstUserMessage).toBe("");
  });

  it("respects limit parameter", async () => {
    const threadId = "test-thread-limit";
    for (let i = 0; i < 5; i++) {
      const cp: any = {
        v: 4,
        id: `cp-limit-${i}`,
        ts: new Date().toISOString(),
        channel_values: { messages: [{ lc_id: ["langchain", "messages", "HumanMessage"], content: `Msg ${i}` }] },
        channel_versions: {},
        versions_seen: {},
      };
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_id: `cp-limit-${i}` } },
        cp,
        { source: "loop", step: i, parents: {} },
      );
    }
    const entries = await saver.listCheckpoints(threadId, 3);
    expect(entries.length).toBe(3);
  });
});

describe("getCheckpointState", () => {
  let saver: BunSqliteSaver;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openpx-test-"));
    saver = new BunSqliteSaver(join(tmpDir, "checkpoints.db"));
    saver.setup();
  });

  afterEach(() => {
    saver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for unknown checkpoint", async () => {
    const state = await saver.getCheckpointState("nonexistent", "nonexistent");
    expect(state).toBeNull();
  });

  it("returns full state from checkpoint", async () => {
    const threadId = "test-state-1";
    const checkpoint: any = {
      v: 4,
      id: "cp-state",
      ts: new Date().toISOString(),
      channel_values: {
        messages: [
          { lc_id: ["langchain", "messages", "HumanMessage"], content: "hi" },
          { lc_id: ["langchain", "messages", "AIMessage"], content: "hey" },
        ],
        workspaceAccess: "read-only",
        phase: "planning",
        plan: { name: "test", description: "test plan", steps: [] },
        contextSummary: "summary text",
      },
      channel_versions: {},
      versions_seen: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-state" } },
      checkpoint,
      { source: "loop", step: 0, parents: {} },
    );

    const state = await saver.getCheckpointState(threadId, "cp-state");
    expect(state).not.toBeNull();
    if (state) {
      expect(state.messages).toHaveLength(2);
      expect(state.workspaceAccess).toBe("read-only");
      expect(state.phase).toBe("planning");
      expect(state.plan?.name).toBe("test");
      expect(state.contextSummary).toBe("summary text");
    }
  });

  it("returns undefined authorization when missing from checkpoint", async () => {
    const threadId = "test-state-no-auth";
    const checkpoint: any = {
      v: 4,
      id: "cp-no-auth",
      ts: new Date().toISOString(),
      channel_values: {
        messages: [
          { lc_id: ["langchain", "messages", "HumanMessage"], content: "hi" },
        ],
      },
      channel_versions: {},
      versions_seen: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-no-auth" } },
      checkpoint,
      { source: "loop", step: 0, parents: {} },
    );

    const state = await saver.getCheckpointState(threadId, "cp-no-auth");
    expect(state).not.toBeNull();
    // authorization should be undefined (old checkpoints may not have it)
    expect(state!.authorization).toBeUndefined();
  });
});

describe("close safety", () => {
  let saver: BunSqliteSaver;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openpx-test-"));
    saver = new BunSqliteSaver(join(tmpDir, "checkpoints.db"));
    saver.setup();
  });

  afterEach(() => {
    try { saver.close(); } catch { /* already closed */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dummyCheckpoint: Checkpoint = {
    v: 4,
    id: "cp-1",
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };

  it("put throws after close", async () => {
    saver.close();
    await expect(
      saver.put(
        { configurable: { thread_id: "t" } },
        dummyCheckpoint,
        { source: "loop", step: 0, parents: {} },
      ),
    ).rejects.toThrow("Database is closed");
  });

  it("putWrites throws after close", async () => {
    saver.close();
    await expect(
      saver.putWrites(
        { configurable: { thread_id: "t", checkpoint_id: "cp-1" } },
        [["channel1", "value1"]],
        "task-1",
      ),
    ).rejects.toThrow("Database is closed");
  });
});

describe("created_at migration", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backfills NULL created_at for legacy rows so listSessions does not exclude them", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openpx-test-"));
    const dbPath = join(tmpDir, "checkpoints.db");

    // Simulate a legacy database: create table without created_at, insert a row, then add column
    const db = new Database(dbPath);
    db.run("pragma journal_mode = wal");
    db.run(`create table if not exists checkpoints (
      thread_id text not null,
      checkpoint_ns text not null default '',
      checkpoint_id text not null,
      parent_checkpoint_id text,
      type text,
      checkpoint text,
      metadata text,
      primary key (thread_id, checkpoint_ns, checkpoint_id)
    )`);
    db.run(`create table if not exists writes (
      thread_id text not null,
      checkpoint_ns text not null default '',
      checkpoint_id text not null,
      task_id text not null,
      idx integer not null,
      channel text not null,
      type text,
      value text,
      primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    )`);
    // Insert a checkpoint row (created_at column doesn't exist yet)
    db.run(
      `insert into checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
       values (?, '', ?, 'json', '{}', '{}')`,
      ["legacy-thread", "cp-legacy"],
    );
    db.close();

    // Now open with BunSqliteSaver — setup() should add column AND backfill
    const saver = new BunSqliteSaver(dbPath);
    saver.setup();

    const db2 = (saver as any).db as Database;
    const row = db2
      .query<{ created_at: string | null }, []>(
        "SELECT created_at FROM checkpoints WHERE thread_id = 'legacy-thread'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.created_at).not.toBeNull();
    // Verify it's a valid datetime string
    expect(new Date(row!.created_at!.replace(" ", "T") + "Z").getTime()).not.toBeNaN();

    saver.close();
  });
});
