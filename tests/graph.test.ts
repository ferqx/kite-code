import { describe, expect, test } from "bun:test";
import {
  normalizeThreadMode,
  routeAfterApproval,
  type CodeAgentState,
} from "../src/graph";

describe("graph local tool routing", () => {
  test("uses builder as the execution mode and treats execute as a compatibility alias", () => {
    expect(normalizeThreadMode(undefined)).toBe("builder");
    expect(normalizeThreadMode("execute")).toBe("builder");
    expect(routeAfterApproval({ threadMode: "builder" } as CodeAgentState)).toBe("agent");
  });
});
