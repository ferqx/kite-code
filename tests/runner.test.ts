import { describe, expect, test } from "bun:test";
import { initialModeForTask } from "../src/runner";

describe("runner initial mode selection", () => {
  test("starts /plan tasks in plan mode", () => {
    expect(initialModeForTask("/plan Create hello.txt")).toBe("plan");
    expect(initialModeForTask("   /plan inspect repo first")).toBe("plan");
  });

  test("starts non-plan tasks in builder mode", () => {
    expect(initialModeForTask("Create hello.txt")).toBe("builder");
    expect(initialModeForTask("")).toBe("builder");
  });
});
