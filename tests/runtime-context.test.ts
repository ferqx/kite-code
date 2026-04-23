import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { buildRuntimeContext } from "../src/runtime-context";

describe("buildRuntimeContext", () => {
  test("includes volatile runtime facts in a compact dynamic context", () => {
    const context = buildRuntimeContext({
      userId: "user-a",
      workspace: "D:\\workspace",
      modelName: "deepseek-chat",
      messages: [
        new ToolMessage({
          content: JSON.stringify({
            ok: true,
            plan: { items: [{ step: "Draft plan", status: "pending" }] },
          }),
          tool_call_id: "call-1",
        }),
      ],
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
    expect(context).toContain("pending:Draft plan");
    expect(context).toContain("Tool policy: read-only planning");
    expect(context).not.toContain("Checkpoint DB:");
    expect(context).not.toContain("Roles so far:");
    expect(context).not.toContain("Plan draft:");
    expect(context).not.toContain("Pending request:");
    expect(context).not.toContain("Tool result summary:");
    expect(context).not.toContain("Draft final:");
    expect(context.length).toBeLessThan(1000);
  });
});
