/**
 * 沙箱执行器集成测试 — 仅在 macOS 运行
 * Sandbox executor integration tests — macOS only
 *
 * 这些测试验证 sandbox-exec 的实际隔离效果。在非 macOS 平台上全部跳过。
 * These tests verify actual sandbox-exec isolation. Skipped on non-macOS platforms.
 */
import { describe, expect, test } from "bun:test";
import { createSandboxExecutor } from "../src/core/sandbox/executor";
import { homedir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const isMacOS = process.platform === "darwin";

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "openpx-sandbox-test-"));
  return ws;
}

function cleanupWorkspace(ws: string) {
  rmSync(ws, { recursive: true, force: true });
}

describe("sandbox executor integration", () => {
  if (!isMacOS) {
    test.skip("sandbox-exec integration tests are macOS-only", () => {});
    return;
  }

  test("executes commands within workspace successfully", async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: "pwd" });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(ws);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test("can read files within workspace", async () => {
    const ws = setupWorkspace();
    try {
      writeFileSync(join(ws, "hello.txt"), "hello sandbox");
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: "cat hello.txt" });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("hello sandbox");
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test("can write files within workspace", async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      await executor({ workspace: ws, command: "echo created > sandbox-test.txt" });
      const result = await executor({ workspace: ws, command: "cat sandbox-test.txt" });
      expect(result.stdout).toContain("created");
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test("blocks file read outside workspace", async () => {
    const ws = setupWorkspace();
    // 在真实 HOME 目录下创建测试文件，该路径不在沙箱白名单中
    // Create test file in real HOME, which is not in sandbox allowlist
    const secretFile = join(homedir(), `.openpx-sandbox-test-${process.pid}`);
    writeFileSync(secretFile, "secret");
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `cat "${secretFile}"`,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(secretFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test("blocks external network access", async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command:
          "curl -s --connect-timeout 3 --max-time 5 http://example.com 2>&1 || true",
      });
      // 沙箱应拒绝网络连接 / Sandbox should deny network connection
      // 退出码非 0 或 stderr/stdout 包含 sandbox 拒绝信息
      const output = result.stdout + result.stderr;
      const denied =
        result.exitCode !== 0 ||
        output.includes("Operation not permitted") ||
        output.includes("Could not resolve host") ||
        output.includes("deny") ||
        output === "";
      expect(denied).toBe(true);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test("kills commands exceeding CPU time limit", async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({
        enabled: true,
        workspace: ws,
        resourceLimits: { cpuTime: 3 },
      });
      // 无限循环应在约 3 秒后被 ulimit -t 杀死
      const result = await executor({
        workspace: ws,
        command: "while true; do :; done",
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test("rejects commands targeting dangerous file paths", async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: "echo alias ls=evil >> .bashrc",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Rejected");
      expect(result.stderr).toContain(".bashrc");
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test("disabled executor falls back to unsandboxed execution", async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: false, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: "echo unsandboxed",
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("unsandboxed");
    } finally {
      cleanupWorkspace(ws);
    }
  });
});
