import { describe, expect, test } from "bun:test";
import {
  initialModeForTask,
  runtimeQuestionAnswer,
  taskMessageForInitialMode,
} from "../src/runner";

describe("runner initial mode selection", () => {
  test("starts /plan tasks in plan mode", () => {
    expect(initialModeForTask("/plan Create hello.txt")).toBe("plan");
    expect(initialModeForTask("   /plan inspect repo first")).toBe("plan");
  });

  test("honors explicit API or CLI mode", () => {
    expect(initialModeForTask("Create hello.txt", "plan")).toBe("plan");
    expect(initialModeForTask("/plan Create hello.txt", "builder")).toBe("builder");
    expect(initialModeForTask("Create hello.txt", "auto")).toBe("builder");
  });

  test("detects natural-language planning requests in auto mode", () => {
    expect(initialModeForTask("先计划，不要改代码，检查 graph 模式")).toBe("plan");
    expect(initialModeForTask("只计划一下实现方案，不要改文件")).toBe("plan");
    expect(initialModeForTask("Plan first and do not edit files yet")).toBe("plan");
  });

  test("normalizes plan-mode task messages with the explicit plan prefix", () => {
    expect(taskMessageForInitialMode("先计划，不要改代码", "plan")).toStartWith("/plan ");
    expect(taskMessageForInitialMode("/plan inspect", "plan")).toBe("/plan inspect");
    expect(taskMessageForInitialMode("Create hello.txt", "builder")).toBe(
      "Create hello.txt",
    );
  });

  test("answers runtime model questions deterministically from config", () => {
    expect(
      runtimeQuestionAnswer("你当前是什么模型？上下文有多长", {
        modelName: "deepseek-chat",
      }),
    ).toContain("deepseek-chat");
    expect(runtimeQuestionAnswer("Create hello.txt", { modelName: "deepseek-chat" })).toBe(
      null,
    );
  });

  test("starts non-plan tasks in builder mode", () => {
    expect(initialModeForTask("Create hello.txt")).toBe("builder");
    expect(initialModeForTask("")).toBe("builder");
  });
});
