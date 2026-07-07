import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { interrupt, START, StateGraph } from '@langchain/langgraph';
import { ChatOllama } from '@langchain/ollama';
import type { AgentConfig } from '@/core/config/index';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  evaluateCircuitBreaker,
  type RejectionEntry,
} from '@/core/execution/circuit-breaker';
import { checkDoomLoop, updateDoomLoopTracker } from '@/core/execution/doom-loop';
import {
  injectExhaustionSignal,
  isFingerprintExhausted,
  recordExecutionResult,
  recordJournalForMessage,
} from '@/core/execution/journal';
import { issuePermit, migratePermitBatch } from '@/core/execution/permit';
import {
  createAutoReviewModel,
  type ReviewContext,
  reviewToolApproval,
} from '@/core/execution/reviewer';
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
import { normalizeUserInputResume, userInputToolMessage } from './user-input';

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
    reviewFailure?: string,
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
      interactionMode: state.interactionMode,
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
        // Preserve plan mode state — planReview node sets these once; they must
        // survive agent→tools→agent cycles without resetting to defaults.
        interactionMode: state.interactionMode,
        planReviewed: state.planReviewed,
        autoReviewState: state.autoReviewState,
        doomLoopTracker: state.doomLoopTracker,
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
    return result;
  }

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
        }
      | undefined;
    let autoReviewFailureReason: string | null = null;
    let autoReviewRejectionRecord:
      | import('@/core/execution/circuit-breaker').AutoReviewState
      | null = null;
    let doomLoopTrackerNext = state.doomLoopTracker;
    if (state.interactionMode === InteractionMode.Auto) {
      const reviewModel =
        input.config.autoReview?.provider || input.config.autoReview?.model
          ? createAutoReviewModel(input.config)
          : model;
      const reviewModelName =
        (input.config.autoReview?.model as string) ?? input.config.modelName ?? 'unknown';

      // 构建审查上下文
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
          approved = interrupt({
            kind: 'tool_approval',
            request,
            policy,
            approval: {
              ...approvalPayload,
              doomLoopDetected: true,
              doomLoopReason: doomCheck.reason,
            },
          }) as typeof approved;
        } else {
          return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
            doomLoopNext: updateDoomLoopTracker(state.doomLoopTracker, doomCheck.fingerprint!),
          });
        }
      }
      // 暂不在此处递增——等 auto-review 结果出来后再决定是否计入
      // Defer increment — only count rejected calls (see auto-review result handling below)

      // _safety fast-path routing
      const agentSafety = (request.args as Record<string, unknown>)._safety as
        | 'safe'
        | 'caution'
        | 'dangerous'
        | undefined;
      const toolRisk = policy.risk as string;

      // safe + 低风险 → fast path 自动批准（断路器已触发时不允许）
      if (
        agentSafety === 'safe' &&
        !state.autoReviewState.circuitBreakerTripped &&
        (toolRisk === 'write_file' || toolRisk === 'execute_code' || toolRisk === 'read')
      ) {
        console.warn(`[auto-review] FAST PATH: _safety=safe, risk=${toolRisk} — auto-approving`);
        approved = {
          approved: true,
          grant: 'approve_once' as ShellApprovalGrant,
          approvalHash: approvalPayload.approvalHash,
          reason: '[_safety=safe] auto-approved by agent self-assessment',
        };
        autoReviewRejectionRecord = {
          pendingWarnings: {},
          consecutiveRejects: 0,
          rejectionHistory: state.autoReviewState.rejectionHistory,
          circuitBreakerTripped: false,
        };
      }
      // safe + destructive → belt-and-suspenders 覆盖，计入断路器
      else if (agentSafety === 'safe' && toolRisk === 'destructive') {
        console.warn('[auto-review] OVERRIDE: _safety=safe but risk=destructive — denying');
        const overrideEntry: RejectionEntry = {
          timestamp: Date.now(),
          toolName: request.name,
          reason: `Agent claimed _safety=safe on destructive command`,
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
      }
      // dangerous → 跳过 reviewer，直接用户审批
      else if (agentSafety === 'dangerous') {
        console.warn('[auto-review] DANGEROUS: _safety=dangerous — forcing user interrupt');
        if (pendingSubagent) {
          return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
            doomLoopNext: doomLoopTrackerNext,
          });
        }
        approved = interrupt({
          kind: 'tool_approval',
          request,
          policy,
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
          approved = interrupt({
            kind: 'tool_approval',
            request,
            policy,
            approval: { ...approvalPayload, circuitBreakerTripped: true, reviewFailure },
          }) as typeof approved;
        } else {
          // 正常 auto-review 路径
          const review = await reviewToolApproval({
            model: reviewModel,
            payload: approvalPayload,
            request,
            context: reviewContext,
            timeoutMs: input.config.autoReview?.timeoutMs,
          });
          if (!review.ok) {
            const failureReason = review.reason ?? 'auto review technical failure';
            const failOpen = input.config.autoReview?.failOpen === true;
            if (failOpen) {
              autoReviewFailureReason = `auto-review (${reviewModelName}): ${failureReason}`;
              console.warn(
                `[auto-review] FAILED (fail-open): ${failureReason} — tool=${request.name}`,
              );
              if (pendingSubagent) {
                return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
                  doomLoopNext: doomLoopTrackerNext,
                  autoReviewState: {
                    pendingWarnings: {},
                    consecutiveRejects: 0,
                    rejectionHistory: [],
                    circuitBreakerTripped: true,
                  },
                });
              }
              approved = {
                approved: true,
                grant: 'approve_once' as ShellApprovalGrant,
                approvalHash: approvalPayload.approvalHash,
                reason: `[auto-review failed] ${failureReason}`,
              };
            } else {
              doomLoopTrackerNext = updateDoomLoopTracker(
                state.doomLoopTracker,
                doomCheck.fingerprint!,
              );
              autoReviewFailureReason = `auto-review (${reviewModelName}): ${failureReason} (fail-closed)`;
              console.warn(
                `[auto-review] FAILED (fail-closed): ${failureReason} — tool=${request.name}`,
              );
              const pendingWarnings = {
                ...state.autoReviewState.pendingWarnings,
                ...(request.id ? { [request.id]: autoReviewFailureReason } : {}),
              };
              if (pendingSubagent) {
                return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
                  doomLoopNext: doomLoopTrackerNext,
                  autoReviewState: {
                    pendingWarnings,
                    consecutiveRejects: 0,
                    rejectionHistory: [],
                    circuitBreakerTripped: true,
                  },
                });
              }
              return {
                approvedBatch: batch,
                doomLoopTracker: doomLoopTrackerNext,
                autoReviewState: {
                  pendingWarnings,
                  consecutiveRejects: 0,
                  rejectionHistory: [],
                  circuitBreakerTripped: true,
                },
              };
            }
          } else if (!review.suggestion!.approved) {
            doomLoopTrackerNext = updateDoomLoopTracker(
              state.doomLoopTracker,
              doomCheck.fingerprint!,
            );
            const rejectionReason = review.suggestion!.reason || 'auto review rejected this action';
            console.warn(`[auto-review] rejected: ${rejectionReason} — tool=${request.name}`);
            const newEntry: RejectionEntry = {
              timestamp: Date.now(),
              toolName: request.name,
              reason: rejectionReason,
            };
            const cbConfig = {
              ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
              maxRejections:
                input.config.autoReview?.circuitBreakerMaxRejections ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.maxRejections,
              windowMs:
                input.config.autoReview?.circuitBreakerWindowMs ??
                DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs,
            };
            const cbResult = evaluateCircuitBreaker(
              state.autoReviewState.consecutiveRejects,
              state.autoReviewState.rejectionHistory.map((r) => ({
                timestamp: r.timestamp,
                toolName: r.toolName,
                reason: r.reason,
              })),
              cbConfig,
              true,
              newEntry,
            );
            autoReviewRejectionRecord = {
              pendingWarnings: {},
              consecutiveRejects: cbResult.newConsecutiveRejects,
              rejectionHistory: cbResult.newRejectionHistory,
              circuitBreakerTripped: cbResult.tripped,
            };
            if (cbResult.tripped) {
              console.warn(`[auto-review] CIRCUIT BREAKER TRIPPED: ${cbResult.reason}`);
              const pendingWarnings = {
                ...state.autoReviewState.pendingWarnings,
                ...(request.id ? { [request.id]: `auto-review rejected: ${rejectionReason}` } : {}),
              };
              if (pendingSubagent) {
                return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
                  doomLoopNext: doomLoopTrackerNext,
                  autoReviewState: {
                    pendingWarnings,
                    consecutiveRejects: cbResult.newConsecutiveRejects,
                    rejectionHistory: cbResult.newRejectionHistory,
                    circuitBreakerTripped: true,
                  },
                });
              }
              return {
                approvedBatch: batch,
                doomLoopTracker: doomLoopTrackerNext,
                autoReviewState: {
                  pendingWarnings,
                  consecutiveRejects: cbResult.newConsecutiveRejects,
                  rejectionHistory: cbResult.newRejectionHistory,
                  circuitBreakerTripped: true,
                },
              };
            } else {
              if (pendingSubagent) {
                return rejectSubagentTool(batch, pendingSubagent, state.workspace, state.threadId, {
                  doomLoopNext: doomLoopTrackerNext,
                  autoReviewState: {
                    pendingWarnings: {},
                    consecutiveRejects: cbResult.newConsecutiveRejects,
                    rejectionHistory: cbResult.newRejectionHistory,
                    circuitBreakerTripped: false,
                  },
                });
              }
              return {
                ...rejectedToolMessage(request, rejectionReason),
                approvedBatch: batch,
                doomLoopTracker: doomLoopTrackerNext,
                autoReviewState: {
                  pendingWarnings: {},
                  consecutiveRejects: cbResult.newConsecutiveRejects,
                  rejectionHistory: cbResult.newRejectionHistory,
                  circuitBreakerTripped: false,
                },
              };
            }
          } else {
            const suggestion = review.suggestion!;
            approved = {
              approved: true,
              grant: suggestion.grant,
              approvalHash: approvalPayload.approvalHash,
              reason: suggestion.reason,
            };
            autoReviewRejectionRecord = {
              pendingWarnings: {},
              consecutiveRejects: 0,
              rejectionHistory: state.autoReviewState.rejectionHistory,
              circuitBreakerTripped: false,
            };
          }
        }
      } // closes if (!approved)
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

    const pendingWarnings: Record<string, string> = { ...state.autoReviewState.pendingWarnings };
    if (autoReviewFailureReason && request.id) {
      pendingWarnings[request.id] = autoReviewFailureReason;
    }
    const nextAutoReviewState = autoReviewRejectionRecord
      ? { ...autoReviewRejectionRecord, pendingWarnings }
      : { ...state.autoReviewState, pendingWarnings };
    return {
      approvedBatch: batch,
      approvedToolRequest: approvedRequest,
      approvedToolGrant: grant,
      authorization: nextAuthorization,
      autoReviewState: nextAutoReviewState,
      doomLoopTracker: doomLoopTrackerNext ?? state.doomLoopTracker,
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

    // 与 executeOneTool 保持一致的 toolResultSink 路径：ToolMessage 在
    // checkpoint 反序列化后会丢失 _getType，仅靠 stream → isToolMessage →
    // parseToolResultEvents 不够可靠。直接发出 tool_done 确保 TUI 及时更新。
    // Mirror executeOneTool's toolResultSink pattern: ToolMessage loses _getType
    // after checkpoint deserialization; stream path alone is unreliable. Emit
    // tool_done directly so the TUI updates without depending on stream parsing.
    if (input.toolResultSink && request.id) {
      const normalized = normalizeUserInputResume(resume);
      const summary = normalized.answers
        ? Object.entries(normalized.answers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')
        : normalized.answer;
      input.toolResultSink(request.id, 'ask_user', true, summary);
    }

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
      const executionMode = resumeObj?.executionMode as string | undefined;
      const interactionMode = executionMode === 'auto' ? InteractionMode.Auto : InteractionMode.Ask;
      // 方案数据已在 AIMessage.tool_calls.args 中，ToolMessage 只需标记 ok + 简短摘要。
      // 重复放入完整 plan 对象会浪费 token 并降低后续调用前缀缓存命中率。
      // The plan data is already in AIMessage.tool_calls.args; ToolMessage only needs ok + brief summary.
      // Including the full plan redundantly wastes tokens and degrades prefix cache hit rates.
      // 首次方案审批重置授权为 default；执行中修订方案保留现有授权（如 full_access）
      // First plan approval resets authorization to default; plan revision preserves existing authorization

      // 与 executeOneTool 一致：直接发出 tool_done，不依赖 stream 解析
      // Mirror executeOneTool: emit tool_done directly, don't depend on stream parsing
      if (input.toolResultSink && request.id) {
        input.toolResultSink(request.id, 'update_plan', true, planSummary.slice(0, 200));
      }

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
        phase: 'building' as const,
        interactionMode,
        authorization: state.planReviewed
          ? state.authorization
          : { ...state.authorization, mode: 'default' as const },
      };
    }

    const supplement = resumeObj?.planSupplement;
    if (typeof supplement === 'string' && supplement.length > 0) {
      if (input.toolResultSink && request.id) {
        input.toolResultSink(
          request.id,
          'update_plan',
          false,
          `Plan needs revision: ${supplement}`,
        );
      }
      return rejectedToolMessage(request, `Plan needs revision. User feedback: ${supplement}`);
    }

    if (input.toolResultSink && request.id) {
      input.toolResultSink(request.id, 'update_plan', false, 'plan rejected by user');
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
  ): Promise<{
    toolMessage: ToolMessage | null;
    sideEffects: import('./tool-result').ToolExecutionSideEffects;
  }> {
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
          sideEffects: { pendingSubagentApproval: pending },
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
    const reviewFailure = request.id
      ? state.autoReviewState.pendingWarnings[request.id]
      : undefined;
    input.toolResultSink?.(
      request.id ?? '',
      request.name,
      result.ok !== false,
      summary,
      result.totalLines,
      undefined, // toolTokenCount computed in runner's parseToolResultEvents
      result.exitCode,
      undefined, // status — determined by runner
      reviewFailure,
    );

    const toolMessage = new ToolMessage({
      content: JSON.stringify(result),
      tool_call_id: request.id ?? 'missing-tool-call-id',
      name: request.name,
      status: result.ok === false ? 'error' : 'success',
    });

    const sideEffects: import('./tool-result').ToolExecutionSideEffects = {
      plan: result.plan,
      workspaceAccess: result.workspaceAccess,
      authorization: result.authorization,
      activeSkillInstructions: result.activeSkillInstructions,
    };

    return { toolMessage, sideEffects };
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
          input.toolResultSink?.(
            req.id ?? '',
            req.name,
            false,
            `Concurrent same-file ${req.name} blocked for '${editPath}'. Combine into one call.`,
          );
          continue;
        }
        if (editPath) editedPaths.add(editPath);
      }

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
        journalState = recordJournalForMessage(r.toolMessage, journalState);
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
