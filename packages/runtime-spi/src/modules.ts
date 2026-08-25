import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite/runtime-contract';
import type {
  CapabilityApproval,
  CapabilityApprovalSummaryProjector,
  CapabilityAvailabilityResolver,
  CapabilityDescriptor,
  CapabilityEffects,
  CapabilityEffectsClassifier,
  CapabilityExecutionMechanism,
  CapabilityExecutionPolicy,
  CapabilityExecutionTraitsDeclaration,
  CapabilityExecutionTraitsProjector,
  CapabilityInternalDescriptor,
  CapabilityKind,
  CapabilityParser,
  CapabilityPolicyCompiler,
  CapabilityTurnContext,
  CapabilityVisibility,
  RuntimeJsonValue,
} from './capability';
import type { CapabilityExecutor } from './execution';
import type { ContextSource, RuntimeReceiptNormalizer } from './model';

export interface RuntimeModuleManifest {
  readonly moduleId: string;
  readonly providerId: string;
  readonly revision: string;
  readonly contractRevision: typeof RUNTIME_CONTRACT_BOUNDARY_.revision;
  /** Exact production operations owned by this module at this registry revision. */
  readonly operationIds: readonly string[];
}

export interface RuntimeModule {
  readonly manifest: RuntimeModuleManifest;
  /** Pure, synchronous declaration only. The scoped writer is sealed on return. */
  register(registry: RuntimeModuleRegistryWriter): void;
  /** Readiness must be represented by an execution capability, not module startup. */
  start?(): Promise<void>;
  /** Must settle within the registry lifecycle bound. */
  dispose(): Promise<void>;
}

export interface CapabilityDefinition {
  readonly capabilityId: string;
  readonly revision: string;
  readonly providerId: string;
  readonly title: string;
  /**
   * Strict Builtin mechanism metadata.  Generic SPI capabilities may omit
   * this field for compatibility; Builtin catalog projection rejects an
   * omitted value, so every RM Builtin operation is explicit.
   */
  readonly executionMechanism?: CapabilityExecutionMechanism;
  /** Stable model-facing tool name. Omitted for internal capabilities. */
  readonly toolName?: string;
  /** Stable model-facing description; title remains the required fallback. */
  readonly description?: string;
  /** Whether this capability is eligible for the model-visible projection. */
  readonly visibility?: CapabilityVisibility;
  /** Conservative static effect facts for catalog and scheduler projection. */
  readonly effects?: CapabilityEffects;
  /** Builtin-owned provider-neutral descriptor category. */
  readonly kind?: CapabilityKind;
  /** Prompt-contract-v2 description derived from the same Builtin contract. */
  readonly modelDescription?: string;
  /** Exact Builtin parser/canonicalizer; no caller-supplied schema is accepted. */
  readonly parser?: CapabilityParser;
  /** Model-only parser for phase/visibility-specific input (for example task). */
  readonly modelParser?: CapabilityParser;
  /** Model-only JSON schema; it must not include private runtime branches. */
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  /** Context-selected model schema for planning/public projection differences. */
  readonly modelInputSchemaForContext?: (
    context: CapabilityTurnContext,
  ) => Readonly<Record<string, RuntimeJsonValue>>;
  /** Typed immutable turn gating owned by the Builtin definition. */
  readonly availability?: CapabilityAvailabilityResolver;
  /** Per-invocation classification owned by the Builtin definition. */
  readonly effectsClassifier?: CapabilityEffectsClassifier;
  /** User-visible approval identity projected by the Builtin owner. */
  readonly approvalSummary?: CapabilityApprovalSummaryProjector;
  readonly executionTraitsDeclaration?: CapabilityExecutionTraitsDeclaration;
  readonly executionTraitsProjector?: CapabilityExecutionTraitsProjector;
  readonly minimumApproval?: CapabilityApproval;
  readonly workspaceTrustRequired?: boolean;
  readonly governanceRevision?: string;
  readonly execution?: CapabilityExecutionPolicy;
  /** Strict descriptor projection; its revision may be a content revision distinct from operation revision. */
  readonly descriptor?: CapabilityDescriptor | CapabilityInternalDescriptor;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  readonly outputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  /** Optional exact digest used by the immutable arbitrator. */
  readonly inputSchemaDigest?: string;
  /** Builtin-owned operation policy facts; never contains authorization state. */
  readonly policyCompiler?: CapabilityPolicyCompiler;
}

/** Exact RM/State 27 turn-scoped binding shape. */
export interface RuntimeExecutionAdapterRegistration<TContext = unknown, TAdapter = unknown> {
  readonly adapterId: string;
  readonly revision: string;
  create(context: TContext): TAdapter;
}

export interface RuntimeModuleRegistryWriter {
  registerCapability(definition: CapabilityDefinition): void;
  registerExecutor(executor: CapabilityExecutor): void;
  registerContextSource(source: ContextSource): void;
  registerReceiptNormalizer(normalizer: RuntimeReceiptNormalizer): void;
  registerExecutionAdapter<TContext, TAdapter>(
    adapter: RuntimeExecutionAdapterRegistration<TContext, TAdapter>,
  ): void;
}

export function defineRuntimeModule(input: {
  readonly moduleId: string;
  readonly providerId?: string;
  readonly revision: string;
  readonly operationIds?: readonly string[];
  readonly register?: (registry: RuntimeModuleRegistryWriter) => void;
  readonly start?: () => Promise<void>;
  readonly dispose?: () => Promise<void>;
}): RuntimeModule {
  const moduleId = normalizeRuntimeIdentifier('runtime module id', input.moduleId);
  const providerId = normalizeRuntimeIdentifier(
    'runtime provider id',
    input.providerId ?? moduleId,
  );
  const revision = normalizeRuntimeIdentifier('runtime module revision', input.revision);
  const operationIds = Object.freeze(
    (input.operationIds ?? []).map((operationId) =>
      normalizeRuntimeIdentifier('runtime operation id', operationId),
    ),
  );
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error(`duplicate runtime operation in module ${moduleId}`);
  }
  const manifest: RuntimeModuleManifest = Object.freeze({
    moduleId,
    providerId,
    revision,
    contractRevision: RUNTIME_CONTRACT_BOUNDARY_.revision,
    operationIds,
  });
  return Object.freeze({
    manifest,
    register: input.register ?? (() => undefined),
    ...(input.start ? { start: input.start } : {}),
    dispose: input.dispose ?? (() => Promise.resolve()),
  });
}

export function normalizeRuntimeIdentifier(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (normalized !== value) throw new Error(`${label} must be canonical: ${value}`);
  return normalized;
}
