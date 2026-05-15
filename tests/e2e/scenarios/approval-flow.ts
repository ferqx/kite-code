import type { Scenario } from "../types";

export const approvalFlow: Scenario = {
  terminalWidth: 120,
  stepTimeout: 5000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"],
  steps: [
    { type: "agent-text", text: "I'll create a test file for you." },
    {
      type: "tool-call",
      tool: "write_file",
      args: { path: "src/test.ts", content: "export const hello = 'world';" },
    },
    {
      type: "need-approval",
      approval: {
        tool: "write_file",
        command: "write src/test.ts",
        risk: "write_file",
        summary: "Create test.ts with hello export",
      },
    },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "File written successfully." },
    { type: "agent-done" },
  ],
};
