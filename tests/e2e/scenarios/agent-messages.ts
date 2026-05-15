import type { Scenario } from "../types";

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

/** Error event from agent */
export const errorMessage: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me try to read the missing file." },
    { type: "agent-done" },
  ],
};

/** Retry event */
export const retryMessage: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Attempting operation..." },
    { type: "agent-done" },
  ],
};

/** Context compaction messages */
export const compactionMessages: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me process this large codebase." },
    { type: "agent-text", text: "I need to compact the context to continue." },
    { type: "agent-done" },
  ],
};

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
