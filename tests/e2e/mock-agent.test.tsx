import { describe, test, expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import type { Scenario } from "./types";

describe("runTuiE2E", () => {
  test("renders TUI, dispatches text event, takes terminal snapshot", async () => {
    const scenario: Scenario = {
      terminalWidth: 120,
      steps: [
        { type: "agent-text", text: "Hello from E2E test!" },
        { type: "agent-done" },
      ],
    };

    const result = await runTuiE2E(scenario);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(1);
    expect(result.snapshots[0].reason).toBe("terminal");
    expect(result.snapshots[0].ansi).toContain("Hello from E2E test!");
  });

  test("captures approval snapshot", async () => {
    const scenario: Scenario = {
      terminalWidth: 120,
      steps: [
        { type: "tool-call", tool: "shell_execute", args: { command: "npm test" } },
        {
          type: "need-approval",
          approval: {
            tool: "shell_execute",
            command: "npm test",
            risk: "execute_code",
            summary: "Run tests",
          },
        },
        { type: "expect-mode", mode: "approval" },
        { type: "user-action", action: { type: "approve", grant: "approve_once" } },
        { type: "tool-result", output: "Tests passed." },
        { type: "agent-done" },
      ],
    };

    const result = await runTuiE2E(scenario);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(2);
    expect(result.snapshots[0].reason).toBe("approval-wait");
    expect(result.snapshots[1].reason).toBe("terminal");
  });

  test("reports failure on timeout", async () => {
    const scenario: Scenario = {
      terminalWidth: 120,
      stepTimeout: 100,
      steps: [
        { type: "expect-mode", mode: "approval" },
      ],
    };

    const result = await runTuiE2E(scenario);
    expect(result.pass).toBe(false);
    expect(result.error).toBeDefined();
  });
});
