import { describe, expect, test } from "bun:test";
import {
  initialModeForTask,
  runtimeQuestionAnswer,
  taskMessageForInitialMode,
} from "../src/app/runner";

// 测试 runner 的初始模式选择逻辑 / Test runner initial mode selection logic
describe("runner initial mode selection", () => {
  // 验证以 /plan 开头的任务自动进入 plan 模式 / Verify tasks starting with /plan auto-enter plan mode
  test("starts /plan tasks in plan mode", () => {
    expect(initialModeForTask("/plan Create hello.txt")).toBe("plan");
    expect(initialModeForTask("   /plan inspect repo first")).toBe("plan"); // 前导空格不影响 / Leading whitespace does not matter
  });

  // 验证显式传入的 mode 参数优先于自动检测 / Verify explicit mode parameter overrides auto-detection
  test("honors explicit API or CLI mode", () => {
    expect(initialModeForTask("Create hello.txt", "plan")).toBe("plan");
    expect(initialModeForTask("/plan Create hello.txt", "builder")).toBe("builder");
    expect(initialModeForTask("Create hello.txt", "auto")).toBe("builder");
  });

  // 验证 auto 模式下能根据自然语言识别"只计划不改代码"的意图 / Verify auto mode detects natural-language planning intent
  test("detects natural-language planning requests in auto mode", () => {
    expect(initialModeForTask("先计划，不要改代码，检查 graph 模式")).toBe("plan");
    expect(initialModeForTask("只计划一下实现方案，不要改文件")).toBe("plan");
    expect(initialModeForTask("Plan first and do not edit files yet")).toBe("plan");
  });

  // 验证 plan 模式下的任务消息会被自动添加 /plan 前缀 / Verify task messages get /plan prefix in plan mode
  test("normalizes plan-mode task messages with the explicit plan prefix", () => {
    expect(taskMessageForInitialMode("先计划，不要改代码", "plan")).toStartWith("/plan ");
    expect(taskMessageForInitialMode("/plan inspect", "plan")).toBe("/plan inspect"); // 已有 /plan 前缀不再重复 / Already has prefix, no duplication
    expect(taskMessageForInitialMode("Create hello.txt", "builder")).toBe(
      "Create hello.txt",
    );
  });

  // 验证运行时模型问题能根据配置确定性回答 / Verify runtime model questions are answered deterministically from config
  test("answers runtime model questions deterministically from config", () => {
    expect(
      runtimeQuestionAnswer("你当前是什么模型？上下文有多长", {
        modelName: "deepseek-chat",
      }),
    ).toContain("deepseek-chat"); // 应包含模型名 / Should include model name
    expect(runtimeQuestionAnswer("Create hello.txt", { modelName: "deepseek-chat" })).toBe(
      null, // 非模型问题返回 null / Non-model questions return null
    );
  });

  // 验证普通任务默认使用 builder 模式 / Verify normal tasks default to builder mode
  test("starts non-plan tasks in builder mode", () => {
    expect(initialModeForTask("Create hello.txt")).toBe("builder");
    expect(initialModeForTask("")).toBe("builder"); // 空任务也走 builder / Empty task also uses builder
  });
});
