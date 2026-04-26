import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { buildRuntimeContext } from "../src/model/runtime-context";

// 测试运行时上下文构建函数 / Test runtime context building function
describe("buildRuntimeContext", () => {
  // 验证 plan 模式下运行时上下文包含计划详情和只读限制 / Verify plan mode runtime context includes plan details and read-only policy
  test("includes plan details from graph state in plan mode", () => {
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

    expect(context).toContain("Time: 2026-04-23T12:34:56.000Z"); // 时间戳 / Timestamp
    expect(context).toContain("Timezone: Asia/Shanghai"); // 时区 / Timezone
    expect(context).toContain("OS:");
    expect(context).toContain("Shell:");
    expect(context).toContain("Workspace: D:\\workspace");
    expect(context).toContain("Configured model: deepseek-chat");
    expect(context).toContain("Thread mode: plan"); // 模式为 plan / Mode is plan
    expect(context).toContain("Plan state: active"); // 计划处于活跃状态 / Plan is active
    expect(context).toContain("Plan name: Repository investigation");
    expect(context).toContain(
      "Plan description: Inspect the current graph implementation before editing.",
    );
    expect(context).toContain("Plan status: in_progress");
    expect(context).toContain("Plan steps: in_progress:Inspect graph state"); // 步骤及状态 / Step and status
    expect(context).toContain("Tool policy: read-only planning");
    expect(context).not.toContain("Checkpoint DB:"); // plan 模式不包含这些字段 / Plan mode excludes these fields
    expect(context).not.toContain("Roles so far:");
    expect(context).not.toContain("Pending request:");
    expect(context).not.toContain("Tool result summary:");
    expect(context).not.toContain("Draft final:");
    expect(context.length).toBeLessThan(1200); // 上下文长度有限 / Context length bounded
  });

  // 验证 builder 模式下同样能看到活跃计划详情 / Verify builder mode also shows active plan details
  test("keeps active plan details visible in builder mode", () => {
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

    expect(context).toContain("Thread mode: builder"); // 模式为 builder / Mode is builder
    expect(context).toContain("Plan state: active"); // 计划仍然可见 / Plan still visible
    expect(context).toContain("Plan name: State-first refactor");
    expect(context).toContain("Plan status: in_progress");
    expect(context).toContain("Plan steps: completed:Update runtime context");
    expect(context).toContain(
      "Tool policy: execute mode; write/delete/execute tools require approval before running", // builder 模式需要审批 / Builder mode requires approval
    );
  });
});
