import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

/** Agent encounters an error during execution */
export const agentError: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Fix all bugs" },
    { type: "agent-text", text: "Let me analyze the codebase..." },
    { type: "error", message: "Failed to parse response from model: JSON parse error at line 42" },
    { type: "agent-done" },
  ],
};
export const agentErrorExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "user" },
    ],
  },
];

/** Operation retry (non-model retry, e.g. tool execution retry) */
export const operationRetry: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Run the deployment" },
    { type: "agent-text", text: "Starting deployment..." },
    { type: "retry", attempt: 1, reason: "Connection timeout to remote server" },
    { type: "agent-text", text: "Retrying deployment..." },
    { type: "retry", attempt: 2, reason: "Connection timeout to remote server" },
    { type: "agent-text", text: "Deployment failed after 2 attempts." },
    { type: "agent-done" },
  ],
};
export const operationRetryExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "blocks-min", count: 2 },
    ],
  },
];

/** Model API call fails and retries */
export const modelRetry: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Explain this code" },
    { type: "model-retry", attempt: 1, delayMs: 2000, error: "Rate limit exceeded, retrying in 2s" },
    { type: "agent-text", text: "This code implements a binary search algorithm." },
    { type: "agent-done" },
  ],
};
export const modelRetryExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "text" },
    ],
  },
];

/** Multiple model retries then success */
export const modelRetriesThenSuccess: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "What is 2+2?" },
    { type: "model-retry", attempt: 1, delayMs: 1000, error: "Network error: ETIMEDOUT" },
    { type: "model-retry", attempt: 2, delayMs: 2000, error: "Network error: ETIMEDOUT" },
    { type: "model-retry", attempt: 3, delayMs: 4000, error: "Network error: ETIMEDOUT" },
    { type: "agent-text", text: "2 + 2 = 4" },
    { type: "agent-done" },
  ],
};
export const modelRetriesThenSuccessExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "text" },
    ],
  },
];

/** Tool execution fails with error (shell command non-zero exit) */
export const toolExecutionError: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: [...baseFreeze, "toolElapsed"] as Scenario["freeze"],
  steps: [
    { type: "simulate-input", text: "Run the test suite" },
    { type: "agent-text", text: "Running tests..." },
    { type: "tool-call", tool: "shell_execute", args: { command: "npm test" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "npm test", risk: "execute_code", summary: "Run test suite" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-error", output: "2 tests failed: auth.test.ts, api.test.ts" },
    { type: "agent-text", text: "The test suite has 2 failures. Let me investigate the failing tests." },
    { type: "agent-done" },
  ],
};
export const toolExecutionErrorExpectations: SnapshotExpectation[] = [
  { reason: "approval-wait" },
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "tool_card" },
    ],
  },
];

/** Error then successful recovery */
export const errorRecovery: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"],
  steps: [
    { type: "simulate-input", text: "Read the config" },
    { type: "agent-text", text: "Let me read config.json..." },
    { type: "tool-call", tool: "read_file", args: { path: "config.json" } },
    { type: "tool-error", output: "File not found: config.json" },
    { type: "retry", attempt: 1, reason: "Config file not found, searching for alternatives" },
    { type: "agent-text", text: "config.json not found. Let me check for alternative config files." },
    { type: "tool-call", tool: "shell_execute", args: { command: "ls *.config.* 2>nul || echo 'none found'" } },
    { type: "need-approval", approval: { tool: "shell_execute", command: "ls *.config.*", risk: "read", summary: "Search for config files" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: ".prettierrc.json\ntsconfig.json" },
    { type: "agent-text", text: "Found alternative config files: .prettierrc.json and tsconfig.json." },
    { type: "agent-done" },
  ],
};
export const errorRecoveryExpectations: SnapshotExpectation[] = [
  { reason: "approval-wait" },
  {
    reason: "terminal",
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "text" },
    ],
  },
];
