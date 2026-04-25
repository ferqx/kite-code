import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  evaluateStopCheck,
  recordToolProgress,
  isPlanMode,
  routeAfterApproval,
  routeAfterAgent,
  routeAfterStopCheck,
  routeAfterTools,
  runApprovedTool,
  type CodeAgentState,
} from "../src/graph";
import type { AgentPlan, AgentProgressLedger, ShellResult } from "../src/types";

const activePlan: AgentPlan = {
  name: "Implement state-first plan flow",
  description: "Persist mode and plan in graph state.",
  status: "in_progress",
  steps: [{ step: "Inspect graph state", status: "in_progress" }],
};

// 图路由单元测试 / Graph routing unit tests — 验证 agent 主循环中各节点的路由逻辑、stop check 守卫和工具审批流
describe("graph local tool routing", () => {
  // 无待审批工具调用时，审批节点直接回到 agent / When no pending tool call exists, approval node returns to agent immediately
  test("stays in agent when approval has no pending tool call", () => {
    expect(routeAfterApproval({ messages: [] } as unknown as CodeAgentState)).toBe("agent");
  });

  // 验证 graph state 中的 mode 字段是判断 plan 模式的唯一权威来源 / Graph state mode field is the single source of truth for plan mode detection
  test("uses graph state mode as the plan mode source of truth", () => {
    expect(isPlanMode({ mode: "plan" } as CodeAgentState)).toBe(true); // plan 字符串应被识别为 plan 模式 / "plan" string should be recognized as plan mode
    expect(isPlanMode({ mode: "builder" } as CodeAgentState)).toBe(false); // builder 字符串不应被识别为 plan 模式 / "builder" string should NOT be recognized as plan mode
  });

  // 验证 builder 模式下 update_plan 工具调用直接路由到 tools，无需审批 / update_plan tool calls skip approval and go directly to tools in builder mode
  test("routes update_plan tool calls directly to tools without approval in builder mode", () => {
    expect(
      routeAfterAgent({
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

  // 验证 plan 模式下只读 shell 调用直接路由到 tools，无需审批 / Read-only shell calls in plan mode are routed directly to tools without approval
  test("routes plan read-only shell calls directly to tools without approval", () => {
    expect(
      routeAfterAgent({
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

  // 验证 plan 模式下有 final 文本且有有效 plan 时，路由到 stop_check 进行最终守卫检查 / When plan mode has final text AND a valid plan, route to stop_check for final guard evaluation
  test("routes plan completion through stop check when final exists and plan mode is active", () => {
    expect(
      routeAfterAgent({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("stop_check"); // 有 final + 有 plan → 必须经 stop_check 守卫 / final + plan present → must pass stop_check guard
  });

  // 验证 plan 模式下无结构化 plan 但有 final 文本时，同样路由到 stop_check / Even without structured plan, final text in plan mode still routes to stop_check
  test("routes unstructured plan-mode final text through stop check", () => {
    expect(
      routeAfterAgent({
        mode: "plan",
        plan: null,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan text without update_plan",
      } as unknown as CodeAgentState),
    ).toBe("stop_check"); // 无 plan 但有 final → 仍需 stop_check 判定 / no plan but has final → still needs stop_check to evaluate
  });

  // 验证工具执行完成后，plan 模式下已完成的 plan 同样路由到 stop_check / After tools complete, completed plan updates route to stop_check in plan mode
  test("routes completed plan tool updates through stop check", () => {
    expect(
      routeAfterTools({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("stop_check");
  });

  // 验证 stop_check 守卫阻止"读预算耗尽"的 final 文本提前结束流程 / Stop check guard rejects "read budget reached" finals without a valid plan
  test("does not treat a plan read-budget final as ready for approval without a plan", () => {
    const checked = evaluateStopCheck({
        mode: "plan",
        plan: null,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan read budget reached",
      } as unknown as CodeAgentState);

    expect(checked.final).toBe(""); // final 被清空，阻止流程结束 / final cleared, preventing premature completion
  });

  // 验证 stop_check 通过后，有效的 plan final 路由到审批节点 / After stop_check passes, approved plan finals route to the approval node
  test("routes approved plan finals from stop check to approval", () => {
    expect(
      routeAfterStopCheck({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("approval"); // stop_check 放行后进入审批 / after stop_check greenlight, enter approval
  });

  // 验证 plan 模式下写入工具调用不路由到审批，而是直接到 tools 节点以拒绝执行 / Non-read tool calls in plan mode route to tools (for rejection) instead of approval
  test("routes unexpected plan write tool calls to tools for rejection instead of approval", () => {
    expect(
      routeAfterAgent({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "apply_patch",
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
    expect((result as ShellResult).stderr).toContain("read-only");
  });

  // 验证 plan 模式下拒绝非只读工具（如 apply_patch）的调用 / Non-read tools (e.g., apply_patch) are rejected in plan mode
  test("rejects non-read tools when the thread is in plan mode", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "apply_patch",
        args: { path: "hello.txt", content: "hi" },
        reason: "Unexpected write",
        protectedCommand: "write hello.txt",
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
      requestArgs: { command: "cat src/graph.ts" },
      result: {
        ok: true,
        command: "cat src/graph.ts",
        exitCode: 0,
        stdout: "graph",
        stderr: "",
      },
      previousEvidence: { commands: ["cat package.json"], files: [], verification: [] },
      nextEvidence: { commands: ["cat package.json", "cat src/graph.ts"], files: [], verification: [] },
      previousPlan: null,
      nextPlan: null,
    });

    expect(next.repeatedCallCount).toBe(1);
    expect(next.lastToolSignature).toBe('shell_read:{"command":"cat src/graph.ts"}');
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

  // 验证 builder 模式下修改文件后无验证记录时 final 被清空，强制要求验证 / Builder mode blocks final when files were changed but no verification evidence exists
  test("blocks builder final after file changes without verification", () => {
    const update = evaluateStopCheck({
      mode: "builder",
      plan: null,
      workspace: "/tmp/workspace",
      messages: [],
      final: "Changed hello.txt.",
      evidence: { commands: [], files: ["hello.txt"], verification: [] },
    } as unknown as CodeAgentState);

    expect(update.final).toBe("");
    expect(update.messages?.[0]?.content).toContain("verification");
  });
});
