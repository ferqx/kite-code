/**
 * Runtime feature flags are explicitly registered here so config and CLI
 * overrides cannot silently introduce a typo or an undocumented switch.
 */
export interface FeatureFlags {
  planLifecycle: boolean;
  interactionController: boolean;
  autoReview: boolean;
  nativeLoopEngine: boolean;
  loopMode: boolean;
  capabilityCatalog: boolean;
  mcpRuntimeBinding: boolean;
  mcpExecutionRecord: boolean;
  mcpProviderAction: boolean;
  skillActivation: boolean;
  skillWorkflow: boolean;
  verification: boolean;
  toolSearch: boolean;
  contextCompaction: boolean;
  contextCompactionAuto: boolean;
  contextCompactionManual: boolean;
  sessionLoggingPolicy: boolean;
  resourceBudget: boolean;
  terminalOutcome: boolean;
  boundedCancellation: boolean;
  executionBoundary: boolean;
  networkBoundary: boolean;
  releaseProfile: boolean;
  observabilityMetrics: boolean;
  brokeredGit: boolean;
}

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  planLifecycle: true,
  interactionController: true,
  autoReview: false,
  nativeLoopEngine: false,
  loopMode: false,
  capabilityCatalog: true,
  mcpRuntimeBinding: true,
  mcpExecutionRecord: false,
  mcpProviderAction: false,
  skillActivation: false,
  skillWorkflow: false,
  verification: false,
  toolSearch: true,
  contextCompaction: true,
  contextCompactionAuto: false,
  contextCompactionManual: true,
  sessionLoggingPolicy: true,
  resourceBudget: false,
  terminalOutcome: false,
  boundedCancellation: false,
  executionBoundary: false,
  networkBoundary: false,
  releaseProfile: false,
  observabilityMetrics: false,
  brokeredGit: false,
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
