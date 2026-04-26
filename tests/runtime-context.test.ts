import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { buildRuntimeContext } from "../src/model/runtime-context";

// 测试运行时上下文构建函数 / Test runtime context building function
describe("buildRuntimeContext", () => {
  // 验证 plan 模式下运行时上下文包含模式策略信息 / Verify plan mode runtime context includes mode and tool policy
  test("includes mode and tool policy in plan mode", () => {
    const context = buildRuntimeContext({
      userId: "user-a",
      workspace: "D:\\workspace",
      modelName: "deepseek-chat",
      messages: [new HumanMessage("/plan please inspect the repo")],
      mode: "plan",
      plan: {
        name: "Repository investigation",
        description: "Inspect the current graph implementation before editing.",
        status: "in_progress",
        steps: [{ step: "Inspect graph state", status: "in_progress" }],
      },
      now: new Date("2026-04-23T12:34:56.000Z"),
      timezone: "Asia/Shanghai",
    });

    expect(context).toContain("Time: 2026-04-23T12:34:56.000Z");
    expect(context).toContain("Timezone: Asia/Shanghai");
    expect(context).toContain("OS:");
    expect(context).toContain("Shell:");
    expect(context).toContain("Workspace: D:\\workspace");
    expect(context).toContain("Configured model: deepseek-chat");
    expect(context).toContain("Thread mode: plan");
    expect(context).toContain("Tool policy: read-only planning");
    expect(context).not.toContain("Plan state:"); // 动态计划状态不注入运行时上下文 / Plan state not injected into runtime context
    expect(context).not.toContain("Context summary:");
    expect(context).not.toContain("Progress heartbeat:");
    expect(context.length).toBeLessThan(1200);
  });

  // 验证 builder 模式下运行时上下文包含模式策略信息 / Verify builder mode runtime context includes mode and tool policy
  test("includes mode and tool policy in builder mode", () => {
    const context = buildRuntimeContext({
      userId: "user-b",
      workspace: "D:\\workspace",
      messages: [new HumanMessage("please continue")],
      mode: "builder",
      plan: {
        name: "State-first refactor",
        description: "Persist mode and plan in graph state while executing.",
        status: "in_progress",
        steps: [{ step: "Update runtime context", status: "completed" }],
      },
      now: new Date("2026-04-23T12:34:56.000Z"),
      timezone: "Asia/Shanghai",
    });

    expect(context).toContain("Thread mode: builder");
    expect(context).toContain(
      "Tool policy: execute mode; write/delete/execute tools require approval before running",
    );
    expect(context).not.toContain("Plan state:");
    expect(context).not.toContain("Context summary:");
  });
});
