import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  buildModelMessages,
  buildStaticSystemPrompt,
  prepareModelContext,
} from "../src/context";

describe("model context protocol", () => {
  test("keeps user input as the only HumanMessage and places run context in SystemMessage", () => {
    const task = "Create hello.txt with exact content \"hi\".";
    const messages = buildModelMessages("agent", {
      userId: "user-a",
      workspace: "D:\\workspace",
      modelName: "deepseek-chat",
      mode: "builder",
      plan: null,
      messages: [new HumanMessage(task)],
      final: "",
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(SystemMessage);
    expect(messages[2]).toBeInstanceOf(HumanMessage);
    expect(messages[2].content).toBe(task);
    expect(String(messages[2].content)).not.toContain("Plan:");
    expect(String(messages[2].content)).not.toContain("Tool results:");
    expect(String(messages[1].content)).toContain("Configured model: deepseek-chat");
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
  });

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
    const messages = buildModelMessages("agent", {
      userId: "user-a",
      workspace: "D:\\workspace",
      mode: "builder",
      plan: null,
      messages: [new HumanMessage(task), ai, tool],
      final: "",
    });

    expect(messages[2]).toBeInstanceOf(HumanMessage);
    expect(messages[3]).toBeInstanceOf(AIMessage);
    expect(messages[4]).toBeInstanceOf(ToolMessage);
    expect((messages[4] as ToolMessage).tool_call_id).toBe("call-1");
    expect(String(messages[1].content)).not.toContain("Tool result summary:");
    expect(String(messages[1].content)).not.toContain("Pending request:");
    expect(String(messages[1].content)).not.toContain("{\"ok\":true");
  });

  test("keeps dynamic context after reusable conversation prefix for DeepSeek cache", () => {
    const task = "Create hello.txt";
    const messages = buildModelMessages("agent", {
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

    expect(messages.slice(0, 5).map((message) => message.getType())).toEqual([
      "system",
      "system",
      "human",
      "ai",
      "tool",
    ]);
  });

  test("keeps a substantial stable static prompt for provider prefix caching", () => {
    const prompt = buildStaticSystemPrompt("agent");

    expect(prompt).toContain("Local Code Agent Contract");
    expect(prompt).toContain("Tool Policy");
    expect(prompt).toContain("Message Policy");
    expect(prompt).toContain("Completion Policy");
    expect(prompt).toContain("Respond in Chinese by default");
    expect(prompt).toContain("If the user asks about the current model");
    expect(prompt).not.toContain("浣犳槸");
    expect(prompt.length).toBeGreaterThan(1200);
  });

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

    const prepared = prepareModelContext("agent", {
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

    expect(prepared.contextSummary).toContain("Compacted 3 earlier message");
    expect(prepared.contextSummary).toContain("tool output truncated");
    expect(prepared.messages.map((message) => message.getType())).toEqual([
      "system",
      "system",
      "human",
      "ai",
      "tool",
    ]);
    expect((prepared.messages[4] as ToolMessage).tool_call_id).toBe("latest-call");
    expect(String(prepared.messages[1].content)).toContain("Context summary:");
  });

  test("includes progress heartbeat in cacheable runtime context", () => {
    const messages = buildModelMessages("agent", {
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

    expect(String(messages[1].content)).toContain("Progress heartbeat:");
    expect(String(messages[1].content)).toContain("Goal: Create hello.txt");
    expect(String(messages[1].content)).toContain("Next action: Run verification");
    expect(String(messages[1].content)).toContain("Verification: bun test: ok (0)");
  });
});
