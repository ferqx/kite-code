import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchTool, assertInsideWorkspace, shellTool } from "../src/tools";

// 工具安全与执行单元测试 / Tool safety & execution unit tests — 验证 workspace 边界约束和 shell/patch 工具行为
describe("tool safety", () => {
  // 验证工作区内部路径被允许 / Paths inside the workspace are allowed by the safety boundary check
  test("allows paths inside the workspace", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-safe");

    expect(assertInsideWorkspace(workspace, "inside.txt")).toBe(
      join(workspace, "inside.txt"),
    );
  });

  // 验证以点号开头的文件名（如 ..notes.txt）不会被误判为路径穿越 / Dot-prefixed filenames (e.g., ..notes.txt) are not falsely flagged as path traversal
  test("allows workspace files whose names start with dots", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-safe");

    expect(assertInsideWorkspace(workspace, "..notes.txt")).toBe(
      join(workspace, "..notes.txt"),
    );
  });

  // 验证工作区外部路径被拒绝以防止路径穿越攻击 / Paths outside the workspace are rejected to prevent path traversal attacks
  test("rejects paths outside the workspace", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-safe");

    expect(() => assertInsideWorkspace(workspace, "..\\outside.txt")).toThrow(
      /outside workspace/,
    );
  });

  // 验证 apply_patch 工具能在工作区内创建文件 / apply_patch tool successfully creates files inside the workspace
  test("creates files inside the workspace", async () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-patch");
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = await applyPatchTool({
      workspace,
      path: "hello.txt",
      content: "hello from patch\n",
      shellExecutor: async (input) => {
        writeFileSync(join(workspace, "hello.txt"), "hello from patch\n", "utf8");
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspace, "hello.txt"))).toBe(true);
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe(
      "hello from patch\n",
    );
  });

  // 验证 apply_patch 通过 shell executor 委托执行文件编辑，而非直接写文件 / apply_patch delegates file edits through shell executor rather than writing directly
  test("apply_patch delegates edits through shell execution", async () => {
    const commands: string[] = [];
    const result = await applyPatchTool({
      workspace: join(tmpdir(), "openpx-langgraph-tools-shell-delegate"),
      path: "delegated.txt",
      content: "delegated through shell\n",
      shellExecutor: async (input) => {
        commands.push(input.command);
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(process.platform === "win32" ? "Set-Content" : "bun -e");
  });

  // 验证 shellTool 返回结构化的命令执行结果（command, exitCode, stdout, stderr） / shellTool returns structured command execution results with command, exitCode, stdout, and stderr
  test("returns structured shell command results", async () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-shell");
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: "pwd" });

    expect(result.command).toBe("pwd");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });
});
