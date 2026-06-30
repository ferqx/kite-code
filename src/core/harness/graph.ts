import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { interrupt, START, StateGraph } from '@langchain/langgraph';
import { ChatOllama } from '@langchain/ollama';
import type { AgentConfig } from '@/core/config/index';
import type { McpManager } from '@/core/mcp';
import { prepareModelContext } from '@/core/model/context';
import type { ModelRetryListener, RetryListenerHost } from '@/core/model/deepseek';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import { BunSqliteSaver } from '@/core/persistence/checkpoint';
import { createTaskTool } from '@/core/subagent/task-tool';
import { createAgentTools } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ModelRetryEvent,
  ThreadAuthorizationState,
} from '@/core/types';
import type { AgentPlan, PlanStatus, ShellApprovalGrant } from '@/protocol/events';
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
      };
      if (retryEvents.length > 0) {
        return { ...baseReturn, modelRetries: retryEvents };
      }
      return baseReturn;
    } finally {
      if (hasRetryListener(model)) model.setRetryListener(null);
    }
  };

  /** 审批节点：中断等待人工批准，支持批量积累 / Approval node with batch accumulation */
  const approval = async (state: CodeAgentState) => {
    const batch = { ...state.approvedBatch };
    const hasFullAccess = Object.values(batch).some((g) => g === 'full_access');

    // 查找第一个尚未审批的待处理工具（跳过已在 batch 中的）
    const allPending = getAllPendingToolRequests(state.messages, state.workspace);
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
        if (r.id) batch[r.id] = 'full_access';
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
      if (request.id) batch[request.id] = 'approve_once';
      return { approvedBatch: batch, approvedToolRequest: null, approvedToolGrant: null };
    }

    const approvalPayload = buildToolApproval({
      workspace: state.workspace,
      threadId: state.threadId,
      request,
      decision: policy,
    });

    const approved = interrupt({
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
      return {
        ...rejectedToolMessage(
          request,
          hashMismatch
            ? 'approved request does not match current tool request'
            : typeof approved === 'object' && approved !== null
              ? (approved.reason ?? 'not approved')
              : 'not approved',
        ),
        approvedBatch: batch,
      };
    }

    let approvedRequest = request;
    if (typeof approved === 'object' && approved !== null && approved.replacementCommand) {
      try {
        approvedRequest = replaceApprovalCommand(request, approved.replacementCommand);
      } catch (error) {
        return {
          ...rejectedToolMessage(request, error instanceof Error ? error.message : String(error)),
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
      return {
        ...rejectedToolMessage(
          request,
          `approved command rejected by tool policy: ${approvedPolicy.reason}`,
        ),
        approvedBatch: batch,
      };
    }

    if (approvedRequest.id)
      batch[approvedRequest.id] = grant as 'approve_once' | 'same_command' | 'full_access';

    // full_access → auto-approve all remaining in batch
    if (grant === 'full_access') {
      const allPending = getAllPendingToolRequests(state.messages, state.workspace);
      for (const r of allPending) {
        if (r.id && !batch[r.id]) batch[r.id] = 'full_access';
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
  async function executeOneTool(
    request: import('./tool-requests').PendingToolRequest,
    state: CodeAgentState,
    grantUsed: string,
  ): Promise<{ toolMessage: ToolMessage; extra: Record<string, unknown> }> {
    // Handle task tool (sub-agent dispatch)
    if (request.name === 'task' && input.subagentEventSink) {
      try {
        const taskTool = createTaskTool({
          config: input.config,
          workspace: state.workspace,
          shellExecutor: input.shellExecutor,
          mcpManager: input.mcpManager,
          skills: input.skills,
          skillOptions: input.skillOptions,
          eventSink: input.subagentEventSink,
          signal: input.subagentSignal,
          model: input.model,
        });
        const toolOutput = await taskTool.invoke(request.args);
        let taskOk = true;
        try {
          const p = JSON.parse(toolOutput);
          taskOk = p.ok !== false;
        } catch {}
        return {
          toolMessage: new ToolMessage({
            content: toolOutput,
            tool_call_id: request.id ?? 'missing-tool-call-id',
            name: request.name,
            status: taskOk ? 'success' : 'error',
          }),
          extra: {},
        };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          toolMessage: new ToolMessage({
            content: JSON.stringify({ ok: false, error: errorMsg }),
            tool_call_id: request.id ?? 'missing-tool-call-id',
            name: request.name,
            status: 'error',
          }),
          extra: {},
        };
      }
    }

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
    });

    // Flush React re-renders before dispatching tool_done, so intermediate
    // tool_progress updates (liveOutput) are rendered before status → done.
    // Only needed when this tool emitted progress events; skip otherwise.
    if (onShellProgress) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 逐个推送完成事件，TUI 在并行执行期间逐项刷新 / Push completion
    // event per-tool so TUI refreshes progressively during parallel execution.
    input.toolResultSink?.(
      request.id ?? '',
      request.name,
      result.ok !== false,
      (result.stdout || result.stderr || '').slice(0, 200),
      result.totalLines,
      undefined, // toolTokenCount computed in runner's parseToolResultEvents
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
      return { messages: cancelledToolMessages };
    }
    return {};
  };

  /** 工具节点：并行执行所有待处理的工具调用。
   *  Tools node — execute all pending tool calls in parallel.
   *  Each tool completion fires toolResultSink immediately so the TUI
   *  shows progressive completion without waiting for the full batch. */
  const tools = async (state: CodeAgentState) => {
    const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
    const batch = state.approvedBatch ?? {};

    if (allRequests.length === 0) {
      return { approvedBatch: {} };
    }

    // 所有工具（含 task/子 agent）放入同一个 Promise.all，真正并行执行。
    // All tools (including task sub-agents) in a single Promise.all.
    const results = await Promise.all(
      allRequests.map((req) => {
        const reqGrant = req.id && batch[req.id] ? batch[req.id]! : 'none';
        return executeOneTool(req, state, reqGrant);
      }),
    );

    const messages: ToolMessage[] = results.map((r) => r.toolMessage);
    const mergedExtra: Record<string, unknown> = {};
    for (const r of results) {
      Object.assign(mergedExtra, r.extra);
    }

    return {
      approvedBatch: {},
      approvedToolRequest: null,
      approvedToolGrant: null,
      ...mergedExtra,
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
