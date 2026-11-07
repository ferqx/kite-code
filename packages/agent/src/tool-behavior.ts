import type { AuthorizationCheckAnswer } from './authorization-check-output';
import type {
  ActionDefinition,
  AuthorizationRequest,
  Extension,
  JobDefinition,
  Json,
  PermissionDecision,
  ToolDefinition,
} from './extensions';
import type { CapabilityBinding, GrantCandidate } from './permission-grants';
import { AgentError } from './storage/types';

/** Serializable identity of trusted code selected for an exact registered definition. */
export interface ToolBehaviorBinding {
  readonly capability: CapabilityBinding;
  readonly contractRef: string;
  readonly configurationDigest: string;
}
export interface ReviewPreparation {
  readonly instructions: string;
  readonly material: Json;
  readonly fingerprint: string;
  readonly reusable: boolean;
  readonly evidence?: Json;
  readonly parentProof?: Json;
}
export interface ToolBehaviorContext {
  readonly parent?: {
    readonly executionId: string;
    readonly kind: CapabilityBinding['kind'];
    readonly definitionId: string;
    readonly definitionVersion: string;
    readonly input: Json;
    readonly inputDigest: string;
  };
}
/** Existing owner-specific Store proof bridge; callbacks run only in trusted host code. */
export interface ParentAuthorizationBridge {
  worktree(): Promise<import('./storage/port').AutoAuthorizationEvidence | null>;
}
/** Functions are host code, never reconstructed from configuration JSON or extension records. */
export interface TrustedToolBehavior extends ToolBehaviorBinding {
  readonly definition: ToolDefinition | JobDefinition | ActionDefinition;
  executionConfirmation?(
    request: AuthorizationRequest,
  ): Promise<import('./execution-confirmation').ExecutionConfirmationDeclaration | null>;
  readonly autoReview?: 'check' | 'none';
  readonly grantSatisfiesDefaultCheck?: true;
  prepareReview?(
    request: AuthorizationRequest,
    context?: ToolBehaviorContext,
  ): Promise<ReviewPreparation | null>;
  interpretReview?(content: string): { answer: AuthorizationCheckAnswer; evidence?: Json } | null;
  prepareParentProof?(
    request: AuthorizationRequest,
    context?: ToolBehaviorContext,
  ): Promise<Json | null>;
  authorizeChild?(
    request: AuthorizationRequest,
    decision: PermissionDecision,
    context: ToolBehaviorContext,
    bridge: ParentAuthorizationBridge,
  ): Promise<import('./storage/port').AutoAuthorizationEvidence | null>;
  grantOffers?(request: AuthorizationRequest): Promise<readonly GrantCandidate[]>;
}
const key = (value: CapabilityBinding) =>
  JSON.stringify([value.kind, value.definitionId, value.definitionVersion]);
const definitionSources = new WeakMap<
  ToolDefinition | JobDefinition | ActionDefinition,
  ToolDefinition | JobDefinition | ActionDefinition
>();
/** Runtime sealing preserves provenance; never exported from the public host entry. */
export function inheritToolBehaviorDefinition(
  original: ToolDefinition | JobDefinition | ActionDefinition,
  copy: ToolDefinition | JobDefinition | ActionDefinition,
): void {
  definitionSources.set(copy, definitionSources.get(original) ?? original);
}

/** Identity equality includes the actual object installed in the Tool/Job execution registry. */
export function createToolBehaviorRegistry(input: {
  readonly extensions: readonly Extension[];
  readonly behaviors?: readonly TrustedToolBehavior[];
}) {
  const actual = new Map<string, ToolDefinition | JobDefinition | ActionDefinition>();
  for (const extension of input.extensions) {
    for (const [kind, definitions, action] of [
      ['tool', extension.tools ?? [], false],
      ['job', extension.jobs ?? [], false],
      ['job', extension.actions ?? [], true],
    ] as const)
      for (const definition of definitions) {
        const identity = key({
          kind,
          definitionId: action ? `${extension.id}/${definition.id}` : definition.id,
          definitionVersion: definition.version,
        });
        if (actual.has(identity)) throw new AgentError('tool_behavior_duplicate_definition');
        actual.set(identity, definition);
      }
  }
  const selected = new Map<string, TrustedToolBehavior>();
  for (const behavior of input.behaviors ?? []) {
    const identity = key(behavior.capability);
    const definition = actual.get(identity);
    if (
      !['tool', 'job'].includes(behavior.capability.kind) ||
      !definition ||
      (definition !== behavior.definition &&
        definitionSources.get(definition) !== behavior.definition) ||
      typeof behavior.contractRef !== 'string' ||
      !behavior.contractRef ||
      behavior.contractRef.length > 512 ||
      !/^[a-f0-9]{64}$/.test(behavior.configurationDigest) ||
      (behavior.executionConfirmation !== undefined &&
        typeof behavior.executionConfirmation !== 'function') ||
      (behavior.autoReview !== undefined && !['check', 'none'].includes(behavior.autoReview)) ||
      (behavior.prepareReview === undefined) !== (behavior.interpretReview === undefined) ||
      (behavior.prepareReview !== undefined && typeof behavior.prepareReview !== 'function') ||
      (behavior.interpretReview !== undefined && typeof behavior.interpretReview !== 'function') ||
      (behavior.authorizeChild !== undefined && typeof behavior.authorizeChild !== 'function') ||
      (behavior.grantOffers !== undefined && typeof behavior.grantOffers !== 'function') ||
      (behavior.prepareParentProof !== undefined &&
        typeof behavior.prepareParentProof !== 'function') ||
      (behavior.autoReview === 'check' && !behavior.prepareReview)
    )
      throw new AgentError('tool_behavior_binding_invalid');
    if (selected.has(identity)) throw new AgentError('tool_behavior_duplicate_binding');
    selected.set(
      identity,
      Object.freeze({ ...behavior, capability: Object.freeze({ ...behavior.capability }) }),
    );
  }
  const behaviors = Object.freeze([...selected.values()]);
  const bindings: readonly ToolBehaviorBinding[] = Object.freeze(
    behaviors.map(({ capability, contractRef, configurationDigest }) =>
      Object.freeze({ capability, contractRef, configurationDigest }),
    ),
  );
  return Object.freeze({
    behaviors,
    bindings,
    get(request: CapabilityBinding): TrustedToolBehavior | undefined {
      return selected.get(key(request));
    },
  });
}
