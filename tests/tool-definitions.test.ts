import { describe, expect, test } from "bun:test";
import {
  createCodeAgentTools,
  createPlanAgentTools,
  isPlanReadOnlyShellCommand,
} from "../src/tool-definitions";

describe("code agent tool definitions", () => {
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
      "shell_execute",
      "apply_patch",
      "update_plan",
    ]);
    expect(tools[0].schema).toBeDefined();
    expect(tools[1].schema).toBeDefined();
    expect(tools[2].schema).toBeDefined();
  });

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

  test("exposes read-only shell and update_plan in plan mode", () => {
    const tools = createPlanAgentTools({
      workspace: "D:\\workspace",
    });

    expect(tools.map((item) => item.name)).toEqual(["shell_read", "update_plan"]);
    expect(String(tools[0].description)).toContain("Read-only");
    expect(String(tools[1].description)).toContain("plan mode");
  });

  test("classifies conservative plan shell commands as read-only", () => {
    expect(isPlanReadOnlyShellCommand("pwd")).toBe(true);
    expect(isPlanReadOnlyShellCommand("ls src")).toBe(true);
    expect(isPlanReadOnlyShellCommand("rg -n \"Plan\" src tests")).toBe(true);
    expect(isPlanReadOnlyShellCommand("cat package.json | head -n 20")).toBe(true);
    expect(isPlanReadOnlyShellCommand("git status --short")).toBe(true);
    expect(isPlanReadOnlyShellCommand("git diff -- src/runner.ts")).toBe(true);
  });

  test("rejects plan shell commands that can write, delete, or execute project code", () => {
    expect(isPlanReadOnlyShellCommand("echo hi > hello.txt")).toBe(false);
    expect(isPlanReadOnlyShellCommand("sed -i 's/a/b/' src/a.ts")).toBe(false);
    expect(isPlanReadOnlyShellCommand("rm -rf src")).toBe(false);
    expect(isPlanReadOnlyShellCommand("bun test")).toBe(false);
    expect(isPlanReadOnlyShellCommand("git add -A")).toBe(false);
    expect(isPlanReadOnlyShellCommand("mkdir -p tmp")).toBe(false);
  });
});
