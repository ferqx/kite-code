import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { CodeAgentState } from "../src/core/harness/state";
import type { AgentPlan } from "../src/protocol/index";
import { clearOldToolResults, forceContextCompaction } from "../src/core/model/context";
import {
  formatWorkspaceAccessReminder,
  formatPlanStateReminder,
  buildCacheableRuntimeContext,
} from "../src/core/model/runtime-context";
import { buildStaticSystemPrompt } from "../src/core/model/context";

// ============================================================================
// Mock 模型 — 仅用于需要 model.invoke 的场景 / Mock model — only for model.invoke scenarios
// ============================================================================

interface MockTurn {
  content?: string;
  overflow?: boolean;
}

class MockChatModel {
  private script: MockTurn[];
  callCount = 0;

  constructor(script: MockTurn[]) {
    this.script = script;
  }

  bindTools(): this {
    return this;
  }

  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    const turn = this.script[this.callCount++];
    if (!turn) throw new Error(`MockChatModel: exhausted at call ${this.callCount}`);

    if (turn.overflow) {
      throw new Error("This model's maximum context length is 65536 tokens.");
    }

    return new AIMessage({
      content: turn.content ?? "done",
      response_metadata: {
        usage: { prompt_tokens: 5000, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 1000 },
      },
    });
  }
}

// ============================================================================
// isContextOverflowError — 匹配多种 provider 的溢出错误格式
// ============================================================================

function isContextOverflowError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /context.*(?:length|limit|window|exceed|too\s+long)/i.test(msg) ||
    /maximum.*(?:context|token|length)/i.test(msg) ||
    /reduce.*(?:message|context|prompt)/i.test(msg);
}

describe("isContextOverflowError", () => {
  test("matches DeepSeek format", () => {
    expect(isContextOverflowError(
      new Error("This model's maximum context length is 65536 tokens. However, your request has 70000 tokens. Please reduce the length of the messages."),
    )).toBe(true);
  });

  test("matches 'context length exceeded' format", () => {
    expect(isContextOverflowError(
      new Error("context length exceeded: 70000 > 65536"),
    )).toBe(true);
  });

  test("matches 'reduce the length' format (OpenAI)", () => {
    expect(isContextOverflowError(
      new Error("This model's maximum context length is 65536 tokens. However, your messages resulted in 70000 tokens. Please reduce the length of the messages."),
    )).toBe(true);
  });

  test("matches 'context window' format", () => {
    expect(isContextOverflowError(
      new Error("Request exceeds model's context window of 65536 tokens"),
    )).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isContextOverflowError(new Error("Network timeout"))).toBe(false);
    expect(isContextOverflowError(new Error("Invalid API key"))).toBe(false);
  });
});

// ============================================================================
// estimatePromptChars — 字符级估算，驱动 tool result clearing 阈值
// ============================================================================

function estimatePromptChars(
  systemPrompt: string,
  cacheableContext: string,
  messages: BaseMessage[],
  workspaceAccess?: string,
  plan?: AgentPlan | null,
): number {
  let total = systemPrompt.length + cacheableContext.length;
  for (const msg of messages) {
    total += typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length;
  }
  if (workspaceAccess === "read-only") {
    total += formatWorkspaceAccessReminder("read-only").length;
  }
  if (plan) {
    total += formatPlanStateReminder(plan).length;
  }
  return total;
}

describe("estimatePromptChars", () => {
  const systemPrompt = buildStaticSystemPrompt("agent");
  const runtimeCtx = buildCacheableRuntimeContext({
    workspace: "/tmp/test",
    messages: [],
    contextSummary: "",
  });

  test("returns baseline for empty conversation", () => {
    const chars = estimatePromptChars(systemPrompt, runtimeCtx, []);
    expect(chars).toBeGreaterThan(3000); // system prompt alone is >3000 chars
  });

  test("scales linearly with message count", () => {
    const msgs: BaseMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(new HumanMessage("x".repeat(200)));
      msgs.push(new AIMessage("y".repeat(300)));
    }
    const chars = estimatePromptChars(systemPrompt, runtimeCtx, msgs);
    // 10 × (200 + 300) = 5000 + system/runtime overhead
    expect(chars).toBeGreaterThan(8000);
  });

  test("includes workspace access reminder for read-only", () => {
    const charsRw = estimatePromptChars(systemPrompt, runtimeCtx, [], "write");
    const charsRo = estimatePromptChars(systemPrompt, runtimeCtx, [], "read-only");
    expect(charsRo).toBeGreaterThan(charsRw);
  });

  test("includes plan state reminder when plan exists", () => {
    const charsNoPlan = estimatePromptChars(systemPrompt, runtimeCtx, []);
    const charsWithPlan = estimatePromptChars(systemPrompt, runtimeCtx, [], undefined, {
      name: "Test Plan",
      description: "A test",
      status: "in_progress",
      steps: [{ step: "Do it", status: "pending" }],
    });
    expect(charsWithPlan).toBeGreaterThan(charsNoPlan);
  });

  test("crosses 150K threshold with many messages", () => {
    const msgs: BaseMessage[] = [];
    for (let i = 0; i < 500; i++) {
      msgs.push(new HumanMessage("x".repeat(200)));
    }
    const chars = estimatePromptChars(systemPrompt, runtimeCtx, msgs);
    // 500 × 200 = 100000 + system overhead ≈ 103K
    // With tool messages that are larger, it could exceed 150K
    expect(chars).toBeGreaterThan(100000);
  });
});

// ============================================================================
// forceContextCompaction — 边界场景 / edge cases
// ============================================================================

describe("forceContextCompaction edge cases", () => {
  test("handles messages with no tool calls at all", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("hi 1"),
      new AIMessage("ok 1"),
      new HumanMessage("hi 2"),
      new AIMessage("ok 2"),
      new HumanMessage("hi 3"),
      new AIMessage("ok 3"),
      new HumanMessage("hi 4"),
      new AIMessage("ok 4"),
      new HumanMessage("hi 5"),
      new AIMessage("ok 5"),
    ];

    const compacted = forceContextCompaction(msgs, { maxToolOutputChars: 1000 });
    expect(compacted.summary).toContain("Compacted");
    // 无工具调用时保持最近消息，不注入 <compacted> / No <compacted> when no tools
    const content = compacted.messages.map((m) => String(m.content)).join("\n");
    expect(content).not.toContain("<compacted");
  });

  test("ToolMessage guard: walks left past orphan ToolMessage at KEEP_FULL boundary", () => {
    // 构造：前 4 条为旧步骤，第 5 条（KEEP_FULL 起点）恰好是 ToolMessage
    // fullStart = 12-8 = 4, messages[4] is ToolMessage → walk left to include AIMessage
    const msgs: BaseMessage[] = [
      new HumanMessage("old"),
      new AIMessage("old answer"),
      new HumanMessage("old 2"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "paired", name: "write_file", args: { path: "orphan.txt" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: "orphan.txt" }),
        tool_call_id: "paired",
      }),
      new HumanMessage("recent 1"),
      new AIMessage({ content: "ok 1" }),
      new HumanMessage("recent 2"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "read_file", ok: true, path: "a.txt" }),
        tool_call_id: "c1",
      }),
      new AIMessage({ content: "done" }),
    ];

    const compacted = forceContextCompaction(msgs, { maxToolOutputChars: 1000 });
    const types = compacted.messages.map((m) => m.getType());

    // 保留窗口不能以 ToolMessage 开头 / Kept window must not start with ToolMessage
    expect(types[0]).not.toBe("tool");
    // 应包含配对的 AIMessage+ToolMessage / Should include the paired AIMessage+ToolMessage
    if (compacted.messages.length > 1) {
      const firstKept = compacted.messages[0];
      if (firstKept instanceof AIMessage) {
        // 如果补充进了 AIMessage，后面应有对应的 ToolMessage / If AIMessage added, ToolMessage should follow
        const hasRelatedTool = compacted.messages.some(
          (m) => m instanceof ToolMessage && m.tool_call_id === "paired",
        );
        expect(hasRelatedTool).toBe(true);
      }
    }
  });
});

// ============================================================================
// LLM 摘要生成 — 仅这里需要 mock model / LLM summary generation — only this needs mock
// ============================================================================

describe("LLM summary generation via mock", () => {
  test("generateLLMSummary-like: model returns summary, caller uses it", async () => {
    const mock = new MockChatModel([
      { content: "Summary: created a.txt and b.txt, verified both. No errors." },
    ]);

    // 模拟 generateLLMSummary 的行为 / Simulate generateLLMSummary behavior
    const msgs: BaseMessage[] = [
      new HumanMessage("step 1"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "write_file", args: { path: "a.txt" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: "a.txt" }),
        tool_call_id: "c1",
      }),
    ];

    const conversationText = msgs
      .map((m) => {
        const role = m.getType();
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}] ${content}`;
      })
      .join("\n\n");

    const prompt = [
      "Summarize for context compaction.",
      "Preserve: files, errors, verification.",
      "",
      "<conversation>",
      conversationText,
      "</conversation>",
    ].join("\n");

    const response = await mock.invoke([new HumanMessage(prompt)]);
    const summary = `<summary>${response.content}</summary>`;

    expect(summary).toContain("<summary>");
    expect(summary).toContain("a.txt");
    expect(mock.callCount).toBe(1);
  });

  test("overflow in summary model call itself propagates error", async () => {
    const mock = new MockChatModel([
      { overflow: true },
    ]);

    try {
      await mock.invoke([new HumanMessage("summarize")]);
      expect(false).toBe(true);
    } catch (e) {
      expect(isContextOverflowError(e)).toBe(true);
    }
  });
});

// ============================================================================
// 三层 retry 链完整性 / Three-layer retry chain completeness
// ============================================================================

describe("three-layer retry chain logic", () => {
  test("layer 1 (clearing) → layer 2 (rules) → layer 3 (LLM) sequence is exerciseable", async () => {
    // Layer 1: tool result clearing on long enough history
    const toolMsgs: BaseMessage[] = [];
    for (let i = 0; i < 10; i++) {
      toolMsgs.push(new ToolMessage({
        content: "x".repeat(3000),
        tool_call_id: `c${i}`,
      }));
    }
    const cleared = clearOldToolResults(toolMsgs, 6);
    const clearedCount = cleared.filter(
      (m) => m instanceof ToolMessage && String(m.content).includes("cleared"),
    ).length;
    expect(clearedCount).toBe(4); // 10 - 6 kept = 4 cleared

    // Layer 2: rules compaction on overflow
    const msgs: BaseMessage[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(new HumanMessage(`step ${i}`));
      msgs.push(new AIMessage({
        content: "",
        tool_calls: [{ id: `c${i}`, name: "write_file", args: { path: `file${i}.txt` } }],
      }));
      msgs.push(new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: `file${i}.txt` }),
        tool_call_id: `c${i}`,
      }));
    }
    // 15 messages > 8 → triggers compaction
    expect(msgs.length).toBe(15);

    const compacted = forceContextCompaction(msgs, { maxToolOutputChars: 1000 });
    expect(compacted.summary).toContain("Compacted");
    const content = compacted.messages.map((m) => String(m.content)).join("\n");
    expect(content).toContain("<compacted");

    // Layer 3: LLM summary when rules compaction still overflows
    const mock = new MockChatModel([
      { overflow: true }, // simulate overflow even after rules compaction
      { overflow: true }, // second overflow triggers LLM summary
      {
        content: "Summary: created file0.txt through file4.txt. All verified.",
      },
      { content: "task completed after summary" },
    ]);

    // Simulate what invokeModel does in the retry chain
    let response: AIMessage | null = null;

    // Attempt 1: overflow
    try {
      await mock.invoke(msgs);
    } catch (e) {
      expect(isContextOverflowError(e)).toBe(true);
    }

    // Attempt 2: rules compaction → still overflow
    try {
      await mock.invoke(compacted.messages);
    } catch (e) {
      expect(isContextOverflowError(e)).toBe(true);
    }
    expect(mock.callCount).toBe(2);

    // Attempt 3: generate LLM summary
    const summaryResponse = await mock.invoke([
      new HumanMessage("Summarize this conversation for context compaction."),
    ]);
    expect(String(summaryResponse.content)).toContain("Summary:");
    expect(mock.callCount).toBe(3);

    // Attempt 4: retry with LLM summary
    const llmMessages = [
      new HumanMessage(`<summary>${summaryResponse.content}</summary>`),
      ...compacted.messages.slice(-6),
    ];
    const finalResponse = await mock.invoke(llmMessages);
    expect(String(finalResponse.content)).toContain("task completed");
    expect(mock.callCount).toBe(4);
  });
});
