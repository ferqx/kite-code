/**
 * Real agent e2e scenarios.
 * Uses StreamingMockModel + runAgent() to test complete agent loop
 * with TUI rendering. Verifies both rendered ANSI and state.
 */
import type { RealAgentScenario } from "../types";

/** Simple text response from agent — verifies content is visible at terminal */
export const simpleTextResponse: RealAgentScenario = {
  terminalWidth: 120,
  stepTimeout: 15000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
  task: "Say hello",
  modelResponses: [
    { message: { content: "Hello! I'm the coding assistant. How can I help you today?" } },
  ],
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Hello! I'm the coding assistant", description: "AI response visible" },
        { type: "contains", text: "──", description: "exit summary visible" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "blocks-min", count: 2, description: "user message + AI response + exit" },
        { type: "has-block-kind", kind: "user" },
        { type: "has-block-kind", kind: "text" },
      ],
    },
  ],
};

/** Agent with tool call — auto-approve, verify tool card and result */
export const toolCallAutoApprove: RealAgentScenario = {
  terminalWidth: 120,
  stepTimeout: 15000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"],
  task: "Read package.json",
  autoApprove: true,
  modelResponses: [
    {
      message: {
        content: "Let me read the package.json file.",
        tool_calls: [{ id: "tc1", name: "read_file", args: { path: "package.json" } }],
      },
    },
    {
      message: { content: "The package.json shows this is a Bun project with LangChain dependencies." },
    },
  ],
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "read_file", description: "tool name visible" },
        { type: "contains", text: "read the package.json", description: "AI text before tool" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "tool_card" },
        { type: "has-block-kind", kind: "user" },
      ],
    },
  ],
};

/** Agent error — model throws, verify error is captured and loop completes */
export const modelError: RealAgentScenario = {
  terminalWidth: 120,
  stepTimeout: 15000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
  task: "Do something that will fail",
  modelResponses: [
    { error: "Network timeout after 30s", delay: 50 },
  ],
  expectations: [
    {
      reason: "terminal",
      state: [
        { type: "running-is", value: false, description: "loop must complete even on error" },
      ],
    },
  ],
};

/** Multi-turn conversation simulation (run agent twice in sequence) */
export const multiTurnSimple: RealAgentScenario = {
  terminalWidth: 120,
  stepTimeout: 15000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
  task: "Hi there",
  modelResponses: [
    { message: { content: "Hello! How can I help?" } },
  ],
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Hello! How can I help?", description: "response visible" },
        { type: "contains", text: "──", description: "exit summary present" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "blocks-min", count: 2 },
      ],
    },
  ],
};

/** Agent with empty response — should not hang */
export const emptyResponse: RealAgentScenario = {
  terminalWidth: 120,
  stepTimeout: 15000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount"],
  task: "Say nothing",
  modelResponses: [
    { message: { content: "" } },
  ],
  expectations: [
    {
      reason: "terminal",
      state: [
        { type: "running-is", value: false },
        { type: "interrupt-kind", kind: null },
      ],
    },
  ],
};

/**
 * Viewport culling regression test.
 *
 * Bug: When the final text response is long enough to overflow the viewport,
 * the user prompt and tool card blocks are excluded from visibleBlocks.
 * This test enforces that user prompt, tool cards, and final response are
 * all preserved in state, and that key content is visible in rendered output
 * even with a constrained viewport.
 */
/**
 * Viewport culling regression test.
 *
 * Bug: When the final text response is long enough to overflow the viewport,
 * user prompt and tool card blocks are excluded from visibleBlocks by the
 * bottom-up culling algorithm.
 *
 * This test sets viewportHeight=10 to force culling. With the current
 * "at least 2 blocks" guard, only the last 2 blocks (final text + exit summary)
 * are rendered. The user prompt and tool card are hidden.
 *
 * The test must FAIL until the viewport culling is fixed to preserve
 * all blocks that can reasonably fit.
 */
export const viewportPreservesHistory: RealAgentScenario = {
  terminalWidth: 120,
  stepTimeout: 20000,
  freeze: ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"],
  task: "Read package.json and give a detailed code review",
  autoApprove: true,
  workspaceFiles: {
    "package.json": '{"name": "test-project", "version": "2.0.0", "dependencies": {"react": "^19.0.0"}}',
  },
  modelResponses: [
    {
      message: {
        content: "Let me check the project configuration.",
        tool_calls: [{ id: "tc1", name: "read_file", args: { path: "package.json" } }],
      },
    },
    {
      message: {
        content:
          "Here is my detailed code review:\n\n" +
          "1. Package name: test-project — clear and descriptive.\n" +
          "2. Version: 2.0.0 — follows semver convention.\n" +
          "3. Dependencies: React 19.0.0 is the latest stable release.\n" +
          "4. No devDependencies — consider adding testing libraries.\n" +
          "5. No scripts defined — add build, test, and lint commands.\n" +
          "6. No engines field — specify Node.js version requirements.\n" +
          "7. License field is missing — add one for open source clarity.\n" +
          "8. Repository field is missing — helps with npm package page.\n" +
          "9. Keywords field is missing — improves npm search visibility.\n" +
          "10. Overall: solid foundation but needs standard fields added.\n\n" +
          "This concludes my comprehensive analysis. The project is on the right track.",
      },
    },
    {
      message: { content: "Task complete." },
    },
    {
      message: { content: "Done." },
    },
  ],
  expectations: [
    {
      reason: "terminal",
      ansi: [
        // Tool card MUST be visible with compressed culling
        { type: "contains", text: "read_file", description: "tool name visible" },
        { type: "contains", text: "package.json", description: "tool path visible" },
        // Final response snippet visible
        { type: "contains", text: "comprehensive analysis", description: "final AI response visible" },
        // Exit summary present
        { type: "contains", text: "──", description: "exit summary visible" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "user" },
        { type: "has-block-kind", kind: "tool_card" },
        // Block state integrity after agent loop:
        // user + tool_card + text + tool_card + text(final) + text(exit)
        { type: "block-kinds-in-order", kinds: [
          "user",
          "tool_card",
          "text",
          "tool_card",
          "text",
          "text",
        ] },
        { type: "all-blocks-non-streaming" },
      ],
    },
  ],
};
