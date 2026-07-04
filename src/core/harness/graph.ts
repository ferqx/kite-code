import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { interrupt, START, StateGraph } from '@langchain/langgraph';
import { ChatOllama } from '@langchain/ollama';
import type { AgentConfig } from '@/core/config/index';
import { isFingerprintExhausted, recordExecutionResult } from '@/core/execution/journal';
import { issuePermit, migratePermitBatch } from '@/core/execution/permit';
import { createAutoReviewModel, reviewToolApproval } from '@/core/execution/reviewer';
import type { McpManager } from '@/core/mcp';
import { prepareModelContext } from '@/core/model/context';
import type { ModelRetryListener, RetryListenerHost } from '@/core/model/deepseek';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import { BunSqliteSaver } from '@/core/persistence/checkpoint';
import { resumeSubAgent } from '@/core/subagent/runner';
import type { SubAgentResult } from '@/core/subagent/types';
import { createAgentTools, isReadOnlyShellCommand } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ModelRetryEvent,
  ThreadAuthorizationState,
} from '@/core/types';
import {
  type AgentPlan,
  InteractionMode,
  isFullAccessMode,
  type PlanStatus,
  type ShellApprovalGrant,
} from '@/protocol/events';
import {
  routeAfterAgent,
  routeAfterApproval,
  routeAfterPlanReview,
  routeAfterTools,
  routeAfterUserInput,
  routeEntry,
} from './routes';
import { AgentState, type CodeAgentState } from './state';
import {
  applyApprovalGrant,
  buildToolApproval,
  classifyShellRisk,
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
  normalizeAuthorizationState,
  replaceApprovalCommand,
  validateApprovalHash,
} from './tool-policy';
import {
  getAllPendingToolRequests,
  type getPendingToolRequest,
  messageText,
  toolRequestFromCall,
  toolRequestFromMessage,
} from './tool-requests';
import { runApprovedTool } from './tool-runner';
import { userInputToolMessage } from './user-input';

/** 构建代码 Agent 图的输入 / Build code agent graph input */
export interface BuildCodeAgentGraphInput {
  /** Agent 配置 / Agent configuration */
  config: AgentConfig;
  /** Checkpoint 数据库路径 / Checkpoint database path */
  checkpointPath: string;
  /** 可选的自定义 Shell 执行器 / Optional custom shell executor */
  shellExecutor?: ShellExecutor;
  /** 可选的自定义模型实例（用于 mock 测试）/ Optional custom model instance (for mock testing) */
  model?: SupportedChatModel;
  /** 可选的内存级授权覆盖 / Optional in-memory authorization override */
  authorizationOverride?: AuthorizationOverride;
  /** 思考级别，映射到 reasoning_effort API 参数 / Thinking level, mapped to reasoning_effort API param */
  thinkingLevel?: string | null;
  /** 可选 MCP 管理器 / Optional MCP manager */
  mcpManager?: McpManager;
  /** 可选技能清单 / Optional skill manifests */
  skills?: import('@/core/skills/types').SkillManifest[];
  /** 可选技能扫描选项 / Optional skill scan options */
  skillOptions?: import('@/core/skills/types').SkillScanOptions;
  /** 子 agent 事件回调 */
  subagentEventSink?: import('@/core/subagent/types').SubAgentEventSink;
  /** 子 agent 中止信号 */
  subagentSignal?: AbortSignal;
  /** 工具完成回调 — 每个工具执行完立即调用，不等 Promise.all 整体返回。
   *  使 TUI 能在工具并行执行期间逐项展示完成状态，而非等全部结束后一起刷新。
   *  Per-tool completion callback — called as each tool finishes during
   *  Promise.all, so the TUI shows progressive completion. */
  toolResultSink?: (
    callId: string,
    toolName: string,
    ok: boolean,
    summary: string,
    totalLines?: number,
    toolTokenCount?: number,
    exitCode?: number,
    status?: 'success' | 'error' | 'exhausted',
  ) => void;
  /** 工具进度回调 — shell 进程产生输出时逐行调用，使 TUI 实时展示。
   *  Per-line progress callback — called for each stdout/stderr line during
   *  shell execution, so the TUI shows live output. */
  toolProgressSink?: (
    callId: string,
    toolName: string,
    chunk: string,
    stream: 'stdout' | 'stderr',
  ) => void;
}

/** 构建 LangGraph 状态图 / Build LangGraph state graph */
export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model =
    input.model ??
    createChatModel({
      ...input.config,
      reasoningEffort: input.thinkingLevel ?? input.config.reasoningEffort ?? null,
    });
  const checkpointer = new BunSqliteSaver(input.checkpointPath);
  const override = input.authorizationOverride;

  // Build MCP risk override map from server configs
  const mcpRiskOverride: Record<string, 'read'> = {};
  if (input.mcpManager) {
    for (const [name, state] of input.mcpManager.getServerStates()) {
      if (state.config.risk === 'read') {
        mcpRiskOverride[name] = 'read';
      }
    }
  }

  /** Agent 节点：使用稳定工具 schema，由执行层强制工作区访问边界 / Agent node */
  const agent = async (state: CodeAgentState) => {
    // cleanup 节点已在 agent 之前为所有孤儿 tool_calls 注入 cancelled ToolMessage，
    // 不再需要 sanitizeToolCallPairs 的重复防御。
    // The cleanup node already injects cancelled ToolMessages for all orphan tool_calls
    // before agent runs, so the duplicate sanitize pass is unnecessary here.
    const tools = createAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
      config: input.config,
      subagentEventSink: input.subagentEventSink,
      subagentSignal: input.subagentSignal,
      signal: input.subagentSignal,
      model: input.model,
      threadId: state.threadId,
      authorization: state.authorization,
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
    });
    const retryEvents: ModelRetryEvent[] = [];
    const listener: ModelRetryListener = (attempt, maxAttempts, error, delayMs) => {
      retryEvents.push({
        attempt,
        maxAttempts,
        error: typeof error === 'string' ? error : String(error).slice(0, 200),
        delayMs,
      });
    };
    if (hasRetryListener(model)) model.setRetryListener(listener);

    try {
      const { state: result } = await invokeModel({
        model,
        state,
        tools,
        skills: input.skills,
        signal: input.subagentSignal,
      });
      const syncedAuth = authorizationForState(state, override);
      const modelConfigState = {
        modelProvider: input.config.providerName,
        modelName: input.config.modelName,
        thinkingLevel: input.thinkingLevel ?? null,
      };
      const baseReturn = {
        ...result,
        ...modelConfigState,
        authorization: syncedAuth,
        // Preserve execution journal state across agent→tools cycles.
        // Without these, LangGraph may reset channels with default reducer
        // to their defaults between node invocations.
        executionJournal: state.executionJournal,
        exhaustedFingerprints: state.exhaustedFingerprints,
      };
      if (retryEvents.length > 0) {
        return { ...baseReturn, modelRetries: retryEvents };
      }
      return baseReturn;
    } catch (e) {
      // Return retry events even on failure — user should see retry context in error display
      if (retryEvents.length > 0) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
          modelRetries: retryEvents,
        });
      }
      throw e;
    } finally {
      if (hasRetryListener(model)) model.setRetryListener(null);
    }
  };

  /** 审批节点：中断等待人工批准，支持批量积累 / Approval node with batch accumulation */
  const approval = async (state: CodeAgentState) => {
    const batch = migratePermitBatch(state.approvedBatch);
    const pendingSubagent = state.pendingSubagentApproval;
    const hasFullAccess =
      isFullAccessMode(state.interactionMode) ||
      Object.values(batch).some((p) => !p.consumed && p.grant === 'full_access');

    // 查找第一个尚未审批的待处理工具（跳过已在 batch 中的）
    const allPending = pendingSubagent
      ? [pendingSubagent.request]
      : getAllPendingToolRequests(state.messages, state.workspace);
    let request: ReturnType<typeof getPendingToolRequest> = null;
    for (const r of allPending) {
      if (r.id && !batch[r.id]) {
        request = r;
        break;
      }
    }

    if (!request?.id) {
      return {};
    }

    // full_access 已授权 → 自动批准剩余所有工具 / full_access already granted → auto-approve all remaining
    if (hasFullAccess) {
      for (const r of allPending) {
        Object.assign(
          batch,
          issuePermit({
            batch,
            workspace: state.workspace,
            threadId: state.threadId,
            request: r,
            grant: 'full_access',
          }),
        );
      }
      return { approvedBatch: batch, approvedToolRequest: null, approvedToolGrant: null };
    }

    const workspaceAccess = state.workspaceAccess ?? 'write';
    const policy = evaluateToolPolicy({
      request,
      workspaceAccess,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: state.authorization,
      override,
      mcpRiskOverride,
    });

    // 不需要审批的工具（如 read_file）→ 标记为 auto-pass 并直接返回
    // Non-approval tools (e.g. read_file) → mark as auto-pass and return
    if (!policy.requiresApproval) {
      Object.assign(
        batch,
        issuePermit({
          batch,
          workspace: state.workspace,
          threadId: state.threadId,
          request,
          grant: 'approve_once',
        }),
      );
      return { approvedBatch: batch, approvedToolRequest: null, approvedToolGrant: null };
    }

    const approvalPayload = buildToolApproval({
      workspace: state.workspace,
      threadId: state.threadId,
      request,
      decision: policy,
    });
    // 标记子 agent 审批来源，TUI 据此暂停该子 agent 的加载动画
    if (pendingSubagent) {
      approvalPayload.subagentId = pendingSubagent.continuation.id;
    }

    let approved:
      | boolean
      | {
          approved?: boolean;
          grant?: ShellApprovalGrant;
          approvalHash?: string;
          replacementCommand?: string;
          reason?: string;
        };
    if (state.interactionMode === InteractionMode.Auto) {
      const reviewModel =
        input.config.autoReview?.provider || input.config.autoReview?.model
          ? createAutoReviewModel(input.config)
          : model;
      const review = await reviewToolApproval({
        model: reviewModel,
        payload: approvalPayload,
        request,
        timeoutMs: input.config.autoReview?.timeoutMs,
      });
      if (!review.ok || !review.suggestion?.approved) {
        if (pendingSubagent) {
          Object.assign(
            batch,
            issuePermit({
              batch,
              workspace: state.workspace,
              threadId: state.threadId,
              request: pendingSubagent.request,
              grant: 'none',
            }),
          );
          return { approvedBatch: batch };
        }
        return {
          ...rejectedToolMessage(
            request,
            `auto review rejected: ${review.suggestion?.reason ?? review.reason ?? 'not approved'}`,
          ),
          approvedBatch: batch,
        };
      }
      approved = {
        approved: true,
        grant: review.suggestion.grant,
        approvalHash: approvalPayload.approvalHash,
        reason: review.suggestion.reason,
      };
    } else {
      approved = interrupt({
        kind: 'tool_approval',
        request,
        policy,
        approval: approvalPayload,
      }) as
        | boolean
        | {
            approved?: boolean;
            grant?: ShellApprovalGrant;
            approvalHash?: string;
            replacementCommand?: string;
            reason?: string;
          };
    }
    const approvalGrant = approvalGrantFromResume(approved);
    const allowed =
      approved === true ||
      (typeof approved === 'object' &&
        approved !== null &&
        (approved.approved === true ||
          (approved.approved === undefined && approvalGrant !== null)) &&
        (approved.approvalHash === undefined ||
          validateApprovalHash(approved, approvalPayload.approvalHash)));

    if (!allowed) {
      const hashMismatch =
        typeof approved === 'object' &&
        approved !== null &&
        approved.approvalHash !== undefined &&
        !validateApprovalHash(approved, approvalPayload.approvalHash);
      const reason = hashMismatch
        ? 'approved request does not match current tool request'
        : typeof approved === 'object' && approved !== null
          ? (approved.reason ?? 'not approved')
          : 'not approved';
      // 子 agent 审批被拒 → 注入拒绝结果并恢复子 agent，让它尝试其他方法
      // Sub-agent approval rejected → inject rejection result so it can try alternatives
      if (pendingSubagent) {
        Object.assign(
          batch,
          issuePermit({
            batch,
            workspace: state.workspace,
            threadId: state.threadId,
            request: pendingSubagent.request,
            grant: 'none',
          }),
        );
        return { approvedBatch: batch };
      }
      return {
        ...rejectedToolMessage(request, reason),
        approvedBatch: batch,
      };
    }

    let approvedRequest = request;
    if (typeof approved === 'object' && approved !== null && approved.replacementCommand) {
      try {
        approvedRequest = replaceApprovalCommand(request, approved.replacementCommand);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (pendingSubagent) {
          Object.assign(
            batch,
            issuePermit({
              batch,
              workspace: state.workspace,
              threadId: state.threadId,
              request: pendingSubagent.request,
              grant: 'none',
            }),
          );
          return { approvedBatch: batch };
        }
        return {
          ...rejectedToolMessage(request, reason),
          approvedBatch: batch,
        };
      }
    }

    const grant = approvalGrant ?? 'approve_once';
    const nextAuthorization = applyApprovalGrant({
      authorization: state.authorization,
      grant,
      workspace: state.workspace,
      threadId: state.threadId,
      request: approvedRequest,
    });
    const approvedPolicy = evaluateToolPolicy({
      request: approvedRequest,
      workspaceAccess,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: nextAuthorization,
      override,
    });
    if (!approvedPolicy.allowed) {
      const reason = `approved command rejected by tool policy: ${approvedPolicy.reason}`;
      if (pendingSubagent) {
        Object.assign(
          batch,
          issuePermit({
            batch,
            workspace: state.workspace,
            threadId: state.threadId,
            request: pendingSubagent.request,
            grant: 'none',
          }),
        );
        return { approvedBatch: batch };
      }
      return {
        ...rejectedToolMessage(request, reason),
        approvedBatch: batch,
      };
    }

    Object.assign(
      batch,
      issuePermit({
        batch,
        workspace: state.workspace,
        threadId: state.threadId,
        request: approvedRequest,
        grant,
      }),
    );

    // full_access → auto-approve all remaining in batch
    if (grant === 'full_access') {
      const allPending = pendingSubagent
        ? [pendingSubagent.request]
        : getAllPendingToolRequests(state.messages, state.workspace);
      for (const r of allPending) {
        if (r.id && !batch[r.id]) {
          Object.assign(
            batch,
            issuePermit({
              batch,
              workspace: state.workspace,
              threadId: state.threadId,
              request: r,
              grant: 'full_access',
            }),
          );
        }
      }
    }

    return {
      approvedBatch: batch,
      approvedToolRequest: approvedRequest,
      approvedToolGrant: grant,
      authorization: nextAuthorization,
    };
  };

  /** 用户输入节点：中断等待用户选择或自由文本 / User input node
   *  从全部待处理工具中查找 ask_user——batch 中 ask_user 未必排在第一位 */
  const userInput = async (state: CodeAgentState) => {
    const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
    const request = allRequests.find((r) => r.name === 'ask_user');

    if (!request || request.name !== 'ask_user') {
      return {};
    }

    const resume = interrupt({
      kind: 'user_input',
      request,
    }) as AgentResumeValue;

    return {
      messages: [userInputToolMessage(request, resume)],
    };
  };

  /** plan review 节点：中断等待用户审查计划，支持反馈 / Plan review node: interrupt for user plan review with optional feedback
   *  从全部待处理工具中查找 update_plan——batch 中 update_plan 未必排在第一位 */
  const planReview = async (state: CodeAgentState) => {
    const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
    const request = allRequests.find((r) => r.name === 'update_plan');
    if (!request) return {};

    const planArgs = request.args as {
      name: string;
      description: string;
      status: string;
      steps: { step: string; status: string }[];
    };
    const plan: AgentPlan = {
      name: planArgs.name,
      description: planArgs.description,
      status: (planArgs.status as PlanStatus) ?? 'pending',
      steps: (planArgs.steps ?? []).map((s) => ({
        step: s.step,
        status: (s.status as PlanStatus) ?? 'pending',
      })),
    };

    // 将 scheme content 格式化为工具输出，通过 need_plan_review payload 传递给 TUI
    // Format scheme content as tool output, passed to TUI via need_plan_review payload
    const stepsText = plan.steps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
    const planSummary = `${plan.description}\n\nSteps:\n${stepsText}`;

    const resume = interrupt({
      kind: 'plan_review',
      plan,
      planSummary,
      callId: request.id,
    }) as AgentResumeValue;

    const resumeObj = resume as Record<string, unknown> | null | undefined;
    const approved =
      resume === true ||
      (typeof resume === 'object' && resume !== null && resumeObj?.planApproved === true);

    if (approved) {
      const mode = (resumeObj?.executionMode as string) === 'manual' ? 'default' : 'full_access';
      // 方案数据已在 AIMessage.tool_calls.args 中，ToolMessage 只需标记 ok + 简短摘要。
      // 重复放入完整 plan 对象会浪费 token 并降低后续调用前缀缓存命中率。
      // The plan data is already in AIMessage.tool_calls.args; ToolMessage only needs ok + brief summary.
      // Including the full plan redundantly wastes tokens and degrades prefix cache hit rates.
      return {
        messages: [
          new ToolMessage({
            content: JSON.stringify({ ok: true, stdout: planSummary.slice(0, 200) }),
            tool_call_id: request.id ?? 'missing-tool-call-id',
            name: 'update_plan',
            status: 'success',
          }),
        ],
        plan,
        planReviewed: true,
        authorization: { ...state.authorization, mode },
      };
    }

    const supplement = resumeObj?.planSupplement;
    if (typeof supplement === 'string' && supplement.length > 0) {
      return rejectedToolMessage(request, `Plan needs revision. User feedback: ${supplement}`);
    }

    return rejectedToolMessage(request, 'plan rejected by user');
  };

  /** 执行单个工具调用并返回 ToolMessage / Execute a single tool call and return ToolMessage */
  function pendingSubagentApprovalFromBlocked(
    taskCallId: string,
    blocked: NonNullable<SubAgentResult['blocked']>,
    workspace: string,
  ): CodeAgentState['pendingSubagentApproval'] {
    const request = toolRequestFromCall(
      {
        id: blocked.toolCallId,
        name: blocked.toolName,
        args: blocked.args,
      },
      workspace,
    );
    if (!request) return null;
    return {
      taskCallId,
      request,
      continuation: blocked.continuation,
    };
  }

  async function executeOneTool(
    request: import('./tool-requests').PendingToolRequest,
    state: CodeAgentState,
    grantUsed: string,
  ): Promise<{ toolMessage: ToolMessage | null; extra: Record<string, unknown> }> {
    // 构造 shell 实时输出回调（仅对 shell_execute 生效）
    const onShellProgress = input.toolProgressSink
      ? (chunk: string, stream: 'stdout' | 'stderr') => {
          input.toolProgressSink!(request.id ?? '', request.name, chunk, stream);
        }
      : undefined;

    const result = await runApprovedTool({
      workspace: state.workspace,
      request,
      shellExecutor: input.shellExecutor,
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
      authorization: state.authorization,
      approvedGrant: grantUsed as import('@/protocol/events').ShellGrantUsed,
      threadId: state.threadId,
      override,
      mcpManager: input.mcpManager,
      mcpRiskOverride,
      skillManifests: input.skills,
      skillOptions: input.skillOptions,
      signal: input.subagentSignal,
      onShellProgress,
      permitBatch: migratePermitBatch(state.approvedBatch),
      interactionMode: state.interactionMode,
      taskConfig: input.config,
      taskModel: input.model,
      subagentEventSink: input.subagentEventSink,
    });

    if (request.name === 'task' && result.subagentResult?.blocked) {
      const pending = pendingSubagentApprovalFromBlocked(
        request.id ?? 'missing-tool-call-id',
        result.subagentResult.blocked,
        state.workspace,
      );
      if (pending) {
        return {
          toolMessage: null,
          extra: { pendingSubagentApproval: pending },
        };
      }
    }

    // Flush React re-renders before dispatching tool_done, so intermediate
    // tool_progress updates (liveOutput) are rendered before status → done.
    // Only needed when this tool emitted progress events; skip otherwise.
    if (onShellProgress) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 逐个推送完成事件，TUI 在并行执行期间逐项刷新 / Push completion
    // event per-tool so TUI refreshes progressively during parallel execution.
    const summary =
      request.name === 'shell_execute' && result.exitCode === 124 && result.stdout
        ? result.stdout
        : (result.stdout || result.stderr || '').slice(0, 200);
    input.toolResultSink?.(
      request.id ?? '',
      request.name,
      result.ok !== false,
      summary,
      result.totalLines,
      undefined, // toolTokenCount computed in runner's parseToolResultEvents
      result.exitCode,
    );

    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: request.id ?? 'missing-tool-call-id',
      name: request.name,
      status: result.ok === false ? 'error' : 'success',
    });

    const extra: Record<string, unknown> = {};
    if ('plan' in result) extra.plan = result.plan;
    if ('workspaceAccess' in result) extra.workspaceAccess = result.workspaceAccess;
    if ('authorization' in result) extra.authorization = result.authorization;
    if ('activeSkillInstructions' in result)
      extra.activeSkillInstructions = result.activeSkillInstructions;

    return { toolMessage, extra };
  }

  /**
   * 清理节点：检测因中断/取消产生的孤儿 tool_calls，插入 cancelled ToolMessage。
   *
   * 当用户 ESC/Ctrl+C 取消正在执行工具的 agent 后，checkpoint 中的 AIMessage
   * 仍带有未执行的 tool_calls。resume 时若不处理，graph 会将这些孤儿 tool_calls
   * 当作"待处理"重新执行，导致：
   *   1. 安全风险：重复执行已取消的 shell 命令
   *   2. 顺序错乱：ToolMessage 被追加到新 HumanMessage 之后，导致 DeepSeek API 400 错误
   *
   * 本节点在 graph 入口处运行，为所有孤儿 tool_calls 插入 cancelled ToolMessage，
   * 使其变为"已解决"。后续路由直接跳过 tools 节点，agent 节点看到完整干净的对话历史。
   */
  const cleanup = async (state: CodeAgentState) => {
    // Collect resolved tool_call_ids from existing ToolMessages
    const resolvedIds = new Set<string>();
    for (const msg of state.messages) {
      const m = msg as unknown as Record<string, unknown>;
      if (typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0) {
        resolvedIds.add(m.tool_call_id);
      }
    }

    const cancelledToolMessages: ToolMessage[] = [];

    for (const msg of state.messages) {
      // Use field-based detection (consistent with sanitizeToolCallPairs)
      // instead of instanceof to handle checkpoint-deserialized plain objects.
      const m = msg as unknown as Record<string, unknown>;
      const toolCalls = m.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const id = (tc as Record<string, unknown>).id;
        if (!id || resolvedIds.has(id as string)) continue;

        cancelledToolMessages.push(
          new ToolMessage({
            content: JSON.stringify({ cancelled: true, reason: 'User cancelled the operation' }),
            tool_call_id: id as string,
            name: String((tc as Record<string, unknown>).name ?? 'unknown'),
            status: 'error',
          }),
        );
      }
    }

    if (cancelledToolMessages.length > 0) {
      return { messages: cancelledToolMessages, executionJournal: [], exhaustedFingerprints: {} };
    }
    return { executionJournal: [], exhaustedFingerprints: {} };
  };

  /**
   * Phase 5: 判断工具请求是否为写操作（mutation）。
   * Mutations 需串行化以保证 journal 状态正确流动；
   * Reads 可安全并行。Determine whether a tool request is a mutation. */
  function isMutationRequest(request: import('./tool-requests').PendingToolRequest): boolean {
    switch (request.name) {
      case 'write_file':
      case 'edit_file':
      case 'task':
        return true;
      case 'shell_execute': {
        const cmd = (request.args as unknown as { command: string }).command;
        const risk = classifyShellRisk(cmd);
        if (risk !== 'execute_code') return true; // known mutation pattern
        // Fallback: if classifyShellRisk didn't recognize the command, check against the
        // read-only whitelist. Commands NOT on the whitelist (e.g. sed -i, bare redirects)
        // are treated as mutations for safety — they won't slip into the reads path.
        if (!isReadOnlyShellCommand(cmd)) return true;
        return false;
      }
      default:
        return false; // read_file, search_*, read_mcp_resource, Skill, update_plan, ask_user
    }
  }

  /** Parse a ToolMessage's JSON content and update journalState via callback.
   *  For task (subagent) results, also merges the subagent's journal entries
   *  and exhausted fingerprints into the main journal. */
  function recordJournalForMessage(
    msg: ToolMessage | null,
    journalState: {
      executionJournal: import('@/core/execution/journal').ExecutionJournalEntry[];
      exhaustedFingerprints: Record<string, true>;
    },
    setJournal: (next: typeof journalState) => void,
  ): void {
    if (!msg) return;
    try {
      const parsed = JSON.parse(String(msg.content)) as {
        ok?: boolean;
        stderr?: string;
        exitCode?: number;
        path?: string;
        subagentResult?: {
          executionJournal?: import('@/core/execution/journal').ExecutionJournalEntry[];
          exhaustedFingerprints?: Record<string, true>;
        };
      };
      let next = recordExecutionResult(journalState, {
        toolCallId: (msg as unknown as Record<string, unknown>).tool_call_id?.toString() ?? '',
        toolName: msg.name ?? 'unknown',
        ok: parsed.ok !== false,
        stderr: parsed.stderr,
        exitCode: parsed.exitCode,
        path: parsed.path,
      });
      // Phase 5: Merge subagent journal entries and exhausted fingerprints.
      if (parsed.subagentResult?.executionJournal?.length) {
        next = {
          ...next,
          executionJournal: [
            ...next.executionJournal,
            ...parsed.subagentResult.executionJournal,
          ].slice(-50),
        };
      }
      if (parsed.subagentResult?.exhaustedFingerprints) {
        next = {
          ...next,
          exhaustedFingerprints: {
            ...next.exhaustedFingerprints,
            ...parsed.subagentResult.exhaustedFingerprints,
          },
        };
      }
      setJournal(next);
    } catch (e) {
      // ToolMessage content is expected to be JSON. Non-JSON content indicates
      // a tool implementation bug — warn so it's discoverable rather than silently
      // dropping the journal entry (which would let the tool retry indefinitely).
      console.warn(
        `recordJournalForMessage: failed to parse ToolMessage content for ${msg.name ?? 'unknown'}:`,
        (e as Error)?.message ?? e,
      );
    }
  }

  /** When a tool execution just exhausted a fingerprint, rebuild the ToolMessage
   *  to carry status:'exhausted' and failure.exhausted so the model sees it.
   *  The exhaustion signal is constructed explicitly from the fingerprint rather
   *  than parsed from the message content (which never contains it). */
  function injectExhaustionSignal(msg: ToolMessage, toolName: string, fp: string): ToolMessage {
    try {
      const parsed = JSON.parse(String(msg.content));
      const exhausted: import('@/core/execution/journal').ExhaustionSignal = {
        fingerprint: fp,
        consecutiveFailures: 0, // actual count unavailable; model trusts the status
        maxFailures: 0,
        suggestion: toolName === 'shell_execute' ? ('skip_step' as const) : ('replan' as const),
        reason: `Repeated failures exhausted retry limit for ${toolName}.`,
        suggestedAlternatives: ['Continue another independent step', 'Safely finalize if blocked'],
      };
      return new ToolMessage({
        content: JSON.stringify({
          ...parsed,
          status: 'exhausted',
          failure: {
            ...(parsed.failure ?? {}),
            exhausted,
            guidance:
              toolName === 'shell_execute'
                ? `Stop retrying this operation (${toolName}). Skip this step and continue other independent work.`
                : `Stop retrying this operation (${toolName}). Replan or safely finalize.`,
          },
        }),
        tool_call_id: msg.tool_call_id,
        name: msg.name,
        status: 'exhausted' as unknown as ToolMessage['status'],
      });
    } catch {
      return msg;
    }
  }

  /** 工具节点：并行执行所有待处理的工具调用。
   *  Tools node — execute all pending tool calls in parallel.
   *  Each tool completion fires toolResultSink immediately so the TUI
   *  shows progressive completion without waiting for the full batch. */
  const tools = async (state: CodeAgentState) => {
    const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
    const batch = migratePermitBatch(state.approvedBatch);

    if (state.pendingSubagentApproval) {
      const pending = state.pendingSubagentApproval;
      const request = pending.request;
      const grantUsed = request.id && batch[request.id] ? batch[request.id]!.grant : 'none';
      const onShellProgress = input.toolProgressSink
        ? (chunk: string, stream: 'stdout' | 'stderr') => {
            input.toolProgressSink!(request.id ?? '', request.name, chunk, stream);
          }
        : undefined;

      const result = await runApprovedTool({
        workspace: state.workspace,
        request,
        shellExecutor: input.shellExecutor,
        workspaceAccess: state.workspaceAccess,
        phase: state.phase,
        authorization: state.authorization,
        approvedGrant: grantUsed as import('@/protocol/events').ShellGrantUsed,
        threadId: state.threadId,
        override,
        mcpManager: input.mcpManager,
        mcpRiskOverride,
        skillManifests: input.skills,
        skillOptions: input.skillOptions,
        signal: input.subagentSignal,
        onShellProgress,
        permitBatch: batch,
        interactionMode: state.interactionMode,
        taskConfig: input.config,
        taskModel: input.model,
        subagentEventSink: input.subagentEventSink,
      });

      if (onShellProgress) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const summary =
        request.name === 'shell_execute' && result.exitCode === 124 && result.stdout
          ? result.stdout
          : (result.stdout || result.stderr || '').slice(0, 200);
      input.toolResultSink?.(
        request.id ?? '',
        request.name,
        result.ok !== false,
        summary,
        result.totalLines,
        undefined,
        result.exitCode,
      );

      const baseJournal = recordExecutionResult(
        {
          executionJournal: state.executionJournal ?? [],
          exhaustedFingerprints: state.exhaustedFingerprints ?? {},
        },
        {
          toolCallId: request.id ?? '',
          toolName: request.name,
          ok: result.ok !== false,
          stderr: result.stderr,
          exitCode: result.exitCode,
          path: result.path,
        },
      );

      // 审批被拒时，修改 stderr 告诉子 agent 不要重试同一工具
      // When approval was rejected, rewrite stderr so the sub-agent knows to try alternatives
      const resumeResult =
        grantUsed === 'none' && result.status === 'rejected'
          ? {
              ...result,
              stderr: `The user rejected this ${request.name} call. Try a completely different approach — use alternative tools, different arguments, or explain why the task cannot be completed.`,
            }
          : result;

      const resumed = await resumeSubAgent(
        {
          config: input.config,
          workspace: state.workspace,
          role: pending.continuation.role,
          task: pending.continuation.task,
          shellExecutor: input.shellExecutor,
          mcpManager: input.mcpManager,
          skills: input.skills,
          skillOptions: input.skillOptions,
          authorization: state.authorization,
          workspaceAccess: state.workspaceAccess,
          phase: state.phase,
          threadId: state.threadId,
          timeoutMs: 30 * 60 * 1000,
          signal: input.subagentSignal ?? new AbortController().signal,
          eventSink:
            input.subagentEventSink ??
            (((_event: unknown) => {}) as import('@/core/subagent/types').SubAgentEventSink),
          model: input.model,
          depth: 1,
          maxDepth: 0,
        },
        pending.continuation,
        {
          toolCallId: request.id ?? '',
          toolName: request.name,
          result: resumeResult,
        },
      );

      let journalState = baseJournal;

      // Phase 5: Merge subagent journal into main journal state.
      if (resumed.executionJournal?.length) {
        journalState = {
          ...journalState,
          executionJournal: [...journalState.executionJournal, ...resumed.executionJournal].slice(
            -50,
          ),
        };
      }
      if (resumed.exhaustedFingerprints) {
        journalState = {
          ...journalState,
          exhaustedFingerprints: {
            ...journalState.exhaustedFingerprints,
            ...resumed.exhaustedFingerprints,
          },
        };
      }

      if (resumed.blocked) {
        const nextPending = pendingSubagentApprovalFromBlocked(
          pending.taskCallId,
          resumed.blocked,
          state.workspace,
        );
        if (nextPending) {
          return {
            approvedBatch: {},
            approvedToolRequest: null,
            approvedToolGrant: null,
            pendingSubagentApproval: nextPending,
            ...journalState,
          };
        }
      }

      const taskMessage = new ToolMessage({
        content: JSON.stringify(resumed),
        tool_call_id: pending.taskCallId,
        name: 'task',
        status: resumed.ok === false ? 'error' : 'success',
      });

      return {
        approvedBatch: {},
        approvedToolRequest: null,
        approvedToolGrant: null,
        pendingSubagentApproval: null,
        ...journalState,
        messages: [taskMessage],
      };
    }

    if (allRequests.length === 0) {
      return { approvedBatch: {} };
    }

    // Phase 5: 写操作串行化 — 同批次 reads 并行，mutations 逐个执行。
    // Reads execute in parallel; mutations execute sequentially so journal state
    // (exhaustedFingerprints) flows between steps and prevents stale preflight checks.
    // Mutation serialization — reads parallel, mutations one at a time.
    const reads = allRequests.filter((req) => !isMutationRequest(req));
    const mutations = allRequests.filter((req) => isMutationRequest(req));

    const messages: ToolMessage[] = [];
    const mergedExtra: Record<string, unknown> = {};
    let journalState = {
      executionJournal: state.executionJournal ?? [],
      exhaustedFingerprints: { ...(state.exhaustedFingerprints ?? {}) },
    };

    // Phase 1: Execute read tools sequentially with per-iteration preflight.
    // Each read's journal update flows into the next iteration's preflight check,
    // so exhaustion triggered mid-batch blocks subsequent reads BEFORE they execute.
    // (Previously reads executed in parallel via Promise.all, which meant all N
    // reads ran before the journal was updated — exhaustion at position 5+N
    // couldn't block reads 6..N that had already started.)
    for (const req of reads) {
      const preflightPath = (req.args as Record<string, unknown>).path as string | undefined;
      if (isFingerprintExhausted(journalState.exhaustedFingerprints, req.name, preflightPath)) {
        const blockedMsg = new ToolMessage({
          content: JSON.stringify({
            ok: false,
            command: req.protectedCommand,
            exitCode: -1,
            stdout: '',
            stderr: `Execution blocked: too many repeated failures for ${req.name}${preflightPath ? ` on ${preflightPath}` : ''}.`,
            status: 'exhausted' as const,
            failure: {
              message: 'Tool execution failed.' as const,
              tool: req.name,
              reason: `Execution blocked by exhaustion guard for ${req.name}.`,
              guidance: 'Stop retrying this operation. Skip this step, replan, or safely finalize.',
            },
          }),
          tool_call_id: req.id ?? 'missing-tool-call-id',
          name: req.name,
          status: 'exhausted' as unknown as ToolMessage['status'],
        });
        messages.push(blockedMsg);
        input.toolResultSink?.(
          req.id ?? '',
          req.name,
          false,
          `Execution blocked: too many repeated failures for ${req.name}${preflightPath ? ` on ${preflightPath}` : ''}.`,
          undefined,
          undefined,
          -1,
          'exhausted',
        );
        continue;
      }

      const reqGrant = req.id && batch[req.id] ? batch[req.id]!.grant : 'none';
      const r = await executeOneTool(req, state, reqGrant);

      if (r.toolMessage) {
        const journalBefore = { ...journalState.exhaustedFingerprints };
        recordJournalForMessage(r.toolMessage, journalState, (next) => {
          journalState = next;
        });
        // Check whether this execution just exhausted a NEW fingerprint.
        const newExhaustedFp = Object.keys(journalState.exhaustedFingerprints).find(
          (fp) => !journalBefore[fp],
        );
        if (newExhaustedFp) {
          r.toolMessage = injectExhaustionSignal(
            r.toolMessage,
            (r.toolMessage as ToolMessage).name ?? 'unknown',
            newExhaustedFp,
          );
          // Override the earlier toolResultSink (from executeOneTool, Path A)
          // which reported plain ok=false. The TUI needs status:'exhausted'
          // to render the amber dot and notification text block.
          const toolName = (r.toolMessage as ToolMessage).name ?? 'unknown';
          const callId = ((r.toolMessage as ToolMessage).tool_call_id as string) || '';
          input.toolResultSink?.(
            callId,
            toolName,
            false,
            `Execution blocked: too many repeated failures for ${toolName}.`,
            undefined,
            undefined,
            -1,
            'exhausted',
          );
        }
        messages.push(r.toolMessage);
      }
      Object.assign(mergedExtra, r.extra);
    }

    // Phase 2: Execute mutations sequentially — journal state flows between steps.
    // This ensures an exhaustion triggered by mutation N blocks mutation N+1's preflight.
    const sequentialState = { ...state, ...journalState };
    for (const req of mutations) {
      // Preflight: check if this tool+path fingerprint is already exhausted.
      const preflightPath = (req.args as Record<string, unknown>).path as string | undefined;
      if (isFingerprintExhausted(journalState.exhaustedFingerprints, req.name, preflightPath)) {
        const blockedMsg = new ToolMessage({
          content: JSON.stringify({
            ok: false,
            command: req.protectedCommand,
            exitCode: -1,
            stdout: '',
            stderr: `Execution blocked: too many repeated failures for ${req.name}${preflightPath ? ` on ${preflightPath}` : ''}.`,
            status: 'exhausted' as const,
            failure: {
              message: 'Tool execution failed.' as const,
              tool: req.name,
              reason: `Execution blocked by exhaustion guard for ${req.name}.`,
              guidance: 'Stop retrying this operation. Skip this step, replan, or safely finalize.',
            },
          }),
          tool_call_id: req.id ?? 'missing-tool-call-id',
          name: req.name,
          status: 'exhausted' as unknown as ToolMessage['status'],
        });
        messages.push(blockedMsg);
        input.toolResultSink?.(
          req.id ?? '',
          req.name,
          false,
          `Execution blocked: too many repeated failures for ${req.name}${preflightPath ? ` on ${preflightPath}` : ''}.`,
          undefined,
          undefined,
          -1,
          'exhausted',
        );
        continue;
      }

      const reqGrant = req.id && batch[req.id] ? batch[req.id]!.grant : 'none';
      const r = await executeOneTool(req, sequentialState, reqGrant);

      if (r.toolMessage) {
        // Update journal — if a new fingerprint was just exhausted, inject the signal.
        const journalBefore = { ...journalState.exhaustedFingerprints };
        recordJournalForMessage(r.toolMessage, journalState, (next) => {
          journalState = next;
        });
        // Check whether this execution just exhausted a NEW fingerprint.
        const newExhaustedFp = Object.keys(journalState.exhaustedFingerprints).find(
          (fp) => !journalBefore[fp],
        );
        if (newExhaustedFp) {
          // Rebuild ToolMessage with exhaustion signal so the model sees it immediately.
          r.toolMessage = injectExhaustionSignal(r.toolMessage, req.name, newExhaustedFp);
          // Override the earlier toolResultSink (from executeOneTool, Path A)
          // which reported plain ok=false. The TUI needs status:'exhausted'.
          input.toolResultSink?.(
            req.id ?? '',
            req.name,
            false,
            `Execution blocked: too many repeated failures for ${req.name}.`,
            undefined,
            undefined,
            -1,
            'exhausted',
          );
        }
        messages.push(r.toolMessage);
      }
      Object.assign(mergedExtra, r.extra);
      // Flow updated journal into state for the next mutation iteration.
      Object.assign(sequentialState, journalState);
    }

    return {
      approvedBatch: {},
      approvedToolRequest: null,
      approvedToolGrant: null,
      ...mergedExtra,
      ...journalState,
      messages,
    };
  };

  const graph = new StateGraph(AgentState)
    .addNode('cleanup', cleanup)
    .addNode('agent', agent)
    .addNode('approval', approval)
    .addNode('user_input', userInput)
    .addNode('plan_review', planReview)
    .addNode('tools', tools)
    .addEdge(START, 'cleanup')
    .addConditionalEdges('cleanup', (state: CodeAgentState) =>
      routeEntry(state, override, mcpRiskOverride),
    )
    .addConditionalEdges('agent', (state: CodeAgentState) =>
      routeAfterAgent(state, override, mcpRiskOverride),
    )
    .addConditionalEdges('approval', routeAfterApproval)
    .addConditionalEdges('user_input', routeAfterUserInput)
    .addConditionalEdges('plan_review', routeAfterPlanReview)
    .addConditionalEdges('tools', routeAfterTools)
    .compile({ checkpointer });

  return { graph, checkpointer };
}

/** 检查模型是否支持 RetryListener / Check if model supports RetryListener */
function hasRetryListener(
  model: SupportedChatModel,
): model is SupportedChatModel & RetryListenerHost {
  return (
    'setRetryListener' in model &&
    typeof (model as { setRetryListener: unknown }).setRetryListener === 'function'
  );
}

/** 将 override 同步到 state.authorization / Sync override to state.authorization */
function authorizationForState(
  state: CodeAgentState,
  override?: AuthorizationOverride,
): ThreadAuthorizationState {
  const base = normalizeAuthorizationState(state.authorization);
  if (override && override.current !== base.mode) {
    return { ...base, mode: override.current };
  }
  return base;
}

/** invokeModel 参数 / invokeModel parameters (exported for testing) */
export interface InvokeModelParams {
  model: ReturnType<typeof createChatModel>;
  state: CodeAgentState;
  tools: ReturnType<typeof createAgentTools>;
  skills?: import('@/core/skills/types').SkillManifest[];
  signal?: AbortSignal;
}

/** invokeModel 返回值 / Return value of invokeModel */
export interface InvokeModelResult {
  /** 图中其他节点可消费的状态更新 / State update consumed by other graph nodes */
  state: Record<string, unknown>;
}

/** 共享的模型调用逻辑 / Shared model invocation logic (exported for testing) */
export async function invokeModel({
  model,
  state,
  tools,
  skills,
  signal,
}: InvokeModelParams): Promise<InvokeModelResult> {
  const prepared = prepareModelContext('agent', state, skills);

  const response = (await bindAgentTools(model, tools).invoke(prepared.messages, {
    signal,
  })) as AIMessage;

  // 处理 invalid_tool_calls：LLM 偶尔生成不合法的 JSON arguments，
  // parseToolCall 失败后这些调用被放入 invalid_tool_calls 而非 tool_calls。
  // 若不加处理：(1) graph 看不到 tool_calls → 不执行 → 无 ToolMessage，
  // (2) additional_kwargs.tool_calls 残留 → 下轮 fallback 到 API → 400 错误。
  //
  // 处理 invalid_tool_calls：为每个解析失败的调用创建合成 tool_calls 条目，
  // 携带原始参数标记 _raw_invalid_args。不在此处创建 ToolMessage——
  // 让合成条目保持"未解决"状态，graph 会路由到 tools 节点，
  // runApprovedTool 检测到标记后生成工具特定的错误反馈。
  // tools 节点结束后自动路由回 agent，模型立刻看到错误并重试。
  //
  // Handle invalid_tool_calls: create synthetic tool_calls entries with
  // _raw_invalid_args marker. No ToolMessage here — keep them unresolved
  // so the graph routes to tools → runApprovedTool detects the marker
  // and creates error feedback → routes back to agent → model retries.
  const invalidCalls = response.invalid_tool_calls;
  if (Array.isArray(invalidCalls) && invalidCalls.length > 0) {
    const syntheticToolCalls = invalidCalls.map((tc) => ({
      id: (tc.id as string) ?? `invalid-${crypto.randomUUID()}`,
      name: (tc.name as string) ?? 'unknown',
      args: {
        _raw_invalid_args: tc.args,
        _parse_error: tc.error,
      },
      type: 'tool_call' as const,
    }));

    // 清理 additional_kwargs.tool_calls 防止 LangChain converter
    // fallback 发送残留原始数据到 API（触发 400）。
    const cleanAkw = { ...((response.additional_kwargs ?? {}) as Record<string, unknown>) };
    delete cleanAkw.tool_calls;

    return {
      state: {
        workspaceAccess: state.workspaceAccess,
        phase: state.phase,
        approvedToolRequest: state.approvedToolRequest,
        approvedToolGrant: state.approvedToolGrant,
        authorization: state.authorization,
        messages: [
          new AIMessage({
            id: response.id,
            content: response.content,
            tool_calls: [...(response.tool_calls ?? []), ...syntheticToolCalls],
            invalid_tool_calls: [],
            additional_kwargs: cleanAkw,
            response_metadata: response.response_metadata,
            usage_metadata: response.usage_metadata,
          }),
        ],
      },
    };
  }

  const request = toolRequestFromMessage(response, state.workspace);
  if (request) {
    return {
      state: {
        workspaceAccess: state.workspaceAccess,
        phase: state.phase,
        approvedToolRequest: state.approvedToolRequest,
        approvedToolGrant: state.approvedToolGrant,
        authorization: state.authorization,
        messages: [response],
      },
    };
  }

  return {
    state: {
      workspaceAccess: state.workspaceAccess,
      phase: state.phase,
      approvedToolRequest: state.approvedToolRequest,
      approvedToolGrant: state.approvedToolGrant,
      authorization: state.authorization,
      final: messageText(response),
      messages: [response],
    },
  };
}

/** 绑定模型工具，按 provider adapter 传入其支持的调用参数 / Bind tools with provider-supported call options */
function bindAgentTools(
  model: ReturnType<typeof createChatModel>,
  tools: ReturnType<typeof createAgentTools>,
) {
  if (model instanceof ChatOllama) {
    return model.bindTools(tools);
  }
  return model.bindTools(tools, { tool_choice: 'auto' });
}

function approvalGrantFromResume(
  resume: boolean | { grant?: ShellApprovalGrant } | null | undefined,
): ShellApprovalGrant | null {
  if (resume === true) {
    return 'approve_once';
  }
  if (
    resume &&
    typeof resume === 'object' &&
    (resume.grant === 'approve_once' ||
      resume.grant === 'same_command' ||
      resume.grant === 'full_access')
  ) {
    return resume.grant;
  }
  return null;
}

function rejectedToolMessage(
  request: NonNullable<ReturnType<typeof getPendingToolRequest>>,
  reason: string,
) {
  return {
    messages: [
      new ToolMessage({
        content: JSON.stringify({
          ok: false,
          rejected: true,
          reason,
        }),
        tool_call_id: request.id ?? 'missing-tool-call-id',
        name: request.name,
        status: 'error',
      }),
    ],
  };
}
