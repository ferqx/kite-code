// src/core/subagent/runner.ts

import type { BaseMessage } from '@langchain/core/messages';
import { type AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { buildStaticSystemPrompt } from '@/core/model/context';
import { createChatModel } from '@/core/model/factory';
import { buildCacheableRuntimeContext } from '@/core/model/runtime-context';
import { classifyToolFailure } from '@/core/session-logger/classifier';
import { countTokens } from '@/core/token-counter';
import { createAgentTools, isReadOnlyShellCommand } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';
import type { SubAgentResult, SubAgentRunnerInput, SubAgentStepSnapshot } from './types';

export type { SubAgentRunnerInput } from './types';

/** 提取 AIMessage.content 中的纯文本 / Extract plain text from AIMessage.content */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) =>
        b && typeof b === 'object' && 'text' in (b as Record<string, unknown>)
          ? String((b as Record<string, unknown>).text)
          : '',
      )
      .join('');
  }
  return String(content ?? '');
}

/** 包装 shell executor：只允许只读命令 / Wrap shell executor to allow only read-only commands */
function wrapReadOnlyShell(inner: ShellExecutor): ShellExecutor {
  return async (shellInput) => {
    if (!isReadOnlyShellCommand(shellInput.command)) {
      return {
        ok: false,
        command: shellInput.command,
        exitCode: -1,
        stdout: '',
        stderr: `Command rejected: "${shellInput.command}" is not a read-only command. This sub-agent has read-only access only.`,
      };
    }
    return inner(shellInput);
  };
}

/** 绑定模型工具（区分 Ollama）/ Bind tools to model (handle Ollama separately) */
function bindTools(
  model: ReturnType<typeof createChatModel>,
  tools: ReturnType<typeof createAgentTools>,
) {
  if (model instanceof ChatOllama) return model.bindTools(tools);
  return model.bindTools(tools, { tool_choice: 'auto' });
}

/** 子 agent ID 生成器 */
let _subAgentCounter = 0;
function nextSubAgentId(): string {
  return `sub-${Date.now().toString(36)}-${_subAgentCounter++}`;
}

/** 运行子 Agent：独立上下文窗口 + 受限工具集 + 循环执行至完成 */
export async function runSubAgent(input: SubAgentRunnerInput): Promise<SubAgentResult> {
  const id = nextSubAgentId();
  const model = input.role.model ?? input.model ?? createChatModel(input.config);
  const effectiveTimeoutMs = input.role.timeoutMs ?? input.timeoutMs;
  const startTime = Date.now();
  let toolCallCount = 0;
  const steps: SubAgentStepSnapshot[] = [];

  // 发出 start 事件
  input.eventSink({
    type: 'start',
    data: { id, role: input.role.role, task: input.task },
  });

  // 只读角色：包装 shell executor 限制为只读命令，防止绕过审批
  // Read-only roles: wrap shell executor to restrict to read-only commands
  const effectiveShellExecutor =
    input.role.allowedTools && input.shellExecutor
      ? wrapReadOnlyShell(input.shellExecutor)
      : input.shellExecutor;

  // 组合超时信号 + 外部 abort 信号，传播到模型调用和工具执行
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
  const combinedSignal = AbortSignal.any([input.signal, timeoutController.signal]);

  // 构建工具集：受限角色只提供允许的工具
  const allTools = createAgentTools({
    workspace: input.workspace,
    shellExecutor: effectiveShellExecutor,
    mcpManager: input.mcpManager,
    skills: input.skills,
    skillOptions: input.skillOptions,
    signal: combinedSignal,
  });
  // Filter: apply role restrictions, then exclude "task" when depth limit reached
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 0;
  const canSpawnSubAgents = depth < maxDepth;
  const tools = input.role.allowedTools
    ? allTools.filter(
        (t) => input.role.allowedTools?.has(t.name) && (canSpawnSubAgents || t.name !== 'task'),
      )
    : allTools.filter((t) => canSpawnSubAgents || t.name !== 'task');

  // 构造缓存安全的运行时上下文（对齐主 agent 的布局，不含时间戳/CWD）
  // Build cache-safe runtime context (same layout as main agent, no timestamps/CWD)
  const cacheableRuntimeCtx = buildCacheableRuntimeContext({ workspace: input.workspace });

  // CWD 嵌入 task HumanMessage：task 每次调用都不同，嵌入 CWD 不增加缓存 miss
  // Embed CWD in task HumanMessage: task is unique per call, doesn't affect prefix cache
  const taskWithCwd = `<runtime-state source="harness.subagent">
CWD: ${process.cwd()}
</runtime-state>

${input.task}`;

  // System prompt layout (single merged message for cache stability):
  //   Merged: sharedSystemPrompt + "\\n\\n" + role.systemPrompt + "\\n\\n" + cacheableRuntimeCtx
  //   Position 0: SystemMessage(merged)  — cache-stable prefix
  //   Position 1: HumanMessage(taskWithCwd) — unique per call
  const sharedSystemPrompt = buildStaticSystemPrompt('agent', input.skills);
  const mergedSystemPrompt = `${sharedSystemPrompt}\n\n${input.role.systemPrompt}\n\n${cacheableRuntimeCtx}`;
  const messages: BaseMessage[] = [
    new SystemMessage(mergedSystemPrompt),
    new HumanMessage(taskWithCwd),
  ];

  try {
    // Yield control so Ink/React can render the subagent_start block before we block on model calls
    await new Promise((r) => setTimeout(r, 0));

    while (true) {
      // Check abort before blocking on model invoke
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
      const response = (await bindTools(model, tools).invoke(messages, {
        signal: combinedSignal,
      })) as AIMessage;
      // Check abort after model invoke returns (signal may have fired during the call)
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');

      // 提取子 agent 缓存指标并上报 / Extract sub-agent cache metrics and report
      const cacheMetrics = extractPromptCacheMetrics(response);
      if (cacheMetrics && (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)) {
        input.eventSink({
          type: 'cache_metrics',
          data: {
            subagentId: id,
            cacheHitTokens: cacheMetrics.cacheHitTokens,
            cacheMissTokens: cacheMetrics.cacheMissTokens,
            inputTokens: cacheMetrics.inputTokens,
          },
        });
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        // 将 AI 消息推入一次（在循环外），避免重复
        messages.push(response);

        // 处理工具调用
        for (const tc of response.tool_calls) {
          // 每个工具调用前检查中止信号 / Check abort signal before each tool invocation
          if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) continue;

          // 发出 step 事件
          const stepSnapshot: SubAgentStepSnapshot = {
            toolName: tc.name,
            toolArgs: (tc.args as Record<string, unknown>) ?? {},
          };
          steps.push(stepSnapshot);
          input.eventSink({
            type: 'step',
            data: {
              id,
              toolName: tc.name,
              toolArgs: (tc.args as Record<string, unknown>) ?? {},
            },
          });

          toolCallCount++;

          const toolStart = Date.now();
          let toolOutput: string;
          let ok = true;
          let totalLines: number | undefined;
          try {
            toolOutput = await tool.invoke(tc.args ?? {});
            // 尝试解析 JSON 判断 ok，并提取 totalLines（用于 TUI 行号展示）
            try {
              const parsed = JSON.parse(toolOutput);
              ok = parsed.ok !== false;
              if (typeof parsed.totalLines === 'number') totalLines = parsed.totalLines;
            } catch {
              /* not JSON */
            }
          } catch (e) {
            toolOutput = JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            });
            ok = false;
          }

          const durationMs = Date.now() - toolStart;

          // 回填步骤快照的结果 / Backfill step snapshot with result
          stepSnapshot.ok = ok;
          if (totalLines != null) stepSnapshot.totalLines = totalLines;

          // 发出 tool_result 事件（含手动 token 统计 + failure_reason + summary）
          const toolTokenCount = countTokens(toolOutput);
          input.eventSink({
            type: 'tool_result',
            data: {
              id,
              toolName: tc.name,
              ok,
              summary: typeof toolOutput === 'string' ? toolOutput.slice(0, 200) : '',
              durationMs,
              ...(totalLines != null ? { totalLines } : {}),
              ...(toolTokenCount > 0 ? { toolTokenCount } : {}),
              ...(!ok
                ? {
                    failureReason: classifyToolFailure(
                      tc.name,
                      typeof toolOutput === 'string' ? toolOutput.slice(0, 200) : '',
                    ),
                  }
                : {}),
            },
          });

          messages.push(
            new ToolMessage({
              content: toolOutput,
              tool_call_id: tc.id ?? '',
              name: tc.name,
            }),
          );
        }
      } else {
        // 无工具调用 → 最终文本 = 摘要
        clearTimeout(timeoutId);
        messages.push(response);
        const summary = extractText(response.content);
        const durationMs = Date.now() - startTime;

        input.eventSink({
          type: 'done',
          data: { id, summary, toolCallCount, durationMs },
        });

        return { ok: true, summary, toolCallCount, durationMs, steps };
      }
    }
  } catch (e) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const errMsg = e instanceof Error ? e.message : String(e);
    const summary = e instanceof Error && e.name === 'AbortError' ? 'Cancelled' : errMsg;
    input.eventSink({
      type: 'error',
      data: { id, error: summary, summary, toolCallCount, durationMs },
    });
    return { ok: false, summary, toolCallCount, durationMs, error: summary, steps };
  }
}
