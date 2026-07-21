import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import {
  type ContextCompactor,
  executeContextCompaction,
} from '@/core/controllers/compaction-controller';
import {
  invokeRuntimeModel,
  resolveContextProjectionEnvironment,
} from '@/core/controllers/model-controller';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import {
  createAutoReviewModel,
  reviewToolApproval,
  reviewVerificationEvidence,
} from '@/core/execution/reviewer';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { McpRuntimeProvider } from '@/core/mcp';
import {
  createModelContextSummaryGenerator,
  createStructuredContextCompactor,
} from '@/core/model/compaction-summary';
import type { SupportedChatModel } from '@/core/model/factory';
import { resolveModelCapabilities } from '@/core/model/model-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';
import { executeVerificationEffect } from '@/core/verification';
import type { RuntimeEffectExecutor } from './kernel';

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  subagentEventSink?: SubAgentEventSink;
  contextCompactor?: ContextCompactor;
}

/** Resolve the reviewer timeout while preserving the pre-flag compatibility path. */
export function resolveAutoReviewTimeout(config: AgentConfig): number {
  return getFeatureFlags(config).autoReviewV2 ? (config.autoReview?.timeoutMs ?? 15_000) : 15_000;
}

export function resolveRuntimeContextProjectionEnvironment(
  dependencies: RuntimeExecutorDependencies,
  state: import('./state').RuntimeState,
) {
  const flags = getFeatureFlags(dependencies.config);
  const skillCatalog =
    dependencies.skillOptions && flags.skillWorkflowV1 && flags.skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : dependencies.skillCatalog;
  return resolveContextProjectionEnvironment({
    state,
    config: dependencies.config,
    model: dependencies.model,
    shellExecutor: dependencies.shellExecutor,
    mcpManager: dependencies.mcpManager,
    skills: dependencies.skills,
    skillOptions: dependencies.skillOptions,
    skillCatalog,
    subagentEventSink: dependencies.subagentEventSink,
    signal: dependencies.signal,
  });
}

/** Build the production executor for Kernel effects. */
export function createRuntimeEffectExecutor(
  dependencies: RuntimeExecutorDependencies,
): RuntimeEffectExecutor {
  // Tool definitions need a sink to expose the task tool during model calls.
  // executeRuntimeTools converts the real lifecycle callbacks into durable
  // RuntimeEvents, so this fallback is only a capability marker.
  const subagentEventSink: SubAgentEventSink = dependencies.subagentEventSink ?? (() => {});
  const currentSkillCatalog = (): SkillCatalogSnapshot | undefined =>
    dependencies.skillOptions &&
    getFeatureFlags(dependencies.config).skillWorkflowV1 &&
    getFeatureFlags(dependencies.config).skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : undefined;
  const contextCompactor =
    dependencies.contextCompactor ??
    createStructuredContextCompactor({
      generate: createModelContextSummaryGenerator({
        model: dependencies.model,
        signal: dependencies.signal,
      }),
      recentTurns: dependencies.config.compaction?.recentTurns,
      maxSummaryTokens: dependencies.config.compaction?.maxSummaryTokens,
      maxSummaryInputTokens: dependencies.config.compaction?.maxSummaryInputTokens,
      targetRatio: dependencies.config.compaction?.targetRatio,
      modelCapabilities: resolveModelCapabilities({
        config: dependencies.config,
        adapter: dependencies.model.capabilityMetadata,
      }),
      requestMaxOutputTokens:
        typeof dependencies.config.modelKwargs?.maxOutputTokens === 'number'
          ? dependencies.config.modelKwargs.maxOutputTokens
          : typeof dependencies.config.modelKwargs?.maxTokens === 'number'
            ? dependencies.config.modelKwargs.maxTokens
            : undefined,
      providerSafetyRatio: dependencies.config.compaction?.providerSafetyRatio,
    });
  return async (effect, state, emit) => {
    if (effect.type === 'compact_context') {
      const projectionEnvironment = resolveRuntimeContextProjectionEnvironment(
        { ...dependencies, subagentEventSink },
        state,
      );
      return executeContextCompaction({
        state,
        compactionId: effect.compactionId,
        compact: contextCompactor,
        projectionEnvironment,
      });
    }
    if (effect.type === 'call_model') {
      return invokeRuntimeModel({
        model: dependencies.model,
        state,
        config: dependencies.config,
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        skills: dependencies.skills,
        skillOptions: dependencies.skillOptions,
        skillCatalog: currentSkillCatalog(),
        subagentEventSink,
        signal: dependencies.signal,
        emitRuntimeEvent: emit,
      });
    }
    if (effect.type === 'run_tools') {
      try {
        return await executeRuntimeTools({
          state,
          toolCallIds: effect.toolCallIds,
          shellExecutor: dependencies.shellExecutor,
          mcpManager: dependencies.mcpManager,
          skillManifests: dependencies.skills,
          skillOptions: dependencies.skillOptions,
          skillCatalog: currentSkillCatalog(),
          signal: dependencies.signal,
          taskConfig: dependencies.config,
          taskModel: dependencies.model,
          subagentEventSink,
          emitRuntimeEvent: emit,
        });
      } catch (error) {
        const mcpCalls = effect.toolCallIds.flatMap((toolCallId) => {
          const call = state.tools.calls[toolCallId];
          return call?.name.startsWith('mcp__') ? [{ toolCallId, call }] : [];
        });
        if (mcpCalls.length !== effect.toolCallIds.length) throw error;
        return mcpCalls.map(({ toolCallId }) => ({
          type: 'tool.failed' as const,
          toolCallId,
          failure: classifyFailure(
            'tool_runtime_error',
            'The MCP tool failed inside the local execution adapter. The current call was isolated and the conversation can continue.',
          ),
        }));
      }
    }
    if (effect.type === 'run_auto_review') {
      return executeAutoReview(effect, state, dependencies);
    }
    if (
      effect.type === 'run_verification' ||
      effect.type === 'repair_verification' ||
      effect.type === 'run_verification_compensation'
    ) {
      let reviewerModel: SupportedChatModel | undefined;
      return executeVerificationEffect(effect, state, {
        shellExecutor: dependencies.shellExecutor,
        mcpManager: dependencies.mcpManager,
        signal: dependencies.signal,
        reviewer: async (evidence) => {
          reviewerModel ??= createAutoReviewModel(dependencies.config);
          return reviewVerificationEvidence({
            model: reviewerModel,
            evidence,
            timeoutMs: dependencies.config.autoReview?.timeoutMs ?? 30_000,
          });
        },
      });
    }
    if (effect.type === 'subagent.recovery_unavailable') {
      return [
        {
          type: 'subagent.failed',
          subagent: {
            id: effect.subagentId,
            error: effect.reason,
            summary: effect.reason,
            toolCallCount: 0,
            durationMs: 0,
          },
        },
        {
          type: 'tool.finished',
          toolCallId: effect.toolCallId,
          name: 'task',
          result: {
            ok: false,
            command: '',
            exitCode: -1,
            stdout: '',
            stderr: effect.reason,
            status: 'error',
          },
        },
      ];
    }
    return [];
  };
}

/** Execute auto-review for a pending tool call. */
async function executeAutoReview(
  effect: Extract<import('./effects').RuntimeEffect, { type: 'run_auto_review' }>,
  state: Readonly<import('./state').RuntimeState>,
  dependencies: RuntimeExecutorDependencies,
): Promise<RuntimeEvent[]> {
  const call = state.tools.calls[effect.toolCallId];
  if (!call || state.interactions.kind !== 'awaiting_auto_review') return [];

  const request = toolRequestFromCall(
    { id: call.toolCallId, name: call.name, args: (call.args ?? {}) as Record<string, unknown> },
    state.session.workspace,
  );
  if (!request) {
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: false,
          approved: false,
          reason: 'Unsupported tool',
          reviewerModelName: '',
          durationMs: 0,
        },
      },
    ];
  }

  const startTime = Date.now();
  try {
    const reviewerConfig = dependencies.config.autoReview
      ? dependencies.config
      : {
          ...dependencies.config,
          autoReview: {
            provider: dependencies.config.providerName,
            model: dependencies.config.modelName,
          },
        };
    const reviewerModel = createAutoReviewModel(reviewerConfig);

    const result = await reviewToolApproval({
      model: reviewerModel,
      payload: state.interactions
        .approval as import('@/core/harness/tool-policy').ToolApprovalPayload,
      request,
      // V2 makes the configured reviewer timeout part of the rollout surface;
      // the established path retains the fixed compatibility timeout.
      timeoutMs: resolveAutoReviewTimeout(dependencies.config),
    });

    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: result.ok,
          approved: result.suggestion?.approved ?? false,
          grant: result.suggestion?.grant,
          reason: result.suggestion?.reason ?? result.reason,
          reviewerModelName: reviewerConfig.modelName ?? reviewerConfig.providerName ?? 'unknown',
          durationMs: Date.now() - startTime,
        },
      },
    ];
  } catch (error) {
    return [
      {
        type: 'auto_review.completed',
        reviewId: effect.reviewId,
        toolCallId: effect.toolCallId,
        result: {
          ok: false,
          approved: false,
          reason: error instanceof Error ? error.message : String(error),
          reviewerModelName: dependencies.config.modelName ?? 'unknown',
          durationMs: Date.now() - startTime,
        },
      },
    ];
  }
}
