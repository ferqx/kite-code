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

describe("graph local tool routing", () => {
  test("stays in agent when approval has no pending tool call", () => {
    expect(routeAfterApproval({ messages: [] } as unknown as CodeAgentState)).toBe("agent");
  });

  test("uses graph state mode as the plan mode source of truth", () => {
    expect(isPlanMode({ mode: "plan" } as CodeAgentState)).toBe(true);
    expect(isPlanMode({ mode: "builder" } as CodeAgentState)).toBe(false);
  });

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

  test("routes plan completion through stop check when final exists and plan mode is active", () => {
    expect(
      routeAfterAgent({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("stop_check");
  });

  test("routes unstructured plan-mode final text through stop check", () => {
    expect(
      routeAfterAgent({
        mode: "plan",
        plan: null,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan text without update_plan",
      } as unknown as CodeAgentState),
    ).toBe("stop_check");
  });

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

  test("does not treat a plan read-budget final as ready for approval without a plan", () => {
    const checked = evaluateStopCheck({
        mode: "plan",
        plan: null,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan read budget reached",
      } as unknown as CodeAgentState);

    expect(checked.final).toBe("");
  });

  test("routes approved plan finals from stop check to approval", () => {
    expect(
      routeAfterStopCheck({
        mode: "plan",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("approval");
  });

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
