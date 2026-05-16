/**
 * Keyboard shortcut e2e scenarios.
 * Tests both dispatch-based (reducer state → render) and key-based
 * (useGlobalKeys → dispatch → render) flows.
 */
import type { Scenario, SnapshotExpectation } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

interface KbCase {
  scenario: Scenario;
  expectations: SnapshotExpectation[];
}

/** Ctrl+H — show help panel */
export const ctrlHShowHelp: KbCase = {
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
        { type: "contains", text: "Keyboard Shortcuts", description: "help panel visible" },
      ],
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** Esc — close help panel */
export const escCloseHelp: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_HELP" },
      { type: "agent-done" },
      { type: "dispatch", actionType: "ESCAPE" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    { reason: "terminal", state: [{ type: "running-is", value: false }] },
    { reason: "terminal", state: [{ type: "running-is", value: false }] },
  ],
};

/** Ctrl+L — clear output */
export const ctrlLClearOutput: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-text", text: "Some content to clear" },
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

/** Ctrl+T — toggle thinking visibility */
export const ctrlTToggleThinking: KbCase = {
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

/** Ctrl+R — toggle authorization mode */
export const ctrlRToggleAuth: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SWITCH_AUTH", payload: { mode: "toggle" } },
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

/** Ctrl+C when not running (first press) — sets ctrlCPressed */
export const ctrlCFirstPress: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
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

/** Ctrl+C when not running (second press) — sets exitRequested */
export const ctrlCSecondPress: KbCase = {
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

/** Leader key (Ctrl+X) → cancel with Esc */
export const leaderCancel: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "LEADER_PENDING" },
      { type: "dispatch", actionType: "LEADER_CANCEL" },
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

/** Leader key → New session (Ctrl+X N) */
export const leaderNewSession: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-text", text: "Previous session content" },
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
        { type: "blocks-max", count: 2, description: "only exit summary in new session" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** Ctrl+O — Escape/reset overlays */
export const ctrlOEscape: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "SHOW_HELP" },
      { type: "dispatch", actionType: "ESCAPE" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "not-contains", text: "Keyboard Shortcuts", description: "help dismissed via escape" },
      ],
      state: [{ type: "running-is", value: false }],
    },
  ],
};
