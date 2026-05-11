import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  buildCacheableRuntimeContext,
  buildRuntimeContext,
} from "../src/core/model/runtime-context";

// 测试运行时上下文构建函数 / Test runtime context building function
describe("buildRuntimeContext", () => {
  // 验证 read-only 访问下运行时上下文只包含稳定访问策略信息 / Verify read-only access runtime context only includes stable access policy
  test("includes concise workspace access policy under read-only access without identity noise", () => {
    const context = buildRuntimeContext({
      workspace: "D:\\workspace",
      messages: [new HumanMessage("/plan please inspect the repo")],
      workspaceAccess: "read-only",
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
    expect(context).toContain("Workspace access policy:");
    expect(context).toContain("ask_user when clarification is needed");
    expect(context).toContain("read-only access rejects write/delete/execute tools");
    expect(context).not.toContain("Tool policy (plan mode):");
    expect(context).not.toContain("Configured model:");
    expect(context).not.toContain("User ID:");
    expect(context).not.toContain("Thread mode:");
    expect(context).not.toContain("Current workspace access:");
    expect(context).not.toContain("Plan state:"); // 动态计划状态不注入运行时上下文 / Plan state not injected into runtime context
    expect(context).not.toContain("Context summary:");
    expect(context.length).toBeLessThan(1200);
  });

  // 验证 write 访问下运行时上下文包含合并后的访问策略信息 / Verify write access runtime context includes combined access policy
  test("includes concise workspace access policy under write access", () => {
    const context = buildRuntimeContext({
      workspace: "D:\\workspace",
      messages: [new HumanMessage("please continue")],
      workspaceAccess: "write",
      plan: {
        name: "State-first refactor",
        description: "Persist access and plan in graph state while executing.",
        status: "in_progress",
        steps: [{ step: "Update runtime context", status: "completed" }],
      },
      now: new Date("2026-04-23T12:34:56.000Z"),
      timezone: "Asia/Shanghai",
    });

    expect(context).toContain("Workspace access policy:");
    expect(context).toContain("ask_user when clarification is needed");
    expect(context).toContain("write access requires approval for write/delete/execute tools");
    expect(context).not.toContain("Tool policy (builder mode):");
    expect(context).not.toContain("User ID:");
    expect(context).not.toContain("Thread mode:");
    expect(context).not.toContain("Current workspace access:");
    expect(context).not.toContain("Plan state:");
    expect(context).not.toContain("Context summary:");
  });

  // 验证可缓存运行时上下文不随 read-only/write 访问变化，避免破坏 provider 前缀缓存 / Verify cacheable runtime context is stable across access values
  test("keeps cacheable runtime context stable across read-only and write access", () => {
    const readOnlyContext = buildCacheableRuntimeContext({
      workspace: "D:\\workspace",
      messages: [new HumanMessage("inspect")],
      workspaceAccess: "read-only",
      plan: null,
    });
    const writeContext = buildCacheableRuntimeContext({
      workspace: "D:\\workspace",
      messages: [new HumanMessage("inspect")],
      workspaceAccess: "write",
      plan: null,
    });

    expect(readOnlyContext).toBe(writeContext);
    expect(readOnlyContext).toContain("Workspace access policy:");
    expect(readOnlyContext).not.toContain("Tool policy (plan mode):");
    expect(readOnlyContext).not.toContain("Tool policy (builder mode):");
    expect(readOnlyContext).not.toContain("Current workspace access:");
  });
});
