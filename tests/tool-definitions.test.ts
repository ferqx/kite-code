import { describe, expect, test } from "bun:test";
import {
  createAgentTools,
  isReadOnlyShellCommand,
} from "../src/tools/definitions";

// Code Agent 工具定义与只读约束单元测试 / Code agent tool definitions & read-only constraint unit tests
describe("code agent tool definitions", () => {
  // 验证 agent 暴露稳定工具 schema / Agent exposes the stable tool schema
  test("exposes cache-stable agent tools plus update_plan", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    });

    expect(tools.map((item) => item.name)).toEqual([
      "read_file",
      "edit_file",
      "write_file",
      "search",
      "shell_read",
      "shell_execute",
      "update_plan",
    ]);
    expect(tools[0].schema).toBeDefined();
    expect(tools[1].schema).toBeDefined();
    expect(tools[2].schema).toBeDefined();
  });

  // 验证 update_plan 的 Zod schema 要求完整的 state-first plan 字段（name 必填） / update_plan Zod schema requires full state-first plan fields with name as required
  test("requires full state-first plan fields in update_plan schema", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
    });
    const updatePlanTool = tools.find((item) => item.name === "update_plan")!;
    expect(updatePlanTool).toBeDefined();
    const parsed = updatePlanTool.schema.safeParse({
      name: "State-first refactor",
      description: "Persist access and plan in graph state.",
      status: "in_progress",
      steps: [{ step: "Update graph state", status: "pending" }],
    });
    const missingName = updatePlanTool.schema.safeParse({
      description: "Persist access and plan in graph state.",
      status: "in_progress",
      steps: [{ step: "Update graph state", status: "pending" }],
    });

    expect(parsed.success).toBe(true);
    expect(missingName.success).toBe(false);
    expect(String(updatePlanTool.description)).toContain("current plan state");
  });

  // 验证工具 schema 不随工作区访问权限变化，实际边界由工具执行层拒绝 / Tool schema is stable; runner enforces access boundaries
  test("exposes one cache-stable tool schema", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
    });

    expect(tools.map((item) => item.name)).toEqual([
      "read_file",
      "edit_file",
      "write_file",
      "search",
      "shell_read",
      "shell_execute",
      "update_plan",
    ]);
    expect(String(tools.find((item) => item.name === "shell_read")?.description)).toContain(
      "Read-only",
    );
    expect(String(tools.find((item) => item.name === "update_plan")?.description)).toContain(
      "current plan state",
    );
  });

  // 验证常见只读 shell 命令（ls, cat, rg, git status 等）被正确分类为只读 / Common read-only shell commands (ls, cat, rg, git status, etc.) are correctly classified as read-only
  test("classifies conservative shell_read commands as read-only", () => {
    expect(isReadOnlyShellCommand("pwd")).toBe(true);
    expect(isReadOnlyShellCommand("ls src")).toBe(true);
    expect(isReadOnlyShellCommand("rg -n \"Plan\" src tests")).toBe(true);
    expect(isReadOnlyShellCommand("cat package.json | head -n 20")).toBe(true);
    expect(
      isReadOnlyShellCommand(
        'Get-ChildItem -Path "D:\\app\\openpx-new" -Recurse -Depth 2 -Name | Select-Object -First 100',
      ),
    ).toBe(true);
    expect(isReadOnlyShellCommand('Get-Content "package.json" -Raw')).toBe(true);
    expect(isReadOnlyShellCommand('Select-String -Path "src\\*.ts" -Pattern graph')).toBe(
      true,
    );
    expect(isReadOnlyShellCommand("git status --short")).toBe(true);
    expect(isReadOnlyShellCommand("git diff -- src/app/runner.ts")).toBe(true);
  });

  // 验证可能写入、删除或执行项目代码的 shell 命令被拒绝（sed -i, rm -rf, git add, mkdir 等） / Shell commands that can write, delete, or execute project code (sed -i, rm -rf, git add, mkdir, etc.) are rejected
  test("rejects shell_read commands that can write, delete, or execute project code", () => {
    expect(isReadOnlyShellCommand("echo hi > hello.txt")).toBe(false);
    expect(isReadOnlyShellCommand("sed -i 's/a/b/' src/a.ts")).toBe(false);
    expect(isReadOnlyShellCommand("rm -rf src")).toBe(false);
    expect(isReadOnlyShellCommand("bun test")).toBe(false);
    expect(isReadOnlyShellCommand("git add -A")).toBe(false);
    expect(isReadOnlyShellCommand("mkdir -p tmp")).toBe(false);
    expect(isReadOnlyShellCommand("find . -exec rm {} ;")).toBe(false);
    expect(isReadOnlyShellCommand("awk 'BEGIN { system(\"rm hello.txt\") }'")).toBe(
      false,
    );
  });
});
