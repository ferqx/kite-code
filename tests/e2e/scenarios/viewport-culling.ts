/**
 * Viewport culling regression scenarios.
 *
 * These tests set a small viewportHeight to force OutputArea's culling
 * algorithm to activate. Each scenario verifies that the compressed
 * culling guard shows as many blocks as possible rather than just 2.
 */
import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

interface VpCase {
  scenario: Scenario;
  expectations: SnapshotExpectation[];
}

/**
 * Regression: all blocks rendered when content exceeds terminal height.
 * No viewport culling — terminal scrollback handles overflow natively.
 */
export const noCullingAllBlocksVisible: VpCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      // Simulate a user prompt
      { type: "user-input", text: "Analyze this project thoroughly" },
      // AI text + tool calls interleaved
      { type: "agent-text", text: "Let me check the project files." },
      { type: "tool-call", tool: "read_file", args: { path: "package.json" } },
      { type: "tool-result", output: '{"name": "test", "version": "2.0.0"}' },
      { type: "agent-text", text: "Now checking source code." },
      { type: "tool-call", tool: "read_file", args: { path: "src/index.ts" } },
      { type: "tool-result", output: 'console.log("hello");' },
      // Long final text — 14+ lines
      { type: "agent-text", text: [
        "Here is my detailed analysis:",
        "",
        "1. The project structure is well-organized.",
        "2. Dependencies are up to date.",
        "3. Configuration follows best practices.",
        "4. Entry point is clearly defined.",
        "5. Module boundaries are respected.",
        "6. No circular dependencies detected.",
        "7. TypeScript usage is appropriate.",
        "8. Test coverage needs improvement.",
        "9. CI/CD pipeline is needed.",
        "10. Overall, the project is healthy.",
        "",
        "This concludes the analysis.",
      ].join("\n") },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        // All blocks rendered — no viewport culling
        { type: "contains", text: "read_file", description: "tool name visible" },
        { type: "contains", text: "package.json", description: "first tool visible" },
        { type: "contains", text: "src/index.ts", description: "second tool visible" },
        // Exit summary visible
        { type: "contains", text: "──", description: "exit summary visible" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "user" },
        { type: "has-block-kind", kind: "tool_card" },
      ],
    },
  ],
};

/**
 * Regression: all blocks visible even with long text responses.
 * Verifies no viewport culling is hiding tool cards.
 */
export const allBlocksVisibleWithLongText: VpCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "user-input", text: "Check file" },
      { type: "agent-text", text: "Reading the file." },
      { type: "tool-call", tool: "read_file", args: { path: "config.json" } },
      { type: "tool-result", output: '{"key": "value"}' },
      { type: "agent-text", text: "Here is a very long analysis:\n\nLine A\nLine B\nLine C\nLine D\nLine E\nLine F\nLine G\nLine H\nLine I\nLine J\nLine K\nLine L\nFinal line." },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "read_file", description: "tool name visible with long text content" },
        { type: "contains", text: "──", description: "exit summary visible" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "tool_card" },
      ],
    },
  ],
};

/**
 * No viewportHeight set — full viewport. Verifies the override
 * doesn't affect default behavior.
 */
export const defaultViewportWorks: VpCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "user-input", text: "Hello" },
      { type: "agent-text", text: "Hi there!" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Hello", description: "user message visible" },
        { type: "contains", text: "Hi there", description: "AI response visible" },
        { type: "contains", text: "──", description: "exit summary visible" },
      ],
      state: [{ type: "running-is", value: false }],
    },
  ],
};
