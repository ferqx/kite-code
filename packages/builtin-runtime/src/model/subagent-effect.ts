import type { CapabilityBinding } from '@kite/runtime-contract';
import type { ToolSet } from 'ai';
import { extractPromptCacheMetrics, type PromptCacheMetrics } from './cache-metrics';
import type { ModelRuntimeConfigV1 } from './config';
import type { SupportedChatModel } from './factory';
import {
  type BuiltinModelEventV1,
  computeModelInvocationPrivateDigestV1,
  type ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type ModelInvocationStateViewV1,
  normalizedModelResponseToAIMessageV1,
} from './invocation-gateway';
import type { AIMessage, BaseMessage } from './messages';
import type { ProviderDataAdmissionGateV1 } from './provider-data-admission';
import { compileModelSurfaceV1 } from './surface-compiler';

/**
 * The immutable identity facts carried from the parent invocation into one
 * child model step. These are provenance only; the coordinator never derives
 * a second registry, catalog, or response source from them.
 */
export interface BuiltinSubagentModelStepProvenanceV1 {
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

export interface BuiltinSubagentModelStepInputV1<
  State extends ModelInvocationStateViewV1 = ModelInvocationStateViewV1,
  Event extends BuiltinModelEventV1 = BuiltinModelEventV1,
> {
  readonly config: ModelRuntimeConfigV1;
  /** Required for provider-neutral surface capability compilation and live dispatch. */
  readonly model: SupportedChatModel;
  readonly tools: ToolSet;
  readonly messages: readonly BaseMessage[];
  readonly persistence?: ModelInvocationPersistenceV1<State, Event>;
  readonly provenance: BuiltinSubagentModelStepProvenanceV1;
  readonly maxOutputTokens?: number;
  readonly estimatedInputTokens: number;
  readonly providerDataAdmission?: ProviderDataAdmissionGateV1;
  readonly providerDataPolicyRequired: boolean;
  readonly parentReservationId?: string;
  readonly signal?: AbortSignal;
}

/**
 * Facts exposed after an accepted subagent model step is committed. No
 * response or cache observation is returned until Gateway completion evidence
 * has been acknowledged by the injected persistence port.
 */
export interface BuiltinSubagentModelStepResultV1 {
  readonly invocationId: string;
  readonly message: AIMessage;
  readonly cacheMetrics: Readonly<PromptCacheMetrics> | null;
}

/**
 * Compile and execute exactly one subagent model step through the coordinator's
 * already-owned Gateway. The model remains available for compiling the frozen
 * provider-neutral surface and then enters the single live response source.
 */
export async function executeBuiltinSubagentModelStepV1<
  State extends ModelInvocationStateViewV1,
  Event extends BuiltinModelEventV1,
>(
  gateway: ModelInvocationGatewayV1,
  input: BuiltinSubagentModelStepInputV1<State, Event>,
): Promise<BuiltinSubagentModelStepResultV1> {
  const persistence = input.persistence;
  if (!persistence) {
    throw new Error('ModelInvocationGateway execution context is unavailable.');
  }

  const compiled = compileModelSurfaceV1({
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
      projectionEnvironmentDigest: computeModelInvocationPrivateDigestV1(
        'kite.model-projection-environment.v1',
        {
          ...input.provenance.projectionEnvironment,
          tools: compiled.surface.request.tools,
        },
      ),
      capabilityBindingDigest: computeModelInvocationPrivateDigestV1(
        'kite.model-capability-bindings.v1',
        input.provenance.capabilityBindings,
      ),
    },
    providerDataAdmission: input.providerDataAdmission,
    providerDataPolicyRequired: input.providerDataPolicyRequired,
    resourceKind: 'model',
    ...(input.parentReservationId ? { parentReservationId: input.parentReservationId } : {}),
    signal: input.signal,
  });

  // Commit is intentionally awaited before normalization. A rejected commit
  // must never leak a provider response to the subagent runner.
  const normalized = await pending.commit();
  const message = normalizedModelResponseToAIMessageV1(normalized);
  const cacheMetrics = extractPromptCacheMetrics(message);
  return Object.freeze({
    invocationId: pending.invocationId,
    message,
    cacheMetrics: cacheMetrics ? Object.freeze({ ...cacheMetrics }) : null,
  });
}
