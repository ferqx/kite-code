import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

/** Basic: user types a message, agent responds with text */
export const basicInputReply: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Write a hello function in TypeScript" },
    { type: "agent-text", text: "Here's a hello function:" },
    { type: "agent-text", text: "```ts\nfunction hello(): void {\n  console.log('Hello, world!');\n}\n```" },
    { type: "agent-done" },
  ],
};
export const basicInputReplyExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "user" },
      { type: "has-block-kind", kind: "text" },
      { type: "blocks-min", count: 2, description: "at least user + agent text blocks" },
    ],
  },
];

/** Input triggers tool call, user grants full_access */
export const inputFullAccess: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: [...baseFreeze!, "toolElapsed"] as Scenario["freeze"],
  steps: [
    { type: "simulate-input", text: "Run dir /B to list files" },
    { type: "tool-call", tool: "shell_execute", args: { command: "dir /B" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "dir /B", risk: "execute_code", summary: "List directory files" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "full_access" } },
    { type: "tool-result", output: "package.json\ntsconfig.json\nsrc/" },
    { type: "agent-text", text: "Here are the files in the directory:\n- package.json\n- tsconfig.json\n- src/" },
    { type: "agent-done" },
  ],
};
export const inputFullAccessExpectations: SnapshotExpectation[] = [
  { reason: "approval-wait" },
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "package.json", description: "tool output visible" },
      { type: "contains", text: "Here are the files", description: "agent text visible" },
    ],
    state: [{ type: "running-is", value: false }],
  },
];

/** Input triggers tool call, user grants approve_once */
export const inputToolApproval: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: [...baseFreeze!, "toolElapsed"] as Scenario["freeze"],
  steps: [
    { type: "simulate-input", text: "Create a config file config.json" },
    { type: "agent-text", text: "I'll create the config file." },
    { type: "tool-call", tool: "write_file", args: { path: "config.json", content: '{"port": 3000}' } },
    { type: "need-approval", approval: { tool: "write_file", command: "write config.json", risk: "write_file", summary: "Create config.json" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "File written." },
    { type: "agent-done" },
  ],
};
export const inputToolApprovalExpectations: SnapshotExpectation[] = [
  { reason: "approval-wait" },
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "config.json", description: "file path visible in output" },
    ],
    state: [{ type: "running-is", value: false }],
  },
];

/** Multi-turn conversation */
export const multiTurn: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Hi" },
    { type: "agent-text", text: "Hello!" },
    { type: "agent-done" },
    { type: "simulate-input", text: "What is 1+1?" },
    { type: "agent-text", text: "2" },
    { type: "agent-done" },
  ],
};
export const multiTurnExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "Hi", description: "first user message visible" },
      { type: "contains", text: "Hello!", description: "first agent response visible" },
    ],
    state: [{ type: "running-is", value: false }],
  },
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "What is 1+1?", description: "second user message visible" },
      { type: "contains", text: "2", description: "second agent response visible" },
    ],
    state: [{ type: "running-is", value: false }],
  },
];

/**
 * Ctrl+C during agent running — verify the interrupt stops execution.
 * simulate-input dispatches USER_MESSAGE + SET_RUNNING, so the agent is
 * running when \x03 (Ctrl+C) arrives. After Ctrl+C, running must be false.
 */
export const ctrlCInterrupt: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Long task" },
    { type: "agent-text", text: "Running..." },
    { type: "simulate-key", key: "\x03" },
    { type: "assert-snapshot" },
  ],
};
export const ctrlCInterruptExpectations: SnapshotExpectation[] = [
  {
    reason: "explicit",
    ansi: [
      { type: "contains", text: "Running...", description: "agent output visible before interrupt" },
    ],
    state: [{ type: "running-is", value: false }],
  },
];
