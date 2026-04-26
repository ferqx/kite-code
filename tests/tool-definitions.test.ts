import { describe, expect, test } from "bun:test";
import {
  createCodeAgentTools,
  createPlanAgentTools,
  isPlanReadOnlyShellCommand,
} from "../src/tools/definitions";

// Code Agent 工具定义与只读约束单元测试 / Code agent tool definitions & read-only constraint unit tests
describe("code agent tool definitions", () => {
  // 验证 builder 模式包含所有工具 / Builder mode includes all tools
  test("exposes builder tools plus update_plan", () => {
    const tools = createCodeAgentTools({
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
      "shell_execute",
      "update_plan",
    ]);
    expect(tools[0].schema).toBeDefined();
    expect(tools[1].schema).toBeDefined();
    expect(tools[2].schema).toBeDefined();
  });

  // 验证 update_plan 的 Zod schema 要求完整的 state-first plan 字段（name 必填） / update_plan Zod schema requires full state-first plan fields with name as required
  test("requires full state-first plan fields in update_plan schema", () => {
    const tools = createPlanAgentTools({
      workspace: "D:\\workspace",
    });
    const updatePlanTool = tools[1];
    const parsed = updatePlanTool.schema.safeParse({
      name: "State-first refactor",
      description: "Persist mode and plan in graph state.",
      status: "in_progress",
      steps: [{ step: "Update graph state", status: "pending" }],
    });
    const missingName = updatePlanTool.schema.safeParse({
      description: "Persist mode and plan in graph state.",
      status: "in_progress",
      steps: [{ step: "Update graph state", status: "pending" }],
    });

    expect(parsed.success).toBe(true);
    expect(missingName.success).toBe(false);
    expect(String(updatePlanTool.description)).toContain("plan mode");
  });

  // 验证 plan 模式只公开 shell_read 和 update_plan 两个工具，不包含写入工具 / Plan mode only exposes shell_read and update_plan, no write tools
  test("exposes read-only shell and update_plan in plan mode", () => {
    const tools = createPlanAgentTools({
      workspace: "D:\\workspace",
    });

    expect(tools.map((item) => item.name)).toEqual(["shell_read", "update_plan"]);
    expect(String(tools[0].description)).toContain("Read-only");
    expect(String(tools[1].description)).toContain("plan mode");
  });

  // 验证常见只读 shell 命令（ls, cat, rg, git status 等）被正确分类为只读 / Common read-only shell commands (ls, cat, rg, git status, etc.) are correctly classified as read-only
  test("classifies conservative plan shell commands as read-only", () => {
    expect(isPlanReadOnlyShellCommand("pwd")).toBe(true);
    expect(isPlanReadOnlyShellCommand("ls src")).toBe(true);
    expect(isPlanReadOnlyShellCommand("rg -n \"Plan\" src tests")).toBe(true);
    expect(isPlanReadOnlyShellCommand("cat package.json | head -n 20")).toBe(true);
    expect(
      isPlanReadOnlyShellCommand(
        'Get-ChildItem -Path "D:\\app\\openpx-new" -Recurse -Depth 2 -Name | Select-Object -First 100',
      ),
    ).toBe(true);
    expect(isPlanReadOnlyShellCommand('Get-Content "package.json" -Raw')).toBe(true);
    expect(isPlanReadOnlyShellCommand('Select-String -Path "src\\*.ts" -Pattern graph')).toBe(
      true,
    );
    expect(isPlanReadOnlyShellCommand("git status --short")).toBe(true);
    expect(isPlanReadOnlyShellCommand("git diff -- src/app/runner.ts")).toBe(true);
  });

  // 验证可能写入、删除或执行项目代码的 shell 命令被拒绝（sed -i, rm -rf, git add, mkdir 等） / Shell commands that can write, delete, or execute project code (sed -i, rm -rf, git add, mkdir, etc.) are rejected
  test("rejects plan shell commands that can write, delete, or execute project code", () => {
    expect(isPlanReadOnlyShellCommand("echo hi > hello.txt")).toBe(false);
    expect(isPlanReadOnlyShellCommand("sed -i 's/a/b/' src/a.ts")).toBe(false);
    expect(isPlanReadOnlyShellCommand("rm -rf src")).toBe(false);
    expect(isPlanReadOnlyShellCommand("bun test")).toBe(false);
    expect(isPlanReadOnlyShellCommand("git add -A")).toBe(false);
    expect(isPlanReadOnlyShellCommand("mkdir -p tmp")).toBe(false);
    expect(isPlanReadOnlyShellCommand("find . -exec rm {} ;")).toBe(false);
    expect(isPlanReadOnlyShellCommand("awk 'BEGIN { system(\"rm hello.txt\") }'")).toBe(
      false,
    );
  });
});
