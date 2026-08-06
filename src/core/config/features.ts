import { z } from 'zod';

/**
 * Runtime feature flags are registered once here. The default resolver, config
 * schema, CLI override parser, and diagnostic inventory all consume this same
 * declaration so a new flag cannot silently create a second public surface.
 */
export type FeatureFlagCliOverridePolicyV1 = 'allow' | 'deny_enable';
export type FeatureFlagImplementationStateV1 = 'implemented' | 'declared_only';
/**
 * Configuration enters through each of these public product surfaces. A
 * default-off implemented flag narrows this registry scope to its verified
 * product guard entrypoints when the diagnostic Matrix is generated.
 */
export const FEATURE_FLAG_CONFIGURATION_ENTRYPOINTS_V1 = ['cli', 'tui', 'runtime'] as const;
export type FeatureFlagConfigurationEntrypointV1 =
  (typeof FEATURE_FLAG_CONFIGURATION_ENTRYPOINTS_V1)[number];

export interface FeatureFlagDefinitionV1 {
  defaultEnabled: boolean;
  /**
   * `declared_only` is a registered compatibility placeholder with no product
   * consumer. It must become `implemented` before source-owned qualification
   * can treat it as an experimental runtime surface.
   */
  implementationState: FeatureFlagImplementationStateV1;
  /**
   * CLI may always request a stricter `false` value. Release-controlled flags
   * reject a CLI attempt to raise their default/preceding ceiling to `true`.
   */
  cliOverridePolicy: FeatureFlagCliOverridePolicyV1;
  /** Source-owned configuration surface that can receive this flag. */
  configurationEntrypoints: readonly FeatureFlagConfigurationEntrypointV1[];
}

const cliAllowed = {
  cliOverridePolicy: 'allow',
  implementationState: 'implemented',
  configurationEntrypoints: FEATURE_FLAG_CONFIGURATION_ENTRYPOINTS_V1,
} as const;
const cliDenyEnable = {
  cliOverridePolicy: 'deny_enable',
  implementationState: 'implemented',
  configurationEntrypoints: FEATURE_FLAG_CONFIGURATION_ENTRYPOINTS_V1,
} as const;
const declaredOnlyCliAllowed = {
  cliOverridePolicy: 'allow',
  implementationState: 'declared_only',
  configurationEntrypoints: FEATURE_FLAG_CONFIGURATION_ENTRYPOINTS_V1,
} as const;

export const FEATURE_FLAG_DEFINITIONS_V1 = Object.freeze({
  planLifecycleV2: { defaultEnabled: true, ...cliAllowed },
  interactionControllerV2: { defaultEnabled: true, ...cliAllowed },
  autoReviewV2: { defaultEnabled: false, ...cliAllowed },
  nativeLoopEngine: { defaultEnabled: false, ...declaredOnlyCliAllowed },
  loopMode: { defaultEnabled: false, ...declaredOnlyCliAllowed },
  capabilityCatalogV1: { defaultEnabled: true, ...cliAllowed },
  mcpRuntimeBindingV1: { defaultEnabled: true, ...cliAllowed },
  mcpExecutionRecordV1: { defaultEnabled: false, ...cliAllowed },
  mcpProviderActionV1: { defaultEnabled: false, ...cliAllowed },
  skillActivationV2: { defaultEnabled: false, ...cliAllowed },
  skillWorkflowV1: { defaultEnabled: false, ...cliAllowed },
  verificationV1: { defaultEnabled: false, ...cliAllowed },
  toolSearchV1: { defaultEnabled: true, ...cliAllowed },
  contextCompactionV2: { defaultEnabled: true, ...cliAllowed },
  contextCompactionAutoV1: { defaultEnabled: false, ...cliAllowed },
  contextCompactionManualV1: { defaultEnabled: true, ...cliAllowed },
  sessionLoggingPolicyV1: { defaultEnabled: true, ...cliAllowed },
  providerDataPolicyV1: { defaultEnabled: false, ...cliAllowed },
  remoteMcpEgressPolicyV1: { defaultEnabled: false, ...cliAllowed },
  resourceBudgetV1: { defaultEnabled: false, ...cliAllowed },
  terminalOutcomeV1: { defaultEnabled: false, ...cliAllowed },
  boundedCancellationV1: { defaultEnabled: false, ...cliAllowed },
  executionBoundaryV1: { defaultEnabled: false, ...cliDenyEnable },
  networkBoundaryV1: { defaultEnabled: false, ...cliDenyEnable },
  releaseProfileV1: { defaultEnabled: false, ...cliDenyEnable },
  observabilityMetricsV1: { defaultEnabled: false, ...cliDenyEnable },
} satisfies Record<string, FeatureFlagDefinitionV1>);

export type FeatureFlagName = keyof typeof FEATURE_FLAG_DEFINITIONS_V1;
export type FeatureFlags = { [Name in FeatureFlagName]: boolean };

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_FLAG_DEFINITIONS_V1).map(([name, definition]) => [
      name,
      definition.defaultEnabled,
    ]),
  ) as FeatureFlags,
);

/** The config schema consumes the same registered names as the resolver. */
export const featureFlagOverridesSchema = z
  .object(
    Object.fromEntries(
      Object.keys(FEATURE_FLAG_DEFINITIONS_V1).map((name) => [name, z.boolean().optional()]),
    ) as Record<FeatureFlagName, z.ZodOptional<z.ZodBoolean>>,
  )
  .strict()
  .optional();

export function isFeatureFlagName(value: string): value is FeatureFlagName {
  return value in DEFAULT_FEATURE_FLAGS;
}

export function featureFlagAllowsCliEnablementV1(name: FeatureFlagName): boolean {
  return FEATURE_FLAG_DEFINITIONS_V1[name].cliOverridePolicy === 'allow';
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
