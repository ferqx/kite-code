import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolSet } from 'ai';
import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { digestCapability } from '@/core/capabilities/catalog';
import { validateCapabilityArguments } from '@/core/capabilities/schema';
import {
  type ExecutionJournalEntry,
  isFingerprintExhausted,
  recordExecutionResult,
} from '@/core/execution/journal';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { BaseMessage } from '@/core/messages';
import { humanMessage, systemMessage, toolMessage } from '@/core/messages';
import { createChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import { buildCacheableRuntimeContext } from '@/core/model/runtime-context';
import { isReadOnlyShellCommand } from '@/core/policies/shell-classification';
import { classifyToolFailure } from '@/core/session-logger/classifier';
import { countTokens } from '@/core/token-counter';
import { createAgentTools } from '@/core/tools/definitions';
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

function mcpBindingError(input: {
  toolName: string;
  args: Record<string, unknown>;
  mcpManager?: SubAgentRunnerInput['mcpManager'];
  bindings: Map<string, NonNullable<SubAgentRunnerInput['mcpBindings']>[number]>;
}): string | null {
  const entry = input.bindings.get(input.toolName);
  if (!entry) return 'MCP tool call has no Runtime-issued binding for this sub-agent.';
  const { binding } = entry;
  const descriptor = input.mcpManager?.findCapability(binding.capabilityId);
  if (
    binding.exposedToolName !== input.toolName ||
    !descriptor ||
    descriptor.revision !== binding.capabilityRevision
  ) {
    return 'MCP capability changed after its binding was issued; request a new Runtime turn.';
  }
  if (
    descriptor.kind !== 'mcp_tool' ||
    descriptor.availability !== 'available' ||
    !descriptor.inputSchema ||
    binding.schemaDigest !== digestCapability(descriptor.inputSchema)
  ) {
    return 'MCP capability is unavailable for execution.';
  }
  return validateCapabilityArguments(descriptor.inputSchema, input.args);
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
  return [systemMessage(systemPrompt), humanMessage(taskWithCwd)];
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
    executionJournal: [],
    exhaustedFingerprints: {},
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
      toolMessage({
        content: toolOutput,
        tool_call_id: toolResult.toolCallId,
        name: toolResult.toolName,
        status: toolResult.result.ok === false ? 'error' : 'success',
      }),
    ],
    toolCallCount: continuation.toolCallCount,
    steps: continuation.steps,
    executionJournal: continuation.executionJournal ?? [],
    exhaustedFingerprints: continuation.exhaustedFingerprints ?? {},
  });
}

async function runSubAgentLoop(
  input: SubAgentRunnerInput,
  state: {
    id: string;
    messages: BaseMessage[];
    toolCallCount: number;
    steps: SubAgentStepSnapshot[];
    // Phase 5: journal tracking for subagent tool executions
    executionJournal: ExecutionJournalEntry[];
    exhaustedFingerprints: Record<string, true>;
  },
): Promise<SubAgentResult> {
  const id = state.id;
  const model = input.role.model ?? input.model ?? createChatModel(input.config);
  const effectiveTimeoutMs = input.role.timeoutMs ?? input.timeoutMs;
  const startTime = Date.now();
  let toolCallCount = state.toolCallCount;
  const steps = state.steps;
  const messages = [...state.messages];
  let executionJournal = state.executionJournal ?? [];
  const exhaustedFingerprints: Record<string, true> = { ...(state.exhaustedFingerprints ?? {}) };

  const effectiveShellExecutor =
    input.role.allowedTools && input.shellExecutor
      ? wrapReadOnlyShell(input.shellExecutor)
      : input.shellExecutor;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
  // 手动合并信号，避免 AbortSignal.any 的跨运行时兼容性问题
  const combinedController = new AbortController();
  const onAbort = () => combinedController.abort();
  if (input.signal.aborted) {
    combinedController.abort(input.signal.reason);
  } else {
    input.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutController.signal.aborted) {
    combinedController.abort(timeoutController.signal.reason);
  } else {
    timeoutController.signal.addEventListener('abort', onAbort, { once: true });
  }
  const combinedSignal = combinedController.signal;

  const allTools = createAgentTools({
    workspace: input.workspace,
    shellExecutor: effectiveShellExecutor,
    mcpManager: input.mcpManager,
    skills: input.skills,
    skillOptions: input.skillOptions,
    mcpBindings: input.mcpBindings,
    signal: combinedSignal,
  });
  const mcpBindings = new Map(
    (input.mcpBindings ?? []).map((entry) => [entry.binding.exposedToolName, entry]),
  );
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 0;
  const canSpawnSubAgents = depth < maxDepth;
  // ToolSet is now Record<string, Tool> — filter by key (tool name)
  const tools: ToolSet = {};
  if (input.role.allowedTools) {
    for (const [name, t] of Object.entries(allTools)) {
      if (input.role.allowedTools.has(name) && (canSpawnSubAgents || name !== 'task')) {
        tools[name] = t;
      }
    }
  } else {
    for (const [name, t] of Object.entries(allTools)) {
      if (canSpawnSubAgents || name !== 'task') {
        tools[name] = t;
      }
    }
  }

  try {
    await new Promise((r) => setTimeout(r, 0));

    while (true) {
      if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
      const response = await invokeBoundModel({
        model,
        tools,
        messages,
        signal: combinedSignal,
      });
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
            executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
            exhaustedFingerprints:
              Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
          };
        }
        input.eventSink({
          type: 'done',
          data: { id, summary, toolCallCount, durationMs },
        });
        return {
          ok: true,
          summary,
          toolCallCount,
          durationMs,
          steps,
          executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
          exhaustedFingerprints:
            Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
        };
      }

      messages.push(response);
      for (const tc of response.tool_calls) {
        if (combinedSignal.aborted) throw new Error('Sub-agent aborted');
        const tool = tools[tc.name];
        if (!tool) {
          const available = Object.keys(tools).sort().join(', ');
          const errMsg = `Tool "${tc.name}" is not available to this sub-agent. Available tools: ${available}. Use one of the available tools instead.`;
          messages.push(
            toolMessage({
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

        if (tc.name.startsWith('mcp__')) {
          const bindingError = mcpBindingError({
            toolName: tc.name,
            args: toolArgs,
            mcpManager: input.mcpManager,
            bindings: mcpBindings,
          });
          if (bindingError) {
            const blockedOutput = JSON.stringify({ ok: false, error: bindingError });
            messages.push(
              toolMessage({
                content: blockedOutput,
                tool_call_id: tc.id ?? '',
                name: tc.name,
                status: 'error',
              }),
            );
            stepSnapshot.ok = false;
            stepSnapshot.status = 'error';
            input.eventSink({
              type: 'tool_result',
              data: {
                id,
                toolName: tc.name,
                ok: false,
                summary: bindingError,
                durationMs: 0,
                failureReason: 'invalid_mcp_binding',
              },
            });
            continue;
          }
        }

        toolCallCount++;

        // Phase 5: 预检 — 如果 tool+path 已耗尽，跳过执行
        // Preflight: skip execution if this tool+path is already exhausted.
        const preflightPath = (toolArgs as Record<string, unknown>).path as string | undefined;
        if (isFingerprintExhausted(exhaustedFingerprints, tc.name, preflightPath)) {
          const blockedOutput = JSON.stringify({
            ok: false,
            command: tc.name,
            exitCode: -1,
            stdout: '',
            stderr: `Execution blocked: too many repeated failures for ${tc.name}${preflightPath ? ` on ${preflightPath}` : ''}.`,
            status: 'exhausted' as const,
            failure: {
              message: 'Tool execution failed.' as const,
              tool: tc.name,
              reason: `Execution blocked by exhaustion guard for ${tc.name}.`,
              guidance: 'Stop retrying this operation. Skip this step, replan, or safely finalize.',
            },
          });
          messages.push(
            toolMessage({
              content: blockedOutput,
              tool_call_id: tc.id ?? '',
              name: tc.name,
              status: 'exhausted',
            }),
          );
          stepSnapshot.ok = false;
          stepSnapshot.status = 'error';
          input.eventSink({
            type: 'tool_result',
            data: {
              id,
              toolName: tc.name,
              ok: false,
              summary: blockedOutput.slice(0, 200),
              durationMs: 0,
              failureReason: 'exhausted',
            },
          });
          continue;
        }

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
          const boundMcpDescriptor = tc.name.startsWith('mcp__')
            ? (() => {
                const binding = mcpBindings.get(tc.name)?.binding;
                return binding ? input.mcpManager?.findCapability(binding.capabilityId) : undefined;
              })()
            : undefined;
          const result = await runApprovedTool({
            workspace: input.workspace,
            request: pendingRequest,
            shellExecutor: effectiveShellExecutor,
            workspaceAccess: input.workspaceAccess ?? 'write',
            phase: input.phase ?? 'building',
            authorization: input.authorization,
            threadId: input.threadId ?? '',
            recordFilePreimage: input.recordFilePreimage,
            mcpManager: input.mcpManager,
            ...(boundMcpDescriptor
              ? {
                  mcpInvocation: {
                    capabilityId: boundMcpDescriptor.capabilityId,
                    expectedRevision: boundMcpDescriptor.revision,
                  },
                  mcpPolicy: {
                    effects: boundMcpDescriptor.effectiveEffects,
                    minimumApproval: boundMcpDescriptor.policy.minimumApproval,
                  },
                }
              : {}),
            skillManifests: input.skills,
            skillOptions: input.skillOptions,
            signal: combinedSignal,
            interactionMode: 'accept_edits',
            taskConfig: input.config,
            taskModel: model,
            subagentEventSink: input.eventSink,
          });
          const blocked = approvalRequiredBlock(
            result,
            pendingRequest.id ?? tc.id ?? `subagent-${toolCallCount}`,
            pendingRequest.name,
            toolArgs,
            {
              id,
              role: input.role,
              task: input.task,
              messages: [...messages],
              toolCallCount,
              steps,
              executionJournal: executionJournal.length > 0 ? [...executionJournal] : undefined,
              exhaustedFingerprints:
                Object.keys(exhaustedFingerprints).length > 0
                  ? { ...exhaustedFingerprints }
                  : undefined,
            },
          );
          if (blocked) {
            clearTimeout(timeoutId);
            const totalDurationMs = Date.now() - startTime;

            // 同一 AI message 中可能有多个 tool call，blocked 后剩余的工具
            // 未被处理。必须为它们添加 deferred ToolMessage，否则消息格式不合法
            // （每个 tool_call_id 都需要对应 ToolMessage），resume 后模型调用会 400。
            const currentIndex = response.tool_calls.indexOf(tc);
            for (let i = currentIndex + 1; i < response.tool_calls.length; i++) {
              const remaining = response.tool_calls[i]!;
              messages.push(
                toolMessage({
                  content: JSON.stringify({
                    ok: false,
                    deferred: true,
                    error: `Execution deferred: sub-agent paused for ${tc.name} approval before this tool could run.`,
                  }),
                  tool_call_id: remaining.id ?? `subagent-deferred-${i}`,
                  name: remaining.name,
                  status: 'error',
                }),
              );
            }

            // 重建 continuation，包含 deferred ToolMessages
            // Rebuild continuation WITH deferred messages so resumed state is valid
            const continuation: SubAgentContinuation = {
              id,
              role: input.role,
              task: input.task,
              messages: [...messages],
              toolCallCount,
              steps,
              executionJournal: executionJournal.length > 0 ? [...executionJournal] : undefined,
              exhaustedFingerprints:
                Object.keys(exhaustedFingerprints).length > 0
                  ? { ...exhaustedFingerprints }
                  : undefined,
            };
            // 更新 blocked.continuation 为包含 deferred 消息的新版本
            blocked.continuation = continuation;

            // 子 agent 工具需要审批：标记步骤为 awaiting_approval，暂停子 agent，
            // 将 blocked 结果返回给调用方（tool-controller）以通过 Runtime Kernel
            // 的审批管线处理。Kernel 审批通过后通过 resumeSubAgent 恢复执行。
            // Sub-agent tool needs approval: mark step as awaiting_approval, pause
            // the sub-agent, and return the blocked result to the caller so the
            // Runtime Kernel's approval pipeline can handle it. After approval, the
            // kernel resumes execution via resumeSubAgent.
            stepSnapshot.status = 'awaiting_approval' as const;
            return {
              ok: false,
              summary: JSON.stringify({ ok: false, blocked }),
              toolCallCount,
              durationMs: totalDurationMs,
              error: blocked.message,
              blocked,
              steps,
              executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
              exhaustedFingerprints:
                Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
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

        // Phase 5: Record subagent tool execution in journal.
        const journalResult = recordExecutionResult(
          { executionJournal, exhaustedFingerprints },
          {
            toolCallId: tc.id ?? `subagent-${toolCallCount}`,
            toolName: tc.name,
            ok,
            stderr: ok ? undefined : (JSON.parse(toolOutput).stderr as string | undefined),
            exitCode: ok ? undefined : (JSON.parse(toolOutput).exitCode as number | undefined),
            path: (toolArgs as Record<string, unknown>).path as string | undefined,
          },
        );
        executionJournal = journalResult.executionJournal;
        Object.assign(exhaustedFingerprints, journalResult.exhaustedFingerprints);

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
          toolMessage({
            content: toolOutput,
            tool_call_id: tc.id ?? '',
            name: tc.name,
            status: ok ? 'success' : 'error',
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
    return {
      ok: false,
      summary,
      toolCallCount,
      durationMs,
      error: summary,
      steps,
      executionJournal: executionJournal.length > 0 ? executionJournal : undefined,
      exhaustedFingerprints:
        Object.keys(exhaustedFingerprints).length > 0 ? exhaustedFingerprints : undefined,
    };
  }
}
