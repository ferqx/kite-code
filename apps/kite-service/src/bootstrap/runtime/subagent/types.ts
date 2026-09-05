// apps/kite-service/src/bootstrap/runtime/subagent/types.ts
import type { BaseMessage } from '@kite-ai/builtin-runtime/model';
import type {
  SubAgentEventSink,
  SubAgentFailureDiagnostic,
  SubAgentRole,
} from '@kite-ai/runtime-contract';
import type {
  DescendantBudgetReservation,
  DescendantResourceAdmission,
  RuntimeBudgetAdmissionReason,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { AppApprovalBinding } from '../approval-binding';

export type { SubAgentRole };

/** Runtime-owned bridge for one child model tool call. */
export interface SubAgentToolDispatcher {
  dispatch(input: {
    subagentId: string;
    modelInvocationId: string;
    modelToolCallId: string;
    request: import('@kite-ai/builtin-runtime').PendingToolRequest;
    signal: AbortSignal;
    /** Reserve the exact child attempt after policy/approval and before Pipeline admission. */
    beforeAdmission?: () => Promise<DescendantBudgetReservation>;
    /** Observe the durable invocation attempt acknowledgement before adapter dispatch. */
    beforeDispatch?: (attempt: number, reservationId?: string) => Promise<void>;
    afterDispatch?: (input: {
      attempt?: number;
      reservationId?: string;
      dispatchState: 'not_started' | 'started';
      result?: import('../tool-result').ToolExecutionResult;
      error?: unknown;
    }) => Promise<void>;
    /** Exact parent approval receipt used for a resumed blocked child. */
    parentApproval?: {
      parentToolCallId: string;
      grant: 'approve_once' | 'same_command';
      approvalBindingDigest?: string;
    };
    binding?: import('@kite-ai/runtime-contract').CapabilityBinding;
  }): Promise<{
    runtimeToolCallId: string;
    result: import('../tool-result').ToolExecutionResult;
  }>;
}

/** 子 agent 角色配置 */
export interface SubAgentRoleConfig {
  role: SubAgentRole;
  /** System prompt 文本 */
  systemPrompt: string;
  /** 允许使用的工具名称集合（undefined 表示全部可用） */
  allowedTools?: Set<string>;
  /** 可选独立模型（不指定则使用主 agent 模型）/ Optional model override for this role */
  model?: import('@kite-ai/builtin-runtime/model').SupportedChatModel;
  /** 可选超时毫秒（不指定则使用 SubAgentRunnerInput.timeoutMs）/ Optional timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Durable facts for the approval interaction that suspended a child.
 *
 * These facts belong to the continuation, rather than to a transient TUI
 * slot.  A resumed child must replay the original route and identity even if
 * another sibling has since claimed focus or the live interaction mode has
 * changed.
 */
export interface SubAgentApprovalFacts {
  readonly route: 'auto_review' | 'user';
  readonly generation: number;
  readonly sequence: number;
  readonly bindingDigest: string;
  readonly parentToolCallId: string;
  readonly childToolCallId: string;
  readonly runtimeToolCallId?: string;
}

/** 子 agent 运行输入 / Sub-agent runner input */
export interface SubAgentRunnerInput {
  /** Turn projections derive from the App's one Host snapshot; children never build a registry. */
  builtinToolCatalog?: import('@kite-ai/builtin-runtime').BuiltinToolCatalogProjection;
  config: import('#kite-service/config/index').AgentConfig;
  workspace: string;
  role: SubAgentRoleConfig;
  /** Public display name supplied explicitly by the parent model. */
  name: string;
  task: string;
  shellExecutor?: import('@kite-ai/builtin-runtime/sandbox').ShellExecutor;
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
  mcpManager?: import('@kite-ai/builtin-runtime/mcp').McpRuntimeProvider;
  skills?: import('@kite-ai/builtin-runtime/skills').SkillManifest[];
  skillOptions?: import('@kite-ai/builtin-runtime/skills').SkillScanOptions;
  mcpBindings?: Array<{
    binding: import('@kite-ai/runtime-contract').CapabilityBinding;
    descriptor: import('@kite-ai/runtime-contract').CapabilityDescriptor;
  }>;
  /** Explicit capability-derived tool ceiling for a governed caller. */
  allowedTools?: Set<string>;
  workspaceAccess?: import('@kite-ai/runtime-contract').WorkspaceAccess;
  phase?: import('@kite-ai/runtime-contract').AgentPhase;
  /** Parent Runtime interaction mode for this invocation. Resume callers pass the current live mode. */
  interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
  /** Project instructions visible to the parent model when this sub-agent was dispatched. */
  projectInstructions?: import('@kite-ai/builtin-runtime/model').ProjectInstructionSnapshot;
  threadId?: string;
  /** Parent Runtime private artifact store shared by child execution. */
  recoveryIdentityKey: string;
  model?: import('@kite-ai/builtin-runtime/model').SupportedChatModel;
  descendantResourceAdmission?: DescendantResourceAdmission;
  modelEffectCoordinator?: import('@kite-ai/builtin-runtime/model').BuiltinModelEffectCoordinator;
  modelInvocationPersistence?: import('@kite-ai/builtin-runtime/model').ModelInvocationPersistence<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeState,
    import('@kite-ai/runtime-host').StateRuntimeEvent
  >;
  /** Durable model invocation that produced the parent Task/Skill tool call. */
  modelInvocationParentId?: string;
  /** Parent Task/Skill tool call that owns each child model step. */
  modelInvocationParentToolCallId?: string;
  /** Parent subagent reservation consumed by each child model step. */
  modelInvocationParentReservationId?: string;
  /** Runtime-issued child identity, created before the delegation grant is sealed. */
  childInvocationId?: string;
  /** Exact Pipeline-owned grant facts used for driver cross-checks. */
  subagentGrantContext?: {
    parentInvocationId: string;
    authorizationDigest: string;
    attempt: number;
    capabilityRevision: string;
    admissionDigest: string;
    effectiveEffectsDigest: string;
  };
  /** Parent Runtime callback that admits and durably receipts child tool calls. */
  toolDispatcher?: SubAgentToolDispatcher;
  timeoutMs: number;
  signal: AbortSignal;
  eventSink: SubAgentEventSink;
  /** 当前嵌套深度（0 = 主 agent 直接派生）/ Current nesting depth (0 = spawned by main agent) */
  depth?: number;
  /** 最大允许嵌套深度（0 = 不允许子 agent 再派生）/ Max nesting depth (0 = no further nesting) */
  maxDepth?: number;
  /** 写入前文件原像记录器（ADR-0042 §4），透传给工具执行。 */
  recordFilePreimage?: import('@kite-ai/runtime-host/storage').RuntimeHostFilePreimageRecorder;
}

export interface SubAgentContinuation {
  id: string;
  role: SubAgentRoleConfig;
  name?: string;
  task: string;
  messages: BaseMessage[];
  toolCallCount: number;
  modelInvocationOrdinal?: number;
  steps: SubAgentStepSnapshot[];
  /** Phase 5: journal state preserved across approval round-trips */
  executionJournal?: import('@kite-ai/runtime-spi').PersistedExecutionJournalEntry[];
  exhaustedFingerprints?: Record<string, true>;
  toolRecovery: import('@kite-ai/runtime-host/kernel-adapter').StateToolRecoveryJournal;
  projectInstructions?: import('@kite-ai/builtin-runtime/model').ProjectInstructionSnapshot;
  /** Exact child tool surface retained across approval suspension. */
  allowedTools?: string[];
  /** Runtime-issued bindings that authorize the retained dynamic MCP surface. */
  mcpBindingIds?: string[];
  /** Original approval route and identity retained across restart/resume. */
  approvalFacts?: SubAgentApprovalFacts;
}

/** 已暂停子 agent 的待执行工具 / Pending tool preserved with a suspended continuation */
export interface SubAgentBlockedTool {
  reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
  toolCallId: string;
  /** Namespaced Runtime identity; model-facing toolCallId remains unchanged. */
  runtimeToolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  command: string;
  /** Kernel-issued governance facts transported across the private continuation. */
  approvalBinding?: AppApprovalBinding;
}

/** 从持久化快照恢复的 continuation，包含恢复前必须执行的阻塞工具 */
export interface RestoredSubAgentContinuation extends SubAgentContinuation {
  blockedTool: SubAgentBlockedTool;
}

/** 子 agent 步骤记录（用于持久化到 checkpoint）
 *  status 与 TUI 的 SubAgentStepRecord.status 保持一致 */
export interface SubAgentStepSnapshot {
  /** Stable identity allocated when the child tool call is admitted. */
  stepId: string;
  /** Exact child tool-call identity shared by started/result/replay. */
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** 步生命周期状态（与 TUI SubAgentStepRecord.status 同步） */
  status: 'pending' | 'awaiting_approval' | 'success' | 'rejected' | 'error' | 'cancelled';
  totalLines?: number;
}

/** 子 agent 运行结果 */
export interface SubAgentResult {
  ok: boolean;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  terminalStatus?: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'suspended';
  error?: string;
  /** Content-free reason retained across the private Provider observation seam. */
  failureDiagnostic?: SubAgentFailureDiagnostic;
  /** Parent-private typed terminal propagated across the Provider observation seam. */
  resourceAdmissionFailure?: {
    reason: Exclude<RuntimeBudgetAdmissionReason, 'admitted'>;
    message: string;
    parentInvocationId: string;
    parentToolCallId: string;
    childInvocationId: string;
  };
  blocked?: {
    reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' | 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW';
    toolCallId: string;
    runtimeToolCallId?: string;
    toolName: string;
    command: string;
    args: Record<string, unknown>;
    message: string;
    approvalBinding?: AppApprovalBinding;
    continuation: SubAgentContinuation;
  };
  /** 步骤快照：用于会话重放时恢复步骤树 / Step snapshots for session replay */
  steps?: SubAgentStepSnapshot[];
  /** Phase 5: 子 Agent 工具执行的 journal 条目 / Journal entries from subagent tool executions */
  executionJournal?: import('@kite-ai/runtime-spi').PersistedExecutionJournalEntry[];
  /** Phase 5: 子 Agent 中已耗尽的操作指纹 / Exhausted fingerprints detected in subagent */
  exhaustedFingerprints?: Record<string, true>;
  toolRecovery?: import('@kite-ai/runtime-host/kernel-adapter').StateToolRecoveryJournal;
}

/** 子 agent 缓存指标 / Sub-agent cache metrics */
export type { SubAgentEventSink };
