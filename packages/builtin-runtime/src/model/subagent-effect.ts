import type { CapabilityBinding } from '@kite-ai/runtime-contract';
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
import type { AIMessage, BaseMessage, HumanMessage } from './messages';
import { humanMessage } from './messages';
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
  readonly provenance?: BuiltinSubagentModelStepProvenance;
  readonly maxOutputTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly parentReservationId?: string;
  /** Service owns authorization and durable batch selection; Builtin only inserts prepared frames. */
  readonly prepareAgentMail?: (input: {
    readonly invocationId: string;
    readonly existingMessages: readonly BaseMessage[];
    readonly childIdentity: Readonly<{ agentId: string; taskId: string }>;
  }) => Promise<{
    readonly frames: readonly Readonly<{
      kind: 'agent_message';
      trust: 'untrusted_agent';
      modelRole: 'user';
      messageId: string;
      content: string;
    }>[];
    readonly preparationId?: string;
  }>;
  readonly childIdentity?: Readonly<{ agentId: string; taskId: string }>;
  /** Loop-owned estimate, provenance, and ceiling resolved after prepared frames are inserted. */
  readonly resolvePreparedStep?: (messages: readonly BaseMessage[]) => Promise<{
    readonly provenance: BuiltinSubagentModelStepProvenance;
    readonly estimatedInputTokens: number;
    readonly maxOutputTokens?: number;
  }>;
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
  /** Exact low-trust messages admitted into this model Surface, for the child checkpoint. */
  readonly appendedAgentMail?: readonly Readonly<HumanMessage>[];
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
  if (!input.prepareAgentMail && (!input.provenance || input.estimatedInputTokens === undefined))
    throw new Error('Subagent model step preparation is unavailable.');

  const compiled = input.prepareAgentMail
    ? undefined
    : compileModelSurface({
        purpose: 'subagent',
        config: input.config,
        model: input.model,
        tools: input.tools,
        messages: input.messages,
        maxOutputTokens: input.maxOutputTokens,
        transport: 'generate',
        estimatedInputTokens: input.estimatedInputTokens,
      });

  let appendedAgentMail: readonly Readonly<HumanMessage>[] | undefined;
  if (input.prepareAgentMail && (!input.childIdentity || !input.resolvePreparedStep))
    throw new Error('Prepared Agent mail requires child identity and model preparation.');
  const pending = await gateway.invoke({
    model: input.model,
    ...(compiled
      ? { compiled }
      : {
          prepareSurface: async (invocationId: string) => {
            const prepared = await input.prepareAgentMail!({
              invocationId,
              existingMessages: input.messages,
              childIdentity: input.childIdentity!,
            });
            if (
              !prepared ||
              !Array.isArray(prepared.frames) ||
              (prepared.frames.length > 0 && !prepared.preparationId) ||
              (prepared.frames.length === 0 && prepared.preparationId)
            )
              throw new Error('Prepared Agent mail batch is invalid.');
            const seen = new Set<string>();
            const frames = prepared.frames.map((frame) => {
              if (
                frame.kind !== 'agent_message' ||
                frame.trust !== 'untrusted_agent' ||
                frame.modelRole !== 'user' ||
                !frame.messageId ||
                !frame.content.startsWith('<agent_message ') ||
                seen.has(frame.messageId) ||
                input.messages.some(
                  (message) => message.name === 'agent_message' && message.id === frame.messageId,
                )
              )
                throw new Error('Prepared Agent mail frame is invalid or duplicated.');
              seen.add(frame.messageId);
              return Object.freeze(
                humanMessage({
                  id: frame.messageId,
                  name: 'agent_message',
                  content: frame.content,
                  response_metadata: { source: 'agent_message', trust: 'untrusted_agent' },
                }),
              );
            });
            appendedAgentMail = Object.freeze(frames);
            const messages = Object.freeze([...input.messages, ...frames]);
            const resolved = await input.resolvePreparedStep!(messages);
            const preparedCompiled = compileModelSurface({
              purpose: 'subagent',
              config: input.config,
              model: input.model,
              tools: input.tools,
              messages,
              maxOutputTokens: resolved.maxOutputTokens,
              transport: 'generate',
              estimatedInputTokens: resolved.estimatedInputTokens,
            });
            return {
              compiled: preparedCompiled,
              provenance: modelProvenance(resolved.provenance, preparedCompiled),
              ...(prepared.preparationId
                ? { mailPreparation: { preparationId: prepared.preparationId } }
                : {}),
            };
          },
        }),
    persistence,
    ...(compiled ? { provenance: modelProvenance(input.provenance!, compiled) } : {}),
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
    ...(appendedAgentMail ? { appendedAgentMail } : {}),
  });
}

function modelProvenance(
  provenance: BuiltinSubagentModelStepProvenance,
  compiled: ReturnType<typeof compileModelSurface>,
) {
  return {
    parentInvocationId: provenance.parentInvocationId ?? null,
    parentToolCallId: provenance.parentToolCallId ?? null,
    contextCheckpointId: provenance.contextCheckpointId ?? null,
    promptContractVersion: provenance.promptContractVersion,
    projectionEnvironmentDigest: computeModelInvocationPrivateDigest(
      'kite.model-projection-environment.v1',
      { ...provenance.projectionEnvironment, tools: compiled.surface.request.tools },
    ),
    capabilityBindingDigest: computeModelInvocationPrivateDigest(
      'kite.model-capability-bindings.v1',
      provenance.capabilityBindings,
    ),
  };
}
