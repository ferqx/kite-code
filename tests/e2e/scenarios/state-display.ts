import type { Scenario } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

/** State change: phase transition from building to planning */
export const phaseChangeToPlanning: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Let me plan this feature first." },
    { type: "agent-done" },
  ],
};

/** State change: workspace access mode display */
export const workspaceAccessReadOnly: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Reading project files in read-only mode." },
    { type: "agent-done" },
  ],
};

/** No output — fresh session blank state */
export const emptySession: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "assert-snapshot" },
  ],
};

/** Multiple state changes during a run */
export const multiPhaseRun: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Phase transition scenario." },
    { type: "agent-done" },
  ],
};
