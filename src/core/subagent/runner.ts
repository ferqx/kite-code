import { isAbsolute, relative, resolve } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { type AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { createChatModel } from '@/core/model/factory';
import { buildCacheableRuntimeContext } from '@/core/model/runtime-context';
import { classifyToolFailure } from '@/core/session-logger/classifier';
import { countTokens } from '@/core/token-counter';
import { createAgentTools, isReadOnlyShellCommand } from '@/core/tools/definitions';
import { msys2ToWindowsPath } from '@/core/tools/path-utils';
import type { ShellExecutor } from '@/core/tools/shell';
import { getRoleConfig } from './roles';
import type {
  SubAgentContinuation,
  SubAgentResult,
  SubAgentRoleConfig,
  SubAgentRunnerInput,
  SubAgentStepSnapshot,
} from './types';

export type { SubAgentRunnerInput } from './types';

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

function bindTools(
  model: ReturnType<typeof createChatModel>,
  tools: ReturnType<typeof createAgentTools>,
) {
  if (model instanceof ChatOllama) return model.bindTools(tools);
  return model.bindTools(tools, { tool_choice: 'auto' });
}

let _subAgentCounter = 0;
function nextSubAgentId(): string {
  return `sub-${Date.now().toString(36)}-${_subAgentCounter++}`;
}

function normalizeSubAgentToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  if (
    (toolName !== 'read_file' && toolName !== 'edit_file' && toolName !== 'write_file') ||
    typeof args.path !== 'string'
  ) {
    return args;
  }

  const rawPath = msys2ToWindowsPath(args.path);
  if (!isAbsolute(rawPath)) return args;

  const workspaceRoot = resolve(workspace);
  const rel = relative(workspaceRoot, rawPath);
  if (rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))) {
    return { ...args, path: rel || '.' };
  }
  return args;
}

function approvalRequiredBlock(
  result: { command?: string; status?: string; stderr?: string },
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  continuation: SubAgentContinuation,
) {
  if (
    result.status !== 'rejected' ||
    !result.stderr?.includes('requires approval but was not approved')
  ) {
    return null;
  }
  const command = result.command ?? toolName;
  return {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' as const,
    toolCallId,
    toolName,
    command,
    args,
    message: `Sub-agent blocked: ${toolName} requires main-agent approval before execution.`,
    continuation,
  };
}

function initialMessages(input: SubAgentRunnerInput): BaseMessage[] {
  const cacheableRuntimeCtx = buildCacheableRuntimeContext({ workspace: input.workspace });
  const taskWithCwd = `<runtime-state source="harness.subagent">
CWD: ${process.cwd()}
</runtime-state>

${input.task}`;

  let systemPrompt = input.role.systemPrompt;
  if (input.role.role === 'code' && input.skills && input.skills.length > 0) {
    const skillLines = input.skills.map((s) => `- ${s.name}: ${s.description}`);
    systemPrompt += [
      '',
      '## Available Skills',
      'Use the Skill tool to invoke a skill when its description matches your task.',
      ...skillLines,
    ].join('\n');
  }
  systemPrompt += `\n\n${cacheableRuntimeCtx}`;
  return [new SystemMessage(systemPrompt), new HumanMessage(taskWithCwd)];
}

function normalizeRoleConfig(role: SubAgentRoleConfig): SubAgentRoleConfig {
  if (!role.allowedTools || role.allowedTools instanceof Set) return role;
  const fallback = getRoleConfig(role.role);
  return {
    ...fallback,
    systemPrompt: role.systemPrompt || fallback.systemPrompt,
    model: role.model,
    timeoutMs: role.timeoutMs,
  };
}

export async function runSubAgent(input: SubAgentRunnerInput): Promise<SubAgentResult> {
  const id = nextSubAgentId();
  const normalizedInput = { ...input, role: normalizeRoleConfig(input.role) };
  input.eventSink({
    type: 'start',
    data: { id, role: normalizedInput.role.role, task: normalizedInput.task },
  });
  return runSubAgentLoop(normalizedInput, {
    id,
    messages: initialMessages(normalizedInput),
    toolCallCount: 0,
    steps: [],
  });
}

export async function resumeSubAgent(
  input: SubAgentRunnerInput,
  continuation: SubAgentContinuation,
  toolResult: {
    toolCallId: string;
    toolName: string;
    result: ToolExecutionResult;
  },
): Promise<SubAgentResult> {
  const normalizedInput = { ...input, role: normalizeRoleConfig(input.role) };
  const toolOutput = JSON.stringify(toolResult.result);
  const actualOk = toolResult.result.ok !== false;
  normalizedInput.eventSink({
    type: 'tool_result',
    data: {
      id: continuation.id,
      toolName: toolResult.toolName,
      ok: actualOk,
      summary: toolOutput.slice(0, 200),
      durationMs: 0,
      ...(typeof toolResult.result.totalLines === 'number'
        ? { totalLines: toolResult.result.totalLines }
        : {}),
      toolTokenCount: countTokens(toolOutput),
      ...(toolResult.result.ok === false
        ? { failureReason: classifyToolFailure(toolResult.toolName, toolOutput.slice(0, 200)) }
        : {}),
    },
  });

  // Sync step snapshot with actual result — the blocked case didn't set ok,
  // so the last step in the continuation still has ok: undefined.
  // resumeSubAgent is the authority on the actual tool outcome (approved → ok,
  // rejected → !ok), so update the snapshot here before the loop continues.
  const lastStep = continuation.steps[continuation.steps.length - 1];
  if (lastStep && lastStep.toolName === toolResult.toolName) {
    lastStep.ok = actualOk;
    lastStep.status = actualOk
      ? 'success'
      : toolResult.result.status === 'rejected'
        ? 'rejected'
        : 'error';
  }

  return runSubAgentLoop(normalizedInput, {
    id: continuation.id,
    messages: [
      ...continuation.messages,
      new ToolMessage({
        content: toolOutput,
        tool_call_id: toolResult.toolCallId,
        name: toolResult.toolName,
        status: toolResult.result.ok === false ? 'error' : 'success',
      }),
    ],
    toolCallCount: continuation.toolCallCount,
    steps: continuation.steps,
  });
}

async function runSubAgentLoop(
  input: SubAgentRunnerInput,
  state: {
    id: string;
    messages: BaseMessage[];
    toolCallCount: number;
    steps: SubAgentStepSnapshot[];
  },
): Promise<SubAgentResult> {
  const id = state.id;
  const model = input.role.model ?? input.model ?? createChatModel(input.config);
  const effectiveTimeoutMs = input.role.timeoutMs ?? input.timeoutMs;
  const startTime = Date.now();
  let toolCallCount = state.toolCallCount;
  const steps = state.steps;
  const messages = [...state.messages];

  const effectiveShellExecutor =
    input.role.allowedTools && input.shellExecutor
      ? wrapReadOnlyShell(input.shellExecutor)
      : input.shellExecutor;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
  const combinedSignal = AbortSignal.any([input.signal, timeoutController.signal]);

  const allTools = createAgentTools({
    workspace: input.workspace,
    shellExecutor: effectiveShellExecutor,
    mcpManager: input.mcpManager,
    skills: input.skills,
    skillOptions: input.skillOptions,
    signal: combinedSignal,
  });
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 0;
  const canSpawnSubAgents = depth < maxDepth;
  const tools = input.role.allowedTools
    ? allTools.filter(
        (t) => input.role.allowedTools?.has(t.name) && (canSpawnSubAgents || t.name !== 'task'),
      )
    : allTools.filter((t) => canSpawnSubAgents || t.name !== 'task');

  try {
    await new Promise((r) => setTimeout(r, 0));

    while (true) {
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
      const response = (await bindTools(model, tools).invoke(messages, {
        signal: combinedSignal,
      })) as AIMessage;
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');

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

      if (!response.tool_calls || response.tool_calls.length === 0) {
        clearTimeout(timeoutId);
        messages.push(response);
        const summary = extractText(response.content);
        const durationMs = Date.now() - startTime;
        // 有步骤被拒绝 → 工具级失败，但子 agent 已正常完成运行，仍发 done
        const rejectedSteps = steps.filter((s) => s.ok === false);
        if (rejectedSteps.length > 0) {
          const toolNames = [...new Set(rejectedSteps.map((s) => s.toolName))].join(', ');
          input.eventSink({
            type: 'done',
            data: {
              id,
              summary: summary || `Tool calls rejected: ${toolNames}`,
              toolCallCount,
              durationMs,
            },
          });
          return {
            ok: false,
            summary: summary || `Tool calls rejected: ${toolNames}`,
            toolCallCount,
            durationMs,
            steps,
            error: `Tool calls rejected: ${toolNames}`,
          };
        }
        input.eventSink({
          type: 'done',
          data: { id, summary, toolCallCount, durationMs },
        });
        return { ok: true, summary, toolCallCount, durationMs, steps };
      }

      messages.push(response);
      for (const tc of response.tool_calls) {
        if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) {
          const available = [...new Set(tools.map((t) => t.name))].sort().join(', ');
          const errMsg = `Tool "${tc.name}" is not available to this sub-agent. Available tools: ${available}. Use one of the available tools instead.`;
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ ok: false, error: errMsg }),
              tool_call_id: tc.id ?? '',
              name: tc.name,
              status: 'error',
            }),
          );
          input.eventSink({
            type: 'tool_result',
            data: {
              id,
              toolName: tc.name,
              ok: false,
              summary: errMsg.slice(0, 200),
              durationMs: 0,
              failureReason: 'tool_not_available',
            },
          });
          steps.push({
            toolName: tc.name,
            toolArgs: (tc.args as Record<string, unknown>) ?? {},
            status: 'error' as const,
            ok: false,
          });
          continue;
        }

        const toolArgs = normalizeSubAgentToolArgs(
          tc.name,
          (tc.args as Record<string, unknown>) ?? {},
          input.workspace,
        );
        const stepSnapshot: SubAgentStepSnapshot = {
          toolName: tc.name,
          toolArgs,
          status: 'pending',
        };
        steps.push(stepSnapshot);
        input.eventSink({
          type: 'step',
          data: {
            id,
            toolName: tc.name,
            toolArgs,
          },
        });

        toolCallCount++;
        const toolStart = Date.now();
        let toolOutput: string;
        let ok = true;
        let totalLines: number | undefined;
        try {
          const pendingRequest = toolRequestFromCall(
            {
              id: tc.id ?? `subagent-${toolCallCount}`,
              name: tc.name,
              args: toolArgs,
            },
            input.workspace,
          );
          if (!pendingRequest) {
            throw new Error(`Unknown tool requested by sub-agent: ${tc.name}`);
          }
          const result = await runApprovedTool({
            workspace: input.workspace,
            request: pendingRequest,
            shellExecutor: effectiveShellExecutor,
            workspaceAccess: input.workspaceAccess ?? 'write',
            phase: input.phase ?? 'building',
            authorization: input.authorization,
            threadId: input.threadId ?? '',
            mcpManager: input.mcpManager,
            skillManifests: input.skills,
            skillOptions: input.skillOptions,
            signal: combinedSignal,
            taskConfig: input.config,
            taskModel: model,
            subagentEventSink: input.eventSink,
          });
          const continuation: SubAgentContinuation = {
            id,
            role: input.role,
            task: input.task,
            messages: [...messages],
            toolCallCount,
            steps,
          };
          const blocked = approvalRequiredBlock(
            result,
            pendingRequest.id ?? tc.id ?? `subagent-${toolCallCount}`,
            pendingRequest.name,
            toolArgs,
            continuation,
          );
          if (blocked) {
            clearTimeout(timeoutId);
            const totalDurationMs = Date.now() - startTime;
            return {
              ok: false,
              summary: JSON.stringify({ ok: false, blocked }),
              toolCallCount,
              durationMs: totalDurationMs,
              error: blocked.message,
              blocked,
              steps,
            };
          }
          toolOutput = JSON.stringify(result);
          ok = result.ok !== false;
          if (typeof result.totalLines === 'number') totalLines = result.totalLines;
        } catch (e) {
          toolOutput = JSON.stringify({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
          ok = false;
        }

        const durationMs = Date.now() - toolStart;
        stepSnapshot.ok = ok;
        stepSnapshot.status = ok ? 'success' : 'error';
        if (totalLines != null) stepSnapshot.totalLines = totalLines;

        const toolTokenCount = countTokens(toolOutput);
        input.eventSink({
          type: 'tool_result',
          data: {
            id,
            toolName: tc.name,
            ok,
            summary: toolOutput.slice(0, 200),
            durationMs,
            ...(totalLines != null ? { totalLines } : {}),
            ...(toolTokenCount > 0 ? { toolTokenCount } : {}),
            ...(!ok
              ? {
                  failureReason: classifyToolFailure(tc.name, toolOutput.slice(0, 200)),
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
