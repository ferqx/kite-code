import type { Scenario } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"];

/** Single tool call with result (no approval needed — e.g. read_file) */
export const toolCallNoApproval: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me read the config file." },
    { type: "tool-call", tool: "read_file", args: { path: "package.json" } },
    { type: "tool-result", output: "package.json: 35 lines, project name: openpx-langgraph-code-agent" },
    { type: "agent-done" },
  ],
};

/** Multiple tool calls in sequence */
export const multiToolCalls: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me analyze the project." },
    { type: "tool-call", tool: "read_file", args: { path: "package.json" } },
    { type: "tool-result", output: "package.json loaded." },
    { type: "tool-call", tool: "read_file", args: { path: "tsconfig.json" } },
    { type: "tool-result", output: "tsconfig.json loaded." },
    { type: "tool-call", tool: "read_file", args: { path: "src/index.ts" } },
    { type: "tool-result", output: "src/index.ts loaded." },
    { type: "agent-text", text: "I've read all three files. Ready to proceed." },
    { type: "agent-done" },
  ],
};

/** Tool call with error result */
export const toolError: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me run the tests." },
    { type: "tool-call", tool: "shell_execute", args: { command: "npm test" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "npm test", risk: "execute_code", summary: "Run tests" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-error", output: "ERROR: 3 tests failed" },
    { type: "agent-done" },
  ],
};

/** Mixed blocks: text + file_change + tool_card */
export const mixedBlocks: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-reason", text: "I need to create a utility file for the project." },
    { type: "agent-text", text: "Creating src/utils.ts..." },
    { type: "tool-call", tool: "write_file", args: { path: "src/utils.ts", content: "export const add = (a:number,b:number)=>a+b" } },
    { type: "need-approval", approval: { tool: "write_file", command: "write src/utils.ts", risk: "write_file", summary: "Create utils module" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "File written: src/utils.ts" },
    { type: "agent-text", text: "Done! The utility file is ready." },
    { type: "agent-done" },
  ],
};

/** Agent plan update tool */
export const planUpdate: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me plan this feature." },
    { type: "tool-call", tool: "update_plan", args: { name: "add-auth", description: "Add authentication", steps: [{ step: "Create login page", status: "pending" }, { step: "Add JWT middleware", status: "pending" }] } },
    { type: "tool-result", output: "Plan updated: add-auth (2 steps)" },
    { type: "agent-done" },
  ],
};
