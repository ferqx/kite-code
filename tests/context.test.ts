import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  buildModelMessages,
  buildStaticSystemPrompt,
  prepareModelContext,
} from "../src/context";

// 测试模型上下文构建和压缩逻辑 / Test model context building and compaction logic
describe("model context protocol", () => {
  // 验证用户输入作为唯一的 HumanMessage，运行上下文放在 SystemMessage 中 / Verify user input stays as sole HumanMessage, runtime context in SystemMessage
  test("keeps user input as the only HumanMessage and places run context in SystemMessage", () => {
    const task = "Create hello.txt with exact content \"hi\".";
    const messages = buildModelMessages("agent_build", {
      userId: "user-a",
      workspace: "D:\\workspace",
      modelName: "deepseek-chat",
      mode: "builder",
      plan: null,
      messages: [new HumanMessage(task)],
      final: "",
    });

    expect(messages).toHaveLength(3); // 2 个 SystemMessage + 1 个 HumanMessage / 2 SystemMessages + 1 HumanMessage
    expect(messages[0]).toBeInstanceOf(SystemMessage); // 静态系统提示 / Static system prompt
    expect(messages[1]).toBeInstanceOf(SystemMessage); // 动态运行时上下文 / Dynamic runtime context
    expect(messages[2]).toBeInstanceOf(HumanMessage); // 用户任务 / User task
    expect(messages[2].content).toBe(task);
    expect(String(messages[2].content)).not.toContain("Plan:"); // 上下文信息不混入用户消息 / Context not mixed into user message
    expect(String(messages[2].content)).not.toContain("Tool results:");
    expect(String(messages[1].content)).toContain("Configured model: deepseek-chat");
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
  });

  // 验证工具调用链保留在动态 SystemMessage 外部，不混入运行时上下文 / Verify tool-call chain stays outside dynamic SystemMessage, not mixed into runtime context
  test("preserves tool-call message chain outside dynamic SystemMessage", () => {
    const task = "Create hello.txt";
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call-1",
          name: "apply_patch",
          args: { path: "hello.txt", content: "hi\n" },
        },
      ],
    });
    const tool = new ToolMessage({
      content: "{\"ok\":true,\"path\":\"hello.txt\"}",
      tool_call_id: "call-1",
      status: "success",
    });
    const messages = buildModelMessages("agent_build", {
      userId: "user-a",
      workspace: "D:\\workspace",
      mode: "builder",
      plan: null,
      messages: [new HumanMessage(task), ai, tool],
      final: "",
    });

    expect(messages[2]).toBeInstanceOf(HumanMessage); // 用户消息 / User message
    expect(messages[3]).toBeInstanceOf(AIMessage); // AI 工具调用 / AI tool call
    expect(messages[4]).toBeInstanceOf(ToolMessage); // 工具返回 / Tool response
    expect((messages[4] as ToolMessage).tool_call_id).toBe("call-1");
    expect(String(messages[1].content)).not.toContain("Tool result summary:"); // 工具结果不应在动态上下文中 / Tool results not in dynamic context
    expect(String(messages[1].content)).not.toContain("Pending request:");
    expect(String(messages[1].content)).not.toContain("{\"ok\":true");
  });

  // 验证动态上下文放在可复用对话前缀之后，以利用 DeepSeek 缓存 / Verify dynamic context sits after reusable prefix for DeepSeek cache hit
  test("keeps dynamic context after reusable conversation prefix for DeepSeek cache", () => {
    const task = "Create hello.txt";
    const messages = buildModelMessages("agent_build", {
      userId: "user-a",
      workspace: "D:\\workspace",
      mode: "builder",
      plan: null,
      messages: [
        new HumanMessage(task),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "shell_execute",
              args: { command: "pwd" },
            },
          ],
        }),
        new ToolMessage({
          content: "ok",
          tool_call_id: "call-1",
        }),
      ],
      final: "",
    });

    // 消息顺序：静态提示、动态上下文、用户消息、AI 调用、工具返回 / Order: static prompt, dynamic context, user message, AI call, tool response
    expect(messages.slice(0, 5).map((message) => message.getType())).toEqual([
      "system",
      "system",
      "human",
      "ai",
      "tool",
    ]);
  });

  // 验证静态系统提示足够大且稳定，以利用提供商前缀缓存 / Verify static system prompt is substantial and stable for provider prefix caching
  test("keeps a substantial stable static prompt for provider prefix caching", () => {
    const prompt = buildStaticSystemPrompt("agent_build");

    expect(prompt).toContain("Builder Agent Contract");
    expect(prompt).toContain("Tool policy");
    expect(prompt).toContain("Message policy");
    expect(prompt).toContain("Completion policy");
    expect(prompt).toContain("Respond in Chinese by default"); // 默认中文回复 / Default Chinese response
    expect(prompt).toContain("If the user asks about the current model");
    expect(prompt).not.toContain("浣犳槸"); // 不含乱码 / No garbled text
    expect(prompt.length).toBeGreaterThan(1200); // 提示词应足够长以触发缓存 / Prompt must be long enough for cache threshold
  });

  // 验证压缩长历史时保留最新的工具调用链 / Verify long histories are compacted while keeping the latest tool-call chain
  test("compacts long histories while preserving the latest tool-call chain", () => {
    const oldToolOutput = "x".repeat(100);
    const latestAi = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "latest-call",
          name: "shell_execute",
          args: { command: "pwd" },
        },
      ],
    });
    const latestTool = new ToolMessage({
      content: "latest result",
      tool_call_id: "latest-call",
      status: "success",
    });

    const prepared = prepareModelContext("agent_build", {
      userId: "user-a",
      workspace: "D:\\workspace",
      mode: "builder",
      plan: null,
      contextSummary: "",
      messages: [
        new HumanMessage("Create hello.txt"),
        new AIMessage("old answer"),
        new ToolMessage({
          content: oldToolOutput,
          tool_call_id: "old-call",
        }),
        new HumanMessage("continue"),
        latestAi,
        latestTool,
      ],
      final: "",
      contextBudget: {
        maxMessages: 3,
        maxToolOutputChars: 20,
      },
    });

    expect(prepared.contextSummary).toContain("Compacted 3 earlier message"); // 旧消息被折叠 / Old messages folded
    expect(prepared.contextSummary).toContain("tool output truncated"); // 大工具输出被截断 / Large tool output truncated
    expect(prepared.messages.map((message) => message.getType())).toEqual([
      "system",
      "system",
      "human",
      "ai",
      "tool",
    ]);
    expect((prepared.messages[4] as ToolMessage).tool_call_id).toBe("latest-call"); // 最新工具调用保留 / Latest tool call preserved
    expect(String(prepared.messages[1].content)).toContain("Context summary:"); // 动态上下文包含摘要 / Dynamic context includes summary
  });

  // 验证可缓存的运行时上下文中包含进度心跳信息 / Verify cacheable runtime context includes progress heartbeat
  test("includes progress heartbeat in cacheable runtime context", () => {
    const messages = buildModelMessages("agent_build", {
      userId: "user-a",
      workspace: "D:\\workspace",
      mode: "builder",
      plan: null,
      messages: [new HumanMessage("Create hello.txt")],
      final: "",
      progress: {
        toolCallCount: 2,
        stagnantStepCount: 0,
        repeatedCallCount: 1,
        lastToolSignature: "shell_execute:{\"command\":\"bun test\"}",
        recentOutputSignatures: ["ok"],
        heartbeat: {
          goal: "Create hello.txt",
          findings: ["Edited hello.txt"],
          nextAction: "Run verification",
          blockers: [],
          verification: ["bun test: ok (0)"],
        },
      },
    });

    expect(String(messages[1].content)).toContain("Progress heartbeat:"); // 心跳节出现在动态上下文 / Heartbeat in dynamic context
    expect(String(messages[1].content)).toContain("Goal: Create hello.txt");
    expect(String(messages[1].content)).toContain("Next action: Run verification");
    expect(String(messages[1].content)).toContain("Verification: bun test: ok (0)"); // 验证结果已记录 / Verification result recorded
  });
});
