import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  routeAfterApproval,
  routeAfterAgentPlan,
  routeAfterAgentBuild,
  routeAfterTools,
  routeAfterReflect,
} from "../src/harness/routes";
import { recordToolProgress } from "../src/harness/progress";
import { runApprovedTool } from "../src/harness/tool-runner";
import { isPlanMode } from "../src/harness/state";
import type { CodeAgentState } from "../src/harness/state";
import type { AgentPlan, AgentProgressLedger, ShellResult } from "../src/shared/types";

const activePlan: AgentPlan = {
  name: "Implement state-first plan flow",
  description: "Persist mode and plan in graph state.",
  status: "in_progress",
  steps: [{ step: "Inspect graph state", status: "in_progress" }],
};

// 图路由单元测试 / Graph routing unit tests — 验证 agent 主循环中各节点的路由逻辑和工具审批流
describe("graph local tool routing", () => {
  // 无待审批工具调用时，审批节点根据 mode 路由回对应 agent / When no pending tool call exists, approval routes to correct agent by mode
  test("routes to agent_build when approval has no pending tool call", () => {
    expect(routeAfterApproval({ messages: [] } as unknown as CodeAgentState)).toBe("agent_build");
  });

  // 验证 graph state 中的 mode 字段是判断 plan 模式的唯一权威来源 / Graph state mode field is the single source of truth for plan mode detection
  test("uses graph state mode as the plan mode source of truth", () => {
    expect(isPlanMode({ mode: "plan" } as CodeAgentState)).toBe(true); // plan 字符串应被识别为 plan 模式 / "plan" string should be recognized as plan mode
    expect(isPlanMode({ mode: "builder" } as CodeAgentState)).toBe(false); // builder 字符串不应被识别为 plan 模式 / "builder" string should NOT be recognized as plan mode
  });

  // 验证 builder 模式下 update_plan 工具调用直接路由到 tools，无需审批 / update_plan tool calls skip approval and go directly to tools in builder mode
  test("routes update_plan tool calls directly to tools without approval in builder mode", () => {
    expect(
      routeAfterAgentBuild({
        mode: "builder",
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

  // 验证 builder 模式下受保护的写入工具仍然进入 approval / Protected builder write tools still route through approval
  test("routes protected builder tool calls through approval", () => {
    expect(
      routeAfterAgentBuild({
        mode: "builder",
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

  // 验证 plan 模式下只读 shell 调用直接路由到 tools，无需审批 / Read-only shell calls in plan mode are routed directly to tools without approval
  test("routes plan read-only shell calls directly to tools without approval", () => {
    expect(
      routeAfterAgentPlan({
        mode: "plan",
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

  // 验证 plan 模式下有 final 文本时直接结束，不再经过 stop_check 或模式确认 / Plan final ends directly without stop_check or mode confirmation
  test("ends plan completion directly when final exists", () => {
    expect(
      routeAfterAgentPlan({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("__end__");
  });

  // 验证 plan 模式下即使没有结构化 plan，final 也由模型约束负责，不再由 stop_check 拦截 / Unstructured plan final also ends without stop_check
  test("ends unstructured plan-mode final directly", () => {
    expect(
      routeAfterAgentPlan({
        mode: "plan",
        plan: null,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan text without update_plan",
      } as unknown as CodeAgentState),
    ).toBe("__end__");
  });

  // 验证工具执行完成后，始终路由到 reflect 节点进行评估 / After tools complete, always route to reflect node for evaluation
  test("routes completed plan tool updates to reflect for evaluation", () => {
    expect(
      routeAfterTools({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("reflect");
  });

  // 验证 plan 模式下写入工具调用不路由到审批，而是直接到 tools 节点以拒绝执行 / Non-read tool calls in plan mode route to tools (for rejection) instead of approval
  test("routes unexpected plan write tool calls to tools for rejection instead of approval", () => {
    expect(
      routeAfterAgentPlan({
        mode: "plan",
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
      "plan",
    );

    expect(result.ok).toBe(true);
    expect("plan" in result && result.plan ? result.plan.name : "").toBe(activePlan.name);
    expect("plan" in result && result.plan ? result.plan.status : "").toBe("in_progress");
    expect("plan" in result && result.plan ? result.plan.steps[0]?.step : "").toBe(
      "Inspect graph state",
    );
  });

  // 验证 builder 模式下 update_plan 会将图模式从 builder 切换为 plan / When update_plan is called in builder mode, it switches the graph mode to plan
  test("builder update_plan switches the graph into plan mode before execution", async () => {
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
      "builder",
      null,
    );

    expect(result.ok).toBe(true);
    expect("mode" in result ? result.mode : "").toBe("plan");
  });

  // 验证 plan 模式下允许执行只读 shell 命令（如 cat）并返回正常结果 / Read-only shell commands (e.g., cat) are allowed in plan mode and return normal results
  test("allows read-only shell commands when the thread is in plan mode", async () => {
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
      "plan",
    );

    expect(result.ok).toBe(true);
    expect((result as ShellResult).stdout).toBe("{}");
  });

  // 验证 plan 模式下拒绝包含写入重定向的 shell 命令 / Shell commands with write redirects (e.g., echo > file) are rejected in plan mode
  test("rejects write-like shell commands when the thread is in plan mode", async () => {
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
      "plan",
    );

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("shell_read");
  });

  // 验证 plan 模式下拒绝非只读工具（如 write_file）的调用 / Non-read tools (e.g., write_file) are rejected in plan mode
  test("rejects non-read tools when the thread is in plan mode", async () => {
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
      "plan",
    );

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("Plan mode");
  });

  // 验证第三连续相同工具调用被死循环守卫拦截 / Third consecutive identical tool call is blocked by the doom-loop guard to prevent infinite loops
  test("intercepts the third consecutive identical read-only tool request", async () => {
    const request = {
      id: "call-1",
      name: "shell_read" as const,
      args: { command: "cat package.json" },
      reason: "Read package",
      protectedCommand: "cat package.json",
    };
    const ledger: AgentProgressLedger = {
      toolCallCount: 2,
      stagnantStepCount: 0,
      repeatedCallCount: 2,
      lastToolSignature: "shell_read:{\"command\":\"cat package.json\"}",
      recentOutputSignatures: [],
      heartbeat: {
        goal: "",
        findings: [],
        nextAction: "",
        blockers: [],
        verification: [],
      },
    };

    const result = await runApprovedTool(
      "/tmp/workspace",
      request,
      async () => {
        throw new Error("doom-loop guard should prevent execution");
      },
      "plan",
      null,
      ledger,
    );

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("Repeated tool request blocked");
  });

  // 验证不同命令会重置重复调用计数器 / Different commands reset the repeated-call counter, preventing false doom-loop detection
  test("different commands reset the repeated-call counter", () => {
    const previous: AgentProgressLedger = {
      toolCallCount: 1,
      stagnantStepCount: 0,
      repeatedCallCount: 1,
      lastToolSignature: "shell_read:{\"command\":\"cat package.json\"}",
      recentOutputSignatures: [],
      heartbeat: {
        goal: "",
        findings: [],
        nextAction: "",
        blockers: [],
        verification: [],
      },
    };

    const next = recordToolProgress({
      previous,
      requestName: "shell_read",
      requestArgs: { command: "cat src/harness/graph.ts" },
      result: {
        ok: true,
        command: "cat src/harness/graph.ts",
        exitCode: 0,
        stdout: "graph",
        stderr: "",
      },
      previousEvidence: { commands: ["cat package.json"], files: [], verification: [] },
      nextEvidence: { commands: ["cat package.json", "cat src/harness/graph.ts"], files: [], verification: [] },
      previousPlan: null,
      nextPlan: null,
    });

    expect(next.repeatedCallCount).toBe(1);
    expect(next.lastToolSignature).toBe('shell_read:{"command":"cat src/harness/graph.ts"}');
  });

  // 验证停滞看门狗在连续5次无进展工具调用后介入，注入阻塞信息提示换策略 / Stagnant watchdog intervenes after 5 consecutive unproductive tool calls, injecting blocker info and suggesting strategy change
  test("watchdog intervenes after five stagnant tool results without stopping", () => {
    const previous: AgentProgressLedger = {
      toolCallCount: 4,
      stagnantStepCount: 4,
      repeatedCallCount: 1,
      lastToolSignature: "shell_read:{\"command\":\"cat a.txt\"}",
      recentOutputSignatures: [
        '{"exitCode":0,"ok":true,"stderr":"","stdout":"same-output"}',
      ],
      heartbeat: {
        goal: "",
        findings: [],
        nextAction: "",
        blockers: [],
        verification: [],
      },
    };

    const next = recordToolProgress({
      previous,
      requestName: "shell_read",
      requestArgs: { command: "cat b.txt" },
      result: {
        ok: true,
        command: "cat b.txt",
        exitCode: 0,
        stdout: "same-output",
        stderr: "",
      },
      previousEvidence: { commands: ["cat a.txt"], files: [], verification: [] },
      nextEvidence: { commands: ["cat a.txt"], files: [], verification: [] },
      previousPlan: null,
      nextPlan: null,
    });

    expect(next.stagnantStepCount).toBe(5);
    expect(next.heartbeat.blockers.join("\n")).toContain("No progress detected");
    expect(next.heartbeat.nextAction).toContain("change strategy");
  });

  // 验证新增验证证据会重置停滞计数器 / New verification evidence resets the stagnant step counter, recognizing real progress
  test("new verification evidence resets stagnant progress count", () => {
    const previous: AgentProgressLedger = {
      toolCallCount: 3,
      stagnantStepCount: 3,
      repeatedCallCount: 1,
      lastToolSignature: "shell_execute:{\"command\":\"bun test\"}",
      recentOutputSignatures: ["old"],
      heartbeat: {
        goal: "",
        findings: [],
        nextAction: "",
        blockers: [],
        verification: [],
      },
    };

    const next = recordToolProgress({
      previous,
      requestName: "shell_execute",
      requestArgs: { command: "bun test" },
      result: {
        ok: true,
        command: "bun test",
        exitCode: 0,
        stdout: "same",
        stderr: "",
      },
      previousEvidence: { commands: ["bun test"], files: [], verification: [] },
      nextEvidence: { commands: ["bun test"], files: [], verification: ["bun test: ok (0)"] },
      previousPlan: null,
      nextPlan: null,
    });

    expect(next.stagnantStepCount).toBe(0);
    expect(next.heartbeat.verification).toContain("bun test: ok (0)");
  });

  // 验证 reflect 路由在无 final 时返回 agent_build / reflect routes to agent_build when no final is set (builder is default)
  test("reflect routes to agent_build when no final is set", () => {
    expect(
      routeAfterReflect({
        mode: "builder",
        workspace: "/tmp/workspace",
        messages: [],
        final: "",
      } as unknown as CodeAgentState),
    ).toBe("agent_build");
  });

  // 验证 reflect 路由在 plan 模式下返回 agent_plan，让模型自行总结或继续 / reflect routes back to agent_plan in plan mode
  test("reflect routes to agent_plan when plan is set in plan mode", () => {
    expect(
      routeAfterReflect({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "",
      } as unknown as CodeAgentState),
    ).toBe("agent_plan");
  });

  // 验证 reflect 路由在 builder 有 final 时直接结束 / reflect routes to END when builder final is set
  test("reflect routes to end when builder final is set", () => {
    expect(
      routeAfterReflect({
        mode: "builder",
        workspace: "/tmp/workspace",
        messages: [],
        final: "All tasks completed.",
      } as unknown as CodeAgentState),
    ).toBe("__end__");
  });
});
