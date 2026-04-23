import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { buildModelMessages, buildStaticSystemPrompt } from "../src/context";

describe("model context protocol", () => {
  test("keeps user input as the only HumanMessage and places run context in SystemMessage", () => {
    const task = "Create hello.txt with exact content \"hi\".";
    const messages = buildModelMessages("agent", {
      task,
      userId: "user-a",
      workspace: "D:\\workspace",
      modelName: "deepseek-chat",
      threadMode: "builder",
      roles: ["planner"],
      toolRequest: null,
      toolResults: ["patch ok"],
      messages: [new HumanMessage(task)],
      final: "",
      verification: "verification passed",
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[2]).toBeInstanceOf(SystemMessage);
    expect(messages[1].content).toBe(task);
    expect(String(messages[1].content)).not.toContain("Plan:");
    expect(String(messages[1].content)).not.toContain("Tool results:");
    expect(String(messages[2].content)).not.toContain("Plan draft:");
    expect(String(messages[2].content)).not.toContain("Tool result summary:");
    expect(String(messages[2].content)).toContain("Configured model: deepseek-chat");
    expect(String(messages[2].content)).toContain("Verification: verification passed");
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
      task,
      userId: "user-a",
      workspace: "D:\\workspace",
      threadMode: "builder",
      roles: ["coder"],
      toolRequest: null,
      toolResults: ["tool summary only"],
      messages: [new HumanMessage(task), ai, tool],
      final: "",
      verification: "verification passed",
    });

    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[2]).toBeInstanceOf(AIMessage);
    expect(messages[3]).toBeInstanceOf(ToolMessage);
    expect(messages[4]).toBeInstanceOf(SystemMessage);
    expect((messages[3] as ToolMessage).tool_call_id).toBe("call-1");
    expect(String(messages[4].content)).not.toContain("Tool result summary:");
    expect(String(messages[4].content)).not.toContain("Pending request:");
    expect(String(messages[4].content)).not.toContain("{\"ok\":true");
  });

  test("keeps dynamic context after reusable conversation prefix for DeepSeek cache", () => {
    const task = "Create hello.txt";
    const messages = buildModelMessages("agent", {
      task,
      userId: "user-a",
      workspace: "D:\\workspace",
      threadMode: "builder",
      roles: ["agent", "tools"],
      toolRequest: null,
      toolResults: ["volatile tool result summary"],
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
      verification: "",
    });

    expect(messages.slice(0, 4).map((message) => message.getType())).toEqual([
      "system",
      "human",
      "ai",
      "tool",
    ]);
    expect(messages[4]).toBeInstanceOf(SystemMessage);
  });

  test("keeps a substantial stable static prompt for provider prefix caching", () => {
    const prompt = buildStaticSystemPrompt("agent");

    expect(prompt).toContain("Local Code Agent Contract");
    expect(prompt).toContain("Tool Policy");
    expect(prompt).toContain("Message Policy");
    expect(prompt).toContain("Completion Policy");
    expect(prompt.length).toBeGreaterThan(1200);
  });
});
