/**
 * Slash command e2e scenarios.
 * Uses dispatch steps to test the reducer actions that slash commands trigger.
 * In production, slash commands are parsed in useSlashCommand and dispatch
 * the corresponding actions — these scenarios verify the full dispatch → render pipeline.
 */
import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

interface CmdCase {
  scenario: Scenario;
  expectations: SnapshotExpectation[];
}

/** /help — displays keyboard shortcuts panel */
export const slashHelp: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_HELP" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Keyboard Shortcuts", description: "help panel title" },
        { type: "contains", text: "Esc", description: "shortcut reference" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "interrupt-kind", kind: null },
      ],
    },
  ],
};

/** /setting — displays current configuration */
export const slashSetting: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_SETTING" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Current Settings", description: "settings panel title" },
        { type: "contains", text: "deepseek-v4", description: "model name displayed" },
        { type: "contains", text: "building", description: "phase displayed" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "text" },
      ],
    },
  ],
};

/** /clear — clears all output blocks */
export const slashClear: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-text", text: "Previous output that should be cleared." },
      { type: "agent-done" },
      { type: "dispatch", actionType: "CLEAR_OUTPUT" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    { reason: "terminal", state: [{ type: "running-is", value: false }] },
    {
      reason: "terminal",
      state: [
        { type: "blocks-max", count: 2, description: "only exit summary after clear" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** /thinking — toggles thinking visibility */
export const slashThinking: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "TOGGLE_THINKING" },
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

/** /auth — switch authorization mode */
export const slashAuth: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SWITCH_AUTH", payload: { mode: "full_access" } },
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

/** /model list — lists available models */
export const slashModelList: CmdCase = {
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
      ],
      state: [
        { type: "has-block-kind", kind: "text" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** /export — exports session to file */
export const slashExport: CmdCase = {
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
      state: [{ type: "running-is", value: false }],
    },
  ],
};

/** /plan — switch to planning phase */
export const slashPlan: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SET_PHASE", payload: { phase: "planning" } },
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

/** /code — switch to building phase */
export const slashCode: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SET_PHASE", payload: { phase: "building" } },
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

/** /compact — request context compaction during running */
export const slashCompact: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "COMPACT_CONTEXT" },
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

/** /editor — open external editor */
export const slashEditor: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "OPEN_EDITOR" },
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

/** /undo — undo stub */
export const slashUndo: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "UNDO" as any },
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
