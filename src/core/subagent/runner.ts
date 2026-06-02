// src/core/subagent/runner.ts
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { ChatOllama } from "@langchain/ollama";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentConfig } from "@/core/config/index";
import { createChatModel, type SupportedChatModel } from "@/core/model/factory";
import { createAgentTools, isReadOnlyShellCommand } from "@/core/tools/definitions";
import type { ShellExecutor } from "@/core/tools/shell";
import type { McpManager } from "@/core/mcp";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { SubAgentRoleConfig, SubAgentRunnerInput, SubAgentResult, SubAgentEventSink } from "./types";

export type { SubAgentRunnerInput } from "./types";

/** 提取 AIMessage.content 中的纯文本 / Extract plain text from AIMessage.content */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => (b && typeof b === "object" && "text" in (b as Record<string, unknown>))
        ? String((b as Record<string, unknown>).text) : "")
      .join("");
  }
  return String(content ?? "");
}

/** 包装 shell executor：只允许只读命令 / Wrap shell executor to allow only read-only commands */
function wrapReadOnlyShell(inner: ShellExecutor): ShellExecutor {
  return async (shellInput) => {
    if (!isReadOnlyShellCommand(shellInput.command)) {
      return {
        ok: false,
        command: shellInput.command,
        exitCode: -1,
        stdout: "",
        stderr: `Command rejected: "${shellInput.command}" is not a read-only command. This sub-agent has read-only access only.`,
      };
    }
    return inner(shellInput);
  };
}

/** 绑定模型工具（区分 Ollama）/ Bind tools to model (handle Ollama separately) */
function bindTools(model: ReturnType<typeof createChatModel>, tools: ReturnType<typeof createAgentTools>) {
  if (model instanceof ChatOllama) return model.bindTools(tools);
  return model.bindTools(tools, { tool_choice: "auto" });
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

  // 发出 start 事件
  input.eventSink({
    type: "start",
    data: { id, role: input.role.role, task: input.task },
  });

  // 只读角色：包装 shell executor 限制为只读命令，防止绕过审批
  // Read-only roles: wrap shell executor to restrict to read-only commands
  const effectiveShellExecutor = input.role.allowedTools && input.shellExecutor
    ? wrapReadOnlyShell(input.shellExecutor)
    : input.shellExecutor;

  // 构建工具集：受限角色只提供允许的工具
  const allTools = createAgentTools({
    workspace: input.workspace,
    shellExecutor: effectiveShellExecutor,
    mcpManager: input.mcpManager,
    skills: input.skills,
    skillOptions: input.skillOptions,
  });
  // Filter: apply role restrictions, then exclude "task" when depth limit reached
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 0;
  const canSpawnSubAgents = depth < maxDepth;
  const tools = input.role.allowedTools
    ? allTools.filter((t) => input.role.allowedTools!.has(t.name) && (canSpawnSubAgents || t.name !== "task"))
    : allTools.filter((t) => canSpawnSubAgents || t.name !== "task");

  const systemMessage = new SystemMessage(input.role.systemPrompt);
  const messages: BaseMessage[] = [systemMessage, new HumanMessage(input.task)];

  // 组合超时信号 + 外部 abort 信号，传播到模型 HTTP 请求
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
  const combinedSignal = AbortSignal.any([input.signal, timeoutController.signal]);

  try {
    // Yield control so Ink/React can render the subagent_start block before we block on model calls
    await new Promise((r) => setTimeout(r, 0));

    while (true) {
      // Check abort before blocking on model invoke
      if (combinedSignal.aborted) throw new Error("Sub-agent aborted");
      const response = await bindTools(model, tools).invoke(messages, { signal: combinedSignal }) as AIMessage;

      if (response.tool_calls && response.tool_calls.length > 0) {
        // 将 AI 消息推入一次（在循环外），避免重复
        messages.push(response);

        // 处理工具调用
        for (const tc of response.tool_calls) {
          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) continue;

          // 发出 step 事件
          input.eventSink({
            type: "step",
            data: {
              id,
              toolName: tc.name,
              toolArgs: (tc.args as Record<string, unknown>) ?? {},
            },
          });

          toolCallCount++;

          let toolOutput: string;
          let ok = true;
          try {
            toolOutput = await tool.invoke(tc.args ?? {});
            // 尝试解析 JSON 判断 ok
            try {
              const parsed = JSON.parse(toolOutput);
              ok = parsed.ok !== false;
            } catch { /* not JSON */ }
          } catch (e: any) {
            toolOutput = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
            ok = false;
          }

          // 发出 tool_result 事件
          input.eventSink({
            type: "tool_result",
            data: { id, toolName: tc.name, ok },
          });

          messages.push(new ToolMessage({
            content: toolOutput,
            tool_call_id: tc.id ?? "",
            name: tc.name,
          }));
        }
      } else {
        // 无工具调用 → 最终文本 = 摘要
        clearTimeout(timeoutId);
        messages.push(response);
        const summary = extractText(response.content);
        const durationMs = Date.now() - startTime;

        input.eventSink({
          type: "done",
          data: { id, summary, toolCallCount, durationMs },
        });

        return { ok: true, summary, toolCallCount, durationMs };
      }
    }
  } catch (e: any) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const error = e?.message ?? String(e);
    input.eventSink({
      type: "error",
      data: { id, error },
    });
    return { ok: false, summary: error, toolCallCount, durationMs, error };
  }
}
