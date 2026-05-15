import { expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import type { Scenario } from "./types";

export function verifyScenario(
  scenarioName: string,
  scenario: Scenario,
  expectedSnapshotCount: number,
) {
  const resultPromise = runTuiE2E(scenario);

  return {
    async verifyAll() {
      const result = await resultPromise;

      if (!result.pass) {
        throw new Error(`[${scenarioName}] Scenario execution failed: ${result.error}`);
      }

      expect(result.snapshots.length, `[${scenarioName}] snapshot count`)
        .toBe(expectedSnapshotCount);

      for (let i = 0; i < result.snapshots.length; i++) {
        const snap = result.snapshots[i];
        verifySnapshot(snap, scenarioName, i);
      }
    },
  };
}

function verifySnapshot(
  snap: { reason: string; state: Record<string, unknown> },
  scenarioName: string,
  index: number,
): void {
  const label = `[${scenarioName}] snapshot ${index + 1}`;

  switch (snap.reason) {
    case "approval-wait": {
      const interrupt = snap.state.interrupt as Record<string, unknown> | null;
      expect(interrupt, `${label}: interrupt must be set for approval`).not.toBeNull();
      expect(interrupt!.kind, `${label}: interrupt kind must be approval`).toBe("approval");
      expect(typeof interrupt!.blockId, `${label}: interrupt must have blockId`).toBe("number");
      break;
    }
    case "question-wait": {
      const interrupt = snap.state.interrupt as Record<string, unknown> | null;
      expect(interrupt, `${label}: interrupt must be set for question`).not.toBeNull();
      expect(interrupt!.kind, `${label}: interrupt kind must be input`).toBe("input");
      expect(typeof interrupt!.blockId, `${label}: interrupt must have blockId`).toBe("number");
      break;
    }
    case "terminal": {
      expect(snap.state.interrupt, `${label}: interrupt must be null at terminal`).toBeNull();
      break;
    }
    case "explicit": {
      // No specific state contract; just verified execution didn't crash
      break;
    }
  }
}
