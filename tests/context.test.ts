import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildModelMessages,
  buildStaticSystemPrompt,
  prepareModelContext,
  forceContextCompaction,
  clearOldToolResults,
  sanitizeToolCallPairs,
} from "../src/core/model/context";
import {
  summarizeMessages,
  formatCompactedSummary,
} from "../src/core/model/summarizer";
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

    // 消息顺序：system, system, human(user), human(synthetic plan reminder) / Message order: system, system, human(user), human(synthetic plan reminder)
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
    expect(String(messages[0].content)).not.toContain("Add dark mode");
    expect(String(messages[0].content)).not.toContain("Create toggle component");
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
    expect(String(messages[1].content)).not.toContain("<runtime-state");
    expect(String(messages[1].content)).not.toContain("graph.state.plan:"); // plan 不在可缓存上下文中 / plan not in cacheable context
  });

  // 验证当前只读工作区访问作为尾部合成 HumanMessage 注入，不改变真实会话前缀 / Verify read-only workspace access is projected as trailing HumanMessage
  test("projects read-only workspace access as trailing HumanMessage after conversation messages", () => {
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
    expect(messages[3]).toBeInstanceOf(HumanMessage);
    expect(String(messages[0].content)).not.toContain("Current workspace access: read-only");
    expect(String(messages[1].content)).toContain("Cacheable runtime context:");
    expect(String(messages[1].content)).not.toContain("Current workspace access:");
    expect(String(messages[2].content)).toBe("Inspect before editing");
    expect(String(messages[3].content)).toContain(
      '<runtime-state source="graph.state.workspaceAccess">',
    );
    expect(String(messages[3].content)).toContain("Current workspace access: read-only");
    expect(String(messages[3].content)).toContain("read-only");
  });

  // 验证 plan 模式常见组合：read-only 和 plan 都用独立尾部 HumanMessage / Verify plan-mode combination keeps runtime states as separate trailing HumanMessages
  test("projects read-only HumanMessage before plan HumanMessage when both trailing runtime states exist", () => {
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
      workspaceAccess: "read-only",
      plan,
      messages: [new HumanMessage("/plan inspect cache behavior")],
      final: "",
    });

    expect(messages.map((message) => message.getType())).toEqual([
      "system",
      "system",
      "human",
      "human",
      "human",
    ]);
    expect(messages[3]).toBeInstanceOf(HumanMessage);
    expect(messages[4]).toBeInstanceOf(HumanMessage);
    expect(String(messages[2].content)).toBe("/plan inspect cache behavior");
    expect(String(messages[3].content)).toContain(
      '<runtime-state source="graph.state.workspaceAccess">',
    );
    expect(String(messages[3].content)).toContain("Current workspace access: read-only");
    expect(String(messages[4].content)).toContain('<runtime-state source="graph.state.plan">');
    expect(String(messages[4].content)).toContain("Name: Inspect cache layout");
    expect(String(messages[0].content)).not.toContain("Current workspace access: read-only");
    expect(String(messages[0].content)).not.toContain("Inspect cache layout");
    expect(String(messages[1].content)).not.toContain("<runtime-state");
  });

  // 验证 summarizeMessages 从 AIMessage.tool_calls 中提取工具名 / Verify summarizeMessages extracts tool names from AIMessage.tool_calls
  test("summarizeMessages extracts tool names from AIMessage tool_calls", () => {
    const messages = [
      new HumanMessage("Create file"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "write_file", args: { path: "hello.txt", content: "hi" } },
        ],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: "hello.txt" }),
        tool_call_id: "c1",
      }),
    ];
    const summaries = summarizeMessages(messages);
    expect(summaries.length).toBe(1);
    expect(summaries[0].tools).toContain("write_file");
  });

  // 验证 summarizeMessages 提取文件路径 / Verify summarizeMessages extracts file paths
  test("summarizeMessages extracts file paths from tool results", () => {
    const messages = [
      new HumanMessage("Create files"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "write_file", args: { path: "a.txt", content: "A" } },
          { id: "c2", name: "edit_file", args: { path: "b.txt", old: "x", new: "y" } },
        ],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: "a.txt" }),
        tool_call_id: "c1",
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "edit_file", ok: true, path: "b.txt" }),
        tool_call_id: "c2",
      }),
    ];
    const summaries = summarizeMessages(messages);
    expect(summaries[0].created).toContain("a.txt");
    expect(summaries[0].edited).toContain("b.txt");
  });

  // 验证 summarizeMessages 提取错误信息 / Verify summarizeMessages extracts errors
  test("summarizeMessages extracts errors from failed tool results", () => {
    const messages = [
      new HumanMessage("Read missing file"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "read_file", args: { path: "missing.txt" } },
        ],
      }),
      new ToolMessage({
        content: JSON.stringify({
          tool: "read_file",
          ok: false,
          path: "missing.txt",
          failure: { reason: "File not found", guidance: "Check the path" },
        }),
        tool_call_id: "c1",
      }),
    ];
    const summaries = summarizeMessages(messages);
    expect(summaries[0].errors).toContain("File not found");
  });

  // 验证 formatCompactedSummary 生成 detailed 和 concise 格式 / Verify formatCompactedSummary produces detailed and concise formats
  test("formatCompactedSummary produces detailed and concise levels", () => {
    const summaries = [
      {
        description: "Create math.ts",
        tools: ["write_file"],
        created: ["src/math.ts"],
        edited: [],
        verified: "verified",
        errors: [],
      },
    ];
    const detailed = formatCompactedSummary(summaries, "detailed");
    expect(detailed).toContain('<compacted level="detailed">');
    expect(detailed).toContain("[step] Create math.ts");
    expect(detailed).toContain("write_file");
    expect(detailed).toContain("src/math.ts");

    const concise = formatCompactedSummary(summaries, "concise");
    expect(concise).toContain('<compacted level="concise">');
    expect(concise).toContain("Created: src/math.ts");
    expect(concise).toContain("write_file");
  });

});

// ============================================================================
// forceContextCompaction 测试 / Tests for forceContextCompaction
// ============================================================================
describe("forceContextCompaction", () => {
  test("preserves the latest tool-call chain and generates summary with >8 messages", () => {
    // 构建 10 条消息触发压缩 / Build 10 messages to trigger compaction (> KEEP_FULL=8)
    const msgs: BaseMessage[] = [
      new HumanMessage("old step 1"),
      new AIMessage("old answer 1"),
      new HumanMessage("old step 2"),
      new AIMessage("old answer 2"),
      new HumanMessage("Create hello.txt"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c0", name: "shell_execute", args: { command: "pwd" } },
        ],
      }),
      new ToolMessage({
        content: "x".repeat(100),
        tool_call_id: "c0",
      }),
      new HumanMessage("continue"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "latest-call", name: "shell_execute", args: { command: "ls" } },
        ],
      }),
      new ToolMessage({
        content: "latest result",
        tool_call_id: "latest-call",
        status: "success",
      }),
    ];

    const compacted = forceContextCompaction(msgs);

    expect(compacted.summary).toContain("Compacted");
    expect(compacted.summary).toContain("context overflow");
    // 最新消息保留 / Latest messages kept
    const types = compacted.messages.map((m) => m.getType());
    expect(types).toContain("ai");
    expect(types).toContain("tool");
  });

  test("generates <compacted> summary for old messages", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("Old step"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c0", name: "write_file", args: { path: "x.txt", content: "X" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: "x.txt" }),
        tool_call_id: "c0",
      }),
      new AIMessage({ content: "will continue" }),
      new HumanMessage("Step 1"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "write_file", args: { path: "a.txt", content: "A" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "write_file", ok: true, path: "a.txt" }),
        tool_call_id: "c1",
      }),
      new HumanMessage("Step 2"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c2", name: "read_file", args: { path: "a.txt" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "read_file", ok: true, path: "a.txt" }),
        tool_call_id: "c2",
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c3", name: "edit_file", args: { path: "a.txt" } }],
      }),
      new ToolMessage({
        content: JSON.stringify({ tool: "edit_file", ok: true, path: "a.txt" }),
        tool_call_id: "c3",
      }),
    ];

    const compacted = forceContextCompaction(msgs);

    expect(compacted.summary).toContain("Compacted");
    const allContent = compacted.messages.map((m) => String(m.content)).join("\n");
    expect(allContent).toContain("<compacted level=");
    expect(allContent).toContain("write_file");
  });

  test("returns all messages unchanged when under KEEP_FULL", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("hi"),
      new AIMessage("hello"),
    ];

    const compacted = forceContextCompaction(msgs);

    // 不超过 8 条时不压缩 / No compaction when <= 8 messages
    expect(compacted.summary).toBe("");
    expect(compacted.messages.length).toBe(2);
  });
});

// ============================================================================
// clearOldToolResults 测试 / Tests for clearOldToolResults
// ============================================================================
describe("clearOldToolResults", () => {
  test("clears old tool results while keeping recent ones", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("hi"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "shell_execute", args: { command: "ls" } }],
      }),
      new ToolMessage({ content: "old result 1", tool_call_id: "c1", status: "success" }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c2", name: "shell_execute", args: { command: "pwd" } }],
      }),
      new ToolMessage({ content: "old result 2", tool_call_id: "c2", status: "success" }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c3", name: "read_file", args: { path: "a.txt" } }],
      }),
      new ToolMessage({ content: "recent result", tool_call_id: "c3", status: "success" }),
    ];

    const cleared = clearOldToolResults(msgs, 1);

    // 最近 1 条保留 / Last 1 kept intact
    expect(String(cleared[6].content)).toBe("recent result");
    // 旧结果被清除 / Old results cleared
    expect(String(cleared[2].content)).toContain("cleared to save context");
    expect(String(cleared[4].content)).toContain("cleared to save context");
    // AIMessage 不受影响 / AIMessages unaffected
    expect(cleared[1]).toBeInstanceOf(AIMessage);
  });

  test("preserves tool_call_id and status on cleared messages", () => {
    const msgs: BaseMessage[] = [
      new ToolMessage({ content: "x", tool_call_id: "abc", status: "error" }),
    ];

    const cleared = clearOldToolResults(msgs, 0);
    const tm = cleared[0] as ToolMessage;

    expect(tm.tool_call_id).toBe("abc");
    expect(tm.status).toBe("error");
    expect(String(tm.content)).toContain("cleared");
  });
});

// ============================================================================
// buildStaticSystemPrompt with skills / Tests for buildStaticSystemPrompt skill section
// ============================================================================
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
});
