/**
 * Runtime feature flags are explicitly registered here so config and CLI
 * overrides cannot silently introduce a typo or an undocumented switch.
 */
export interface FeatureFlags {
  planLifecycleV2: boolean;
  interactionControllerV2: boolean;
  autoReviewV2: boolean;
  nativeLoopEngine: boolean;
  loopMode: boolean;
  capabilityCatalogV1: boolean;
  mcpRuntimeBindingV1: boolean;
  mcpExecutionRecordV1: boolean;
  mcpProviderActionV1: boolean;
  skillActivationV2: boolean;
  skillWorkflowV1: boolean;
  verificationV1: boolean;
  toolSearchV1: boolean;
  contextCompactionV2: boolean;
  contextCompactionAutoV1: boolean;
  contextCompactionManualV1: boolean;
  sessionLoggingPolicyV1: boolean;
  remoteMcpEgressPolicyV1: boolean;
  resourceBudgetV1: boolean;
  terminalOutcomeV1: boolean;
  boundedCancellationV1: boolean;
  executionBoundaryV1: boolean;
  networkBoundaryV1: boolean;
  releaseProfileV1: boolean;
  observabilityMetricsV1: boolean;
  brokeredGitV1: boolean;
  promptContractV2: boolean;
}

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  planLifecycleV2: true,
  interactionControllerV2: true,
  autoReviewV2: false,
  nativeLoopEngine: false,
  loopMode: false,
  capabilityCatalogV1: true,
  mcpRuntimeBindingV1: true,
  mcpExecutionRecordV1: false,
  mcpProviderActionV1: false,
  skillActivationV2: false,
  skillWorkflowV1: false,
  verificationV1: false,
  toolSearchV1: true,
  contextCompactionV2: true,
  contextCompactionAutoV1: false,
  contextCompactionManualV1: true,
  sessionLoggingPolicyV1: true,
  remoteMcpEgressPolicyV1: false,
  resourceBudgetV1: false,
  terminalOutcomeV1: false,
  boundedCancellationV1: false,
  executionBoundaryV1: false,
  networkBoundaryV1: false,
  releaseProfileV1: false,
  observabilityMetricsV1: false,
  brokeredGitV1: false,
  promptContractV2: true,
});

export type FeatureFlagName = keyof FeatureFlags;

export function isFeatureFlagName(value: string): value is FeatureFlagName {
  return value in DEFAULT_FEATURE_FLAGS;
}

/** Resolve partial config or CLI overrides against the registered defaults. */
export function getFeatureFlags(input?: { features?: Partial<FeatureFlags> }): FeatureFlags {
  return { ...DEFAULT_FEATURE_FLAGS, ...input?.features };
}

/** Parse a CLI --feature value (`name`, `name=true`, or `name=false`). */
export function parseFeatureOverride(value: string): Partial<FeatureFlags> {
  const [name, rawValue] = value.split('=', 2);
  if (!name || !isFeatureFlagName(name)) {
    throw new Error(`Unknown feature flag '${name ?? value}'. Register it in FeatureFlags first.`);
  }
  if (rawValue !== undefined && rawValue !== 'true' && rawValue !== 'false') {
    throw new Error(`Feature flag '${name}' must be true or false.`);
  }
  return { [name]: rawValue !== 'false' } as Partial<FeatureFlags>;
}
