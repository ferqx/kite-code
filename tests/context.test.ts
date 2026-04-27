import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  buildModelMessages,
  buildStaticSystemPrompt,
  prepareModelContext,
} from "../src/model/context";

// 测试模型上下文构建和压缩逻辑 / Test model context building and compaction logic
describe("model context protocol", () => {
  // 验证用户输入作为唯一的 HumanMessage，运行上下文放在 SystemMessage 中 / Verify user input stays as sole HumanMessage, runtime context in SystemMessage
  test("keeps user input as the only HumanMessage and places useful run context in SystemMessage", () => {
    const task = "Create hello.txt with exact content \"hi\".";
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
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
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
    expect(String(messages[1].content)).toContain("Workspace access policy:");
    expect(String(messages[1].content)).not.toContain("Tool policy (builder mode):");
    expect(String(messages[1].content)).not.toContain("Configured model:");
    expect(String(messages[1].content)).not.toContain("User ID:");
    expect(String(messages[1].content)).not.toContain("Thread mode:");
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
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
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

  // 验证动态上下文放在可复用对话前缀之后，以利用 provider 前缀缓存 / Verify dynamic context sits after reusable conversation prefix for provider cache hit
  test("keeps dynamic context after reusable conversation prefix for provider cache", () => {
    const task = "Create hello.txt";
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
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

  // 验证单一静态系统提示足够大且稳定，避免访问权限变化破坏 provider 前缀缓存 / Verify one stable static prompt for provider prefix caching
  test("uses one substantial stable static prompt for the agent", () => {
    const prompt = buildStaticSystemPrompt("agent");

    expect(prompt).toContain("Code Agent Contract");
    expect(prompt).toContain("Planning policy");
    expect(prompt).toContain("Execution policy");
    expect(prompt).toContain("Workspace access policy");
    expect(prompt).toContain("Message policy");
    expect(prompt).toContain("Completion policy");
    expect(prompt).toContain("Respond in Chinese by default"); // 默认中文回复 / Default Chinese response
    expect(prompt).not.toContain("current model");
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

    const prepared = prepareModelContext("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
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
    expect(String(prepared.messages[1].content)).not.toContain("Context summary:"); // 运行时上下文不含动态摘要 / Runtime context excludes dynamic summary
    expect(prepared.messages.map((message) => String(message.content)).join("\n")).not.toContain(
      '<runtime-state source="harness.runtime">',
    );
  });

  // 验证 plan 作为 harness 生成的用户侧状态提醒注入尾部，避免 provider 特殊处理 system role / Verify plan is injected as a trailing synthetic user-side state reminder
  test("injects plan as trailing synthetic user-side state reminder", () => {
    const plan = {
      name: "Add dark mode",
      description: "Add dark mode toggle to settings",
      status: "in_progress" as const,
      steps: [
        { step: "Create toggle component", status: "completed" as const },
        { step: "Update styles", status: "in_progress" as const },
        { step: "Run tests", status: "pending" as const },
      ],
    };
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
      plan,
      messages: [new HumanMessage("Create dark mode")],
      final: "",
    });

    // 消息顺序：system, system, human(user), human(synthetic state reminder) / Message order: system, system, human(user), human(synthetic state reminder)
    expect(messages).toHaveLength(4);
    expect(messages[0]).toBeInstanceOf(SystemMessage); // 静态提示 / Static prompt
    expect(messages[1]).toBeInstanceOf(SystemMessage); // 运行时上下文 / Runtime context
    expect(messages[2]).toBeInstanceOf(HumanMessage);
    expect(String(messages[2].content)).toBe("Create dark mode");
    expect(messages[3]).toBeInstanceOf(HumanMessage); // synthetic 状态提醒 / Synthetic state reminder
    expect(String(messages[3].content)).toContain('<runtime-state source="graph.state.plan">');
    expect(String(messages[3].content)).toContain("This message is generated by the harness, not by the user.");
    expect(String(messages[3].content)).toContain("Name: Add dark mode");
    expect(String(messages[3].content)).toContain("Status: in_progress");
    expect(String(messages[3].content)).toContain("Description: Add dark mode toggle to settings");
    expect(String(messages[3].content)).toContain("- [completed] Create toggle component");
    expect(String(messages[3].content)).toContain("- [in_progress] Update styles");
    expect(String(messages[3].content)).toContain("- [pending] Run tests");

    // system prompt 前缀不受 plan 状态影响 / system prompt prefix unchanged by plan state
    expect(String(messages[0].content)).toContain("Code Agent Contract");
    expect(String(messages[0].content)).not.toContain("<runtime-state");
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
    expect(String(messages[1].content)).not.toContain("<runtime-state");
    expect(String(messages[1].content)).not.toContain("graph.state.plan:"); // plan 不在可缓存上下文中 / plan not in cacheable context
  });

  // 验证当前只读工作区访问作为尾部合成用户侧状态提醒注入，不改变 system prompt 前缀 / Verify read-only workspace access is projected as a trailing synthetic user-side reminder
  test("projects read-only workspace access as trailing synthetic user-side state reminder", () => {
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "read-only",
      plan: null,
      messages: [new HumanMessage("Inspect before editing")],
      final: "",
    });

    expect(messages.map((message) => message.getType())).toEqual([
      "system",
      "system",
      "human",
      "human",
    ]);
    expect(String(messages[0].content)).toContain("Code Agent Contract");
    expect(String(messages[0].content)).not.toContain("Current workspace access: read-only");
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
    expect(String(messages[1].content)).not.toContain("Current workspace access:");
    expect(String(messages[3].content)).toContain(
      '<runtime-state source="graph.state.workspaceAccess">',
    );
    expect(String(messages[3].content)).toContain("Current workspace access: read-only");
    expect(String(messages[3].content)).toContain("read-only");
  });
});
