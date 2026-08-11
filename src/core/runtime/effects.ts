// ── Runtime Effect 类型定义 / Runtime effect type definitions ──
// Phase 4: 声明式效果 — AgentKernel 通过 decideNextEffect 决定下一步，
// 不再在 LangGraph 路由函数中硬编码业务调度。
//
// Declarative effects — AgentKernel uses decideNextEffect to determine the next step,
// no longer hard-coding business scheduling in LangGraph routing functions.

/**
 * 运行时效果 — AgentKernel 主循环中可执行的下一步操作。
 * Runtime effect — the next operation to execute in the AgentKernel main loop.
 *
 * 效果是无副作用的描述，由 Controller 解释执行。
 * Effects are side-effect-free descriptions, interpreted by Controllers.
 */
export type RuntimeEffect =
  /** 调用模型生成响应 / Call the model to generate a response */
  | {
      type: 'call_model';
      /** Exact input and bounded output prepared before budget reservation. */
      resourceEstimate?: {
        inputTokens: number;
        maxOutputTokens: number;
      };
      /** Exact immutable request built before resource reservation. */
      preparedContextV2?: import('@/core/model/context-admission-v2').PreparedPrimaryContextRequestV2;
      /** Stable ToolSet/disclosure source paired with preparedContextV2. */
      preparedCapabilitySetV2?: import('@/core/model/context-capability-v2').PreparedContextCapabilitySetV2;
    }
  /** Build one durable M2 context checkpoint. */
  | {
      type: 'compact_context';
      compactionId: string;
      resourceEstimate?: { inputTokens: number; maxOutputTokens: number };
    }
  /** 执行指定工具调用 / Execute the specified tool calls */
  | { type: 'run_tools'; toolCallIds: string[] }
  /** 向用户请求输入（ask_user）/ Request user input (ask_user) */
  | { type: 'request_user_input'; interactionId: string; toolCallId: string }
  /** 请求用户审核方案 / Request user plan review */
  | { type: 'request_plan_review'; interactionId: string; toolCallId: string }
  /** 请求用户审批工具 / Request user tool approval */
  | { type: 'request_tool_approval'; interactionId: string; toolCallId: string }
  /** Ask the user how to resolve a required verification that exhausted automatic repair. */
  | {
      type: 'request_verification_decision';
      interactionId: string;
      verificationId: string;
    }
  /** Ask the App shell to perform one redacted MCP provider recovery action. */
  | {
      type: 'request_provider_action';
      interactionId: string;
      providerId: string;
      action: import('@/core/mcp/provider-errors').McpProviderRecoveryAction;
      originatingToolCallId: string;
    }
  /** Gate a new run until a required MCP provider is ready or explicitly waived. */
  | {
      type: 'request_provider_admission';
      interactionId: string;
      providerId: string;
      providerStatus: import('@/core/mcp/runtime-provider').McpProviderDirectoryStatus;
      retryable: boolean;
    }
  /** 执行自动审查 / Run auto-review */
  | { type: 'run_auto_review'; reviewId: string; toolCallId: string }
  /** Execute the next attempt of a durable VerificationSpec. */
  | { type: 'run_verification'; verificationId: string }
  /** Re-enter the model loop with deterministic verifier failures as repair context. */
  | { type: 'repair_verification'; verificationId: string }
  /** Execute a user-requested compensation after verification cannot establish success. */
  | { type: 'run_verification_compensation'; verificationId: string }
  /** Terminate a legacy subagent approval that cannot safely be resumed after recovery. */
  | {
      type: 'subagent.recovery_unavailable';
      toolCallId: string;
      subagentId: string;
      reason: string;
    }
  /** 发出最终事件并终止 / Emit final event and terminate */
  | { type: 'emit_final' }
  /** 停止执行 / Stop execution */
  | { type: 'stop' }
  /** 第二个 runner 被拒绝 / A second runner was rejected */
  | { type: 'busy'; reason: string }
  /** 持久化状态损坏，禁止继续执行 / Persisted state is corrupted */
  | {
      type: 'recovery_blocked';
      reason: string;
      failureKind: 'persistence_unavailable' | 'unknown';
    };

/** Returned when a second runner attempts to enter the same Kernel. */
export type RuntimeBusyEffect = { type: 'busy'; reason: string };

/**
 * 判断效果是否为终止型（不再产生后续效果）。
 * Returns true if the effect is terminal (no further effects follow).
 */
export function isTerminalEffect(effect: RuntimeEffect): boolean {
  return (
    effect.type === 'emit_final' ||
    effect.type === 'stop' ||
    effect.type === 'busy' ||
    effect.type === 'recovery_blocked'
  );
}

/**
 * 判断效果是否为中断型（需要等待外部输入）。
 * Returns true if the effect requires waiting for external input.
 */
export function isInterruptEffect(effect: RuntimeEffect): boolean {
  return (
    effect.type === 'request_user_input' ||
    effect.type === 'request_plan_review' ||
    effect.type === 'request_tool_approval' ||
    effect.type === 'request_verification_decision' ||
    effect.type === 'request_provider_action' ||
    effect.type === 'request_provider_admission'
  );
}

/** Internal lease attached to an effect while it is executing. */
export interface RuntimeEffectLease {
  effectId: string;
  expectedRevision: number;
  turnId: string;
  effect: RuntimeEffect;
}
