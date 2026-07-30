import { Database } from 'bun:sqlite';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import type { McpRuntimeProvider } from '@/core/mcp';
import { createLocalCompactionDebugReporter } from '@/core/model/compaction-debug';
import {
  buildContextStatusReport,
  compactResetPreflight,
  inspectManualContextCompaction,
  manualContextCompactionEvent,
} from '@/core/model/context-compaction-manual';
import { contextCompactionTerminalNotice } from '@/core/model/context-compaction-presentation';
import type { ContextStatusSnapshot } from '@/core/model/context-status';
import { createChatModel } from '@/core/model/factory';
import { resolveModelCapabilities } from '@/core/model/model-capabilities';
import type { RuntimeUserAction } from '@/core/runtime/actions';
import {
  type RunRuntimeAgentInput,
  type RuntimeKernelControl,
  runRuntimeAgent,
} from '@/core/runtime/agent';
import type { RuntimeEffect } from '@/core/runtime/effects';
import type { RuntimeEvent } from '@/core/runtime/events';
import {
  createRuntimeEffectExecutor,
  resolveRuntimeContextProjectionEnvironment,
} from '@/core/runtime/executor';
import { createAgentKernel } from '@/core/runtime/kernel';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import { decideNextEffect } from '@/core/runtime/scheduler';
import type { RuntimeState } from '@/core/runtime/state';
import { getActivePlanning, getActiveTask, getAgentPhase } from '@/core/runtime/state';
import { defaultRuntimeJournalMode, runtimeStorePathFor } from '@/core/runtime/store';
import { createSandboxExecutor, resolveSandboxRuntime } from '@/core/sandbox/index';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { InterruptPayload, UserAction } from '@/protocol/actions';
import type { AgentPhase } from '@/protocol/events';
import type { Action } from './App';
import { fullModeUnavailableReason } from './interaction-mode';
import { providerActionInput, providerAdmissionInput } from './mcp/runtime-interrupts';
import type { McpController } from './mcp/types';
import type { TuiUserInputProvider } from './provider';
import { buildRunAgentParams } from './run-agent';
import type { SessionSnapshot, StatusState } from './types';

function isRecoverableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|timed out|rate limit|overloaded|\b429\b|\b5\d\d\b/.test(message);
}

/** 取消竞态不应作为用户可见错误输出。 */
export function isSilentCancellationMismatch(event: RuntimeEvent): boolean {
  return (
    event.type === 'run.error' &&
    event.message === 'Runtime action does not match the active interaction.'
  );
}

export {
  admitInteractionModeTarget,
  fullModeUnavailableReason,
  resolveInteractionModeTarget,
} from './interaction-mode';

/** 可丢弃的缓冲事件类型（text/reason 为非关键信息，丢弃时不丢失用户可见状态） */
const DISPOSABLE_EVENT_TYPES = new Set([
  'text',
  'reason',
  'model.text_delta',
  'model.reasoning_delta',
  'model.reasoning_completed',
]);

/** 工厂依赖：注入到每个 SessionRuntime */
export interface SessionDeps {
  config: AgentConfig;
  provider: TuiUserInputProvider;
  skillManifests: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpRuntimeProvider | null;
  mcpRecoveryController?: Pick<McpController, 'recover'> | null;
  /** checkpoint DB 路径，用于持久化 token 统计 / Checkpoint DB path for persisting token stats */
  checkpointPath: string;
}

export interface ContextCompactionCommandResult {
  events: RuntimeEvent[];
  text: string;
  isError?: boolean;
}

export interface PlanningModeExitResult {
  events: RuntimeEvent[];
  /** Runtime-authoritative phase after evaluating the exit request. */
  phase: AgentPhase;
}

/** 单会话运行时：持有独立的 AbortController、generator、缓冲 */
export class SessionRuntime {
  readonly threadId: string;
  readonly workspace: string;

  abortController: AbortController | null = null;
  agentLoopActive = false;
  pendingInterrupt = false;
  eventBuffer: RuntimeEvent[] = [];
  /** true if loaded from DB and state not yet hydrated / 从 DB 加载但尚未加载完整状态 */
  dormant = false;
  static readonly MAX_BUFFER = 1000;

  conversationHistory: string[] = [];
  thinkingLevel: string | null = null;
  interactionMode: 'accept_edits' | 'auto' | 'full';
  phase: AgentPhase = 'building';
  name: string;

  skillManifests: SkillManifest[];
  readonly skillOptions: SkillScanOptions | null;
  mcpManager: McpRuntimeProvider | null;
  mcpRecoveryController: Pick<McpController, 'recover'> | null;

  generator: AsyncGenerator<RuntimeEvent> | null = null;
  runtimeControl: RuntimeKernelControl | null = null;
  /** 当后台会话命中中断时通知 Manager 刷新快照 / Callback to notify Manager on background interrupt */
  notifyInterrupt: (() => void) | null = null;

  // ── 双模式代理：生成器始终使用 _proxyProvider，通过 _foreground 切换事件路由 ──
  private _foreground = true;
  private _foregroundWake: (() => void) | null = null;
  private _proxyProvider: Pick<TuiUserInputProvider, 'requestAction'>;
  /** 每实例独立的中断状态，不与 realProvider 共享 pendingResolve。中断永久等待用户处理 */
  private _pendingInterrupt: InterruptPayload | null = null;
  private _pendingResolve: ((action: UserAction) => void) | null = null;
  private _activeDispatch: ((action: Action) => void) | null = null;
  private _contentLoggingDisclosureShown = false;
  private _sessionLoggingStatusShown = false;
  /**
   * Remains pending while the previous generator is unwinding after abort().
   * abort() clears the user-visible running flag immediately, but a new run
   * must not enter the same RuntimeStore until the old loop has closed.
   */
  private _runCompletion: Promise<void> | null = null;
  private _deltaBuffer: {
    dispatch: ((action: Action) => void) | null;
    text?: Extract<RuntimeEvent, { type: 'model.text_delta' }>;
    reasoning?: Extract<RuntimeEvent, { type: 'model.reasoning_delta' }>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { dispatch: null, timer: null };

  constructor(threadId: string, workspace: string, deps: SessionDeps) {
    this.threadId = threadId;
    this.workspace = workspace;
    this.name = threadId;
    this.skillManifests = deps.skillManifests;
    this.skillOptions = deps.skillOptions;
    this.mcpManager = deps.mcpManager;
    this.mcpRecoveryController = deps.mcpRecoveryController ?? null;
    this.interactionMode = deps.config.interactionMode ?? 'accept_edits';

    this._proxyProvider = this._createProxyProvider();
  }

  // ── 公开 API ──

  abort(): void {
    this._flushModelDeltas();
    try {
      const cancellationEvents = this.runtimeControl?.cancelRun('Cancelled by user.') ?? [];
      for (const event of cancellationEvents) {
        if (this._activeDispatch) {
          this._routeRuntimeEvent(event, this._activeDispatch);
        } else {
          this._pushToBuffer(event);
        }
      }
    } catch (error) {
      const event: RuntimeEvent = {
        type: 'run.error',
        message: `Failed to persist cancellation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        recoverable: false,
      };
      if (this._activeDispatch) this._routeRuntimeEvent(event, this._activeDispatch);
      else this._pushToBuffer(event);
    } finally {
      // Resolve a suspended interaction before aborting so the generator can
      // leave requestAction and close its RuntimeStore handle.
      this.resolveInterrupt({ type: 'cancel' as const });
      this.abortController?.abort();
      this.abortController = null;
      this.agentLoopActive = false;
      this.generator = null;
      this._foregroundWake?.();
      this._foregroundWake = null;
    }
  }

  clearBuffer(): void {
    this._clearModelDeltas();
    this.eventBuffer = [];
    this.conversationHistory = [];
    this.pendingInterrupt = false;
  }

  /** 切换到前台：新事件路由到 provider.onEvent，唤醒挂起的后台中断 */
  setForeground(foreground: boolean): void {
    this._flushModelDeltas();
    this._foreground = foreground;
    if (foreground) {
      this._foregroundWake?.();
      this._foregroundWake = null;
    }
  }

  // ── Agent 运行 ──

  /** 运行 agent 任务。始终使用代理提供器，通过 _foreground 控制事件路由 */
  async runTask(
    task: string,
    deps: {
      dispatch: (action: Action) => void;
      provider: TuiUserInputProvider;
      config: AgentConfig;
      model?: import('@/core/model/factory').SupportedChatModel;
    },
    requestedPhase?: AgentPhase,
    initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>,
  ): Promise<void> {
    if (this.agentLoopActive) return;
    const previousRun = this._runCompletion;
    if (previousRun) await previousRun;
    // Several callers may have waited for the same cancelled run. Only the
    // first continuation may claim the session for a new loop.
    if (this.agentLoopActive) return;

    const shellContext =
      this.conversationHistory.length > 0 ? `\n${this.conversationHistory.join('\n')}` : '';
    const sandboxRuntime = resolveSandboxRuntime({ enabled: deps.config.sandbox.enabled });
    const fullModeReason = fullModeUnavailableReason(this.interactionMode, sandboxRuntime.backend);
    if (fullModeReason) {
      this.interactionMode = 'accept_edits';
      deps.dispatch({ type: 'SET_INTERACTION_MODE', mode: 'accept_edits' });
      deps.dispatch({
        type: 'RUNTIME_EVENT',
        event: { type: 'run.error', message: fullModeReason, recoverable: true },
      });
      return;
    }
    const shellExecutor = createSandboxExecutor({
      enabled: sandboxRuntime.enabled,
      workspace: this.workspace,
    });

    const abortController = new AbortController();

    const authMode =
      this.interactionMode === 'full' ? ('full_access' as const) : ('default' as const);

    const runAgentParams = buildRunAgentParams({
      task,
      threadId: this.threadId,
      workspace: this.workspace,
      config: deps.config,
      shellExecutor,
      signal: abortController.signal,
      thinkingLevel: this.thinkingLevel,
      skills: this.skillManifests,
      skillOptions: this.skillOptions,
      initialSkillActivations,
      mcpManager: this.mcpManager,
      shellContext,
      interactionMode: this.interactionMode,
      authorizationMode: authMode,
      phase: requestedPhase ?? 'building',
      sandboxBackend: sandboxRuntime.backend,
      model: deps.model,
      // 后台会话不再默认注入 full_access；中断会挂起到该会话，等待切回前台处理。
    });

    // 始终使用代理提供器 — 事件路由由 _foreground 控制
    const runtimeInput: RunRuntimeAgentInput = {
      task: runAgentParams.task,
      userId: runAgentParams.userId,
      threadId: runAgentParams.threadId,
      workspace: runAgentParams.workspace,
      runtimeStorePath: runtimeStorePathFor(runAgentParams.checkpointPath),
      config: runAgentParams.config,
      model: runAgentParams.model,
      shellExecutor: runAgentParams.shellExecutor,
      mcpManager: runAgentParams.mcpManager,
      skills: runAgentParams.skills,
      skillOptions: runAgentParams.skillOptions,
      initialSkillActivations: runAgentParams.initialSkillActivations,
      interactionMode: runAgentParams.interactionMode,
      authorizationMode: runAgentParams.authorizationMode,
      authorizationSource: runAgentParams.authorizationSource,
      phase: runAgentParams.phase,
      thinkingLevel: runAgentParams.thinkingLevel,
      sandboxBackend: runAgentParams.sandboxBackend,
      signal: runAgentParams.signal,
      frontend: 'tui',
      sessionLoggingPolicy: runAgentParams.sessionLoggingPolicy,
      sessionLoggingContentInspector: runAgentParams.sessionLoggingContentInspector,
      onSessionLoggingStatus: ({ mode }) => {
        if (!this._sessionLoggingStatusShown) {
          this._sessionLoggingStatusShown = true;
          deps.dispatch({
            type: 'LOCAL_TEXT',
            text: `  ⎿  Session logging mode: ${mode}.`,
          });
        }
        if (mode === 'content' && !this._contentLoggingDisclosureShown) {
          this._contentLoggingDisclosureShown = true;
          deps.dispatch({
            type: 'LOCAL_TEXT',
            text:
              '  ⎿  Session content logging is enabled by the release artifact and your explicit opt-in. ' +
              'Reasoning, tool/file content, secrets, and credentials remain excluded.',
          });
        }
      },
      onSessionLoggingDiagnostic: (message) => {
        deps.dispatch({
          type: 'LOCAL_TEXT',
          text: `  ⎿  ${message}`,
        });
      },
      onKernelControl: (control) => {
        this.runtimeControl = control;
      },
      onCompactionProgress: (phase) => {
        deps.dispatch({ type: 'SET_COMPACTION_PROGRESS', phase });
      },
    };
    const runtimeProvider: RuntimeActionProvider = {
      requestAction: (effect, state) => this._requestRuntimeAction(effect, state),
    };
    const generator = runRuntimeAgent(runtimeInput, runtimeProvider);
    let resolveRunCompletion!: () => void;
    const runCompletion = new Promise<void>((resolve) => {
      resolveRunCompletion = resolve;
    });
    this._runCompletion = runCompletion;

    // 所有状态变更必须在 try 块内，防止 buildRunAgentParams/runAgent 抛出时
    // agentLoopActive 和 abortController 泄漏导致会话永久冻结
    let aborted = false;
    try {
      this.agentLoopActive = true;
      this.abortController = abortController;
      this.generator = generator;
      this._activeDispatch = deps.dispatch;
      for await (const event of generator) {
        if (isSilentCancellationMismatch(event)) continue;
        this._routeRuntimeEvent(event, deps.dispatch);
        if (abortController.signal.aborted) {
          aborted = true;
          break;
        }
      }
      if (!aborted && this._foreground) {
        deps.dispatch({ type: 'SET_EXITED' });
      }
    } catch (e: any) {
      // Emit any accumulated retry events before the fatal error.
      // In the Kernel architecture, model retries are normally emitted
      // through the runtime event pipeline.  This catch block handles
      // retries that were accumulated on the error object before the
      // pipeline could emit them.
      if (Array.isArray(e.modelRetries)) {
        for (const retry of e.modelRetries) {
          if (this._foreground) {
            deps.dispatch({
              type: 'RUNTIME_EVENT',
              event: {
                type: 'model.retry',
                attempt: (retry as any).attempt ?? 0,
                maxAttempts: (retry as any).maxAttempts ?? 0,
                error: (retry as any).error ?? String(retry),
                delayMs: (retry as any).delayMs ?? 0,
              },
            });
          } else {
            this._pushToBuffer({
              type: 'model.retry',
              attempt: (retry as any).attempt ?? 0,
              maxAttempts: (retry as any).maxAttempts ?? 0,
              error: (retry as any).error ?? String(retry),
              delayMs: (retry as any).delayMs ?? 0,
            });
          }
        }
      }
      const errorEvent: RuntimeEvent = {
        type: 'run.error',
        message: e?.message ?? String(e),
        recoverable: isRecoverableError(e),
      };
      if (this._foreground) {
        deps.dispatch({ type: 'RUNTIME_EVENT', event: errorEvent });
      } else {
        this._pushToBuffer(errorEvent);
      }
      if (this._foreground) {
        deps.dispatch({ type: 'SET_EXITED' });
      }
    } finally {
      this.runtimeControl = null;
      this.agentLoopActive = false;
      this.abortController = null;
      this.generator = null;
      this._activeDispatch = null;
      if (this._runCompletion === runCompletion) {
        this._runCompletion = null;
      }
      resolveRunCompletion();
      if (this._foreground) {
        deps.provider.reset();
      }
    }
  }

  // ── 私有：代理提供器 & 缓冲 ──

  /** 推送事件到缓冲，溢出时优先丢弃非关键事件 */
  private _pushToBuffer(event: RuntimeEvent): void {
    if (this.eventBuffer.length >= SessionRuntime.MAX_BUFFER) {
      // 查找第一个可丢弃事件的下标
      const dropIdx = this.eventBuffer.findIndex((e) => DISPOSABLE_EVENT_TYPES.has(e.type));
      if (dropIdx >= 0) {
        this.eventBuffer.splice(dropIdx, 1);
      } else {
        // 无可丢弃事件，移除最老的
        this.eventBuffer.shift();
      }
    }
    this.eventBuffer.push(event);
  }

  /** Route the public RuntimeEvent stream directly to the foreground or buffer. */
  private _routeRuntimeEvent(event: RuntimeEvent, dispatch: (action: Action) => void): void {
    if (event.type === 'model.text_delta' || event.type === 'model.reasoning_delta') {
      this._bufferModelDelta(event, dispatch);
      return;
    }
    this._flushModelDeltas();
    if (this._foreground) {
      dispatch({ type: 'RUNTIME_EVENT', event });
      return;
    }
    // Background ask_user is immediately cancelled by the provider below; do not
    // replay a request the user can no longer answer after switching sessions.
    if (event.type === 'user_input.requested') return;
    this._pushToBuffer(event);
    if (event.type === 'approval.requested' || event.type === 'plan.review_requested') {
      this.pendingInterrupt = true;
      this.notifyInterrupt?.();
    }
  }

  private _bufferModelDelta(
    event: Extract<RuntimeEvent, { type: 'model.text_delta' | 'model.reasoning_delta' }>,
    dispatch: (action: Action) => void,
  ): void {
    this._deltaBuffer.dispatch = dispatch;
    if (event.type === 'model.text_delta') this._deltaBuffer.text = event;
    else this._deltaBuffer.reasoning = event;
    if (this._deltaBuffer.timer) return;
    this._deltaBuffer.timer = setTimeout(() => this._flushModelDeltas(), 50);
  }

  private _flushModelDeltas(): void {
    const buffered = this._deltaBuffer;
    if (buffered.timer) clearTimeout(buffered.timer);
    this._deltaBuffer = { dispatch: null, timer: null };
    for (const event of [buffered.reasoning, buffered.text]) {
      if (!event) continue;
      if (this._foreground && buffered.dispatch) {
        buffered.dispatch({ type: 'RUNTIME_EVENT', event });
      } else {
        this._pushToBuffer(event);
      }
    }
  }

  private _clearModelDeltas(): void {
    if (this._deltaBuffer.timer) clearTimeout(this._deltaBuffer.timer);
    this._deltaBuffer = { dispatch: null, timer: null };
  }

  /** Adapt existing Ink button actions at the UI edge and bind the persisted interaction id. */
  private async _requestRuntimeAction(
    effect: Extract<RuntimeEffect, { interactionId: string }>,
    state: Readonly<RuntimeState>,
  ): Promise<RuntimeUserAction> {
    if (effect.type === 'request_provider_action') {
      const response = await this._proxyProvider.requestAction({
        kind: 'input',
        question: providerActionInput(effect.providerId, effect.action),
      });
      if (response.type !== 'input' || response.text.toLowerCase().startsWith('later')) {
        return {
          type: 'provider_action_result',
          interactionId: effect.interactionId,
          outcome: 'deferred',
        };
      }
      const result = await this.mcpRecoveryController?.recover?.(effect.providerId, effect.action);
      return result?.outcome === 'completed'
        ? {
            type: 'provider_action_result',
            interactionId: effect.interactionId,
            outcome: 'completed',
            providerDirectoryRevision: result.providerDirectoryRevision,
          }
        : {
            type: 'provider_action_result',
            interactionId: effect.interactionId,
            outcome: 'failed',
            failureCode:
              effect.action === 'login'
                ? 'authentication_failed'
                : effect.action === 'approve'
                  ? 'approval_denied'
                  : 'provider_unavailable',
          };
    }
    if (effect.type === 'request_provider_admission') {
      const response = await this._proxyProvider.requestAction({
        kind: 'input',
        question: providerAdmissionInput(
          effect.providerId,
          effect.providerStatus,
          effect.retryable,
        ),
      });
      const choice = response.type === 'input' ? response.text.toLowerCase() : 'cancel';
      if (choice.startsWith('session') || choice.startsWith('waive')) {
        return {
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision: { kind: 'waive' },
        };
      }
      if (choice.startsWith('retry')) {
        const result = await this.mcpRecoveryController?.recover?.(effect.providerId, 'retry');
        return {
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision:
            result?.outcome === 'completed'
              ? {
                  kind: 'retry',
                  outcome: 'ready',
                  providerDirectoryRevision: result.providerDirectoryRevision,
                }
              : {
                  kind: 'retry',
                  outcome: 'unavailable',
                  providerStatus: result?.providerStatus ?? effect.providerStatus,
                },
        };
      }
      return {
        type: 'provider_admission_decision',
        interactionId: effect.interactionId,
        decision: { kind: 'cancel' },
      };
    }
    if (effect.type === 'request_verification_decision') {
      const record = state.verification.records[effect.verificationId];
      if (!record) {
        return {
          type: 'replan_verification',
          verificationId: effect.verificationId,
          instruction: 'Re-evaluate the missing verification state before continuing.',
        };
      }
      const options = [
        {
          id: 'replan',
          label: 'Repair / replan',
          description: 'Continue work using the verifier evidence.',
        },
        ...(record.spec.compensation
          ? [
              {
                id: 'compensate',
                label: 'Compensate',
                description: 'Run the declared compensation before deciding completion.',
              },
            ]
          : []),
        {
          id: 'waive',
          label: 'Waive verification',
          description: 'Finish explicitly marked as unverified.',
        },
      ];
      const action = await this._proxyProvider.requestAction({
        kind: 'input',
        question: {
          question: `Required verification is ${record.status}. Choose a recovery action.`,
          options,
          allow_free_text: true,
          recommended: 'replan',
          context: `verification:${record.spec.subject}`,
        },
      });
      if (action.type === 'input') {
        const answer = action.text.trim();
        const normalized = answer.toLowerCase();
        if (normalized.startsWith('compensate') && record.spec.compensation) {
          return {
            type: 'request_verification_compensation',
            verificationId: effect.verificationId,
          };
        }
        if (normalized.startsWith('waive')) {
          return {
            type: 'waive_verification',
            verificationId: effect.verificationId,
            reason:
              answer.replace(/^waive\s*:?\s*/i, '').trim() ||
              'User explicitly waived required verification in the verification decision prompt.',
          };
        }
        return {
          type: 'replan_verification',
          verificationId: effect.verificationId,
          instruction:
            answer.replace(/^replan\s*:?\s*/i, '').trim() ||
            'Repair the failed verification using its recorded evidence.',
        };
      }
      return {
        type: 'replan_verification',
        verificationId: effect.verificationId,
        instruction: 'The verification decision was cancelled; continue with a safe repair.',
      };
    }
    const interaction = state.interactions;
    const planReviewDecision = (
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
            clearPlanningContext: boolean;
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string },
    ): RuntimeUserAction | null =>
      interaction.kind === 'awaiting_review'
        ? {
            type: 'plan_review_decision',
            interactionId: effect.interactionId,
            planId: interaction.planId,
            version: interaction.version,
            structuralDigest: interaction.structuralDigest,
            decision,
          }
        : null;
    let payload: InterruptPayload;
    if (effect.type === 'request_user_input' && interaction.kind === 'awaiting_user_input') {
      payload = { kind: 'input', question: interaction.request };
    } else if (
      effect.type === 'request_tool_approval' &&
      interaction.kind === 'awaiting_tool_approval'
    ) {
      payload = { kind: 'approval', approval: interaction.approval };
    } else if (effect.type === 'request_plan_review' && interaction.kind === 'awaiting_review') {
      payload = {
        kind: 'plan_review',
        plan: interaction.plan,
        ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
      };
    } else {
      return {
        type: 'cancel',
        interactionId: effect.interactionId,
        reason: 'Interaction state changed.',
      };
    }

    const action = await this._proxyProvider.requestAction(payload);
    switch (action.type) {
      case 'input':
        return {
          type: 'input',
          interactionId: effect.interactionId,
          text: action.text,
          answers: action.answers,
        };
      case 'approve':
        return action.grant === 'none'
          ? {
              type: 'reject',
              interactionId: effect.interactionId,
              reason: 'No approval grant selected.',
            }
          : { type: 'approve', interactionId: effect.interactionId, grant: action.grant };
      case 'reject':
        return { type: 'reject', interactionId: effect.interactionId };
      case 'plan_review_decision':
        return planReviewDecision(action.decision)!;
      case 'cancel':
        return { type: 'cancel', interactionId: effect.interactionId };
      default:
        return {
          type: 'cancel',
          interactionId: effect.interactionId,
          reason: 'Unsupported UI action.',
        };
    }
  }

  /** 创建代理提供器。interrupt 使用运行时自身状态，永久等待用户处理 */
  private _createProxyProvider(): Pick<TuiUserInputProvider, 'requestAction'> {
    const self = this;
    const proxy = {
      async requestAction(payload: InterruptPayload): Promise<UserAction> {
        if (!self._foreground) {
          // user_input in background: auto-cancel (user can't respond)
          // need_approval won't fire due to authorizationOverride, but guard anyway
          if (
            payload.kind === 'input' &&
            !payload.question?.context?.startsWith('verification:') &&
            !payload.question?.context?.startsWith('mcp-provider-')
          ) {
            return { type: 'cancel' as const };
          }
          // 后台 tool_approval 中断：标记并等待前台切换
          // Background tool_approval: mark and wait for foreground switch
          self.pendingInterrupt = true;
          self.notifyInterrupt?.();
          await new Promise<void>((resolve) => {
            self._foregroundWake = resolve;
          });
          if (!self.abortController) {
            return { type: 'cancel' as const };
          }
          self.pendingInterrupt = false;
        }
        // 使用运行时自身的中断状态，永久等待用户处理
        self._pendingInterrupt = payload;
        return new Promise<UserAction>((resolve) => {
          self._pendingResolve = resolve;
        });
      },

      submitAction(action: UserAction): void {
        self.resolveInterrupt(action);
      },

      reset(): void {
        self.resolveInterrupt({ type: 'cancel' as const });
      },

      getPendingInterrupt(): InterruptPayload | null {
        return self._pendingInterrupt;
      },

      teardown(): Promise<void> {
        self.resolveInterrupt({ type: 'cancel' as const });
        return Promise.resolve();
      },
    };
    return proxy;
  }

  /** 解析挂起的中断（由 SessionManager 的中央 bridge 调用）/ Resolve pending interrupt (called by SessionManager's central bridge) */
  resolveInterrupt(action: UserAction): void {
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingInterrupt = null;
      r(action);
    }
  }
}

/** 多会话管理器：创建/切换/查快照 */
export class SessionManager {
  private runtimes = new Map<string, SessionRuntime>();
  private activeId = '';
  private snapshotCallback: ((threadId: string) => void) | null = null;
  private static sessionCounter = 0;
  /** token 统计内存缓存，避免 getSnapshot 每次打开 DB / In-memory token stats cache to avoid DB access in getSnapshot */
  private tokenStatsCache = new Map<
    string,
    { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number }
  >();
  /** 复用的 DB 连接，避免每次 saveTokenStats 开新连接 / Reusable DB connection to avoid opening a new one on every save */
  private _statsDb: Database | null = null;
  /** 防抖定时器：合并高频 token 统计变更为批量写入，避免每个 stream chunk 都写 DB
   *  Debounce timers: batch high-frequency token stat changes into fewer writes */
  private _statsDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 防抖延迟（毫秒）/ Debounce delay in ms */
  private static readonly STATS_DEBOUNCE_MS = 1000;

  private deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    // Central bridge: when UI components (ApprovalBlock, InputBlock) call submitAction
    // on the real provider, route to the active runtime's resolveInterrupt.
    // This runs once, avoiding the chain-wrapping anti-pattern of per-runtime bridges.
    if (deps.provider.submitAction) {
      const origSubmit = deps.provider.submitAction.bind(deps.provider);
      deps.provider.submitAction = (action: UserAction) => {
        origSubmit(action);
        const active = this.runtimes.get(this.activeId);
        active?.resolveInterrupt(action);
      };
    }
  }

  /** 懒加载 stats DB 连接 / Lazy-load the stats DB connection */
  private get statsDb(): Database {
    if (!this._statsDb) {
      this._statsDb = new Database(runtimeStorePathFor(this.deps.checkpointPath));
      // Keep token-stat writes compatible with concurrent RuntimeStore access.
      this._statsDb.run(`pragma journal_mode = ${defaultRuntimeJournalMode()}`);
      this._statsDb.run('pragma busy_timeout = 5000');
      this._statsDb.run(`create table if not exists session_stats (
        thread_id text primary key not null,
        cache_hit_tokens integer not null default 0,
        cache_miss_tokens integer not null default 0,
        total_tokens integer not null default 0,
        updated_at text not null default (datetime('now')))`);
    }
    return this._statsDb;
  }

  /** 持久化 token 统计到 checkpoint DB（防抖合并，避免每次 token 变化都写 DB）
   *  Persist token stats to DB with debounce, avoiding a write on every token change */
  saveTokenStats(threadId: string, status: StatusState, immediate = false): void {
    const stats = {
      cacheHitTokens: status.cacheHitTokens,
      cacheMissTokens: status.cacheMissTokens,
      totalTokens: status.totalTokens,
    };
    this.tokenStatsCache.set(threadId, stats);

    if (immediate) {
      this._flushTokenStatsNow(threadId, stats);
      return;
    }

    // 清除旧定时器，创建新的合并定时器
    const existing = this._statsDebounceTimers.get(threadId);
    if (existing) clearTimeout(existing);
    this._statsDebounceTimers.set(
      threadId,
      setTimeout(() => {
        this._statsDebounceTimers.delete(threadId);
        // 从缓存读取最新值而非闭包捕获，避免跨调用 stale write 风险
        // Read latest from cache rather than closure-captured value to avoid stale-write risk
        const latest = this.tokenStatsCache.get(threadId) ?? stats;
        this._flushTokenStatsNow(threadId, latest);
      }, SessionManager.STATS_DEBOUNCE_MS),
    );
  }

  /** 立即写入 DB（绕过防抖）/ Immediate DB write (bypasses debounce) */
  private _flushTokenStatsNow(
    threadId: string,
    stats: { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number },
  ): void {
    try {
      this.statsDb.run(
        `insert or replace into session_stats (thread_id, cache_hit_tokens, cache_miss_tokens, total_tokens, updated_at)
         values (?, ?, ?, ?, datetime('now'))`,
        [threadId, stats.cacheHitTokens, stats.cacheMissTokens, stats.totalTokens],
      );
    } catch (e) {
      console.warn(
        `[SessionManager] Failed to persist token stats for ${threadId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  createSession(workspace: string): string {
    // TUI navigation is an explicit cancellation gesture. Other clients may
    // retain background runs because their navigation model is different.
    const oldRt = this.runtimes.get(this.activeId);
    if (oldRt) {
      if (oldRt.agentLoopActive) oldRt.abort();
      else oldRt.resolveInterrupt({ type: 'cancel' as const });
      oldRt.setForeground(false);
      oldRt.pendingInterrupt = false;
    }
    const threadId = `tui-${Date.now().toString(36)}-${SessionManager.sessionCounter++}`;
    const rt = new SessionRuntime(threadId, workspace, this.deps);
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    this.runtimes.set(threadId, rt);
    this.activeId = threadId;
    return threadId;
  }

  getRuntime(threadId: string): SessionRuntime | undefined {
    return this.runtimes.get(threadId);
  }

  /** Execute or queue a manual compaction command through the durable Kernel boundary. */
  async handleContextCompaction(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase:
        | import('@/core/model/context-compaction-presentation').ContextCompactionProgressPhase
        | undefined,
    ) => void,
  ): Promise<ContextCompactionCommandResult> {
    const rt = this.runtimes.get(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    const flags = getFeatureFlags(this.deps.config);
    if (!flags.contextCompactionV2 || !flags.contextCompactionManualV1) {
      return {
        events: [],
        text: 'Context compaction is disabled by feature flags.',
        isError: true,
      };
    }

    const runWithState = async (
      state: Readonly<RuntimeState>,
      processEvent: (event: RuntimeEvent) => void,
      execute?: (event: RuntimeEvent) => Promise<RuntimeEvent[]>,
    ): Promise<ContextCompactionCommandResult> => {
      processEvent({
        type: 'user.command_invoked',
        commandId: crypto.randomUUID(),
        command: customInstructions ? `/compact ${customInstructions}` : '/compact',
      });
      const model = createChatModel(this.deps.config);
      const capabilities = resolveModelCapabilities({
        config: this.deps.config,
        adapter: model.capabilityMetadata,
      });
      const status = inspectManualContextCompaction(state, this.deps.config, capabilities);

      // Reject early — emit events so the rejection text persists across TUI restart
      // (replayed through handleRuntimeEventAction during session load).
      if (
        !status.safeBoundary.eligible &&
        status.safeBoundary.reason === 'No settled historical turn is old enough to compact.'
      ) {
        const compactId = crypto.randomUUID();
        const reqEvent: RuntimeEvent = {
          type: 'context.compaction_requested',
          compactionId: compactId,
          reason: 'manual',
          requestedAtRevision: state.revision,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: status.preflight.estimate,
          ...(customInstructions ? { customInstructions } : {}),
        };
        processEvent(reqEvent);
        const failedEvent: RuntimeEvent = {
          type: 'context.compaction_failed',
          compactionId: compactId,
          sourceRevision: state.revision,
          errorKind: 'unsafe_boundary',
          message: 'Not enough messages to compact.',
          retryable: false,
        };
        processEvent(failedEvent);
        return {
          events: [reqEvent, failedEvent],
          text: 'Not enough messages to compact.',
        };
      }

      // A plain repeated /compact has no new source material once the active
      // checkpoint already covers the latest safe message. Do not spend a
      // provider request re-summarizing the same narrative only to fail the
      // minimum-reduction check. Explicit custom instructions still opt into
      // reworking the existing narrative.
      if (
        !customInstructions &&
        status.coveredThroughMessageId &&
        status.safeBoundary.lastMessageId === status.coveredThroughMessageId
      ) {
        const compactId = crypto.randomUUID();
        const reqEvent: RuntimeEvent = {
          type: 'context.compaction_requested',
          compactionId: compactId,
          reason: 'manual',
          requestedAtRevision: state.revision,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: status.preflight.estimate,
        };
        processEvent(reqEvent);
        const failedEvent: RuntimeEvent = {
          type: 'context.compaction_failed',
          compactionId: compactId,
          sourceRevision: state.revision,
          errorKind: 'unsafe_boundary',
          message: 'No new messages to compact.',
          retryable: false,
        };
        processEvent(failedEvent);
        return {
          events: [reqEvent, failedEvent],
          text: 'No new messages to compact.',
        };
      }

      const event = manualContextCompactionEvent({
        state,
        config: this.deps.config,
        customInstructions,
        capabilities,
      });
      if (!event) {
        return {
          events: [],
          text: 'A context compaction request is already pending.',
        };
      }
      processEvent(event);
      if (!execute) {
        return {
          events: [event],
          text: 'Compaction queued; it will run after the current interaction reaches a settled boundary.',
        };
      }
      const produced = await execute(event);
      const completed = produced.find(
        (candidate) => candidate.type === 'context.compaction_completed',
      );
      const failed = produced.find((candidate) => candidate.type === 'context.compaction_failed');
      if (completed?.type === 'context.compaction_completed') {
        const notice = contextCompactionTerminalNotice(completed);
        return {
          events: [event, ...produced],
          text: notice.message,
        };
      }
      const notice =
        failed?.type === 'context.compaction_failed'
          ? contextCompactionTerminalNotice(failed)
          : undefined;
      return {
        events: [event, ...produced],
        text:
          notice?.message ??
          'Compaction queued; it will run when the Runtime reaches a safe boundary.',
        ...(notice?.isError ? { isError: true } : {}),
      };
    };

    if (rt.runtimeControl) {
      return runWithState(rt.runtimeControl.getState(), rt.runtimeControl.processEvent);
    }

    const kernel = createAgentKernel({
      threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: runtimeStorePathFor(this.deps.checkpointPath),
      interactionMode: rt.interactionMode,
      phase: 'building',
    });
    try {
      return await runWithState(
        kernel.getState(),
        (event) => {
          kernel.processEvent(event);
        },
        async () => {
          const scheduled = decideNextEffect(kernel.getState());
          const pending = kernel.getState().context.pendingCompaction;
          const effect =
            scheduled.type === 'compact_context' ||
            (scheduled.type === 'emit_final' && pending?.reason === 'manual')
              ? {
                  type: 'compact_context' as const,
                  compactionId: pending?.compactionId ?? '',
                }
              : scheduled;
          if (effect.type !== 'compact_context' || !effect.compactionId) return [];
          const executor = createRuntimeEffectExecutor({
            config: this.deps.config,
            model: createChatModel(this.deps.config),
            mcpManager: rt.mcpManager ?? undefined,
            skills: rt.skillManifests,
            skillOptions: rt.skillOptions ?? undefined,
            onCompactionProgress: onProgress,
            compactionReporter: this.deps.config.compaction?.localDebug?.enabled
              ? createLocalCompactionDebugReporter({
                  enabled: true,
                  directory: this.deps.config.compaction.localDebug.directory,
                  sessionId: threadId,
                })
              : undefined,
          });
          const lease = kernel.beginEffect(effect);
          const events = await executor(effect, kernel.getState());
          return kernel.applyEffectResult(lease, events) ? events : [];
        },
      );
    } finally {
      kernel.close();
    }
  }

  /** PR 9: Handle /context — display context usage breakdown. */
  handleContextDisplay(threadId: string): string {
    const rt = this.runtimes.get(threadId);
    if (!rt) return 'Session is unavailable.';
    const kernel = createAgentKernel({
      threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: runtimeStorePathFor(this.deps.checkpointPath),
      interactionMode: rt.interactionMode,
      phase: 'building',
    });
    try {
      const state = kernel.getState();
      const model = createChatModel(this.deps.config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config: this.deps.config,
          model,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config: this.deps.config,
        adapter: model.capabilityMetadata,
      });
      const status = buildContextStatusReport(state, this.deps.config, environment, capabilities);
      return `\n${status.text}`;
    } finally {
      kernel.close();
    }
  }

  /** Rebuild the current context projection locally when a session becomes active. */
  buildContextStatusSnapshot(threadId: string): ContextStatusSnapshot | undefined {
    const rt = this.runtimes.get(threadId);
    if (!rt) return undefined;
    const kernel = rt.runtimeControl
      ? undefined
      : createAgentKernel({
          threadId,
          userId: 'tui',
          workspace: rt.workspace,
          storePath: runtimeStorePathFor(this.deps.checkpointPath),
          interactionMode: rt.interactionMode,
          phase: 'building',
        });
    try {
      const state = rt.runtimeControl?.getState() ?? kernel!.getState();
      const model = createChatModel(this.deps.config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config: this.deps.config,
          model,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config: this.deps.config,
        adapter: model.capabilityMetadata,
      });
      const { projection, preflight } = buildContextStatusReport(
        state,
        this.deps.config,
        environment,
        capabilities,
      );
      const checkpoint = state.context.activeCheckpoint;
      return {
        estimate: projection.estimate,
        status: preflight.status,
        ...(preflight.usableInputTokens != null
          ? { usableInputTokens: preflight.usableInputTokens }
          : {}),
        ...(preflight.utilization != null ? { utilization: preflight.utilization } : {}),
        ...(checkpoint
          ? {
              activeCheckpointId: checkpoint.compactionId,
              inputTokensBefore: checkpoint.inputTokensBefore,
              inputTokensAfter: checkpoint.inputTokensAfter,
            }
          : {}),
      };
    } catch (error) {
      console.warn(
        `[SessionManager] Failed to rebuild context status for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    } finally {
      kernel?.close();
    }
  }

  /** PR 9: Handle /compact reset — preflight check and clear the active checkpoint. */
  async handleContextReset(threadId: string): Promise<ContextCompactionCommandResult> {
    const rt = this.runtimes.get(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    const flags = getFeatureFlags(this.deps.config);
    if (!flags.contextCompactionV2 || !flags.contextCompactionManualV1) {
      return {
        events: [],
        text: 'Context compaction is disabled by feature flags.',
        isError: true,
      };
    }

    // REVIEW-FIX: When the model is running, route through the live kernel's
    // processEvent to avoid kernel-racing issues (events lost on snapshot replay).
    // Match the pattern used by handleCompact (line 865-866).
    if (rt.runtimeControl) {
      const state = rt.runtimeControl.getState();
      const checkpoint = state.context.activeCheckpoint;
      if (!checkpoint) {
        return { events: [], text: 'No active checkpoint to reset.' };
      }
      const model = createChatModel(this.deps.config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config: this.deps.config,
          model,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config: this.deps.config,
        adapter: model.capabilityMetadata,
      });
      const preflight = compactResetPreflight(state, this.deps.config, environment, capabilities);
      if (!preflight.safe) {
        return { events: [], text: `Cannot reset: ${preflight.reason}`, isError: true };
      }
      const resetEvent: RuntimeEvent = {
        type: 'context.compaction_reset',
        checkpointId: checkpoint.compactionId,
        reason: 'manual',
      };
      rt.runtimeControl.processEvent(resetEvent);
      return {
        events: [resetEvent],
        text: `Checkpoint ${checkpoint.compactionId.slice(0, 12)}... cleared. Context restored to full transcript.`,
      };
    }

    // Fallback: create a standalone kernel for sessions without a running agent.
    const kernel = createAgentKernel({
      threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: runtimeStorePathFor(this.deps.checkpointPath),
      interactionMode: rt.interactionMode,
      phase: 'building',
    });
    try {
      const state = kernel.getState();
      const checkpoint = state.context.activeCheckpoint;
      if (!checkpoint) {
        return { events: [], text: 'No active checkpoint to reset.' };
      }

      const model = createChatModel(this.deps.config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config: this.deps.config,
          model,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config: this.deps.config,
        adapter: model.capabilityMetadata,
      });
      const preflight = compactResetPreflight(state, this.deps.config, environment, capabilities);
      if (!preflight.safe) {
        return {
          events: [],
          text: `Cannot reset: ${preflight.reason}`,
          isError: true,
        };
      }

      const resetEvent: RuntimeEvent = {
        type: 'context.compaction_reset',
        checkpointId: checkpoint.compactionId,
        reason: 'manual',
      };
      kernel.processEvent(resetEvent);
      return {
        events: [resetEvent],
        text: `Checkpoint ${checkpoint.compactionId.slice(0, 12)}... cleared. Context restored to full transcript.`,
      };
    } finally {
      kernel.close();
    }
  }

  /** Persist a plan-mode intent before the user has supplied the task text. */
  enterPlanningMode(threadId: string): RuntimeEvent[] {
    const rt = this.runtimes.get(threadId);
    if (!rt) return [];
    const kernel = createAgentKernel({
      threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: runtimeStorePathFor(this.deps.checkpointPath),
      interactionMode: rt.interactionMode,
      phase: 'building',
    });
    try {
      const events: RuntimeEvent[] = [];
      let active = getActiveTask(kernel.getState());
      const planning = getActivePlanning(kernel.getState());
      if (active && planning.kind !== 'building_without_plan') {
        return events;
      }
      if (active?.sideEffectsStarted) return events;
      if (!active) {
        const started: RuntimeEvent = {
          type: 'task.started',
          taskId: crypto.randomUUID(),
          userGoal: '',
          turnId: kernel.getState().turn.turnId,
        };
        events.push(started);
        kernel.processEvent(started);
        active = getActiveTask(kernel.getState());
      }
      if (!active) return events;
      const entered: RuntimeEvent = {
        type: 'planning.entered',
        taskId: active.taskId,
        source: 'user_command',
      };
      events.push(entered);
      kernel.processEvent(entered);
      return events;
    } finally {
      kernel.close();
    }
  }

  /** Persist an explicit plan-mode exit; review cancellation remains separate. */
  exitPlanningMode(threadId: string): PlanningModeExitResult | null {
    const rt = this.runtimes.get(threadId);
    if (!rt) return null;
    const kernel = createAgentKernel({
      threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: runtimeStorePathFor(this.deps.checkpointPath),
      interactionMode: rt.interactionMode,
      phase: 'building',
    });
    try {
      const active = getActiveTask(kernel.getState());
      const planning = getActivePlanning(kernel.getState());
      const phase = getAgentPhase(planning);
      // run.completed closes the Core Task before the TUI user explicitly
      // leaves its sticky plan input mode. In that settled state there is no
      // Task lifecycle left to cancel; report the authoritative building
      // phase so the client can reconcile its projection locally.
      if (!active || phase !== 'planning') return { events: [], phase };
      if (kernel.getState().interactions.kind !== 'idle') {
        return { events: [], phase };
      }
      const events: RuntimeEvent[] = [
        { type: 'planning.exited', taskId: active.taskId, reason: 'Exited Plan Mode.' },
        { type: 'task.cancelled', taskId: active.taskId, reason: 'Exited Plan Mode.' },
      ];
      kernel.processEventBatch(events);
      return { events, phase: 'building' };
    } finally {
      kernel.close();
    }
  }

  getActiveId(): string {
    return this.activeId;
  }

  switchSession(fromId: string, toId: string): void {
    // In the TUI, leaving a session cancels its current turn. This adapter
    // policy must not be lifted into Core: a future client can keep the same
    // Runtime and interrupt alive while only changing the visible session.
    const fromRt = this.runtimes.get(fromId);
    if (fromRt) {
      if (fromRt.agentLoopActive) fromRt.abort();
      else fromRt.resolveInterrupt({ type: 'cancel' as const });
      fromRt.setForeground(false);
      fromRt.pendingInterrupt = false;
    }
    this.activeId = toId;
  }

  /** 懒加载：首次访问时从 DB 批量载入 token 统计到内存缓存
   *  Lazy load: populate in-memory cache from DB on first access */
  private ensureTokenStatsLoaded(): void {
    if (this.tokenStatsCache.size > 0) return;
    try {
      const rows = this.statsDb
        .query(
          `select thread_id, cache_hit_tokens, cache_miss_tokens, total_tokens from session_stats`,
        )
        .all() as Array<{
        thread_id: string;
        cache_hit_tokens: number;
        cache_miss_tokens: number;
        total_tokens: number;
      }>;
      for (const r of rows) {
        this.tokenStatsCache.set(r.thread_id, {
          cacheHitTokens: r.cache_hit_tokens,
          cacheMissTokens: r.cache_miss_tokens,
          totalTokens: r.total_tokens,
        });
      }
    } catch (e) {
      console.warn(
        `[SessionManager] Failed to load token stats from DB: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 创建会话快照列表。
   *  @param prevSessions 前一次 snapshot 数组，用于继承已累积的 token 统计等跨生命周期状态。
   *  Create session snapshot list.
   *  @param prevSessions previous snapshot array, used to inherit accumulated token stats across lifecycles. */
  getSnapshot(
    prevSessions?: ReadonlyArray<{ threadId: string; status: StatusState }>,
  ): SessionSnapshot[] {
    // 首次调用时从 DB 批量加载到内存缓存 / Bulk load from DB into memory cache on first call
    this.ensureTokenStatsLoaded();
    const prevMap = new Map(prevSessions?.map((s) => [s.threadId, s.status]));
    const result: SessionSnapshot[] = [];
    for (const [threadId, rt] of this.runtimes) {
      const prevStatus = prevMap.get(threadId);
      const dbStats = this.tokenStatsCache.get(threadId);
      const rawStatus = {
        ...initialStatusSnapshot(),
        ...(dbStats ?? {}), // 从 DB 恢复的 token 统计
        ...(prevStatus ?? {}), // 内存中保留的状态（优先级最高）
      };
      // 从恢复的 token 计数重新计算缓存命中率（派生值，不单独持久化）
      // Recompute cacheHitRate from restored token counts (derived, not persisted separately)
      const cacheTotal = rawStatus.cacheHitTokens + rawStatus.cacheMissTokens;
      rawStatus.cacheHitRate = cacheTotal > 0 ? rawStatus.cacheHitTokens / cacheTotal : 0;
      result.push({
        threadId,
        name: rt.name,
        workspace: rt.workspace,
        active: threadId === this.activeId,
        running: rt.agentLoopActive,
        pendingInterrupt: rt.pendingInterrupt,
        interrupt: null,
        plan: null,
        status: rawStatus,
        turns: [],
        pendingToolCalls: {},
      });
    }
    return result;
  }

  onInterruptPending(threadId: string): void {
    this.snapshotCallback?.(threadId);
  }

  onStatusChange(threadId: string): void {
    this.snapshotCallback?.(threadId);
  }

  /** 设置会话名称（在 generateSessionName 后调用） */
  setName(threadId: string, name: string): void {
    const rt = this.runtimes.get(threadId);
    if (rt) rt.name = name;
  }

  setSnapshotCallback(fn: (threadId: string) => void): void {
    this.snapshotCallback = fn;
  }

  // ── 供 index.tsx /new 拦截使用 ──

  /** 注册一个由外部创建的 threadId（如 FORK） */
  registerSession(threadId: string, workspace: string): SessionRuntime {
    const rt = new SessionRuntime(threadId, workspace, this.deps);
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    this.runtimes.set(threadId, rt);
    return rt;
  }

  /** 检查指定 threadId 是否已有运行时 / Check if a runtime exists for threadId */
  hasRuntime(threadId: string): boolean {
    return this.runtimes.has(threadId);
  }

  /** 移除运行时（会话删除后调用）/ Remove a runtime (called after session deletion) */
  removeRuntime(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (rt) {
      rt.abort();
      rt.clearBuffer();
    }
    this.runtimes.delete(threadId);
    // Don't leave activeId pointing to a deleted session
    if (this.activeId === threadId) {
      this.activeId = '';
    }
  }

  /** 中止所有运行中的会话（退出时调用）/ Abort all running sessions (called on exit) */
  abortAll(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.agentLoopActive) {
        rt.abort();
      }
    }
  }

  /** 清理资源：刷新所有防抖写入、关闭 DB 连接 / Cleanup: flush all pending debounce writes, close DB */
  dispose(): void {
    // 清除所有防抖定时器并立即写入最新值
    // Clear all debounce timers and write latest values immediately
    for (const [threadId, timer] of this._statsDebounceTimers) {
      clearTimeout(timer);
      const stats = this.tokenStatsCache.get(threadId);
      if (stats) this._flushTokenStatsNow(threadId, stats);
    }
    this._statsDebounceTimers.clear();

    // 关闭 stats DB 连接，确保 WAL/SHM 文件正确合并
    // Close stats DB connection to properly merge WAL/SHM files
    if (this._statsDb) {
      try {
        this._statsDb.close();
      } catch {
        /* best-effort */
      }
      this._statsDb = null;
    }
  }

  /** 同步 skills 到所有现有运行时（skills 扫描完成后调用）/ Sync skill manifests to all existing runtimes (called after skill scan completes) */
  updateSkillManifests(manifests: SkillManifest[]): void {
    this.deps.skillManifests = manifests;
    for (const rt of this.runtimes.values()) {
      rt.skillManifests = manifests;
    }
  }

  /** Sync the runtime-facing MCP provider to all existing sessions. */
  updateMcpRuntimeProvider(provider: McpRuntimeProvider | null): void {
    this.deps.mcpManager = provider;
    for (const rt of this.runtimes.values()) {
      rt.mcpManager = provider;
    }
  }

  updateMcpRecoveryController(controller: Pick<McpController, 'recover'> | null): void {
    this.deps.mcpRecoveryController = controller;
    for (const runtime of this.runtimes.values()) {
      runtime.mcpRecoveryController = controller;
    }
  }
}

function initialStatusSnapshot(): StatusState {
  return {
    phase: 'building',
    plan: null,
    pendingPlan: null,
    authorization: 'default',
    workspaceAccess: 'write',
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: '',
    modelName: '',
    thinkingMode: '',
    retryState: null,
  };
}
