import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxExecutor } from "../src/core/sandbox/executor";

describe("shell execute integration", () => {
  const workspace = join(tmpdir(), "openpx-e2e-shell");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "test.txt"), "hello");

  // 使用与 TUI 完全相同的 createSandboxExecutor 创建 shell 执行器
  const shell = createSandboxExecutor({ enabled: true, workspace });

  test("ls returns file list with ok=true", async () => {
    const r = await shell({ workspace, command: "ls" });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("test.txt");
  });

  test("pipe with grep works", async () => {
    const r = await shell({ workspace, command: "echo hello123 | grep hello" });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  test("nonexistent command returns ok=false", async () => {
    const r = await shell({ workspace, command: "nonexistent_cmd_xyz 2>&1" });
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  test("pwd matches workspace", async () => {
    const r = await shell({ workspace, command: "pwd" });
    expect(r.ok).toBe(true);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test("stderr capture works", async () => {
    const r = await shell({ workspace, command: "ls /nonexistent_path_xyz 2>&1" });
    expect(r.ok).toBe(false);
    expect(r.stderr.length + r.stdout.length).toBeGreaterThan(0);
  });
});
