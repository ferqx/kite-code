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
    {
      reason: "terminal",
      ansi: [{ type: "contains", text: "Keyboard Shortcuts", description: "help visible" }],
      state: [{ type: "running-is", value: false }],
    },
    {
      reason: "terminal",
      ansi: [{ type: "not-contains", text: "Keyboard Shortcuts", description: "help dismissed" }],
      state: [{ type: "running-is", value: false }],
    },
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
    {
      reason: "terminal",
      ansi: [{ type: "contains", text: "Some content to clear", description: "content present before clear" }],
      state: [{ type: "running-is", value: false }],
    },
    {
      reason: "terminal",
      ansi: [{ type: "not-contains", text: "Some content to clear", description: "content removed after clear" }],
      state: [
        { type: "blocks-max", count: 2, description: "only exit summary after clear" },
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** Ctrl+T — expand/collapse all reasoning blocks */
export const ctrlTToggleAllReason: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-reason", text: "Let me analyze this step by step." },
      { type: "agent-done" },
      { type: "dispatch", actionType: "TOGGLE_ALL_REASON" },
      { type: "assert-snapshot" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "▶ Thinking...", description: "reason block initially folded" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "reason" },
      ],
    },
    {
      reason: "explicit",
      ansi: [
        { type: "contains", text: "▼ Thinking", description: "after Ctrl+T: expanded" },
        { type: "contains", text: "Let me analyze this step by step", description: "content visible" },
      ],
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
      ansi: [{ type: "contains", text: "[full]", description: "auth mode toggled to full in status bar" }],
      state: [{ type: "running-is", value: false }],
    },
  ],
};

/** Ctrl+C when not running (first press) — sets ctrlCPressed flag.
 *  Note: the flag itself is not checked via state assertion because the
 *  snapshot assertion system currently only covers blocks/interrupt/running. */
export const ctrlCFirstPress: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "CTRL_C" },
      { type: "assert-snapshot" },
    ],
  },
  expectations: [
    {
      reason: "explicit",
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
      { type: "assert-snapshot" },
    ],
  },
  expectations: [
    {
      reason: "explicit",
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

/** Down arrow + Enter — expand a folded reason block (▶ Thinking... → ▼ Thinking) */
export const enterExpandReason: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-reason", text: "Let me think about this carefully. I need to analyze the codebase structure." },
      { type: "agent-done" },
      { type: "simulate-key", key: "\x1b[B" },
      { type: "simulate-key", key: "\r" },
      { type: "assert-snapshot" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "▶ Thinking...", description: "initial state: folded reason block" },
      ],
      state: [
        { type: "running-is", value: false },
        { type: "has-block-kind", kind: "reason" },
      ],
    },
    {
      reason: "explicit",
      ansi: [
        { type: "contains", text: "▼ Thinking", description: "expanded: shows ▼ Thinking label" },
        { type: "contains", text: "Let me think about this carefully", description: "expanded: content visible" },
      ],
      state: [{ type: "running-is", value: false }],
    },
  ],
};

/** Enter toggles reason block back to folded (▼ Thinking → ▶ Thinking...) */
export const enterCollapseReason: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "agent-reason", text: "Analyzing the request..." },
      { type: "agent-done" },
      { type: "simulate-key", key: "\x1b[B" },
      { type: "simulate-key", key: "\r" },
      { type: "assert-snapshot" },
      { type: "simulate-key", key: "\r" },
      { type: "assert-snapshot" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "▶ Thinking...", description: "initial: folded" },
      ],
      state: [{ type: "running-is", value: false }],
    },
    {
      reason: "explicit",
      ansi: [
        { type: "contains", text: "▼ Thinking", description: "after first Enter: expanded" },
        { type: "contains", text: "Analyzing the request", description: "content visible" },
      ],
      state: [{ type: "running-is", value: false }],
    },
    {
      reason: "explicit",
      ansi: [
        { type: "contains", text: "▶ Thinking...", description: "after second Enter: folded again" },
      ],
      state: [{ type: "running-is", value: false }],
    },
  ],
};

/**
 * Ctrl+letter shortcuts must NOT leak the character into the text input.
 * ink-text-input upstream only filters Ctrl+C; our CtrlSafeTextInput filters
 * all Ctrl+letter combos. This test simulates real keyboard input via stdin
 * (not dispatch) to verify the full useInput → TextInput chain.
 */
export const ctrlLetterNoCharLeak: KbCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      // Type "hello" character-by-character via stdin so it stays in the input field
      { type: "simulate-key", key: "h" },
      { type: "simulate-key", key: "e" },
      { type: "simulate-key", key: "l" },
      { type: "simulate-key", key: "l" },
      { type: "simulate-key", key: "o" },
      // Press Ctrl+T — must NOT add 't' to the input
      { type: "simulate-key", key: "\x14" },
      { type: "assert-snapshot" },
    ],
  },
  expectations: [
    {
      reason: "explicit",
      ansi: [
        { type: "contains", text: "❯ hello", description: "input text intact after Ctrl+T" },
        { type: "not-contains", text: "hellot", description: "no 't' leaked from Ctrl+T" },
      ],
      state: [{ type: "running-is", value: false }],
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
