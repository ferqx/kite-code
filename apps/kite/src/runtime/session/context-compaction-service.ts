import {
  buildContextStatusReport,
  compactResetPreflight,
  contextCompactionTerminalNotice,
  createChatModel,
  createLocalCompactionDebugReporter,
  findSafeCompactionBoundary,
  inspectManualContextCompaction,
  manualContextCompactionEvent,
  resolveModelCapabilities,
} from '@kite/builtin-runtime/model';
import type { ContextStatusSnapshot } from '@kite/runtime-contract';
import type { RuntimeSessionCoordinator } from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import {
  type RuntimeExecutorDependencies,
  resolveRuntimeContextProjectionEnvironment,
} from '#app/bootstrap/runtime/runtime-effect-dependencies';
import type { RuntimeEvent, RuntimeState } from '#app/bootstrap/runtime/state-runtime';
import { getFeatureFlags } from '#app/config/features';
import {
  type ContextCompactionCommandResult,
  contextCompactionRequiresLiveControl,
  type SessionDeps,
  type SessionRuntime,
} from './runtime-session';

/** Owns manual compaction commands while reusing the session's one Host control and storage. */
export class ContextCompactionService {
  private readonly dependencies: () => SessionDeps;
  private readonly runtimeFor: (threadId: string) => SessionRuntime | undefined;

  constructor(
    dependencies: () => SessionDeps,
    runtimeFor: (threadId: string) => SessionRuntime | undefined,
  ) {
    this.dependencies = dependencies;
    this.runtimeFor = runtimeFor;
  }

  private runtimeCompactionDependencies(
    runtime: SessionRuntime,
    coordinator: RuntimeSessionCoordinator,
    signal: AbortSignal | undefined,
    onProgress: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
  ): RuntimeExecutorDependencies {
    const config = runtime.config;
    const modelRuntime = this.dependencies().modelInvocationRuntimeFactory(runtime.workspace);
    return {
      config,
      model: createChatModel(config),
      builtinToolCatalog: modelRuntime.builtinToolCatalog,
      toolPipelineComposition: modelRuntime.toolPipelineComposition,
      modelInvocationGateway: modelRuntime.gateway,
      modelEffectCoordinator: modelRuntime.modelEffects,
      capabilityExecution: this.dependencies().capabilityExecution,
      runtimeStore: coordinator.getStateRuntimeStorage(),
      mcpManager: runtime.mcpManager ?? undefined,
      skills: runtime.skillManifests,
      skillOptions: runtime.skillOptions ?? undefined,
      onCompactionProgress: onProgress,
      signal,
      compactionReporter: config.compaction?.localDebug?.enabled
        ? createLocalCompactionDebugReporter({
            enabled: true,
            directory: config.compaction.localDebug.directory,
            sessionId: runtime.threadId,
          })
        : undefined,
    };
  }

  /** Execute or queue a manual compaction command through the durable Kernel boundary. */
  async handle(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
  ): Promise<ContextCompactionCommandResult> {
    const rt = this.runtimeFor(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    return rt.runManualCompactionExclusive((signal) =>
      this.handleUnlocked(threadId, customInstructions, onProgress, onCommand, signal),
    );
  }

  /** Bridge-only path: Host owns serialization and the cancellation signal. */
  executeHost(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    return this.handleUnlocked(threadId, customInstructions, onProgress, onCommand, signal);
  }

  private async handleUnlocked(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    const rt = this.runtimeFor(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    const config = rt.config;
    const flags = getFeatureFlags(config);
    if (!flags.contextCompaction || !flags.contextCompactionManual) {
      return {
        events: [],
        text: 'Context compaction is disabled by feature flags.',
        isError: true,
      };
    }

    // Manual compaction is a Kernel effect, not an App-side recovery helper.
    // An idle SessionRuntime currently has no retained execution control that
    // can safely own the State 25 transition, lease, and Store 4 commit. Keep
    // the operation fail-closed until Host/session lifecycle supplies that
    // single coordinator; never open a second Kernel or executor here.
    const control = rt.authorizedExecutionControl;
    if (!control) return contextCompactionRequiresLiveControl();

    const runWithState = async (
      state: Readonly<RuntimeState>,
      processEvent: (event: RuntimeEvent) => void,
      execute?: () => Promise<RuntimeEvent[]>,
    ): Promise<ContextCompactionCommandResult> => {
      const commandEvent: Extract<RuntimeEvent, { type: 'user.command_invoked' }> = {
        type: 'user.command_invoked',
        commandId: crypto.randomUUID(),
        command: customInstructions ? `/compact ${customInstructions}` : '/compact',
      };
      // Render local commands immediately, but only persist a command once it
      // passes local preflight. A rejected `/compact` remains visible in the
      // current TUI alongside its result without becoming replayed history.
      const presentCommand = () => onCommand?.(commandEvent);
      const persistCommand = () => {
        processEvent(commandEvent);
        presentCommand();
      };

      const executeManualCompaction = async (
        compactionId: string,
      ): Promise<RuntimeEvent[] | undefined> => {
        if (!execute || rt.manualCompactionInFlightId === compactionId) return undefined;
        rt.manualCompactionInFlightId = compactionId;
        try {
          return await execute();
        } finally {
          if (rt.manualCompactionInFlightId === compactionId) {
            rt.manualCompactionInFlightId = null;
          }
        }
      };

      // A previous client version could persist a manual request after the
      // turn had stopped, but never schedule its effect. Once the session is
      // terminal, the next `/compact` must recover that durable request rather
      // than repeatedly reporting it as pending forever.
      const existingPending = state.context.pendingCompaction;
      if (existingPending?.reason === 'manual') {
        const boundary = findSafeCompactionBoundary(state);
        if (!boundary.eligible) {
          presentCommand();
          if (!execute) {
            return {
              events: [],
              text: 'A context compaction request is already pending.',
            };
          }
          const boundaryMessage =
            boundary.reason === 'No settled historical turn is old enough to compact.'
              ? 'Not enough messages to compact.'
              : (boundary.reason ?? 'Not enough messages to compact.');
          const failedEvent: RuntimeEvent = {
            type: 'context.compaction_failed',
            compactionId: existingPending.compactionId,
            sourceRevision: state.revision,
            errorKind: 'unsafe_boundary',
            message: boundaryMessage,
            retryable: false,
          };
          processEvent(failedEvent);
          return {
            events: [failedEvent],
            text: boundaryMessage,
          };
        }
        persistCommand();
        const produced = await executeManualCompaction(existingPending.compactionId);
        if (!produced) {
          return {
            events: [],
            text: 'A context compaction request is already pending.',
          };
        }
        const completed = produced.find(
          (candidate) => candidate.type === 'context.compaction_completed',
        );
        if (completed?.type === 'context.compaction_completed') {
          return {
            events: produced,
            text: contextCompactionTerminalNotice(completed).message,
          };
        }
        const failed = produced.find((candidate) => candidate.type === 'context.compaction_failed');
        const notice =
          failed?.type === 'context.compaction_failed'
            ? contextCompactionTerminalNotice(failed)
            : undefined;
        return {
          events: produced,
          text:
            notice?.message ??
            'Compaction queued; it will run when the Runtime reaches a safe boundary.',
          ...(notice?.isError ? { isError: true } : {}),
        };
      }

      const model = createChatModel(config);
      const capabilities = resolveModelCapabilities({
        config,
        adapter: model.capabilityMetadata,
      });
      const projectionEnvironment = resolveRuntimeContextProjectionEnvironment(
        {
          config,
          model,
          builtinToolCatalog: this.dependencies().builtinToolCatalog,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const status = inspectManualContextCompaction(
        state,
        config,
        capabilities,
        projectionEnvironment,
      );

      // Reject early — emit events so the rejection text persists across TUI restart
      // (replayed through handleRuntimeEventAction during session load).
      if (execute && !status.safeBoundary.eligible) {
        presentCommand();
        const boundaryMessage =
          status.safeBoundary.reason === 'No settled historical turn is old enough to compact.'
            ? 'Not enough messages to compact.'
            : (status.safeBoundary.reason ?? 'Not enough messages to compact.');
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
          message: boundaryMessage,
          retryable: false,
        };
        processEvent(failedEvent);
        return {
          events: [reqEvent, failedEvent],
          text: boundaryMessage,
        };
      }

      // A plain repeated /compact has no new source material once the active
      // checkpoint already covers the latest safe message. Custom summary
      // preferences apply only when there is new source material; /compact is
      // a capacity operation, not a general-purpose narrative editor.
      if (
        status.coveredThroughMessageId &&
        status.safeBoundary.lastMessageId === status.coveredThroughMessageId
      ) {
        presentCommand();
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
        config,
        customInstructions,
        capabilities,
        projectionEnvironment,
      }) as Extract<RuntimeEvent, { type: 'context.compaction_requested' }> | null;
      if (!event) {
        return {
          events: [],
          text: 'A context compaction request is already pending.',
        };
      }
      persistCommand();
      processEvent(event);
      if (!execute) {
        return {
          events: [event],
          text: 'Compaction queued; it will run after the current interaction reaches a settled boundary.',
        };
      }
      const produced = await executeManualCompaction(event.compactionId);
      if (!produced) {
        return {
          events: [event],
          text: 'A context compaction request is already pending.',
        };
      }
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

    {
      const liveState = control.getState();
      // `SET_IDLE` is rendered after the runtime emits its terminal event but
      // can precede the generator's final cleanup by one React turn. Wait for
      // that cleanup before injecting the request into the existing control.
      if (liveState.turn.status === 'completed' && liveState.interactions.kind === 'idle') {
        await rt.waitForRunCompletion();
        if (rt.authorizedExecutionControl !== control) {
          return rt.authorizedExecutionControl
            ? this.handleUnlocked(threadId, customInstructions, onProgress, onCommand, signal)
            : contextCompactionRequiresLiveControl();
        }
      }
      const runtimeCoordinator = this.dependencies().runtimeSessionCoordinator?.get(threadId);
      const execute =
        runtimeCoordinator && !runtimeCoordinator.isTurnActive()
          ? () =>
              runtimeCoordinator.executePendingCompaction({
                dependencies: this.runtimeCompactionDependencies(
                  rt,
                  runtimeCoordinator,
                  signal,
                  onProgress ?? (() => undefined),
                ),
                signal,
              })
          : undefined;
      return runWithState(control.getState(), control.processEvent, execute);
    }
  }

  /** PR 9: Handle /context — display context usage breakdown. */
  display(threadId: string): string {
    const rt = this.runtimeFor(threadId);
    if (!rt) return 'Session is unavailable.';
    const config = rt.config;
    const runtimeCoordinator = this.dependencies().runtimeSessionCoordinator?.get(threadId);
    if (!runtimeCoordinator) return 'Context status requires an active Runtime Host session.';
    const state = runtimeCoordinator.getState();
    const model = createChatModel(config);
    const environment = resolveRuntimeContextProjectionEnvironment(
      {
        config,
        model,
        builtinToolCatalog: this.dependencies().builtinToolCatalog,
        mcpManager: rt.mcpManager ?? undefined,
        skills: rt.skillManifests,
        skillOptions: rt.skillOptions ?? undefined,
      },
      state,
    );
    const capabilities = resolveModelCapabilities({
      config,
      adapter: model.capabilityMetadata,
    });
    const status = buildContextStatusReport(state, config, environment, capabilities);
    return `\n${status.text}`;
  }

  /** Rebuild the current context projection locally when a session becomes active. */
  snapshot(threadId: string): ContextStatusSnapshot | undefined {
    const rt = this.runtimeFor(threadId);
    if (!rt) return undefined;
    const config = rt.config;
    const control =
      rt.authorizedExecutionControl ??
      this.dependencies().runtimeSessionCoordinator?.get(threadId)?.control;
    if (!control) return undefined;
    try {
      const state = control.getState();
      const model = createChatModel(config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config,
          model,
          builtinToolCatalog: this.dependencies().builtinToolCatalog,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config,
        adapter: model.capabilityMetadata,
      });
      const { projection, preflight } = buildContextStatusReport(
        state,
        config,
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
    } catch {
      // Context status is advisory; internal rebuild failures stay out of TUI output.
      return undefined;
    }
  }

  /** PR 9: Handle /compact reset — preflight check and clear the active checkpoint. */
  async reset(threadId: string): Promise<ContextCompactionCommandResult> {
    const rt = this.runtimeFor(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    return rt.runManualCompactionExclusive(() => this.resetUnlocked(threadId));
  }

  /** Bridge-only path: Host owns serialization and the cancellation signal. */
  resetFromHost(threadId: string, signal?: AbortSignal): Promise<ContextCompactionCommandResult> {
    if (signal?.aborted) {
      const error = new Error('Session operation cancelled.');
      error.name = 'AbortError';
      return Promise.reject(error);
    }
    return this.resetUnlocked(threadId);
  }

  private async resetUnlocked(threadId: string): Promise<ContextCompactionCommandResult> {
    const rt = this.runtimeFor(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    const config = rt.config;
    const flags = getFeatureFlags(config);
    if (!flags.contextCompaction || !flags.contextCompactionManual) {
      return {
        events: [],
        text: 'Context compaction is disabled by feature flags.',
        isError: true,
      };
    }

    // When a model run owns the live Kernel, route the reset through that same
    // control plane so its eventual snapshot cannot overwrite the reset.
    const runtimeCoordinator = this.dependencies().runtimeSessionCoordinator?.get(threadId);
    const control = rt.authorizedExecutionControl ?? runtimeCoordinator?.control;
    if (!control) return contextCompactionRequiresLiveControl();
    {
      const state = control.getState();
      if (state.context.pendingCompaction) {
        return { events: [], text: 'Wait for the pending compaction to finish before reset.' };
      }
      const checkpoint = state.context.activeCheckpoint;
      if (!checkpoint) {
        return { events: [], text: 'No active checkpoint to reset.' };
      }
      const model = createChatModel(config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config,
          model,
          builtinToolCatalog: this.dependencies().builtinToolCatalog,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config,
        adapter: model.capabilityMetadata,
      });
      const preflight = compactResetPreflight(state, config, environment, capabilities);
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
      control.processEvent(resetEvent);
      return {
        events: [resetEvent],
        text: `Checkpoint ${checkpoint.compactionId.slice(0, 12)}... cleared. Context restored to full transcript.`,
      };
    }
  }
}
