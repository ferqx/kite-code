import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { buildRuntimeContext } from "../src/runtime-context";

describe("buildRuntimeContext", () => {
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

    expect(context).toContain("Time: 2026-04-23T12:34:56.000Z");
    expect(context).toContain("Timezone: Asia/Shanghai");
    expect(context).toContain("OS:");
    expect(context).toContain("Shell:");
    expect(context).toContain("Workspace: D:\\workspace");
    expect(context).toContain("Configured model: deepseek-chat");
    expect(context).toContain("Thread mode: plan");
    expect(context).toContain("Plan state: active");
    expect(context).toContain("Plan name: Repository investigation");
    expect(context).toContain(
      "Plan description: Inspect the current graph implementation before editing.",
    );
    expect(context).toContain("Plan status: in_progress");
    expect(context).toContain("Plan steps: in_progress:Inspect graph state");
    expect(context).toContain("Tool policy: read-only planning");
    expect(context).not.toContain("Checkpoint DB:");
    expect(context).not.toContain("Roles so far:");
    expect(context).not.toContain("Pending request:");
    expect(context).not.toContain("Tool result summary:");
    expect(context).not.toContain("Draft final:");
    expect(context.length).toBeLessThan(1200);
  });

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

    expect(context).toContain("Thread mode: builder");
    expect(context).toContain("Plan state: active");
    expect(context).toContain("Plan name: State-first refactor");
    expect(context).toContain("Plan status: in_progress");
    expect(context).toContain("Plan steps: completed:Update runtime context");
    expect(context).toContain(
      "Tool policy: execute mode; write/delete/execute tools require approval before running",
    );
  });
});
