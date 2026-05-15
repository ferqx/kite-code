import type { Scenario } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"];

/** approve_once: standard approval flow */
export const approveOnce: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "tool-call", tool: "shell_execute", args: { command: "npm test" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "npm test", risk: "execute_code", summary: "Run test suite" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "Tests passed." },
    { type: "agent-done" },
  ],
};

/** same_command: approve same command for future use */
export const approveSameCommand: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "tool-call", tool: "shell_execute", args: { command: "npm run build" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "npm run build", risk: "execute_code", summary: "Run build" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "same_command" } },
    { type: "tool-result", output: "Build complete." },
    { type: "agent-done" },
  ],
};

/** full_access: approve with full access grant */
export const approveFullAccess: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "tool-call", tool: "write_file", args: { path: "config.json", content: "{}" } },
    { type: "need-approval", approval: { tool: "write_file", command: "write config.json", risk: "write_file", summary: "Create config" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "full_access" } },
    { type: "tool-result", output: "File written." },
    { type: "agent-done" },
  ],
};

/** deny: reject the tool approval */
export const denyApproval: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "tool-call", tool: "shell_execute", args: { command: "rm -rf /" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "rm -rf /", risk: "destructive", summary: "Dangerous delete" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "reject" } },
    { type: "agent-done" },
  ],
};

/** write_file approval with high risk */
export const approveWriteFile: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me write the test file." },
    { type: "tool-call", tool: "write_file", args: { path: "src/app.ts", content: "// app" } },
    { type: "need-approval", approval: { tool: "write_file", command: "write src/app.ts", risk: "write_file", summary: "Create app.ts" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "File written." },
    { type: "agent-done" },
  ],
};
