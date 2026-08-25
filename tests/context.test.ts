import { describe, expect, test } from 'bun:test';
import {
  type AIMessage,
  aiMessage,
  type BaseMessage,
  buildCanonicalFrames,
  buildModelMessages,
  buildStaticSystemPrompt,
  humanMessage,
  isAIMessage,
  isHumanMessage,
  isToolMessage,
  reorderInterleavedMessages,
  sanitizeToolCallPairs,
  serializeFramesToMessages,
  type ToolMessage,
  toolMessage,
  validateFramePairs,
  validateMessagePairs,
} from '@kite/builtin-runtime/model';
import type { SkillManifest } from '@kite/builtin-runtime/skills';
import { currentPlanDocument } from './helpers/current-plan';

// 测试模型上下文构建和压缩逻辑 / Test model context building and compaction logic
describe('model context protocol', () => {
  // 验证用户输入保持原样，动态模式快照放在合成 HumanMessage 中 / Verify user input stays unchanged and mode snapshot is synthetic
  test('keeps user input unchanged and places cacheable run context in SystemMessage', () => {
    const task = 'Create hello.txt with exact content "hi".';
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      messages: [humanMessage(task)],
      final: '',
    });

    expect(messages).toHaveLength(3); // 1 SystemMessage + user HumanMessage + mode snapshot
    expect(messages[0]!.type).toBe('system'); // 合并后的系统提示词 / Merged system prompt (static + cacheable)
    expect(messages[1]!.type).toBe('human'); // 用户任务 / User task
    expect(messages[1]!.content).toBe(task);
    expect(messages[2]!.type).toBe('human');
    expect(String(messages[2]!.content)).toContain('<runtime-state source="runtime.kernel">');
    expect(String(messages[1]!.content)).not.toContain('Plan:');
    expect(String(messages[1]!.content)).not.toContain('Tool results:');
    expect(String(messages[0]!.content)).toContain('Cacheable runtime context:');
    expect(String(messages[0]!.content)).toContain('Workspace:');
    expect(String(messages[0]!.content)).not.toContain('Tool policy (builder mode):');
    expect(String(messages[0]!.content)).not.toContain('Configured model:');
    expect(String(messages[0]!.content)).not.toContain('User ID:');
    expect(String(messages[0]!.content)).not.toContain('Thread mode:');
  });

  // 验证工具调用链保留在动态 SystemMessage 外部，不混入运行时上下文 / Verify tool-call chain stays outside dynamic SystemMessage, not mixed into runtime context
  test('preserves completed tool-call message chain outside dynamic SystemMessage', () => {
    const task = 'Create hello.txt';
    const ai = aiMessage({
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          name: 'write_file',
          args: { path: 'hello.txt', content: 'hi\n' },
        },
      ],
    });
    const tool = toolMessage({
      content: '{"ok":true,"path":"hello.txt"}',
      tool_call_id: 'call-1',
      status: 'success',
    });
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      messages: [humanMessage(task), ai, tool],
      final: '',
    });

    expect(messages[1]!.type).toBe('human'); // 用户消息 / User message
    expect(messages[2]!.type).toBe('ai'); // AI 工具调用 / AI tool call
    expect(messages[3]!.type).toBe('tool'); // 工具返回 / Tool response
    expect((messages[3] as ToolMessage).tool_call_id).toBe('call-1');
    expect(String(messages[0]!.content)).not.toContain('Tool result summary:');
    expect(String(messages[0]!.content)).not.toContain('Pending request:');
    expect(String(messages[0]!.content)).not.toContain('{"ok":true');
  });

  // 验证动态上下文放在可复用对话前缀之后，以利用 provider 前缀缓存 / Verify dynamic context sits after reusable conversation prefix for provider cache hit
  test('keeps dynamic context after reusable conversation prefix for provider cache', () => {
    const task = 'Create hello.txt';
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      messages: [
        humanMessage(task),
        aiMessage({
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              name: 'shell_execute',
              args: { command: 'pwd' },
            },
          ],
        }),
        toolMessage({
          content: 'ok',
          tool_call_id: 'call-1',
        }),
      ],
      final: '',
    });

    // 消息顺序：合并系统提示词、用户消息、AI 调用、工具返回 / Order: merged system prompt, user message, AI call, tool response
    expect(messages.slice(0, 4).map((message) => message.type)).toEqual([
      'system',
      'human',
      'ai',
      'tool',
    ]);
  });

  // 验证 plan 作为高频动态状态注入尾部 HumanMessage，避免动态 SystemMessage 破坏 provider 缓存 / Verify plan is injected as trailing HumanMessage after conversation messages
  test('injects plan as trailing synthetic HumanMessage from planningState', () => {
    const planningState = {
      kind: 'executing' as const,
      document: currentPlanDocument({
        planId: 'plan-dark-mode',
        version: 2,
        title: 'Add dark mode',
        bodyMarkdown: 'Add dark mode toggle to settings',
        steps: [
          {
            id: 'toggle-component',
            title: 'Create toggle component',
            status: 'completed' as const,
          },
          { id: 'update-styles', title: 'Update styles', status: 'in_progress' as const },
          { id: 'run-tests', title: 'Run tests', status: 'pending' as const },
        ],
        structuralDigest: 'abc123',
        createdAtTurnId: 't0',
        updatedAtTurnId: 't1',
      }),
      executionMode: 'accept_edits' as const,
      approvedAtTurnId: 't1',
    };
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      planningState,
      messages: [humanMessage('Create dark mode')],
      final: '',
    });

    // 消息顺序：system(merged), human(user), human(single runtime snapshot)
    expect(messages).toHaveLength(3);
    expect(messages[0]!.type).toBe('system');
    expect(messages[1]!.type).toBe('human');
    expect(String(messages[1]!.content)).toBe('Create dark mode');
    expect(messages[2]!.type).toBe('human');
    expect(String(messages[2]!.content)).toContain('<runtime-state source="runtime.kernel">');
    expect(String(messages[2]!.content)).toContain('lifecycle: executing');
    expect(String(messages[2]!.content)).toContain('plan_id: plan-dark-mode');
    expect(String(messages[2]!.content)).toContain('version: 2');
    expect(String(messages[2]!.content)).toContain('- toggle-component: completed');
    expect(String(messages[2]!.content)).toContain('- update-styles: in_progress');
    expect(String(messages[2]!.content)).toContain('- run-tests: pending');

    expect(String(messages[0]!.content)).not.toContain('Add dark mode');
    expect(String(messages[0]!.content)).not.toContain('Create toggle component');
    expect(String(messages[0]!.content)).toContain('Cacheable runtime context:');
  });

  // 验证 write 工作区访问不再注入独立 HumanMessage 提醒 / Verify write workspace access no longer injects a dedicated HumanMessage
  test('does not inject workspaceAccess reminder when write access', () => {
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      messages: [humanMessage('Inspect before editing')],
      final: '',
    });

    expect(messages.map((message) => message.type)).toEqual(['system', 'human', 'human']);
    expect(messages[1]!.type).toBe('human');
    expect(messages[2]!.type).toBe('human');
    expect(String(messages[2]!.content)).toContain('<runtime-state source="runtime.kernel">');
    expect(String(messages[0]!.content)).not.toContain('Current workspace access:');
    expect(String(messages[0]!.content)).toContain('Cacheable runtime context:');
    expect(String(messages[0]!.content)).not.toContain('Current workspace access:');
    expect(String(messages[1]!.content)).toBe('Inspect before editing');
  });

  test('injects the actual sandbox backend into the dynamic mode snapshot', () => {
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      messages: [humanMessage('Continue safely')],
      final: '',
      sandboxBackend: 'seatbelt',
    });

    expect(messages[2]!.type).toBe('human');
    expect(String(messages[2]!.content)).toContain('runtime.kernel');
    expect(String(messages[2]!.content)).toContain('interaction_mode: accept_edits');
    expect(String(messages[2]!.content)).not.toContain('authorization_mode');
  });

  // 验证 plan 尾部 HumanMessage 仍然注入，但不再有 workspaceAccess 提醒 / Verify plan HumanMessage still injected without workspaceAccess reminder
  test('projects plan reminder from planningState without workspaceAccess reminder', () => {
    const planningState = {
      kind: 'executing' as const,
      document: currentPlanDocument({
        planId: 'plan-cache',
        version: 1,
        title: 'Inspect cache layout',
        bodyMarkdown: 'Check prompt cache behavior before editing',
        steps: [
          { id: 'inspect-ctx', title: 'Inspect context assembly', status: 'completed' as const },
          { id: 'cache-exp', title: 'Run cache experiment', status: 'in_progress' as const },
        ],
        structuralDigest: 'def456',
        createdAtTurnId: 't0',
        updatedAtTurnId: 't0',
      }),
      executionMode: 'auto' as const,
      approvedAtTurnId: 't0',
    };
    const messages = buildModelMessages('agent', {
      workspace: 'D:\\workspace',
      workspaceAccess: 'write',
      planningState,
      messages: [humanMessage('/plan inspect cache behavior')],
      final: '',
    });

    expect(messages.map((message) => message.type)).toEqual(['system', 'human', 'human']);
    expect(messages[2]!.type).toBe('human');
    expect(String(messages[1]!.content)).toBe('/plan inspect cache behavior');
    expect(String(messages[2]!.content)).toContain('<runtime-state source="runtime.kernel">');
    expect(String(messages[2]!.content)).toContain('lifecycle: executing');
    expect(String(messages[2]!.content)).toContain('sandbox_backend: unknown');
    expect(String(messages[0]!.content)).not.toContain('Inspect cache layout');
  });
});

describe('buildStaticSystemPrompt with skills', () => {
  test('uses static MCP usage rules instead of per-tool name injection', () => {
    const prompt = buildStaticSystemPrompt('agent');

    // MCP usage rules are in the static system prompt.
    expect(prompt).toContain('For MCP inventory');
    expect(prompt).toContain('list_mcp_tools');
    expect(prompt).toContain('tool_search');
    // Per-tool names are no longer injected
    expect(prompt).not.toContain('## Available MCP Tool Names');
  });

  test('includes Available Skills section when skills provided', () => {
    const skills: SkillManifest[] = [
      {
        name: 'tdd',
        description: 'Use when writing tests',
        source: 'project',
        origin: '.kite-code',
      },
      { name: 'debugging', description: 'Use when debugging', source: 'user', origin: '.agents' },
    ];
    const prompt = buildStaticSystemPrompt('agent', skills);
    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('- tdd: Use when writing tests');
    expect(prompt).toContain('- debugging: Use when debugging');
    expect(prompt).toContain('`activate_skill`');
    expect(prompt).not.toContain('Use the `Skill` tool');
  });

  test('does not include section when skills empty', () => {
    const prompt = buildStaticSystemPrompt('agent', []);
    expect(prompt).not.toContain('## Available Skills');
  });

  test('does not include section when skills are undefined', () => {
    const prompt = buildStaticSystemPrompt('agent');
    expect(prompt).not.toContain('## Available Skills');
  });

  // ── Prompt cache: prefix stability ──

  test('base prompt is prefix of skills-included prompt', () => {
    const base = buildStaticSystemPrompt('agent');
    const skills: SkillManifest[] = [
      {
        name: 'tdd',
        description: 'Test-driven development',
        source: 'project',
        origin: '.kite-code',
      },
    ];
    const withSkills = buildStaticSystemPrompt('agent', skills);
    // 技能追加在末尾，不破坏 base 前缀缓存
    expect(withSkills.startsWith(base)).toBe(true);
  });

  test('skills appended at end, not injected in middle', () => {
    const base = buildStaticSystemPrompt('agent');
    const skills: SkillManifest[] = [
      { name: 'tdd', description: 'TDD workflow', source: 'project', origin: '.kite-code' },
    ];
    const withSkills = buildStaticSystemPrompt('agent', skills);
    // 验证技能 section 出现在 base 之后（base + 换行间隔）
    const skillsIndex = withSkills.indexOf('## Available Skills');
    expect(skillsIndex).toBeGreaterThan(0);
    // skills section must come strictly after the base prompt (no injection)
    expect(skillsIndex).toBeGreaterThan(base.length - 1);
    // skills content must NOT appear in base portion
    expect(withSkills.substring(0, base.length)).toBe(base);
  });

  test('prompt is idempotent for same skills', () => {
    const skills: SkillManifest[] = [
      { name: 'tdd', description: 'TDD workflow', source: 'project', origin: '.kite-code' },
    ];
    const prompt1 = buildStaticSystemPrompt('agent', skills);
    const prompt2 = buildStaticSystemPrompt('agent', skills);
    expect(prompt1).toBe(prompt2);
  });

  test('multiple skills preserved in stable input order', () => {
    const skills: SkillManifest[] = [
      { name: 'z-skill', description: 'Z description', source: 'project', origin: '.kite-code' },
      { name: 'a-skill', description: 'A description', source: 'project', origin: '.kite-code' },
    ];
    const prompt = buildStaticSystemPrompt('agent', skills);
    // 技能按输入顺序列出（不重新排序），保持可预测性
    const zIndex = prompt.indexOf('- z-skill:');
    const aIndex = prompt.indexOf('- a-skill:');
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
describe('sanitizeToolCallPairs', () => {
  test('passes through clean HumanMessages unchanged', () => {
    const msgs: BaseMessage[] = [humanMessage('hello')];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(1);
    expect(isHumanMessage(result[0])).toBe(true);
  });

  test('passes through clean paired tool_call + ToolMessage unchanged', () => {
    const msgs: BaseMessage[] = [
      humanMessage('run ls'),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
      }),
      toolMessage({ content: 'file list', tool_call_id: 'c1' }),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(3);
    expect(isAIMessage(result[1])).toBe(true);
    expect((result[1] as AIMessage).tool_calls).toHaveLength(1);
    expect(isToolMessage(result[2])).toBe(true);
  });

  test('strips orphaned tool_calls from AIMessage but keeps text content', () => {
    // 模拟：进程在工具执行前崩溃，AIMessage 有 tool_calls 但没有 ToolMessage
    const msgs: BaseMessage[] = [
      humanMessage('run ls'),
      aiMessage({
        content: 'Let me run that command',
        tool_calls: [{ id: 'orphan-1', name: 'shell_execute', args: { command: 'ls' } }],
      }),
      humanMessage('next question'),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(3);

    // AIMessage 保留文本内容，但 tool_calls 被清空
    const ai = result[1] as AIMessage;
    expect(isAIMessage(ai)).toBe(true);
    const content = typeof ai.content === 'string' ? ai.content : '';
    expect(content).toContain('Let me run that command');
    expect(ai.tool_calls).toHaveLength(0);
  });

  test('removes orphaned ToolMessage with no matching AIMessage', () => {
    // 模拟：进程崩溃导致 ToolMessage 还在但 AIMessage 的 tool_calls 丢失
    const msgs: BaseMessage[] = [
      humanMessage('hey'),
      toolMessage({ content: 'orphan result', tool_call_id: 'ghost-1' }),
      humanMessage('continue'),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    expect(isHumanMessage(result[0])).toBe(true);
    expect(isHumanMessage(result[1])).toBe(true);
  });

  test('handles mix of paired and orphaned messages correctly', () => {
    // 混合：有正常的配对，也有孤儿
    const msgs: BaseMessage[] = [
      humanMessage('step 1'),
      aiMessage({
        content: 'ok',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
      }),
      toolMessage({ content: 'content', tool_call_id: 'c1' }), // paired ✓
      humanMessage('step 2'),
      aiMessage({
        content: 'running',
        tool_calls: [{ id: 'c2', name: 'shell_execute', args: { command: 'npm test' } }],
      }),
      // ToolMessage for c2 is MISSING (crash before tool ran)
      aiMessage({ content: 'All done!' }),
      toolMessage({ content: 'ghost result', tool_call_id: 'ghost' }), // orphan ToolMessage ✗
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
    expect(pairedAi.tool_calls?.[0]?.id).toBe('c1');

    // Orphan AIMessage: tool_calls stripped, text kept
    const orphanAi = result[4] as AIMessage;
    expect(orphanAi.tool_calls).toHaveLength(0);
    const orphanContent = typeof orphanAi.content === 'string' ? orphanAi.content : '';
    expect(orphanContent).toBe('running');

    // Orphan ToolMessage removed
    const lastMsgs = result.slice(-2);
    expect(lastMsgs.every((m) => !isToolMessage(m))).toBe(true);
  });

  test('handles multiple tool_calls in one AIMessage — strips only orphaned ones', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { path: 'x.txt' } },
          { id: 'c2', name: 'shell_execute', args: { command: 'ls' } },
        ],
      }),
      toolMessage({ content: 'file', tool_call_id: 'c1' }), // only c1 has result
      // c2 is orphaned — no ToolMessage
    ];
    const result = sanitizeToolCallPairs(msgs);
    const ai = result[0] as AIMessage;
    // Only c1 survives
    expect(ai.tool_calls).toHaveLength(1);
    expect(ai.tool_calls?.[0]?.id).toBe('c1');
  });

  test('handles empty array', () => {
    const result = sanitizeToolCallPairs([]);
    expect(result).toHaveLength(0);
  });

  test('detects orphaned tool_calls on plain objects (checkpoint-deserialized)', () => {
    // Simulate deserialized message where instanceof fails
    const msgs: BaseMessage[] = [
      {
        content: 'run ls',
        tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
        additional_kwargs: {
          tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
        },
      } as unknown as BaseMessage,
      { content: 'next' } as unknown as BaseMessage,
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    const ai = result[0] as AIMessage;
    expect(ai.tool_calls).toHaveLength(0);
  });

  test('detects orphaned tool_calls from additional_kwargs.tool_calls only', () => {
    // Some LangChain adapters store tool_calls only in additional_kwargs
    const msgs: BaseMessage[] = [
      aiMessage({
        content: 'ok',
        additional_kwargs: {
          tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
        },
      }),
      humanMessage('next'),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    const ai = result[0] as AIMessage;
    // tool_calls should be stripped since no matching ToolMessage
    expect(ai.tool_calls).toHaveLength(0);
    expect(ai.additional_kwargs).toEqual({});
  });

  test('rebuilds orphaned message preserving non-tool additional_kwargs and response_metadata', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: 'let me check',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'x.txt' } }],
        additional_kwargs: {
          reasoning_content: 'deep analysis',
          custom_field: 'should_be_preserved',
        } as Record<string, unknown>,
        response_metadata: { model: 'deepseek', usage: { total_tokens: 100 } },
      }),
      humanMessage('next'),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(2);
    const ai = result[0] as AIMessage;
    expect(ai.tool_calls).toHaveLength(0);
    // Non-tool additional_kwargs preserved
    const extra = ai.additional_kwargs as Record<string, unknown>;
    expect(extra.reasoning_content).toBe('deep analysis');
    expect(extra.custom_field).toBe('should_be_preserved');
    // Only tool_calls is removed
    expect(extra.tool_calls).toBeUndefined();
    // response_metadata preserved
    expect(ai.response_metadata).toEqual({ model: 'deepseek', usage: { total_tokens: 100 } });
  });
  test('strips additional_kwargs.tool_calls when they have IDs not in top-level tool_calls (akwDangling)', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        // top-level tool_calls is empty — parseToolCall all failed
        tool_calls: [],
        invalid_tool_calls: [
          { id: 'bad-1', name: 'shell_execute', args: '{broken', error: 'Unexpected token' },
        ],
        additional_kwargs: {
          // raw API data still present in additional_kwargs
          tool_calls: [
            {
              id: 'bad-1',
              type: 'function',
              function: { name: 'shell_execute', arguments: '{broken' },
            },
          ],
        } as Record<string, unknown>,
        response_metadata: {},
      }),
    ];
    const result = sanitizeToolCallPairs(msgs);
    expect(result).toHaveLength(1);
    const ai = result[0]! as AIMessage;
    // additional_kwargs.tool_calls should be deleted because top-level tool_calls doesn't have it
    const akw = ai.additional_kwargs as Record<string, unknown> | undefined;
    expect(akw?.tool_calls).toBeUndefined();
    // tool_calls remains empty
    expect(ai.tool_calls).toHaveLength(0);
    // content preserved
    expect(ai.content).toBe('');
  });

  test('rebuilds checkpoint-deserialized plain-object AIMessage as proper instance', () => {
    // Simulate checkpoint deserialized plain object (no _getType method)
    const plainObj = {
      type: 'ai',
      content: 'checking...',
      tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'f.txt' } }],
      additional_kwargs: {
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"f.txt"}' },
          },
        ],
      },
      response_metadata: { model: 'deepseek' },
    } as unknown as BaseMessage;

    // Matching ToolMessage
    const tm = toolMessage({
      content: JSON.stringify({ ok: true }),
      tool_call_id: 'c1',
      name: 'read_file',
      status: 'success',
    });

    const result = sanitizeToolCallPairs([plainObj, tm]);
    expect(result).toHaveLength(2);
    // Rebuilt as proper AIMessage instance
    expect(isAIMessage(result[0]!)).toBe(true);
    // tool_calls preserved
    const rebuilt = result[0]! as AIMessage;
    expect(rebuilt.tool_calls).toHaveLength(1);
    expect(rebuilt.tool_calls?.[0]?.id).toBe('c1');
  });
});

// ============================================================================
// reorderInterleavedMessages — 消息排序
// 确保 ToolMessage 紧跟在对应 AIMessage 之后，满足 API 格式要求。
// ============================================================================
describe('reorderInterleavedMessages', () => {
  test('passes through messages with no tool_calls unchanged', () => {
    const msgs: BaseMessage[] = [humanMessage('hello'), aiMessage({ content: 'hi' })];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
  });

  test('passes through already-correct order unchanged', () => {
    const msgs: BaseMessage[] = [
      humanMessage('run ls'),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
      }),
      toolMessage({ content: 'output', tool_call_id: 'c1' }),
      aiMessage({ content: 'done' }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(4);
    // Order unchanged
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    expect(result[2]).toBe(msgs[2]);
    expect(result[3]).toBe(msgs[3]);
  });

  test('moves interleaved HumanMessage after ToolMessages', () => {
    // Scenario: user interrupted tool execution
    const msgs: BaseMessage[] = [
      humanMessage('do it'),
      aiMessage({
        content: 'ok',
        tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
      }),
      humanMessage('stop'), // ← interrupt
      toolMessage({ content: 'output', tool_call_id: 'c1' }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(4);
    // AIMessage → ToolMessage → HumanMessage
    expect(result[1]).toBe(msgs[1]); // AIMessage
    expect((result[2] as ToolMessage).tool_call_id).toBe('c1'); // ToolMessage
    expect(result[3]).toBe(msgs[2]); // HumanMessage moved after
  });

  test('handles multiple tool_calls with some interleaved', () => {
    const msgs: BaseMessage[] = [
      humanMessage('go'),
      aiMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'c2', name: 'shell_execute', args: { command: 'ls' } },
        ],
      }),
      toolMessage({ content: 'file content', tool_call_id: 'c1' }),
      humanMessage('wait'), // interrupt
      toolMessage({ content: 'ls output', tool_call_id: 'c2' }),
    ];
    const result = reorderInterleavedMessages(msgs);
    // AIMessage → ToolMessage(c1) → ToolMessage(c2) → HumanMessage
    expect(result[2]).toBe(msgs[2]); // TM(c1) directly after AI
    expect(result[3]).toBe(msgs[4]); // TM(c2) also after AI
    expect(result[4]).toBe(msgs[3]); // HM moved after
  });

  test('handles multiple consecutive AIMessages with cancelled ToolMessages at end', () => {
    // Critical case: cleanup node appends all cancelled TMs at the end
    const msgs: BaseMessage[] = [
      humanMessage('start'),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
      }),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c2', name: 'read_file', args: { path: 'x.txt' } }],
      }),
      humanMessage('new message'),
      toolMessage({
        content: JSON.stringify({ cancelled: true }),
        tool_call_id: 'c1',
        status: 'error',
      }),
      toolMessage({
        content: JSON.stringify({ cancelled: true }),
        tool_call_id: 'c2',
        status: 'error',
      }),
    ];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(6);
    // AIMessage(c1) → TM(c1) → AIMessage(c2) → TM(c2) → HM
    expect(result[1]).toBe(msgs[1]); // AI(c1)
    expect((result[2] as ToolMessage).tool_call_id).toBe('c1');
    expect(result[3]).toBe(msgs[2]); // AI(c2)
    expect((result[4] as ToolMessage).tool_call_id).toBe('c2');
    expect(result[5]).toBe(msgs[3]); // HM at end
  });

  test('handles three consecutive AIMessages with mixed interleaving', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
      }),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c2', name: 'read_file', args: { path: 'b.txt' } }],
      }),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c3', name: 'read_file', args: { path: 'c.txt' } }],
      }),
      humanMessage('interrupt'),
      toolMessage({ content: 'ok', tool_call_id: 'c1' }),
      toolMessage({ content: 'ok', tool_call_id: 'c3' }),
      toolMessage({ content: 'ok', tool_call_id: 'c2' }),
    ];
    const result = reorderInterleavedMessages(msgs);
    // Each AI gets its TM grouped after it, HM at end
    expect((result[1] as ToolMessage).tool_call_id).toBe('c1');
    expect(result[2]).toBe(msgs[1]); // AI(c2)
    expect((result[3] as ToolMessage).tool_call_id).toBe('c2');
    expect(result[4]).toBe(msgs[2]); // AI(c3)
    expect((result[5] as ToolMessage).tool_call_id).toBe('c3');
    expect(result[6]).toBe(msgs[3]); // HumanMessage at end
  });

  test('handles multiple HumanMessages between AIMessage and ToolMessages', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'shell_execute', args: { command: 'ls' } }],
      }),
      humanMessage('stop1'),
      humanMessage('stop2'),
      humanMessage('stop3'),
      toolMessage({ content: 'output', tool_call_id: 'c1' }),
    ];
    const result = reorderInterleavedMessages(msgs);
    // All HumanMessages should be after ToolMessage
    expect((result[1] as ToolMessage).tool_call_id).toBe('c1');
    expect(result[2]).toBe(msgs[1]); // HM1
    expect(result[3]).toBe(msgs[2]); // HM2
    expect(result[4]).toBe(msgs[3]); // HM3
  });

  test('no-op when there are no tool_calls anywhere', () => {
    const msgs: BaseMessage[] = [humanMessage('a'), aiMessage({ content: 'b' }), humanMessage('c')];
    const result = reorderInterleavedMessages(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    expect(result[2]).toBe(msgs[2]);
  });

  test('does not move orphaned ToolMessages without matching AIMessage', () => {
    const msgs: BaseMessage[] = [
      humanMessage('hello'),
      toolMessage({ content: 'orphan', tool_call_id: 'ghost' }),
      humanMessage('world'),
    ];
    const result = reorderInterleavedMessages(msgs);
    // ToolMessage stays in original position (no matching AI to group with)
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    expect(result[2]).toBe(msgs[2]);
  });
});

describe('P0: pairing validator', () => {
  test('passes for valid single-tool pairs', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: {} }],
      }),
      toolMessage({
        content: 'content',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
    ];
    expect(() => validateMessagePairs(msgs)).not.toThrow();
  });

  test('passes for valid multi-tool pairs', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
          { id: 'c2', name: 'search_content', args: { pattern: 'x' } },
        ],
      }),
      toolMessage({
        content: 'file content',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
      toolMessage({
        content: 'matches',
        tool_call_id: 'c2',
        name: 'search_content',
        status: 'success',
      }),
    ];
    expect(() => validateMessagePairs(msgs)).not.toThrow();
  });

  test('throws on missing ToolMessage', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'orphan-call', name: 'read_file', args: {} }],
      }),
    ];
    expect(() => validateMessagePairs(msgs)).toThrow('Missing ToolMessages');
  });

  test('throws on orphan ToolMessage (no matching AIMessage)', () => {
    const msgs: BaseMessage[] = [
      toolMessage({
        content: 'orphan result',
        tool_call_id: 'no-such-call',
        name: 'read_file',
        status: 'success',
      }),
    ];
    expect(() => validateMessagePairs(msgs)).toThrow('Orphan ToolMessages');
  });

  test('throws on duplicate ToolMessages for same tool_call_id', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'dup-call', name: 'read_file', args: {} }],
      }),
      toolMessage({
        content: 'result 1',
        tool_call_id: 'dup-call',
        name: 'read_file',
        status: 'success',
      }),
      toolMessage({
        content: 'result 2',
        tool_call_id: 'dup-call',
        name: 'read_file',
        status: 'success',
      }),
    ];
    expect(() => validateMessagePairs(msgs)).toThrow('Duplicate ToolMessages');
  });

  test('passes for messages with no tool calls', () => {
    const msgs: BaseMessage[] = [humanMessage('hello'), aiMessage({ content: 'hi' })];
    expect(() => validateMessagePairs(msgs)).not.toThrow();
  });
});

// ============================================================================
// PR 2：Canonical Context Frame — 帧构建、序列化、帧级校验
// PR 2: Canonical Context Frame — frame building, serialization, frame-level validation
// ============================================================================

describe('PR 2: canonical frame building', () => {
  test('builds UserFrame for human messages', () => {
    const msgs: BaseMessage[] = [humanMessage('hello')];
    const frames = buildCanonicalFrames(msgs);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('user');
  });

  test('builds AssistantFrame for AI messages without tool calls', () => {
    const msgs: BaseMessage[] = [aiMessage({ content: 'hi there' })];
    const frames = buildCanonicalFrames(msgs);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('assistant');
  });

  test('builds ToolCallBlockFrame for single-tool AIMessage', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
      }),
      toolMessage({
        content: JSON.stringify({ ok: true, path: 'a.txt', totalLines: 10 }),
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('tool_block');
    const block = frames[0]!;
    if (block.kind === 'tool_block') {
      expect(block.calls).toHaveLength(1);
      expect(block.calls[0]!.toolCallId).toBe('c1');
      expect(block.calls[0]!.name).toBe('read_file');
      expect(block.calls[0]!.ok).toBe(true);
    }
  });

  test('builds ToolCallBlockFrame for multi-tool AIMessage with all calls', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: 'Let me check several things.',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
          { id: 'c2', name: 'search_content', args: { pattern: 'TODO' } },
        ],
      }),
      toolMessage({
        content: JSON.stringify({ ok: true, path: 'a.ts', totalLines: 50 }),
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
      toolMessage({
        content: JSON.stringify({ ok: true, matchCount: 3 }),
        tool_call_id: 'c2',
        name: 'search_content',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('tool_block');
    const block = frames[0]!;
    if (block.kind === 'tool_block') {
      expect(block.calls).toHaveLength(2);
      expect(block.calls[0]!.toolCallId).toBe('c1');
      expect(block.calls[0]!.name).toBe('read_file');
      expect(block.calls[1]!.toolCallId).toBe('c2');
      expect(block.calls[1]!.name).toBe('search_content');
      // assistant content preserved
      expect(block.assistantContent).toBe('Let me check several things.');
    }
  });

  test('handles interleaved user messages between tool blocks', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
      }),
      toolMessage({
        content: 'content',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
      humanMessage('now check b'),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c2', name: 'read_file', args: { path: 'b.txt' } }],
      }),
      toolMessage({
        content: 'content b',
        tool_call_id: 'c2',
        name: 'read_file',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    expect(frames).toHaveLength(3);
    expect(frames[0]!.kind).toBe('tool_block');
    expect(frames[1]!.kind).toBe('user');
    expect(frames[2]!.kind).toBe('tool_block');
  });
});

describe('PR 2: frame serialization round-trip', () => {
  test('round-trips single-tool block preserving all pairings', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'config.ts' } }],
      }),
      toolMessage({
        content: JSON.stringify({ ok: true, path: 'config.ts', totalLines: 100 }),
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    const result = serializeFramesToMessages(frames);

    // Should have AIMessage + ToolMessage
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('ai');

    const rm = result[1]! as unknown as Record<string, unknown>;
    expect(rm.tool_call_id).toBe('c1');
    expect(rm.name).toBe('read_file');
  });

  test('round-trips multi-tool block preserving all pairings', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [
          { id: 'ca', name: 'read_file', args: { path: 'x.ts' } },
          { id: 'cb', name: 'search_content', args: { pattern: 'bug' } },
        ],
      }),
      toolMessage({
        content: JSON.stringify({ ok: true, path: 'x.ts' }),
        tool_call_id: 'ca',
        name: 'read_file',
        status: 'success',
      }),
      toolMessage({
        content: JSON.stringify({ ok: true, matchCount: 2 }),
        tool_call_id: 'cb',
        name: 'search_content',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    const result = serializeFramesToMessages(frames);

    // 1 AIMessage + 2 ToolMessages
    expect(result).toHaveLength(3);
    // Verify tool_call_ids match in order
    const toolResults = result.filter((_, i) => i > 0);
    expect(toolResults).toHaveLength(2);
    const r1 = toolResults[0]! as unknown as Record<string, unknown>;
    const r2 = toolResults[1]! as unknown as Record<string, unknown>;
    expect(r1.tool_call_id).toBe('ca');
    expect(r2.tool_call_id).toBe('cb');
  });

  test('round-trip with interleaved user messages preserves order', () => {
    const msgs: BaseMessage[] = [
      humanMessage('start'),
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
      }),
      toolMessage({
        content: 'a content',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
      humanMessage('next'),
    ];
    const frames = buildCanonicalFrames(msgs);
    const result = serializeFramesToMessages(frames);

    expect(result).toHaveLength(4);
    expect(result[0]!.type).toBe('human');
    expect(result[1]!.type).toBe('ai');
    expect((result[2]! as unknown as Record<string, unknown>).tool_call_id).toBe('c1');
    expect(result[3]!.type).toBe('human');
  });
});

describe('PR 2: frame-level validation', () => {
  test('passes for valid single-tool block', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: {} }],
      }),
      toolMessage({
        content: 'content',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    expect(() => validateFramePairs(frames)).not.toThrow();
  });

  test('passes for valid multi-tool block', () => {
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: {} },
          { id: 'c2', name: 'search_content', args: {} },
        ],
      }),
      toolMessage({
        content: 'f1',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
      toolMessage({
        content: 'f2',
        tool_call_id: 'c2',
        name: 'search_content',
        status: 'success',
      }),
    ];
    const frames = buildCanonicalFrames(msgs);
    expect(() => validateFramePairs(frames)).not.toThrow();
  });

  test('throws when calls count does not match tool_calls count', () => {
    // Manually construct a frame with mismatched counts
    const msgs: BaseMessage[] = [
      aiMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: {} },
          { id: 'c2', name: 'read_file', args: {} },
        ],
      }),
      toolMessage({
        content: 'only one result',
        tool_call_id: 'c1',
        name: 'read_file',
        status: 'success',
      }),
      // Missing ToolMessage for c2
    ];
    const frames = buildCanonicalFrames(msgs);
    expect(() => validateFramePairs(frames)).toThrow('calls count');
  });

  test('passes for frames with no tool blocks', () => {
    const msgs: BaseMessage[] = [humanMessage('hello'), aiMessage({ content: 'hi' })];
    const frames = buildCanonicalFrames(msgs);
    expect(() => validateFramePairs(frames)).not.toThrow();
  });
});
