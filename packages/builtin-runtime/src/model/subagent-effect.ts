import type { CapabilityBinding } from '@kite/runtime-contract';
import type { ToolSet } from 'ai';
import { extractPromptCacheMetrics, type PromptCacheMetrics } from './cache-metrics';
import type { ModelRuntimeConfig } from './config';
import type { SupportedChatModel } from './factory';
import {
  type BuiltinModelEvent,
  computeModelInvocationPrivateDigest,
  type ModelInvocationGateway,
  type ModelInvocationPersistence,
  type ModelInvocationStateView,
  normalizedModelResponseToAIMessage,
} from './invocation-gateway';
import type { AIMessage, BaseMessage } from './messages';
import { compileModelSurface } from './surface-compiler';

/**
 * The immutable identity facts carried from the parent invocation into one
 * child model step. These are provenance only; the coordinator never derives
 * a second registry, catalog, or response source from them.
 */
export interface BuiltinSubagentModelStepProvenance {
  readonly parentInvocationId?: string | null;
  readonly parentToolCallId?: string | null;
  readonly contextCheckpointId?: string | null;
  readonly promptContractVersion: string;
  readonly projectionEnvironment: {
    readonly role: string;
    readonly projectInstructions: unknown;
    readonly workspaceAccess: string;
    readonly phase: string;
  };
  readonly capabilityBindings: readonly CapabilityBinding[];
}

export interface BuiltinSubagentModelStepInput<
  State extends ModelInvocationStateView = ModelInvocationStateView,
  Event extends BuiltinModelEvent = BuiltinModelEvent,
> {
  readonly config: ModelRuntimeConfig;
  /** Required for provider-neutral surface capability compilation and live dispatch. */
  readonly model: SupportedChatModel;
  readonly tools: ToolSet;
  readonly messages: readonly BaseMessage[];
  readonly persistence?: ModelInvocationPersistence<State, Event>;
  readonly provenance: BuiltinSubagentModelStepProvenance;
  readonly maxOutputTokens?: number;
  readonly estimatedInputTokens: number;
  readonly parentReservationId?: string;
  readonly signal?: AbortSignal;
}

/**
 * Facts exposed after an accepted subagent model step is committed. No
 * response or cache observation is returned until Gateway completion evidence
 * has been acknowledged by the injected persistence port.
 */
export interface BuiltinSubagentModelStepResult {
  readonly invocationId: string;
  readonly message: AIMessage;
  readonly cacheMetrics: Readonly<PromptCacheMetrics> | null;
}

/**
 * Compile and execute exactly one subagent model step through the coordinator's
 * already-owned Gateway. The model remains available for compiling the frozen
 * provider-neutral surface and then enters the single live response source.
 */
export async function executeBuiltinSubagentModelStep<
  State extends ModelInvocationStateView,
  Event extends BuiltinModelEvent,
>(
  gateway: ModelInvocationGateway,
  input: BuiltinSubagentModelStepInput<State, Event>,
): Promise<BuiltinSubagentModelStepResult> {
  const persistence = input.persistence;
  if (!persistence) {
    throw new Error('ModelInvocationGateway execution context is unavailable.');
  }

  const compiled = compileModelSurface({
    purpose: 'subagent',
    config: input.config,
    model: input.model,
    tools: input.tools,
    messages: input.messages,
    maxOutputTokens: input.maxOutputTokens,
    transport: 'generate',
    estimatedInputTokens: input.estimatedInputTokens,
  });

  const pending = await gateway.invoke({
    model: input.model,
    compiled,
    persistence,
    provenance: {
      parentInvocationId: input.provenance.parentInvocationId ?? null,
      parentToolCallId: input.provenance.parentToolCallId ?? null,
      contextCheckpointId: input.provenance.contextCheckpointId ?? null,
      promptContractVersion: input.provenance.promptContractVersion,
      projectionEnvironmentDigest: computeModelInvocationPrivateDigest(
        'kite.model-projection-environment.v1',
        {
          ...input.provenance.projectionEnvironment,
          tools: compiled.surface.request.tools,
        },
      ),
      capabilityBindingDigest: computeModelInvocationPrivateDigest(
        'kite.model-capability-bindings.v1',
        input.provenance.capabilityBindings,
      ),
    },
    resourceKind: 'model',
    ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
    signal: input.signal,
  });

  // Commit is intentionally awaited before normalization. A rejected commit
  // must never leak a provider response to the subagent runner.
  const normalized = await pending.commit();
  const message = normalizedModelResponseToAIMessage(normalized);
  const cacheMetrics = extractPromptCacheMetrics(message);
  return Object.freeze({
    invocationId: pending.invocationId,
    message,
    cacheMetrics: cacheMetrics ? Object.freeze({ ...cacheMetrics }) : null,
  });
}
