import { describe, expect, test } from "bun:test";
import { parsePlanDirective } from "../src/runner";

describe("runner plan directive", () => {
  test("turns a leading /plan marker into plan mode and strips it from the task", () => {
    expect(parsePlanDirective("/plan Create hello.txt")).toEqual({
      task: "Create hello.txt",
      threadMode: "plan",
    });
  });

  test("leaves unmarked tasks in builder mode", () => {
    expect(parsePlanDirective("Create hello.txt")).toEqual({
      task: "Create hello.txt",
      threadMode: "builder",
    });
  });
});
