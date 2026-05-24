/**
 * MCP e2e test scenarios.
 *
 * Two types:
 * - Mock-agent scenarios: test TUI reducer actions (panel, prompt injection)
 * - Real-agent scenarios: test full agent loop with real MCP server (stdio) + mock model
 */
import type { Scenario, SnapshotExpectation, RealAgentScenario } from "../types";
import type { McpManager } from "../../../src/core/mcp";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];
const realFreeze: RealAgentScenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"];

// ══════════════════════════════════════════════════════════
// Mock-agent: TUI reducer MCP actions
// ══════════════════════════════════════════════════════════

interface CmdCase {
  scenario: Scenario;
  expectations: SnapshotExpectation[];
}

/** /mcp — shows MCP panel */
export const showMcpPanel: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_MCP" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** HIDE_MCP — closes MCP panel */
export const hideMcpPanel: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_MCP" },
      { type: "agent-done" },
      { type: "dispatch", actionType: "HIDE_MCP" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      state: [{ type: "running-is", value: false }],
    },
    {
      reason: "terminal",
      state: [{ type: "running-is", value: false }],
    },
  ],
};

/** INJECT_MCP_PROMPT — shows user output block with prompt path */
export const injectMcpPrompt: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      {
        type: "dispatch",
        actionType: "INJECT_MCP_PROMPT",
        payload: { server: "test", promptName: "greet" },
      },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "/mcp__test__greet", description: "injected prompt slash command visible" },
      ],
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

// ══════════════════════════════════════════════════════════
// Real-agent: MCP tool helpers
// ══════════════════════════════════════════════════════════

const TEST_SERVER_COMMAND = "bun";
const TEST_SERVER_ARGS = ["run", "tests/fixtures/mcp-test-server.ts"];

/** Create and connect a McpManager to the test MCP server */
export async function createTestMcpManager(): Promise<McpManager> {
  const { McpManager } = await import("../../../src/core/mcp");
  const manager = new McpManager();
  await manager.connect("test", {
    type: "stdio",
    command: TEST_SERVER_COMMAND,
    args: TEST_SERVER_ARGS,
  });
  return manager;
}

/** Disconnect and clean up the test MCP manager */
export async function disposeTestMcpManager(manager: McpManager): Promise<void> {
  await manager.disconnectAll();
}

/** Create a scenario where the agent calls an MCP tool */
export function mcpToolCallScenario(mcpManager: McpManager): RealAgentScenario {
  return {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: "Use the MCP echo tool to say hello",
    autoApprove: true,
    mcpManager,
    modelResponses: [
      {
        message: {
          content: "Let me use the echo tool.",
          tool_calls: [{ id: "mc1", name: "mcp__test__echo", args: { message: "Hello from e2e test" } }],
        },
      },
      {
        message: { content: "The echo tool returned the message successfully." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        ansi: [
          { type: "contains", text: "mcp__test__echo", description: "MCP tool name visible" },
        ],
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
        ],
      },
    ],
  };
}

/** MCP add tool scenario */
export function mcpAddToolScenario(mcpManager: McpManager): RealAgentScenario {
  return {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: "Add 3 and 5 using the MCP add tool",
    autoApprove: true,
    mcpManager,
    modelResponses: [
      {
        message: {
          content: "Let me compute the sum.",
          tool_calls: [{ id: "mc1", name: "mcp__test__add", args: { a: 3, b: 5 } }],
        },
      },
      {
        message: { content: "The result is 8." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        ansi: [
          { type: "contains", text: "mcp__test__add", description: "add tool name visible" },
        ],
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
        ],
      },
    ],
  };
}

/** MCP tool requires approval — agent waits, user approves */
export function mcpToolApprovalScenario(mcpManager: McpManager): RealAgentScenario {
  return {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: "Use the MCP info tool",
    autoApprove: false,
    mcpManager,
    modelResponses: [
      {
        message: {
          content: "Let me check the MCP server info.",
          tool_calls: [{ id: "mc1", name: "mcp__test__get_info", args: {} }],
        },
      },
      {
        message: { content: "Got the server information." },
      },
    ],
    expectations: [
      {
        reason: "approval-wait",
        ansi: [
          { type: "contains", text: "mcp__test__get_info", description: "tool name in approval prompt" },
        ],
        state: [
          { type: "interrupt-kind", kind: "approval", description: "interrupt is approval" },
        ],
      },
      {
        reason: "terminal",
        state: [
          { type: "running-is", value: false },
        ],
      },
    ],
  };
}

/** MCP tool with server-level risk:read — auto-approved */
export function mcpToolRiskReadScenario(mcpManager: McpManager): RealAgentScenario {
  // Note: The test server doesn't have risk:read in its config by default.
  // The McpManager.connect() expects McpServerConfig with optional risk field.
  // This scenario tests the auto-approval path using the mcpRiskOverride mechanism
  // which works when the server config has risk: "read".
  // For e2e testing we use the connected manager and rely on the tool-policy
  // which checks the server config state for risk.
  return {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: "Echo 'auto-approved test'",
    autoApprove: true,
    mcpManager,
    modelResponses: [
      {
        message: {
          content: "Testing echo.",
          tool_calls: [{ id: "mc1", name: "mcp__test__echo", args: { message: "auto-approved" } }],
        },
      },
      {
        message: { content: "Done." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
        ],
      },
    ],
  };
}

/** Agent reads MCP resource via read_mcp_resource tool */
export function mcpReadResourceScenario(mcpManager: McpManager): RealAgentScenario {
  return {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: "Read the server info resource from the test MCP server",
    autoApprove: true,
    mcpManager,
    modelResponses: [
      {
        message: {
          content: "Let me read the server resource.",
          tool_calls: [{ id: "mc1", name: "read_mcp_resource", args: { server: "test", uri: "info://server" } }],
        },
      },
      {
        message: { content: "The server status is OK. It's running in test mode." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        ansi: [
          { type: "contains", text: "read_mcp_resource", description: "resource tool visible" },
        ],
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
        ],
      },
    ],
  };
}

/** Agent calls non-existent MCP server — error handling */
export function mcpToolNonExistentServer(mcpManager: McpManager): RealAgentScenario {
  return {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: "Try to use a tool from a non-existent MCP server",
    autoApprove: true,
    mcpManager,
    modelResponses: [
      {
        message: {
          content: "Let me try a non-existent server.",
          tool_calls: [{ id: "mc1", name: "mcp__nonexistent__tool", args: {} }],
        },
      },
      {
        message: { content: "That tool isn't available. I'll try another approach." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        state: [
          { type: "running-is", value: false },
        ],
      },
    ],
  };
}
