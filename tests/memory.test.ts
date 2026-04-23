import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLongTermMemory } from "../src/memory";

describe("SqliteLongTermMemory", () => {
  test("persists memories across store instances", () => {
    const dir = join(tmpdir(), "openpx-langgraph-code-agent-memory-test");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "memory.sqlite");

    const first = new SqliteLongTermMemory(dbPath);
    first.put({
      userId: "user-a",
      namespace: "preferences",
      key: "style",
      value: "Prefer concise TypeScript.",
    });
    first.close();

    const second = new SqliteLongTermMemory(dbPath);
    expect(second.list("user-a", "preferences")).toEqual([
      {
        namespace: "preferences",
        key: "style",
        value: "Prefer concise TypeScript.",
      },
    ]);
    expect(second.recallText("user-a")).toContain("Prefer concise TypeScript.");
    second.close();
  });
});
