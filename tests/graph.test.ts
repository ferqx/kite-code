import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  routeAfterAgent,
  routeAfterApproval,
  routeAfterReflect,
  routeAfterTools,
  routeAfterUserInput,
} from "../src/harness/routes";
import { normalizeUserInputResume } from "../src/harness/user-input";
import { runApprovedTool } from "../src/harness/tool-runner";
import { isReadOnlyWorkspaceAccess } from "../src/harness/state";
import { toolRequestFromMessage } from "../src/harness/tool-requests";
import type { CodeAgentState } from "../src/harness/state";
import type { AgentPlan, ShellResult } from "../src/shared/types";

const activePlan: AgentPlan = {
  name: "Implement state-first plan flow",
  description: "Persist access and plan in graph state.",
  status: "in_progress",
  steps: [{ step: "Inspect graph state", status: "in_progress" }],
};

// 图路由单元测试 / Graph routing unit tests — 验证 agent 主循环中各节点的路由逻辑和工具审批流
describe("graph local tool routing", () => {
  // 无待审批工具调用时，审批节点回到单一 agent / When no pending tool call exists, approval routes back to the single agent
  test("routes to agent when approval has no pending tool call", () => {
    expect(routeAfterApproval({ messages: [] } as unknown as CodeAgentState)).toBe("agent");
  });

  // 验证 graph state 中的 workspaceAccess 字段是只读执行边界的唯一权威来源 / workspaceAccess is the source of truth for read-only execution
  test("uses graph state workspaceAccess as the read-only source of truth", () => {
    expect(
      isReadOnlyWorkspaceAccess({ workspaceAccess: "read-only" } as CodeAgentState),
    ).toBe(true);
    expect(isReadOnlyWorkspaceAccess({ workspaceAccess: "write" } as CodeAgentState)).toBe(
      false,
    );
  });

  // 验证 write 访问下 update_plan 工具调用直接路由到 tools，无需审批 / update_plan skips approval under write access
  test("routes update_plan tool calls directly to tools without approval under write access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "update_plan",
                args: {
                  name: activePlan.name,
                  description: activePlan.description,
                  status: activePlan.status,
                  steps: activePlan.steps,
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 write 访问下 shell_read 只读工具调用直接路由到 tools，无需审批 / shell_read skips approval under write access
  test("routes shell_read tool calls directly to tools without approval under write access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_read",
                args: { command: "rg -n Plan src" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 write 访问下受保护的写入工具仍然进入 approval / Protected write tools still route through approval under write access
  test("routes protected write-access tool calls through approval", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "write_file",
                args: { path: "hello.txt", content: "hi" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("approval");
  });

  // 验证 read-only 访问下只读 shell 调用直接路由到 tools，无需审批 / Read-only shell calls route directly to tools under read-only access
  test("routes read-only shell calls directly to tools without approval", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "read-only",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_read",
                args: { command: "rg -n Plan src" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 ask_user 在 write 访问下不走工具审批，而是进入用户输入中断节点 / ask_user routes to user_input instead of approval under write access
  test("routes ask_user calls to user input under write access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-ask",
                name: "ask_user",
                args: {
                  question: "应该怎么处理缺失配置？",
                  options: [{ id: "default", label: "使用默认配置" }],
                  allow_free_text: true,
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("user_input");
  });

  // 验证 ask_user 在 read-only 访问下也不会被只读工具执行层拒绝 / ask_user is allowed under read-only access through the user_input node
  test("routes ask_user calls to user input under read-only access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "read-only",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-ask",
                name: "ask_user",
                args: {
                  question: "选择实现范围？",
                  options: [{ id: "minimal", label: "最小实现" }],
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("user_input");
  });

  // 验证 read-only 访问下有 final 文本时直接结束，不再经过 stop_check 或模式确认 / Read-only final ends directly without stop_check or mode confirmation
  test("ends read-only completion directly when final exists", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "read-only",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("__end__");
  });

  // 验证工具执行完成后，始终路由到 reflect 节点进行评估 / After tools complete, always route to reflect node for evaluation
  test("routes completed tool updates to reflect for evaluation", () => {
    expect(
      routeAfterTools({
        workspaceAccess: "read-only",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("reflect");
  });

  // 验证 read-only 访问下写入工具调用不路由到审批，而是直接到 tools 节点以拒绝执行 / Write tools under read-only access route to tools for rejection
  test("routes unexpected read-only write tool calls to tools for rejection instead of approval", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "read-only",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "write_file",
                args: { path: "hello.txt", content: "hi" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 ask_user 工具调用会解析为结构化用户输入请求 / ask_user tool call parses into a structured user input request
  test("parses ask_user tool calls", () => {
    const request = toolRequestFromMessage(
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-ask",
            name: "ask_user",
            args: {
              question: "选择方案？",
              options: [
                { id: "a", label: "方案 A", description: "最小改动" },
                { id: "b", label: "方案 B" },
              ],
              allow_free_text: true,
            },
          },
        ],
      }),
      "/tmp/workspace",
    );

    expect(request?.name).toBe("ask_user");
    if (!request || request.name !== "ask_user") {
      throw new Error("expected ask_user request");
    }
    expect(request?.protectedCommand).toBe("ask_user");
    expect(request?.args.question).toBe("选择方案？");
    expect(request?.args.options[0]?.id).toBe("a");
    expect(request?.args.allow_free_text).toBe(true);
  });

  // 验证用户输入中断恢复后回到 reflect，再继续 agent 主循环 / user_input returns through reflect after resume
  test("routes completed user input to reflect", () => {
    expect(
      routeAfterUserInput({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [],
        final: "",
      } as unknown as CodeAgentState),
    ).toBe("reflect");
  });

  // 验证用户输入恢复值既支持字符串，也支持结构化 answer/choice / User input resume supports strings and structured answers
  test("normalizes user input resume values", () => {
    expect(normalizeUserInputResume("使用最小实现")).toEqual({
      answer: "使用最小实现",
    });
    expect(normalizeUserInputResume({ answer: "A" })).toEqual({ answer: "A" });
    expect(normalizeUserInputResume({ choice: "minimal" })).toEqual({
      answer: "minimal",
    });
    expect(normalizeUserInputResume(true)).toEqual({ answer: "" });
  });

  // 验证 update_plan 工具执行后返回结构化的 plan 状态（名称、状态、步骤） / update_plan returns the structured plan state with name, status, and steps after execution
  test("update_plan returns the next plan state", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "update_plan",
        args: activePlan,
        reason: "Create plan",
        protectedCommand: "update_plan",
      },
      undefined,
      "read-only",
    );

    expect(result.ok).toBe(true);
    expect("plan" in result && result.plan ? result.plan.name : "").toBe(activePlan.name);
    expect("plan" in result && result.plan ? result.plan.status : "").toBe("in_progress");
    expect("plan" in result && result.plan ? result.plan.steps[0]?.step : "").toBe(
      "Inspect graph state",
    );
  });

  // 验证 write 访问下 update_plan 只更新计划，不自动切换访问权限 / update_plan updates plan without switching workspace access
  test("write-access update_plan keeps workspace access unchanged", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "update_plan",
        args: activePlan,
        reason: "Create plan",
        protectedCommand: "update_plan",
      },
      undefined,
      "write",
      null,
    );

    expect(result.ok).toBe(true);
    expect("plan" in result && result.plan ? result.plan.name : "").toBe(activePlan.name);
    expect("workspaceAccess" in result ? result.workspaceAccess : undefined).toBeUndefined();
  });

  // 验证 read-only 访问下允许执行只读 shell 命令（如 cat）并返回正常结果 / Read-only shell commands are allowed under read-only access
  test("allows read-only shell commands under read-only access", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "shell_read",
        args: { command: "cat package.json" },
        reason: "Read package",
        protectedCommand: "cat package.json",
      },
      async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "{}",
        stderr: "",
      }),
      "read-only",
    );

    expect(result.ok).toBe(true);
    expect((result as ShellResult).stdout).toBe("{}");
  });

  // 验证 read-only 访问下允许执行稳定工具 schema 中的只读 search 工具 / read-only access allows read-only search from the stable tool schema
  test("allows search under read-only access", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "search",
        args: { pattern: "Plan", path: "src/**/*.ts" },
        reason: "Search code",
        protectedCommand: "search Plan",
      },
      async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "src/model/context.ts:1:Plan",
        stderr: "",
      }),
      "read-only",
    );

    expect(result.ok).toBe(true);
    expect((result as ShellResult).stdout).toContain("src/model/context.ts");
  });

  // 验证 read-only 访问下拒绝包含写入重定向的 shell 命令 / Shell commands with write redirects are rejected under read-only access
  test("rejects write-like shell commands under read-only access", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "shell_read",
        args: { command: "echo hi > hello.txt" },
        reason: "Unexpected write",
        protectedCommand: "echo hi > hello.txt",
      },
      undefined,
      "read-only",
    );

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("shell_read");
  });

  // 验证 read-only 访问下拒绝非只读工具（如 write_file）的调用 / Non-read tools are rejected under read-only access
  test("rejects non-read tools under read-only access", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "write_file",
        args: { path: "hello.txt", content: "hi" },
        reason: "Unexpected write",
        protectedCommand: "write_file hello.txt",
      },
      undefined,
      "read-only",
    );

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("read-only");
  });

  // 验证重复工具调用不再由工具执行层拦截，循环边界交给图递归限制 / Repeated tool calls are not blocked by tool runner; graph recursion owns loop bounds
  test("does not intercept repeated read-only tool requests", async () => {
    const request = {
      id: "call-1",
      name: "shell_read" as const,
      args: { command: "cat package.json" },
      reason: "Read package",
      protectedCommand: "cat package.json",
    };

    const result = await runApprovedTool(
      "/tmp/workspace",
      request,
      async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "package",
        stderr: "",
      }),
      "read-only",
    );

    expect(result.ok).toBe(true);
    expect((result as ShellResult).stdout).toBe("package");
  });

  // 验证 reflect 路由在无 final 时返回单一 agent / reflect routes to agent when no final is set
  test("reflect routes to agent when no final is set", () => {
    expect(
      routeAfterReflect({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [],
        final: "",
      } as unknown as CodeAgentState),
    ).toBe("agent");
  });

  // 验证 reflect 路由在有 final 时直接结束 / reflect routes to END when final is set
  test("reflect routes to end when final is set", () => {
    expect(
      routeAfterReflect({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [],
        final: "All tasks completed.",
      } as unknown as CodeAgentState),
    ).toBe("__end__");
  });
});
