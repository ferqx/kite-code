import { expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import type { Scenario, Snapshot, AnsiAssertion, StateAssertion, SnapshotExpectation } from "./types";

export function verifyScenario(
  scenarioName: string,
  scenario: Scenario,
  expectedSnapshotCount: number,
  expectations?: SnapshotExpectation[],
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
        if (expectations?.[i]) {
          verifySnapshotExpectations(snap, expectations[i], scenarioName, i);
        }
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
      break;
    }
  }
}

// ── Content & state assertion verification ──

export function verifySnapshotExpectations(
  snap: { reason: string; ansi: string; state: Record<string, unknown> },
  expectation: SnapshotExpectation,
  scenarioName: string,
  index: number,
): void {
  const label = `[${scenarioName}] snapshot ${index + 1}`;

  // Verify reason matches
  expect(snap.reason, `${label}: reason mismatch`).toBe(expectation.reason);

  // Verify ANSI content assertions
  if (expectation.ansi) {
    for (const a of expectation.ansi) {
      verifyAnsiAssertion(snap.ansi, a, label);
    }
  }

  // Verify state assertions
  if (expectation.state) {
    for (const s of expectation.state) {
      verifyStateAssertion(snap.state, s, label);
    }
  }
}

function verifyAnsiAssertion(ansi: string, assertion: AnsiAssertion, label: string): void {
  const context = assertion.description ? ` (${assertion.description})` : "";
  switch (assertion.type) {
    case "contains":
      expect(ansi, `${label}: ANSI must contain "${assertion.text}"${context}`)
        .toContain(assertion.text);
      break;
    case "not-contains":
      expect(ansi, `${label}: ANSI must NOT contain "${assertion.text}"${context}`)
        .not.toContain(assertion.text);
      break;
    case "matches": {
      const re = new RegExp(assertion.pattern);
      expect(re.test(ansi), `${label}: ANSI must match /${assertion.pattern}/${context}`)
        .toBe(true);
      break;
    }
    case "contains-all":
      for (const t of assertion.texts) {
        expect(ansi, `${label}: ANSI must contain "${t}"${context}`)
          .toContain(t);
      }
      break;
    case "contains-each":
      for (const t of assertion.texts) {
        expect(ansi, `${label}: ANSI must contain "${t}"${context}`)
          .toContain(t);
      }
      break;
    case "contains-in-order": {
      let searchFrom = 0;
      for (const t of assertion.texts) {
        const idx = ansi.indexOf(t, searchFrom);
        expect(idx !== -1,
          `${label}: ANSI must contain "${t}" after previous texts${context}`).toBe(true);
        searchFrom = idx + t.length;
      }
      break;
    }
  }
}

function verifyStateAssertion(state: Record<string, unknown>, assertion: StateAssertion, label: string): void {
  const context = assertion.description ? ` (${assertion.description})` : "";
  const blocks = (state.blocks as Array<Record<string, unknown>>) ?? [];
  const interrupt = state.interrupt as Record<string, unknown> | null;

  switch (assertion.type) {
    case "blocks-min":
      expect(blocks.length, `${label}: blocks.length >= ${assertion.count}${context}`)
        .toBeGreaterThanOrEqual(assertion.count);
      break;
    case "blocks-max":
      expect(blocks.length, `${label}: blocks.length <= ${assertion.count}${context}`)
        .toBeLessThanOrEqual(assertion.count);
      break;
    case "blocks-equal":
      expect(blocks.length, `${label}: blocks.length must be exactly ${assertion.count}${context}`)
        .toBe(assertion.count);
      break;
    case "has-block-kind":
      expect(blocks.some((b) => b.kind === assertion.kind),
        `${label}: must have block kind "${assertion.kind}"${context}`).toBe(true);
      break;
    case "no-block-kind":
      expect(blocks.some((b) => b.kind === assertion.kind),
        `${label}: must NOT have block kind "${assertion.kind}"${context}`).toBe(false);
      break;
    case "blocks-of-kind-count": {
      const count = blocks.filter((b) => b.kind === assertion.kind).length;
      expect(count, `${label}: expected ${assertion.count} blocks of kind "${assertion.kind}"${context}`)
        .toBe(assertion.count);
      break;
    }
    case "block-kinds-in-order": {
      const actualKinds = blocks.map((b) => b.kind);
      expect(actualKinds, `${label}: block kinds sequence mismatch${context}`)
        .toEqual(assertion.kinds);
      break;
    }
    case "interrupt-kind":
      if (assertion.kind === null) {
        expect(interrupt, `${label}: interrupt must be null${context}`).toBeNull();
      } else {
        expect(interrupt?.kind, `${label}: interrupt.kind must be "${assertion.kind}"${context}`)
          .toBe(assertion.kind);
      }
      break;
    case "last-block-kind":
      expect(blocks.at(-1)?.kind, `${label}: last block kind must be "${assertion.kind}"${context}`)
        .toBe(assertion.kind);
      break;
    case "running-is":
      expect(state.running, `${label}: running must be ${assertion.value}${context}`)
        .toBe(assertion.value);
      break;
    case "all-blocks-non-streaming": {
      const streaming = blocks.filter((b) => b.kind === "text" && (b as any).streaming === true).length;
      expect(streaming, `${label}: all text blocks must be non-streaming${context}`)
        .toBe(0);
      break;
    }
  }
}
