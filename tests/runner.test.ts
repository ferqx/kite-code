import { describe, expect, test } from "bun:test";
import {
  initialAgentPhaseForAccess,
  initialWorkspaceAccessForTask,
  runtimeQuestionAnswer,
  taskMessageForInitialAccess,
} from "../src/app/runner";

// 测试 runner 的初始工作区访问权限选择逻辑 / Test runner initial workspace access selection logic
describe("runner initial workspace access selection", () => {
  // 验证以 /plan 开头的任务自动进入只读工作区访问 / Verify /plan tasks start with read-only workspace access
  test("starts /plan tasks with read-only workspace access", () => {
    expect(initialWorkspaceAccessForTask("/plan Create hello.txt")).toBe("read-only");
    expect(initialWorkspaceAccessForTask("   /plan inspect repo first")).toBe("read-only"); // 前导空格不影响 / Leading whitespace does not matter
  });

  // 验证显式传入的兼容 mode 参数会映射到工作区访问权限 / Verify explicit legacy mode maps to workspace access
  test("maps explicit API or CLI mode to workspace access", () => {
    expect(initialWorkspaceAccessForTask("Create hello.txt", "plan")).toBe("read-only");
    expect(initialWorkspaceAccessForTask("/plan Create hello.txt", "builder")).toBe("write");
    expect(initialWorkspaceAccessForTask("Create hello.txt", "read-only")).toBe("read-only");
    expect(initialWorkspaceAccessForTask("Create hello.txt", "write")).toBe("write");
    expect(initialWorkspaceAccessForTask("Create hello.txt", "auto")).toBe("write");
  });

  // 验证初始 phase 从工作区访问权限派生，规划阶段有独立状态 / Initial phase is derived from workspace access as explicit graph state
  test("derives initial agent phase from workspace access", () => {
    expect(initialAgentPhaseForAccess("read-only")).toBe("planning");
    expect(initialAgentPhaseForAccess("write")).toBe("building");
  });

  // 验证 auto 模式不再用启发式切换到只读，让模型自主决定是否调用 update_plan / Verify auto mode no longer heuristically switches to read-only
  test("leaves natural-language planning requests with write access in auto mode", () => {
    expect(initialWorkspaceAccessForTask("先计划，不要改代码，检查 graph 模式")).toBe("write");
    expect(initialWorkspaceAccessForTask("只计划一下实现方案，不要改文件")).toBe("write");
    expect(initialWorkspaceAccessForTask("Plan first and do not edit files yet")).toBe("write");
  });

  // 验证初始访问权限不会改写用户任务文本，避免把运行状态混入用户消息 / Verify initial access does not rewrite user task text
  test("keeps initial task messages unchanged", () => {
    expect(taskMessageForInitialAccess("先计划，不要改代码", "read-only")).toBe(
      "先计划，不要改代码",
    );
    expect(taskMessageForInitialAccess("/plan inspect", "read-only")).toBe("/plan inspect");
    expect(taskMessageForInitialAccess("Create hello.txt", "write")).toBe(
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

  // 验证普通任务默认使用可写工作区访问 / Verify normal tasks default to write workspace access
  test("starts non-plan tasks with write workspace access", () => {
    expect(initialWorkspaceAccessForTask("Create hello.txt")).toBe("write");
    expect(initialWorkspaceAccessForTask("")).toBe("write"); // 空任务也走 write / Empty task also uses write
  });
});
