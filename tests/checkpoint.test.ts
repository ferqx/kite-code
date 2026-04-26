import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "@langchain/langgraph-checkpoint";
import { BunSqliteSaver } from "../src/persistence/checkpoint";

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
