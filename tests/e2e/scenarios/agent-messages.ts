import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

/** Plain text agent response followed by done */
export const plainText: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Hello! I'm the coding assistant." },
    { type: "agent-text", text: "I can help you with software engineering tasks." },
    { type: "agent-done" },
  ],
};
export const plainTextExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "Hello! I'm the coding assistant.", description: "first message visible" },
      { type: "contains", text: "I can help you with software engineering tasks.", description: "second message visible" },
    ],
    state: [{ type: "running-is", value: false }],
  },
];

/** Agent reasoning block (thinking) */
export const reasonBlock: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-reason", text: "The user wants me to analyze this codebase. Let me start by reading the key files." },
    { type: "agent-reason", text: "I'll check package.json first, then the source directory structure." },
    { type: "agent-text", text: "I've analyzed the codebase structure." },
    { type: "agent-done" },
  ],
};
export const reasonBlockExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "Thinking", description: "reason block indicator visible" },
      { type: "contains", text: "I've analyzed the codebase structure.", description: "final text visible" },
    ],
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "reason" },
    ],
  },
];

/** Multiple text blocks (long agent response) */
export const longTextResponse: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Here is a summary of the project:" },
    { type: "agent-text", text: "- `src/core/`: Core logic and agent harness" },
    { type: "agent-text", text: "- `src/app/tui/`: Terminal UI built with Ink" },
    { type: "agent-text", text: "- `tests/`: Test suite with Bun" },
    { type: "agent-done" },
  ],
};
export const longTextExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "Here is a summary of the project:", description: "opening line visible" },
      { type: "contains", text: "Core logic and agent harness", description: "detail visible" },
    ],
    state: [
      { type: "running-is", value: false },
      { type: "blocks-min", count: 4 },
    ],
  },
];

/** Mixed agent output: reason + text interleaved */
export const mixedReasonAndText: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-reason", text: "Let me think about the best approach..." },
    { type: "agent-text", text: "I'll create a new component for this feature." },
    { type: "agent-reason", text: "I should use React hooks for state management." },
    { type: "agent-text", text: "Done — the component is ready at src/components/NewFeature.tsx." },
    { type: "agent-done" },
  ],
};
export const mixedExpectations: SnapshotExpectation[] = [
  {
    reason: "terminal",
    ansi: [
      { type: "contains", text: "component is ready", description: "final text visible" },
    ],
    state: [
      { type: "running-is", value: false },
      { type: "has-block-kind", kind: "reason" },
      { type: "has-block-kind", kind: "text" },
    ],
  },
];
