import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  isPlanMode,
  routeAfterApproval,
  routeAfterAgent,
  runApprovedTool,
  type CodeAgentState,
} from "../src/graph";
import type { AgentPlan, ShellResult } from "../src/types";

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

  test("routes plan completion to approval when final exists and plan mode is active", () => {
    expect(
      routeAfterAgent({
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
});
