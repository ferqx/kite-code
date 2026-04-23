import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "@langchain/langgraph-checkpoint";
import { BunSqliteSaver } from "../src/checkpoint";

describe("BunSqliteSaver", () => {
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

    const nextConfig = await saver.put(
      { configurable: { thread_id: "thread-a" } },
      checkpoint,
      { source: "input", step: 0, parents: {} },
    );
    saver.close();

    const restored = new BunSqliteSaver(dbPath);
    const tuple = await restored.getTuple({
      configurable: { thread_id: "thread-a" },
    });

    expect(nextConfig.configurable?.checkpoint_id).toBe("checkpoint-1");
    expect(tuple?.checkpoint.channel_values.task).toBe("write file");
    restored.close();
  });
});
