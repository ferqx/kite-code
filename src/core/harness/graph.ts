import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { interrupt, START, StateGraph } from '@langchain/langgraph';
import { ChatOllama } from '@langchain/ollama';
import type { AgentConfig } from '@/core/config/index';
import {
  autoApproveAllWithFullAccess,
  finalizeApproval,
  handleApprovalResume,
  handleAutoReviewResult,
  normalizeApprovalResume,
} from '@/core/controllers/approval-controller';
import { runAutoReview } from '@/core/controllers/auto-review-controller';
import { invokeAgentModel } from '@/core/controllers/model-controller';
import { handlePlanReview } from '@/core/controllers/plan-review-controller';
import { executeTool, preflightExhaustionCheck } from '@/core/controllers/tool-controller';
import { handleUserInput } from '@/core/controllers/user-input-controller';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  evaluateCircuitBreaker,
  type RejectionEntry,
} from '@/core/execution/circuit-breaker';
import { checkDoomLoop, updateDoomLoopTracker } from '@/core/execution/doom-loop';
import {
  injectExhaustionSignal,
  recordExecutionResult,
  recordJournalForMessage,
} from '@/core/execution/journal';
import { issuePermit, migratePermitBatch } from '@/core/execution/permit';
import type { ReviewContext } from '@/core/execution/reviewer';
import type { McpManager } from '@/core/mcp';
import { prepareModelContext } from '@/core/model/context';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import { BunSqliteSaver } from '@/core/persistence/checkpoint';
import { evaluateToolApproval } from '@/core/policies/approval-policy';
import { evaluateSafetyFastPath } from '@/core/policies/auto-review-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import { isPlanProgressOnlyUpdate } from '@/core/policies/plan-policy';
import type { RuntimeEvent } from '@/core/runtime/events';
import { computePlanStructuralHash } from '@/core/runtime/hashes';
import { genInteractionId } from '@/core/runtime/ids';
import { resumeSubAgent } from '@/core/subagent/runner';
import type { SubAgentResult } from '@/core/subagent/types';
import { type createAgentTools, isReadOnlyShellCommand } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';
import type {
  AgentResumeValue,
  AuthorizationOverride,
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
  classifyShellRisk,
  defaultPhaseForWorkspaceAccess,
  normalizeAuthorizationState,
  replaceApprovalCommand,
} from './tool-policy';
import {
  getAllPendingToolRequests,
  type getPendingToolRequest,
  messageText,
  toolRequestFromCall,
  toolRequestFromMessage,
} from './tool-requests';
import { runApprovedTool } from './tool-runner';

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
  /** 工具进度回调 — shell 进程产生输出时逐行调用，使 TUI 实时展示。
   *  Per-line progress callback — called for each stdout/stderr line during
   *  shell execution, so the TUI shows live output. */
  toolProgressSink?: (
    callId: string,
    toolName: string,
    chunk: string,
    stream: 'stdout' | 'stderr',
  ) => void;
  /** 运行时事件回调 — 图节点产出的 RuntimeEvent 通过此回调经投影函数
   *  转换为 AgentEvent 后推入 TUI。Graph nodes emit RuntimeEvent through this
   *  sink; the projection function converts them to AgentEvent for the TUI. */
  runtimeEventSink?: (event: import('@/core/runtime/events').RuntimeEvent) => void;
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

  /** 发出 RuntimeEvent 的辅助函数 — 封装 runtimeEventSink 调用，调用方可
   *  在工具完成或交互事件发生时调用。调用前自动检查 runtimeEventSink 是否存在。 */
  function emitRuntimeEvent(event: RuntimeEvent): void {
    input.runtimeEventSink?.(event);
  }

  // LangGraph 节点在 interrupt() 恢复时会从顶部重放，导致 interrupt 前
  // 的 RuntimeEvent（*.requested）被重复发射。用 toolCallId + eventType
  // 作为复合去重 key 防止 TUI 收到重复的 need_input / need_approval / need_plan_review，
  // 同时允许同一 toolCallId 的不同事件类型各自发射。
  //
  // LangGraph nodes replay from the top on interrupt() resume, causing
  // RuntimeEvents before interrupt() to be re-emitted. Dedup using
  // composite key (toolCallId + eventType) to prevent duplicate TUI
  // interrupt blocks while allowing different event types for the same tool.
  const emittedInterruptEvents = new Set<string>();
  function emitInterruptEvent(event: RuntimeEvent, toolCallId: string): void {
    if (!toolCallId) return;
    const dedupKey = `${toolCallId}:${event.type}`;
    if (emittedInterruptEvents.has(dedupKey)) return;
    emittedInterruptEvents.add(dedupKey);
    input.runtimeEventSink?.(event);
  }

  /** Agent 节点：委托 ModelController 处理工具创建 + 模型调用 / Agent node delegates to ModelController */
  const agent = async (state: CodeAgentState) => {
    const { result, retryEvents } = await invokeAgentModel({
      model,
      state,
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
      config: input.config,
      subagentEventSink: input.subagentEventSink,
      subagentSignal: input.subagentSignal,
      runtimeEventSink: emitRuntimeEvent,
    });

    const syncedAuth = authorizationForState(state, override);
    const modelConfigState = {
      modelProvider: input.config.providerName,
      modelName: input.config.modelName,
      thinkingLevel: input.thinkingLevel ?? null,
    };
    const baseReturn = {
      ...result.state,
      ...modelConfigState,
      authorization: syncedAuth,
      executionJournal: state.executionJournal,
      exhaustedFingerprints: state.exhaustedFingerprints,
      interactionMode: state.interactionMode,
      plan: state.plan,
      planReviewed: state.planReviewed,
      autoReviewState: state.autoReviewState,
      doomLoopTracker: state.doomLoopTracker,
    };
    if (retryEvents && retryEvents.length > 0) {
      return { ...baseReturn, modelRetries: retryEvents };
    }
    return baseReturn;
  };

  /** 统一的子 agent 工具拒绝处理 — 合并 approval 节点中 5 处 copy-paste 的拒绝路径。
   *  Unified sub-agent tool rejection — consolidates 5 copy-pasted rejection paths in the approval node. */
  function rejectSubagentTool(
    batch: ReturnType<typeof migratePermitBatch>,
    pending: NonNullable<CodeAgentState['pendingSubagentApproval']>,
    workspace: string,
    threadId: string,
    opts?: {
      doomLoopNext?: Record<string, { count: number; lastSeenAt: number }>;
      autoReviewState?: import('@/core/execution/circuit-breaker').AutoReviewState;
      planReviewed?: boolean;
    },
  ): Partial<CodeAgentState> {
    Object.assign(
      batch,
      issuePermit({
        batch,
        workspace,
        threadId,
        request: pending.request,
        grant: 'none',
      }),
    );
    const result: Partial<CodeAgentState> = { approvedBatch: batch };
    if (opts?.doomLoopNext) result.doomLoopTracker = opts.doomLoopNext;
    if (opts?.autoReviewState) result.autoReviewState = opts.autoReviewState;
    if (opts?.planReviewed !== undefined) result.planReviewed = opts.planReviewed;
    return result;
  }

  /** 审批节点：中断等待人工批准，支持批量积累 / Approval node with batch accumulation */
  const approval = async (state: CodeAgentState) => {
    const batch = migratePermitBatch(state.approvedBatch);
    const pendingSubagent = state.pendingSubagentApproval;
    const mode = (state.interactionMode ?? 'ask') as 'ask' | 'auto' | 'full';
    const modePolicy = createModePolicy(mode);
    // Full mode denies user interaction → grants blanket tool access
    const modeGrantsFullAccess =
      modePolicy.shouldAskUser({
        interactionMode: mode,
        phase: (state.phase ?? 'building') as 'planning' | 'building',
        planKind: 'none',
        toolName: 'read_file',
        toolArgs: {},
        toolRisk: 'read',
        approvalCached: false,
        sandboxAvailable: true,
        doomLoopCount: 0,
        circuitBreakerTripped: false,
      }).kind === 'deny';
    const hasFullAccess =
      modeGrantsFullAccess ||
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
      return { plan: state.plan, planReviewed: state.planReviewed };
    }

    // full_access 已授权 → 自动批准剩余所有工具 / full_access already granted → auto-approve all remaining
    if (hasFullAccess) {
      autoApproveAllWithFullAccess({
        batch,
        allPending,
        workspace: state.workspace,
        threadId: state.threadId,
      });
      return {
        approvedBatch: batch,
        approvedToolRequest: null,
        approvedToolGrant: null,
        plan: state.plan,
        planReviewed: state.planReviewed,
      };
    }

    const policy = evaluateToolApproval({
      toolName: request.name,
      toolArgs: request.args as Record<string, unknown>,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(state.workspaceAccess ?? 'write'),
      workspace: state.workspace ?? '',
      threadId: state.threadId ?? '',
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
      return {
        approvedBatch: batch,
        approvedToolRequest: null,
        approvedToolGrant: null,
        plan: state.plan,
        planReviewed: state.planReviewed,
      };
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
        }
      | undefined;
    let autoReviewFailureReason: string | null = null;
    let autoReviewRejectionRecord:
      | import('@/core/execution/circuit-breaker').AutoReviewState
      | null = null;
    let doomLoopTrackerNext = state.doomLoopTracker;
    const interactionId = genInteractionId();
    if (
      modePolicy.shouldAutoReview({
        interactionMode: mode,
        phase: (state.phase ?? 'building') as 'planning' | 'building',
        planKind: 'none',
        toolName: request.name,
        toolArgs: request.args as Record<string, unknown>,
        toolRisk: policy.risk,
        approvalCached: false,
        sandboxAvailable: true,
        doomLoopCount: Object.values(state.doomLoopTracker).reduce((sum, d) => sum + d.count, 0),
        circuitBreakerTripped: state.autoReviewState.circuitBreakerTripped,
      }).kind === 'need_auto_review'
    ) {
      // 构建审查上下文 / Build review context
      const reviewContext: ReviewContext = {
        userTask: extractUserTask(state.messages),
        planSummary: state.plan
          ? `Plan: ${state.plan.name} — ${state.plan.description}\nSteps: ${state.plan.steps.map((s) => `[${s.status}] ${s.step}`).join('; ')}`
          : undefined,
        recentRejections: (state.autoReviewState.rejectionHistory ?? [])
          .slice(-5)
          .map((r) => ({ toolName: r.toolName, reason: r.reason, timestamp: r.timestamp })),
        isSubAgent: !!pendingSubagent,
        subAgentRole: pendingSubagent?.continuation.role as string | undefined,
        workspaceRoot: state.workspace,
      };

      // Doom-loop 检测
      // 注意：仅对被拒绝的工具递增计数器。并发批次的工具调用（如多个 edit_file
      // 同时修改不同位置）不应算作 doom-loop——doom-loop 仅检测跨 turn 的重复失败。
      // 同批次内通过审批的工具不递增计数，避免误判。
      // Note: only increment the counter for REJECTED tools. Concurrent batch calls
      // (e.g. multiple edit_file targeting different positions) are NOT a doom-loop.
      // Doom-loop detection guards against across-turn repeated failures only.
      const doomThreshold = input.config.autoReview?.doomLoopRepeatThreshold ?? 3;
      const doomCheck = checkDoomLoop(state.doomLoopTracker, request, doomThreshold, 60_000);
      if (doomCheck.blocked) {
        console.warn(`[auto-review] doom-loop BLOCKED: ${doomCheck.reason} — tool=${request.name}`);
        if (!pendingSubagent) {
          emitInterruptEvent(
            {
              type: 'approval.requested',
              interactionId,
              toolCallId: request.id ?? '',
              approval: {
                ...approvalPayload,
                doomLoopDetected: true,
                doomLoopReason: doomCheck.reason,
              } as unknown as import('@/protocol/events').ToolApprovalPayload,
            },
            request.id ?? '',
          );
          approved = interrupt({
            kind: 'tool_approval',
            request,
            policy,
            interactionId,
            approval: {
              ...approvalPayload,
              doomLoopDetected: true,
              doomLoopReason: doomCheck.reason,
            },
          }) as typeof approved;
        } else {
          return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
            doomLoopNext: updateDoomLoopTracker(state.doomLoopTracker, doomCheck.fingerprint!),
            planReviewed: state.planReviewed,
          });
        }
      }
      // 暂不在此处递增——等 auto-review 结果出来后再决定是否计入
      // Defer increment — only count rejected calls (see auto-review result handling below)

      // _safety fast-path routing — delegate to policy layer (pure logic, no side effects)
      const safetyResult = evaluateSafetyFastPath({
        agentSafety: (request.args as Record<string, unknown>)._safety as
          | 'safe'
          | 'caution'
          | 'dangerous'
          | undefined,
        toolRisk: policy.risk as string,
        circuitBreakerTripped: state.autoReviewState.circuitBreakerTripped,
      });

      if (safetyResult.kind === 'auto_approve') {
        console.warn(`[auto-review] FAST PATH: _safety=safe, risk=${policy.risk} — auto-approving`);
        approved = {
          approved: true,
          grant: safetyResult.grant,
          approvalHash: approvalPayload.approvalHash,
          reason: safetyResult.reason,
        };
        autoReviewRejectionRecord = {
          pendingWarnings: {},
          consecutiveRejects: 0,
          rejectionHistory: state.autoReviewState.rejectionHistory,
          circuitBreakerTripped: false,
        };
      } else if (safetyResult.kind === 'force_deny') {
        // Belt-and-suspenders override — execution concerns (circuit breaker, doom-loop) stay in graph.ts
        console.warn('[auto-review] OVERRIDE: _safety=safe but risk=destructive — denying');
        const overrideEntry: RejectionEntry = {
          timestamp: Date.now(),
          toolName: request.name,
          reason: safetyResult.reason,
        };
        const overrideCbConfig = {
          ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
          maxRejections:
            input.config.autoReview?.circuitBreakerMaxRejections ??
            DEFAULT_CIRCUIT_BREAKER_CONFIG.maxRejections,
          windowMs:
            input.config.autoReview?.circuitBreakerWindowMs ??
            DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs,
        };
        const overrideCbResult = evaluateCircuitBreaker(
          state.autoReviewState.consecutiveRejects,
          state.autoReviewState.rejectionHistory.map((r) => ({
            timestamp: r.timestamp,
            toolName: r.toolName,
            reason: r.reason,
          })),
          overrideCbConfig,
          true,
          overrideEntry,
        );
        doomLoopTrackerNext = updateDoomLoopTracker(state.doomLoopTracker, doomCheck.fingerprint!);
        autoReviewRejectionRecord = {
          pendingWarnings: {},
          consecutiveRejects: overrideCbResult.newConsecutiveRejects,
          rejectionHistory: overrideCbResult.newRejectionHistory,
          circuitBreakerTripped: overrideCbResult.tripped,
        };
        if (pendingSubagent) {
          return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
            doomLoopNext: doomLoopTrackerNext,
            planReviewed: state.planReviewed,
            autoReviewState: {
              pendingWarnings: {},
              consecutiveRejects: overrideCbResult.newConsecutiveRejects,
              rejectionHistory: overrideCbResult.newRejectionHistory,
              circuitBreakerTripped: overrideCbResult.tripped,
            },
          });
        }
        return {
          ...rejectedToolMessage(
            request,
            'Destructive commands cannot be auto-approved by agent self-assessment.',
          ),
          approvedBatch: batch,
          doomLoopTracker: doomLoopTrackerNext,
          autoReviewState: {
            pendingWarnings: {},
            consecutiveRejects: overrideCbResult.newConsecutiveRejects,
            rejectionHistory: overrideCbResult.newRejectionHistory,
            circuitBreakerTripped: overrideCbResult.tripped,
          },
        };
      } else if (safetyResult.kind === 'force_interrupt') {
        console.warn('[auto-review] DANGEROUS: _safety=dangerous — forcing user interrupt');
        if (pendingSubagent) {
          return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
            doomLoopNext: doomLoopTrackerNext,
            planReviewed: state.planReviewed,
          });
        }
        emitInterruptEvent(
          {
            type: 'approval.requested',
            interactionId,
            toolCallId: request.id ?? '',
            approval: {
              ...approvalPayload,
              agentDeclaredDangerous: true,
            } as unknown as import('@/protocol/events').ToolApprovalPayload,
          },
          request.id ?? '',
        );
        approved = interrupt({
          kind: 'tool_approval',
          request,
          policy,
          interactionId,
          approval: { ...approvalPayload, agentDeclaredDangerous: true },
        }) as typeof approved;
      }

      // 断路器 + reviewer：仅当 _safety fast path 未处理时执行
      if (!approved) {
        // 断路器已触发 → 跳过 auto-review，直接中断等用户审批
        if (state.autoReviewState.circuitBreakerTripped) {
          console.warn('[auto-review] circuit breaker tripped — skipping auto-review');
          const reviewFailure = request.id
            ? state.autoReviewState.pendingWarnings[request.id]
            : undefined;
          emitInterruptEvent(
            {
              type: 'approval.requested',
              interactionId,
              toolCallId: request.id ?? '',
              approval: {
                ...approvalPayload,
                circuitBreakerTripped: true,
                reviewFailure,
              } as unknown as import('@/protocol/events').ToolApprovalPayload,
            },
            request.id ?? '',
          );
          approved = interrupt({
            kind: 'tool_approval',
            request,
            policy,
            interactionId,
            approval: { ...approvalPayload, circuitBreakerTripped: true, reviewFailure },
          }) as typeof approved;
        } else {
          // 正常 auto-review 路径 — 委托 auto-review-controller
          const autoReviewResult = await runAutoReview({
            payload: approvalPayload,
            request,
            context: reviewContext,
            config: input.config,
            reviewId: request.id ?? '',
            emitRuntimeEvent,
            // 无专属 auto-review config 时回退到主 agent model / Fall back to main model
            ...(input.config.autoReview?.provider || input.config.autoReview?.model
              ? {}
              : { model }),
          });
          const outcome = handleAutoReviewResult({
            autoReviewResult,
            autoReviewState: state.autoReviewState,
            doomLoopTracker: state.doomLoopTracker,
            request,
            approvalPayload,
            config: input.config,
            pendingSubagent,
            doomFingerprint: doomCheck.fingerprint,
            batch,
            workspace: state.workspace,
            threadId: state.threadId,
            planReviewed: state.planReviewed,
          });
          if (outcome.kind === 'return') {
            return outcome.stateUpdate as Partial<CodeAgentState>;
          }
          approved = outcome.approved;
          autoReviewFailureReason = outcome.autoReviewFailureReason;
          autoReviewRejectionRecord = outcome.autoReviewRejectionRecord;
          doomLoopTrackerNext = outcome.doomLoopTrackerNext;
        }
      } // closes if (!approved)
    } else {
      emitInterruptEvent(
        {
          type: 'approval.requested',
          interactionId,
          toolCallId: request.id ?? '',
          approval: approvalPayload as unknown as import('@/protocol/events').ToolApprovalPayload,
        },
        request.id ?? '',
      );
      approved = interrupt({
        kind: 'tool_approval',
        request,
        policy,
        interactionId,
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
    const resumeValue = normalizeApprovalResume(approved);
    const result = handleApprovalResume({
      toolCallId: request.id ?? '',
      resumeValue,
      expectedHash: approvalPayload.approvalHash,
      interactionId,
      emitRuntimeEvent,
    });

    if (!result.approved) {
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
        ...rejectedToolMessage(request, result.reason ?? 'not approved'),
        approvedBatch: batch,
      };
    }

    let approvedRequest = request;
    if (result.replacementCommand) {
      try {
        approvedRequest = replaceApprovalCommand(request, result.replacementCommand);
        emitRuntimeEvent({
          type: 'approval.command_replaced',
          interactionId,
          command: result.replacementCommand,
        });
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

    const grant = result.grant ?? 'approve_once';
    const nextAuthorization = applyApprovalGrant({
      authorization: state.authorization,
      grant,
      workspace: state.workspace,
      threadId: state.threadId,
      request: approvedRequest,
    });
    if (nextAuthorization.mode !== state.authorization.mode) {
      emitRuntimeEvent({ type: 'authorization.changed', mode: nextAuthorization.mode });
    }
    const approvedPolicy = evaluateToolApproval({
      toolName: approvedRequest.name,
      toolArgs: approvedRequest.args as Record<string, unknown>,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(state.workspaceAccess ?? 'write'),
      workspace: state.workspace ?? '',
      threadId: state.threadId ?? '',
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

    // Delegate permit issuing + full_access propagation to ApprovalController
    const allPendingForBatch = pendingSubagent
      ? [pendingSubagent.request]
      : getAllPendingToolRequests(state.messages, state.workspace);
    const finalized = finalizeApproval({
      request: approvedRequest,
      grant,
      batch,
      workspace: state.workspace,
      threadId: state.threadId,
      allPending: allPendingForBatch,
    });
    const approvedBatchFinal = finalized.batch;

    const pendingWarnings: Record<string, string> = { ...state.autoReviewState.pendingWarnings };
    if (autoReviewFailureReason && request.id) {
      pendingWarnings[request.id] = autoReviewFailureReason;
    }
    const nextAutoReviewState = autoReviewRejectionRecord
      ? { ...autoReviewRejectionRecord, pendingWarnings }
      : { ...state.autoReviewState, pendingWarnings };
    return {
      approvedBatch: approvedBatchFinal,
      approvedToolRequest: approvedRequest,
      approvedToolGrant: grant,
      authorization: nextAuthorization,
      autoReviewState: nextAutoReviewState,
      doomLoopTracker: doomLoopTrackerNext ?? state.doomLoopTracker,
      // Preserve plan state — must survive approval→tools→agent cycles
      plan: state.plan,
      planReviewed: state.planReviewed,
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

    const interactionId = genInteractionId();

    // emitInterruptEvent 防止 LangGraph node 重放时重复发射
    emitInterruptEvent(
      {
        type: 'tool.queued',
        toolCallId: request.id ?? '',
        name: request.name,
        args: request.args,
      },
      request.id ?? '',
    );
    emitInterruptEvent(
      {
        type: 'user_input.requested',
        interactionId,
        toolCallId: request.id ?? '',
        request: request.args as unknown as import('@/protocol/events').UserInputPayload,
      },
      request.id ?? '',
    );

    const resume = interrupt({
      kind: 'user_input',
      request,
      interactionId,
    }) as AgentResumeValue;

    // 委托 Controller 处理 resume → RuntimeEvent + ToolMessage
    // Delegate to Controller for resume → RuntimeEvent + ToolMessage
    return handleUserInput({
      request,
      resume,
      plan: state.plan,
      planReviewed: state.planReviewed,
      interactionId,
      emitRuntimeEvent,
    });
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

    // emitInterruptEvent 防止 LangGraph node 重放时重复发射
    emitInterruptEvent(
      {
        type: 'plan.drafted',
        toolCallId: request.id ?? '',
        plan,
        structuralHash: computePlanStructuralHash(plan),
      },
      request.id ?? '',
    );

    // 将 scheme content 格式化为工具输出，通过 need_plan_review payload 传递给 TUI
    // Format scheme content as tool output, passed to TUI via need_plan_review payload
    const stepsText = plan.steps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
    const planSummary = `${plan.description}\n\nSteps:\n${stepsText}`;

    const interactionId = genInteractionId();
    // emitInterruptEvent 防止 LangGraph node 重放时重复发射
    emitInterruptEvent(
      {
        type: 'tool.queued',
        toolCallId: request.id ?? '',
        name: request.name,
        args: request.args as unknown as Record<string, unknown>,
      },
      request.id ?? '',
    );
    emitInterruptEvent(
      {
        type: 'plan.review_requested',
        interactionId,
        toolCallId: request.id ?? '',
        plan,
        planSummary,
      },
      request.id ?? '',
    );

    const resume = interrupt({
      kind: 'plan_review',
      plan,
      planSummary,
      callId: request.id,
      interactionId,
    }) as AgentResumeValue;

    // 委托 Controller 处理 approve / supplement / reject 三路分支
    // Delegate to Controller for three-way branching: approve / supplement / reject
    return handlePlanReview({
      request: { id: request.id, args: request.args as unknown as Record<string, unknown> },
      resume: resume as boolean | Record<string, unknown>,
      state: {
        plan: state.plan,
        planReviewed: state.planReviewed,
        authorization: state.authorization,
      },
      interactionId,
      emitRuntimeEvent,
    });
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
  ): Promise<{
    toolMessage: ToolMessage | null;
    sideEffects: import('./tool-result').ToolExecutionSideEffects;
  }> {
    // 构造 shell 实时输出回调（仅对 shell_execute 生效）
    const onShellProgress = input.toolProgressSink
      ? (chunk: string, stream: 'stdout' | 'stderr') => {
          input.toolProgressSink!(request.id ?? '', request.name, chunk, stream);
          emitRuntimeEvent({
            type: 'tool.progress',
            toolCallId: request.id ?? '',
            chunk,
            stream,
          });
        }
      : undefined;

    // RuntimeEvent: tool.started — execution is about to begin
    emitRuntimeEvent({
      type: 'tool.started',
      toolCallId: request.id ?? '',
    });

    // 委托 tool-controller 执行工具 / Delegate to tool-controller
    let toolMsg: ToolMessage | null;
    let sideEffects: import('./tool-result').ToolExecutionSideEffects;
    let subagentBlocked: NonNullable<SubAgentResult['blocked']> | undefined;
    try {
      const r = await executeTool({
        workspace: state.workspace,
        request: request as {
          id?: string;
          name: string;
          args: Record<string, unknown>;
          protectedCommand: string;
        },
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
        emitRuntimeEvent,
      });
      toolMsg = r.toolMessage;
      sideEffects = r.sideEffects;

      // Emit plan.progress_updated for status-only update_plan calls
      if (request.name === 'update_plan' && sideEffects.plan) {
        if (isPlanProgressOnlyUpdate(state.plan, sideEffects.plan)) {
          emitRuntimeEvent({
            type: 'plan.progress_updated',
            toolCallId: request.id ?? '',
            plan: sideEffects.plan,
          });
        }
      }

      // Emit plan.completed when update_plan sets status to 'completed'
      if (request.name === 'update_plan' && sideEffects.plan?.status === 'completed') {
        emitRuntimeEvent({
          type: 'plan.completed',
          toolCallId: request.id ?? '',
          plan: sideEffects.plan,
        });
      }

      subagentBlocked = r.subagentBlocked;
    } catch (error) {
      emitRuntimeEvent({
        type: 'tool.failed',
        toolCallId: request.id ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // 子 agent 阻塞 → 创建 pendingSubagentApproval 供 approval 节点处理
    if (subagentBlocked) {
      const pending = pendingSubagentApprovalFromBlocked(
        request.id ?? 'missing-tool-call-id',
        subagentBlocked,
        state.workspace,
      );
      if (pending) {
        return {
          toolMessage: null,
          sideEffects: { pendingSubagentApproval: pending },
        };
      }
    }

    // Flush React re-renders before dispatching tool_done
    if (onShellProgress) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return { toolMessage: toolMsg, sideEffects };
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
      return {
        messages: cancelledToolMessages,
        executionJournal: [],
        exhaustedFingerprints: {},
        // Preserve plan state — cleanup runs at graph START; must not
        // reset planReviewed/plan between turns.
        planReviewed: state.planReviewed,
        plan: state.plan,
      };
    }
    return {
      executionJournal: [],
      exhaustedFingerprints: {},
      planReviewed: state.planReviewed,
      plan: state.plan,
    };
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

  /** 工具节点：并行执行所有待处理的工具调用。
   *  Tools node — execute all pending tool calls in parallel.
   *  Each tool completion emits RuntimeEvent tool.finished immediately so the TUI
   *  shows progressive completion without waiting for the full batch. */
  const tools = async (state: CodeAgentState) => {
    const allRequests = getAllPendingToolRequests(state.messages, state.workspace);
    const batch = migratePermitBatch(state.approvedBatch);

    // RuntimeEvent: tool.queued for each pending request
    for (const req of allRequests) {
      emitRuntimeEvent({
        type: 'tool.queued',
        toolCallId: req.id ?? '',
        name: req.name,
        args: req.args,
      });
    }

    if (state.pendingSubagentApproval) {
      const pending = state.pendingSubagentApproval;
      const request = pending.request;

      // RuntimeEvent: tool.queued for pending subagent request
      emitRuntimeEvent({
        type: 'tool.queued',
        toolCallId: request.id ?? '',
        name: request.name,
        args: request.args,
      });

      const grantUsed = request.id && batch[request.id] ? batch[request.id]!.grant : 'none';
      const onShellProgress = input.toolProgressSink
        ? (chunk: string, stream: 'stdout' | 'stderr') => {
            input.toolProgressSink!(request.id ?? '', request.name, chunk, stream);
            emitRuntimeEvent({
              type: 'tool.progress',
              toolCallId: request.id ?? '',
              chunk,
              stream,
            });
          }
        : undefined;

      // RuntimeEvent: tool.started for subagent tool
      emitRuntimeEvent({
        type: 'tool.started',
        toolCallId: request.id ?? '',
      });

      let subResult: Awaited<ReturnType<typeof runApprovedTool>>;
      try {
        subResult = await runApprovedTool({
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
      } catch (error) {
        emitRuntimeEvent({
          type: 'tool.failed',
          toolCallId: request.id ?? '',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const result = subResult!;

      if (onShellProgress) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // RuntimeEvent 管道发出 tool_done
      emitRuntimeEvent({
        type: 'tool.finished',
        toolCallId: request.id ?? '',
        name: request.name,
        result: {
          ok: result.ok !== false,
          command: result.command ?? request.protectedCommand,
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        },
      });

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
    const mergedSideEffects: import('./tool-result').ToolExecutionSideEffects = {};
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
      const preflightResult = preflightExhaustionCheck({
        requestName: req.name,
        requestId: req.id ?? '',
        requestArgs: req.args as Record<string, unknown>,
        protectedCommand: req.protectedCommand,
        exhaustedFingerprints: journalState.exhaustedFingerprints,
        emitRuntimeEvent,
      });
      if (preflightResult.blocked) {
        messages.push(preflightResult.toolMessage!);
        continue;
      }

      const reqGrant = req.id && batch[req.id] ? batch[req.id]!.grant : 'none';
      const r = await executeOneTool(req, state, reqGrant);

      if (r.toolMessage) {
        const journalBefore = { ...journalState.exhaustedFingerprints };
        journalState = recordJournalForMessage(r.toolMessage, journalState);
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
          // Override the earlier RuntimeEvent (from executeOneTool)
          // to carry status: 'exhausted' so the TUI renders the amber dot.
          const toolName = (r.toolMessage as ToolMessage).name ?? 'unknown';
          const callId = ((r.toolMessage as ToolMessage).tool_call_id as string) || '';
          emitRuntimeEvent({
            type: 'tool.finished',
            toolCallId: callId,
            name: toolName,
            result: {
              ok: false,
              command: '',
              exitCode: -1,
              stdout: '',
              stderr: `Execution blocked: too many repeated failures for ${toolName}.`,
              status: 'exhausted',
            },
          });
        }
        messages.push(r.toolMessage);
      }
      Object.assign(mergedSideEffects, r.sideEffects);
    }

    // Phase 2: Execute mutations sequentially — journal state flows between steps.
    // This ensures an exhaustion triggered by mutation N blocks mutation N+1's preflight.
    const sequentialState = { ...state, ...journalState };
    const editedPaths = new Set<string>();
    for (const req of mutations) {
      // Guard: reject concurrent same-file edits/writes. Each mutation modifies
      // the file immediately, so a second call targeting the same path would
      // conflict. Force the model to combine operations into one call.
      if (req.name === 'edit_file' || req.name === 'write_file') {
        const editPath = (req.args as Record<string, unknown>).path as string | undefined;
        if (editPath && editedPaths.has(editPath)) {
          const blockedMsg = new ToolMessage({
            content: JSON.stringify({
              ok: false,
              path: editPath,
              rejected: true,
              reason: `Concurrent edit to '${editPath}' blocked. The file was already edited in this batch — subsequent edits would fail because old_string no longer matches. Combine all changes to this file into a single edit_file call with a larger old_string/new_string range, or use write_file to rewrite the entire file.`,
              failure: {
                message: 'Tool execution failed.' as const,
                tool: req.name,
                reason: `Concurrent same-file ${req.name} blocked for ${editPath}.`,
                guidance: `Combine all changes to this file into ONE ${req.name} call.`,
              },
            }),
            tool_call_id: req.id ?? 'missing-tool-call-id',
            name: req.name,
            status: 'error',
          });
          messages.push(blockedMsg);
          emitRuntimeEvent({
            type: 'tool.rejected',
            toolCallId: req.id ?? '',
            reason: `Concurrent same-file ${req.name} blocked for '${editPath}'. Combine into one call.`,
          });
          continue;
        }
        if (editPath) editedPaths.add(editPath);
      }

      // Preflight: check if this tool+path fingerprint is already exhausted.
      const preflightResult = preflightExhaustionCheck({
        requestName: req.name,
        requestId: req.id ?? '',
        requestArgs: req.args as Record<string, unknown>,
        protectedCommand: req.protectedCommand,
        exhaustedFingerprints: journalState.exhaustedFingerprints,
        emitRuntimeEvent,
      });
      if (preflightResult.blocked) {
        messages.push(preflightResult.toolMessage!);
        continue;
      }

      const reqGrant = req.id && batch[req.id] ? batch[req.id]!.grant : 'none';
      const r = await executeOneTool(req, sequentialState, reqGrant);

      if (r.toolMessage) {
        // Update journal — if a new fingerprint was just exhausted, inject the signal.
        const journalBefore = { ...journalState.exhaustedFingerprints };
        journalState = recordJournalForMessage(r.toolMessage, journalState);
        // Check whether this execution just exhausted a NEW fingerprint.
        const newExhaustedFp = Object.keys(journalState.exhaustedFingerprints).find(
          (fp) => !journalBefore[fp],
        );
        if (newExhaustedFp) {
          // Rebuild ToolMessage with exhaustion signal so the model sees it immediately.
          r.toolMessage = injectExhaustionSignal(r.toolMessage, req.name, newExhaustedFp);
          // Override the earlier RuntimeEvent with status:'exhausted' for TUI
          emitRuntimeEvent({
            type: 'tool.finished',
            toolCallId: req.id ?? '',
            name: req.name,
            result: {
              ok: false,
              command: '',
              exitCode: -1,
              stdout: '',
              stderr: `Execution blocked: too many repeated failures for ${req.name}.`,
              status: 'exhausted',
            },
          });
        }
        messages.push(r.toolMessage);
      }
      Object.assign(mergedSideEffects, r.sideEffects);
      // Flow updated journal into state for the next mutation iteration.
      Object.assign(sequentialState, journalState);
    }

    return {
      approvedBatch: {},
      approvedToolRequest: null,
      approvedToolGrant: null,
      ...mergedSideEffects,
      ...journalState,
      messages,
      // Preserve plan mode state across tools→agent cycles.
      // mergedSideEffects always carries `plan` (from executeOneTool's sideEffects
      // struct), which is undefined for non-update_plan tools. Without the explicit
      // fallback below, ...mergedSideEffects would override state.plan with undefined,
      // causing isSamePlanTrackingUpdate to fail and re-triggering plan_review.
      interactionMode: state.interactionMode,
      planReviewed: state.planReviewed,
      plan: mergedSideEffects.plan ?? state.plan,
      authorization: state.authorization,
      // Auto-review warnings have been injected into ToolMessages; clear them.
      // Preserve breaker/doom-loop state across tools→agent cycles.
      autoReviewState: { ...state.autoReviewState, pendingWarnings: {} },
      doomLoopTracker: state.doomLoopTracker,
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

/** 从对话历史中提取用户原始任务文本（第一个 HumanMessage 的前 500 字符）。
 *  Extracts the user's original task from conversation history (first HumanMessage, max 500 chars). */
function extractUserTask(
  messages: { getType?: () => string; content?: unknown; type?: string }[],
): string | undefined {
  for (const msg of messages) {
    const msgType =
      typeof msg.getType === 'function' ? msg.getType() : (msg as Record<string, unknown>).type;
    if (msgType === 'human' || msgType === 'user') {
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((part: unknown) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && 'text' in part) {
              return ((part as { text: unknown }).text as string) ?? '';
            }
            return '';
          })
          .join(' ');
      }
      if (text) return text.slice(0, 500);
    }
  }
  return undefined;
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
