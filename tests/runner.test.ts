import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  initialAgentPhaseForAccess,
  initialWorkspaceAccessForTask,
  normalizeGraphStream,
  taskMessageForInitialAccess,
  chunkToEvents,
} from "../src/core/runner";
import { createPromptCacheStandardTracker } from "../src/core/cache-metrics";
import type { AgentEvent } from "../src/protocol/index";
import type { ModelRetryEvent } from "../src/core/types";

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

  // 验证普通任务默认使用可写工作区访问 / Verify normal tasks default to write workspace access
  test("starts non-plan tasks with write workspace access", () => {
    expect(initialWorkspaceAccessForTask("Create hello.txt")).toBe("write");
    expect(initialWorkspaceAccessForTask("")).toBe("write"); // 空任务也走 write / Empty task also uses write
  });
});

describe("normalizeGraphStream model retry events", () => {
  test("yields model_retry events when agent chunk contains modelRetries", async () => {
    const retries: ModelRetryEvent[] = [
      { attempt: 1, error: "ECONNRESET", delayMs: 500 },
      { attempt: 2, error: "ECONNRESET", delayMs: 1000 },
    ];

    async function* mockStream() {
      yield {
        agent: {
          messages: [{ type: "ai", content: "done" }],
          modelRetries: retries,
        },
      };
    }

    const events: AgentEvent[] = [];
    for await (const event of normalizeGraphStream(mockStream())) {
      events.push(event);
    }

    const retryEvents = events.filter((e): e is AgentEvent & { type: "model_retry"; data: ModelRetryEvent } => e.type === "model_retry");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0].data).toEqual(retries[0]);
    expect(retryEvents[1].data).toEqual(retries[1]);
  });

  test("does not yield model_retry when chunk has no modelRetries", async () => {
    async function* mockStream() {
      yield {
        agent: {
          messages: [{ type: "ai", content: "done" }],
        },
      };
    }

    const events: AgentEvent[] = [];
    for await (const event of normalizeGraphStream(mockStream())) {
      events.push(event);
    }

    const retryEvents = events.filter((e) => e.type === "model_retry");
    expect(retryEvents).toHaveLength(0);
  });

  test("yields model_retry events correctly ordered (before cache_metrics when applicable)", async () => {
    const retries: ModelRetryEvent[] = [
      { attempt: 1, error: "500 Internal Error", delayMs: 500 },
    ];

    async function* mockStream() {
      yield {
        agent: {
          modelRetries: retries,
        },
      };
    }

    const events: Array<{ type: string }> = [];
    for await (const event of normalizeGraphStream(mockStream())) {
      events.push({ type: event.type });
    }

    // update always comes first, then model_retry
    expect(events.map((e) => e.type)).toEqual(["update", "model_retry"]);
  });
});

describe("chunkToEvents final dedup", () => {
  const cacheStandard = createPromptCacheStandardTracker();

  test("does not emit final when it duplicates a text event", () => {
    const ai = new AIMessage({ content: "hello world" });
    const chunk = {
      agent: {
        messages: [ai],
        final: "hello world",
      },
    };

    const events = chunkToEvents(chunk, "write", cacheStandard);
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
    expect(events.filter((e) => e.type === "final")).toHaveLength(0);
  });

  test("emits final when its content differs from text events", () => {
    const ai = new AIMessage({ content: "actual response" });
    const chunk = {
      agent: {
        messages: [ai],
        final: "summary of the full conversation",
      },
    };

    const events = chunkToEvents(chunk, "write", cacheStandard);
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
    expect(events.filter((e) => e.type === "final")).toHaveLength(1);
  });

  test("emits final when there are no text events", () => {
    const chunk = {
      agent: {
        final: "done",
      },
    };

    const events = chunkToEvents(chunk, "write", cacheStandard);
    expect(events.filter((e) => e.type === "final")).toHaveLength(1);
    expect(events.filter((e) => e.type === "final")[0].data).toBe("done");
  });

  test("emits final when text events have different content", () => {
    const ai1 = new AIMessage({ content: "step 1" });
    const ai2 = new AIMessage({ content: "step 2" });
    const chunk = {
      agent: {
        messages: [ai1, ai2],
        final: "unique summary",
      },
    };

    const events = chunkToEvents(chunk, "write", cacheStandard);
    expect(events.filter((e) => e.type === "text")).toHaveLength(2);
    expect(events.filter((e) => e.type === "final")).toHaveLength(1);
  });
});
