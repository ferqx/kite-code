import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildModelMessages,
  buildStaticSystemPrompt,
  prepareModelContext,
  reorderInterleavedMessages,
  sanitizeToolCallPairs,
} from "../src/core/model/context";
import type { SkillManifest } from "../src/core/skills/types";

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

    expect(messages).toHaveLength(2); // 1 SystemMessage + 1 HumanMessage
    expect(messages[0]).toBeInstanceOf(SystemMessage); // 合并后的系统提示词 / Merged system prompt (static + cacheable)
    expect(messages[1]).toBeInstanceOf(HumanMessage); // 用户任务 / User task
    expect(messages[1].content).toBe(task);
    expect(String(messages[1].content)).not.toContain("Plan:");
    expect(String(messages[1].content)).not.toContain("Tool results:");
    expect(String(messages[0].content)).toContain("Cacheable runtime context:");
    expect(String(messages[0].content)).toContain("Workspace:");
    expect(String(messages[0].content)).not.toContain("Tool policy (builder mode):");
    expect(String(messages[0].content)).not.toContain("Configured model:");
    expect(String(messages[0].content)).not.toContain("User ID:");
    expect(String(messages[0].content)).not.toContain("Thread mode:");
  });

  // 验证工具调用链保留在动态 SystemMessage 外部，不混入运行时上下文 / Verify tool-call chain stays outside dynamic SystemMessage, not mixed into runtime context
  test("preserves completed tool-call message chain outside dynamic SystemMessage", () => {
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

    expect(messages[1]).toBeInstanceOf(HumanMessage); // 用户消息 / User message
    expect(messages[2]).toBeInstanceOf(AIMessage); // AI 工具调用 / AI tool call
    expect(messages[3]).toBeInstanceOf(ToolMessage); // 工具返回 / Tool response
    expect((messages[3] as ToolMessage).tool_call_id).toBe("call-1");
    expect(String(messages[0].content)).not.toContain("Tool result summary:");
    expect(String(messages[0].content)).not.toContain("Pending request:");
    expect(String(messages[0].content)).not.toContain("{\"ok\":true");
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

    // 消息顺序：合并系统提示词、用户消息、AI 调用、工具返回 / Order: merged system prompt, user message, AI call, tool response
    expect(messages.slice(0, 4).map((message) => message.getType())).toEqual([
      "system",
      "human",
      "ai",
      "tool",
    ]);
  });


  // 验证 plan 作为高频动态状态注入尾部 HumanMessage，避免动态 SystemMessage 破坏 provider 缓存 / Verify plan is injected as trailing HumanMessage after conversation messages
  test("injects plan as trailing synthetic HumanMessage after conversation messages", () => {
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

    // 消息顺序：system(merged), human(user), human(synthetic plan reminder)
    expect(messages).toHaveLength(3);
    expect(messages[0]).toBeInstanceOf(SystemMessage); // 合并系统提示词 / Merged system prompt
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(String(messages[1].content)).toBe("Create dark mode");
    expect(messages[2]).toBeInstanceOf(HumanMessage);
    expect(String(messages[2].content)).toContain('<runtime-state source="graph.state.plan">');
    expect(String(messages[2].content)).toContain("This message is generated by the harness, not by the user.");
    expect(String(messages[2].content)).toContain("Name: Add dark mode");
    expect(String(messages[2].content)).toContain("Status: in_progress");
    expect(String(messages[2].content)).toContain("Description: Add dark mode toggle to settings");
    expect(String(messages[2].content)).toContain("- [completed] Create toggle component");
    expect(String(messages[2].content)).toContain("- [in_progress] Update styles");
    expect(String(messages[2].content)).toContain("- [pending] Run tests");

    expect(String(messages[0].content)).not.toContain("Add dark mode");
    expect(String(messages[0].content)).not.toContain("Create toggle component");
    expect(String(messages[0].content)).toContain("Cacheable runtime context:");
    expect(String(messages[0].content)).not.toContain("<runtime-state");
    expect(String(messages[0].content)).not.toContain("graph.state.plan:");
  });

  // 验证 write 工作区访问不再注入独立 HumanMessage 提醒 / Verify write workspace access no longer injects a dedicated HumanMessage
  test("does not inject workspaceAccess reminder when write access", () => {
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
      plan: null,
      messages: [new HumanMessage("Inspect before editing")],
      final: "",
    });

    expect(messages.map((message) => message.getType())).toEqual([
      "system",
      "human",
    ]);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(String(messages[0].content)).not.toContain("Current workspace access:");
    expect(String(messages[0].content)).toContain("Cacheable runtime context:");
    expect(String(messages[0].content)).not.toContain("Current workspace access:");
    expect(String(messages[1].content)).toBe("Inspect before editing");
  });

  // 验证 plan 尾部 HumanMessage 仍然注入，但不再有 workspaceAccess 提醒 / Verify plan HumanMessage still injected without workspaceAccess reminder
  test("projects plan HumanMessage without workspaceAccess reminder", () => {
    const plan = {
      name: "Inspect cache layout",
      description: "Check prompt cache behavior before editing",
      status: "in_progress" as const,
      steps: [
        { step: "Inspect context assembly", status: "completed" as const },
        { step: "Run cache experiment", status: "in_progress" as const },
      ],
    };
    const messages = buildModelMessages("agent", {
      workspace: "D:\\workspace",
      workspaceAccess: "write",
      plan,
      messages: [new HumanMessage("/plan inspect cache behavior")],
      final: "",
    });

    expect(messages.map((message) => message.getType())).toEqual([
      "system",
      "human",
      "human",
    ]);
    expect(messages[2]).toBeInstanceOf(HumanMessage);
    expect(String(messages[1].content)).toBe("/plan inspect cache behavior");
    expect(String(messages[2].content)).toContain('<runtime-state source="graph.state.plan">');
    expect(String(messages[2].content)).toContain("Name: Inspect cache layout");
    expect(String(messages[0].content)).not.toContain("Inspect cache layout");
    expect(String(messages[0].content)).not.toContain("<runtime-state");
  });

});

describe("buildStaticSystemPrompt with skills", () => {
  test("includes Available Skills section when skills provided", () => {
    const skills: SkillManifest[] = [
      { name: "tdd", description: "Use when writing tests", source: "project", origin: ".openpx" },
      { name: "debugging", description: "Use when debugging", source: "user", origin: ".agents" },
    ];
    const prompt = buildStaticSystemPrompt("agent", skills);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("- tdd: Use when writing tests");
    expect(prompt).toContain("- debugging: Use when debugging");
    expect(prompt).toContain("`Skill`");
  });

  test("does not include section when skills empty", () => {
    const prompt = buildStaticSystemPrompt("agent", []);
    expect(prompt).not.toContain("## Available Skills");
  });

  test("does not include section when skills undefined (backwards compat)", () => {
    const prompt = buildStaticSystemPrompt("agent");
    expect(prompt).not.toContain("## Available Skills");
  });

  // ── Prompt cache: prefix stability ──

  test("base prompt is prefix of skills-included prompt", () => {
    const base = buildStaticSystemPrompt("agent");
    const skills: SkillManifest[] = [
      { name: "tdd", description: "Test-driven development", source: "project", origin: ".openpx" },
    ];
    const withSkills = buildStaticSystemPrompt("agent", skills);
    // 技能追加在末尾，不破坏 base 前缀缓存
    expect(withSkills.startsWith(base)).toBe(true);
  });

  test("skills appended at end, not injected in middle", () => {
    const base = buildStaticSystemPrompt("agent");
    const skills: SkillManifest[] = [
      { name: "tdd", description: "TDD workflow", source: "project", origin: ".openpx" },
    ];
    const withSkills = buildStaticSystemPrompt("agent", skills);
    // 验证技能 section 出现在 base 之后（base + 换行间隔）
    const skillsIndex = withSkills.indexOf("## Available Skills");
    expect(skillsIndex).toBeGreaterThan(0);
    // skills section must come strictly after the base prompt (no injection)
    expect(skillsIndex).toBeGreaterThan(base.length - 1);
    // skills content must NOT appear in base portion
    expect(withSkills.substring(0, base.length)).toBe(base);
  });

  test("prompt is idempotent for same skills", () => {
    const skills: SkillManifest[] = [
      { name: "tdd", description: "TDD workflow", source: "project", origin: ".openpx" },
    ];
    const prompt1 = buildStaticSystemPrompt("agent", skills);
    const prompt2 = buildStaticSystemPrompt("agent", skills);
    expect(prompt1).toBe(prompt2);
  });

  test("multiple skills preserved in stable input order", () => {
    const skills: SkillManifest[] = [
      { name: "z-skill", description: "Z description", source: "project", origin: ".openpx" },
      { name: "a-skill", description: "A description", source: "project", origin: ".openpx" },
    ];
    const prompt = buildStaticSystemPrompt("agent", skills);
    // 技能按输入顺序列出（不重新排序），保持可预测性
    const zIndex = prompt.indexOf("- z-skill:");
    const aIndex = prompt.indexOf("- a-skill:");
    expect(zIndex).toBeGreaterThan(0);
    expect(aIndex).toBeGreaterThan(0);
    expect(zIndex).toBeLessThan(aIndex);
  });
});

// ============================================================================
// sanitizeToolCallPairs — 脏 checkpoint 消息清洗
// 场景：进程崩溃/Ctrl+C 导致 checkpoint 中 AIMessage 的 tool_calls 缺少对应 ToolMessage，
// 或 ToolMessage 缺少对应的 AIMessage。直接发给 DeepSeek API 会触发 400 错误。
// ============================================================================
describe("sanitizeToolCallPairs", () => {
  test("passes through clean HumanMessages unchanged", () => {
    const msgs: BaseMessage[] = [new HumanMessage("hello")];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(1);
    expect(HumanMessage.isInstance(result[0])).toBe(true);
  });

  test("passes through clean paired tool_call + ToolMessage unchanged", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("run ls"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] }),
      new ToolMessage({ content: "file list", tool_call_id: "c1" }),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(3);
    expect(AIMessage.isInstance(result[1])).toBe(true);
    expect((result[1] as AIMessage).tool_calls).toHaveLength(1);
    expect(ToolMessage.isInstance(result[2])).toBe(true);
  });

  test("strips orphaned tool_calls from AIMessage but keeps text content", () => {
    // 模拟：进程在工具执行前崩溃，AIMessage 有 tool_calls 但没有 ToolMessage
    const msgs: BaseMessage[] = [
      new HumanMessage("run ls"),
      new AIMessage({
        content: "Let me run that command",
        tool_calls: [{ id: "orphan-1", name: "shell_execute", args: { command: "ls" } }],
      }),
      new HumanMessage("next question"),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(3);

    // AIMessage 保留文本内容，但 tool_calls 被清空
    const ai = result[1] as AIMessage;
    expect(AIMessage.isInstance(ai)).toBe(true);
    const content = typeof ai.content === "string" ? ai.content : "";
    expect(content).toContain("Let me run that command");
    expect(ai.tool_calls).toHaveLength(0);
  });

  test("removes orphaned ToolMessage with no matching AIMessage", () => {
    // 模拟：进程崩溃导致 ToolMessage 还在但 AIMessage 的 tool_calls 丢失
    const msgs: BaseMessage[] = [
      new HumanMessage("hey"),
      new ToolMessage({ content: "orphan result", tool_call_id: "ghost-1" }),
      new HumanMessage("continue"),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    expect(HumanMessage.isInstance(result[0])).toBe(true);
    expect(HumanMessage.isInstance(result[1])).toBe(true);
  });

  test("handles mix of paired and orphaned messages correctly", () => {
    // 混合：有正常的配对，也有孤儿
    const msgs: BaseMessage[] = [
      new HumanMessage("step 1"),
      new AIMessage({ content: "ok", tool_calls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] }),
      new ToolMessage({ content: "content", tool_call_id: "c1" }),             // paired ✓
      new HumanMessage("step 2"),
      new AIMessage({ content: "running", tool_calls: [{ id: "c2", name: "shell_execute", args: { command: "npm test" } }] }),
      // ToolMessage for c2 is MISSING (crash before tool ran)
      new AIMessage({ content: "All done!" }),
      new ToolMessage({ content: "ghost result", tool_call_id: "ghost" }),     // orphan ToolMessage ✗
    ];
    const result = sanitizeToolCallPairs(msgs);
    // Expected:
    // [0] HumanMessage "step 1"
    // [1] AIMessage "ok" with c1 tool_calls (paired, intact)
    // [2] ToolMessage c1 result
    // [3] HumanMessage "step 2"
    // [4] AIMessage "running" with tool_calls stripped (orphan) but text kept
    // [5] AIMessage "All done!"
    // ToolMessage "ghost" removed

    expect(result).toHaveLength(6);

    // Paired AIMessage keeps tool_calls
    const pairedAi = result[1] as AIMessage;
    expect(pairedAi.tool_calls).toHaveLength(1);
    expect(pairedAi.tool_calls![0].id).toBe("c1");

    // Orphan AIMessage: tool_calls stripped, text kept
    const orphanAi = result[4] as AIMessage;
    expect(orphanAi.tool_calls).toHaveLength(0);
    const orphanContent = typeof orphanAi.content === "string" ? orphanAi.content : "";
    expect(orphanContent).toBe("running");

    // Orphan ToolMessage removed
    const lastMsgs = result.slice(-2);
    expect(lastMsgs.every((m) => !ToolMessage.isInstance(m))).toBe(true);
  });

  test("handles multiple tool_calls in one AIMessage — strips only orphaned ones", () => {
    const msgs: BaseMessage[] = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "read_file", args: { path: "x.txt" } },
          { id: "c2", name: "shell_execute", args: { command: "ls" } },
        ],
      }),
      new ToolMessage({ content: "file", tool_call_id: "c1" }),  // only c1 has result
      // c2 is orphaned — no ToolMessage
    ];
    const result = sanitizeToolCallPairs(msgs);
    const ai = result[0] as AIMessage;
    // Only c1 survives
    expect(ai.tool_calls).toHaveLength(1);
    expect(ai.tool_calls![0].id).toBe("c1");
  });

  test("handles empty array", () => {
    const result = sanitizeToolCallPairs([]);
    expect(result).toHaveLength(0);
  });

  test("detects orphaned tool_calls on plain objects (checkpoint-deserialized)", () => {
    // Simulate deserialized message where instanceof fails
    const msgs: BaseMessage[] = [
      { content: "run ls", tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }], additional_kwargs: { tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] } } as unknown as BaseMessage,
      { content: "next" } as unknown as BaseMessage,
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    const ai = result[0] as AIMessage;
    expect(ai.tool_calls).toHaveLength(0);
  });

  test("detects orphaned tool_calls from additional_kwargs.tool_calls only", () => {
    // Some LangChain adapters store tool_calls only in additional_kwargs
    const msgs: BaseMessage[] = [
      new AIMessage({ content: "ok", additional_kwargs: { tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] } } as any),
      new HumanMessage("next"),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    const ai = result[0] as AIMessage;
    // tool_calls should be stripped since no matching ToolMessage
    expect(ai.tool_calls).toHaveLength(0);
    expect(ai.additional_kwargs).toEqual({});
  });

  test("rebuilds orphaned message preserving non-tool additional_kwargs and response_metadata", () => {
    const msgs: BaseMessage[] = [
      new AIMessage({
        content: "let me check",
        tool_calls: [{ id: "c1", name: "read_file", args: { path: "x.txt" } }],
        additional_kwargs: { reasoning_content: "deep analysis", custom_field: "should_be_preserved" } as any,
        response_metadata: { model: "deepseek", usage: { total_tokens: 100 } },
      }),
      new HumanMessage("next"),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    const ai = result[0] as AIMessage;
    expect(ai.tool_calls).toHaveLength(0);
    // Non-tool additional_kwargs preserved
    expect((ai.additional_kwargs as any).reasoning_content).toBe("deep analysis");
    expect((ai.additional_kwargs as any).custom_field).toBe("should_be_preserved");
    // Only tool_calls is removed
    expect((ai.additional_kwargs as any).tool_calls).toBeUndefined();
    // response_metadata preserved
    expect(ai.response_metadata).toEqual({ model: "deepseek", usage: { total_tokens: 100 } });
  });
});

// ============================================================================
// reorderInterleavedMessages — 消息排序
// 确保 ToolMessage 紧跟在对应 AIMessage 之后，满足 API 格式要求。
// ============================================================================
describe("reorderInterleavedMessages", () => {
  test("passes through messages with no tool_calls unchanged", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("hello"),
      new AIMessage({ content: "hi" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
  });

  test("passes through already-correct order unchanged", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("run ls"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] }),
      new ToolMessage({ content: "output", tool_call_id: "c1" }),
      new AIMessage({ content: "done" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(4);
    // Order unchanged
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    expect(result[2]).toBe(msgs[2]);
    expect(result[3]).toBe(msgs[3]);
  });

  test("moves interleaved HumanMessage after ToolMessages", () => {
    // Scenario: user interrupted tool execution
    const msgs: BaseMessage[] = [
      new HumanMessage("do it"),
      new AIMessage({ content: "ok", tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] }),
      new HumanMessage("stop"),  // ← interrupt
      new ToolMessage({ content: "output", tool_call_id: "c1" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(4);
    // AIMessage → ToolMessage → HumanMessage
    expect(result[1]).toBe(msgs[1]); // AIMessage
    expect((result[2] as ToolMessage).tool_call_id).toBe("c1"); // ToolMessage
    expect(result[3]).toBe(msgs[2]); // HumanMessage moved after
  });

  test("handles multiple tool_calls with some interleaved", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("go"),
      new AIMessage({ content: "", tool_calls: [
        { id: "c1", name: "read_file", args: { path: "a.txt" } },
        { id: "c2", name: "shell_execute", args: { command: "ls" } },
      ] }),
      new ToolMessage({ content: "file content", tool_call_id: "c1" }),
      new HumanMessage("wait"), // interrupt
      new ToolMessage({ content: "ls output", tool_call_id: "c2" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    // AIMessage → ToolMessage(c1) → ToolMessage(c2) → HumanMessage
    expect(result[2]).toBe(msgs[2]); // TM(c1) directly after AI
    expect(result[3]).toBe(msgs[4]); // TM(c2) also after AI
    expect(result[4]).toBe(msgs[3]); // HM moved after
  });

  test("handles multiple consecutive AIMessages with cancelled ToolMessages at end", () => {
    // Critical case: cleanup node appends all cancelled TMs at the end
    const msgs: BaseMessage[] = [
      new HumanMessage("start"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "read_file", args: { path: "x.txt" } }] }),
      new HumanMessage("new message"),
      new ToolMessage({ content: JSON.stringify({ cancelled: true }), tool_call_id: "c1", status: "error" }),
      new ToolMessage({ content: JSON.stringify({ cancelled: true }), tool_call_id: "c2", status: "error" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(6);
    // AIMessage(c1) → TM(c1) → AIMessage(c2) → TM(c2) → HM
    expect(result[1]).toBe(msgs[1]); // AI(c1)
    expect((result[2] as ToolMessage).tool_call_id).toBe("c1");
    expect(result[3]).toBe(msgs[2]); // AI(c2)
    expect((result[4] as ToolMessage).tool_call_id).toBe("c2");
    expect(result[5]).toBe(msgs[3]); // HM at end
  });

  test("handles three consecutive AIMessages with mixed interleaving", () => {
    const msgs: BaseMessage[] = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "read_file", args: { path: "b.txt" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "c3", name: "read_file", args: { path: "c.txt" } }] }),
      new HumanMessage("interrupt"),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new ToolMessage({ content: "ok", tool_call_id: "c3" }),
      new ToolMessage({ content: "ok", tool_call_id: "c2" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    // Each AI gets its TM grouped after it, HM at end
    expect((result[1] as ToolMessage).tool_call_id).toBe("c1");
    expect(result[2]).toBe(msgs[1]); // AI(c2)
    expect((result[3] as ToolMessage).tool_call_id).toBe("c2");
    expect(result[4]).toBe(msgs[2]); // AI(c3)
    expect((result[5] as ToolMessage).tool_call_id).toBe("c3");
    expect(result[6]).toBe(msgs[3]); // HumanMessage at end
  });

  test("handles multiple HumanMessages between AIMessage and ToolMessages", () => {
    const msgs: BaseMessage[] = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }] }),
      new HumanMessage("stop1"),
      new HumanMessage("stop2"),
      new HumanMessage("stop3"),
      new ToolMessage({ content: "output", tool_call_id: "c1" }),
    ];
    const result = reorderInterleavedMessages(msgs);
    // All HumanMessages should be after ToolMessage
    expect((result[1] as ToolMessage).tool_call_id).toBe("c1");
    expect(result[2]).toBe(msgs[1]); // HM1
    expect(result[3]).toBe(msgs[2]); // HM2
    expect(result[4]).toBe(msgs[3]); // HM3
  });

  test("no-op when there are no tool_calls anywhere", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("a"),
      new AIMessage({ content: "b" }),
      new HumanMessage("c"),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    expect(result[2]).toBe(msgs[2]);
  });

  test("does not move orphaned ToolMessages without matching AIMessage", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("hello"),
      new ToolMessage({ content: "orphan", tool_call_id: "ghost" }),
      new HumanMessage("world"),
    ];
    const result = reorderInterleavedMessages(msgs);
    // ToolMessage stays in original position (no matching AI to group with)
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    expect(result[2]).toBe(msgs[2]);
  });
});
