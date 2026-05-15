import { describe, test, expect } from "bun:test";
import { runTuiE2E } from "./mock-agent";
import { approvalFlow } from "./scenarios/approval-flow";

describe("approval flow E2E", () => {
  test("snapshot 1: approval waiting state", async () => {
    const result = await runTuiE2E(approvalFlow);
    expect(result.pass).toBe(true);
    expect(result.snapshots.length).toBe(2);

    const snap = result.snapshots[0];
    expect(snap.reason).toBe("approval-wait");
    expect(snap.state.interrupt).toEqual({ kind: "approval", blockId: expect.any(Number) });
  });

  test("snapshot 2: terminal state after approval", async () => {
    const result = await runTuiE2E(approvalFlow);
    expect(result.pass).toBe(true);

    const snap = result.snapshots[1];
    expect(snap.reason).toBe("terminal");
    expect(snap.state.interrupt).toBeNull();
    expect(snap.state.running).toBe(false);
  });
});
