/**
 * Settings, session management, and exit flow e2e scenarios.
 */
import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

interface Case {
  scenario: Scenario;
  expectations: SnapshotExpectation[];
}

/** /model list — displays available models */
export const modelList: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "LIST_MODELS" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Available Models" },
        { type: "contains", text: "deepseek-v4" },
      ],
      state: [
        { type: "has-block-kind", kind: "text" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** /sessions — shows session list stub */
export const sessionsList: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_SESSIONS" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "not yet implemented", description: "stub message" },
      ],
      state: [
        { type: "has-block-kind", kind: "text" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** Model selector — show and select model */
export const modelSelector: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_MODEL_SELECTOR" },
      { type: "dispatch", actionType: "SELECT_MODEL", payload: { modelId: "gpt-4o" } },
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

/** New session — clears all blocks and resets state */
export const newSession: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-text", text: "Will be cleared" },
      { type: "agent-done" },
      { type: "dispatch", actionType: "NEW_SESSION" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    { reason: "terminal", state: [{ type: "running-is", value: false }] },
    {
      reason: "terminal",
      state: [
        { type: "blocks-max", count: 2, description: "clean slate after new session" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** Exit flow: first Ctrl+C sets flag, second sets exitRequested */
export const exitFlow: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "CTRL_C" },
      { type: "dispatch", actionType: "CTRL_C" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      state: [{ type: "running-is", value: false }],
    },
  ],
};

/** Export session — creates markdown file */
export const exportSession: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "EXPORT_SESSION" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Session exported", description: "export confirmation" },
      ],
      state: [
        { type: "has-block-kind", kind: "text" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** External editor — triggers OPEN_EDITOR then EDITOR_DONE */
export const externalEditor: Case = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "OPEN_EDITOR" },
      { type: "dispatch", actionType: "EDITOR_DONE" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      state: [{ type: "running-is", value: false }],
    },
  ],
};
