import { z } from 'zod';
import {
  RELEASE_CAPABILITIES,
  ROLLOUT_STAGE_RANK,
  releaseCapabilitySchema,
  rolloutStageSchema,
} from './release-capabilities';
import { parseReleaseProfile, type ReleaseProfile } from './release-profile';

const restrictionCapabilitySchema = z
  .object({
    enabled: z.boolean().optional(),
    maxRollout: rolloutStageSchema.optional(),
  })
  .strict();

const capabilityRestrictionsSchema = z
  .record(z.string(), restrictionCapabilitySchema)
  .superRefine((restrictions, context) => {
    for (const capability of Object.keys(restrictions)) {
      if (!releaseCapabilitySchema.safeParse(capability).success) {
        context.addIssue({
          code: 'custom',
          path: [capability],
          message: 'unknown release capability',
        });
      }
    }
  });

const finiteNonNegativeIntegerSchema = z.number().finite().int().nonnegative();
const identitySchema = z.string().trim().min(1);
const pathSchema = z.string().trim().min(1);

const resourceRestrictionSchema = z
  .object({
    maxRunDurationMs: finiteNonNegativeIntegerSchema.optional(),
    maxTurns: finiteNonNegativeIntegerSchema.optional(),
    maxModelRequests: finiteNonNegativeIntegerSchema.optional(),
    maxToolInvocations: finiteNonNegativeIntegerSchema.optional(),
    maxRunInputTokens: finiteNonNegativeIntegerSchema.optional(),
    maxRunOutputTokens: finiteNonNegativeIntegerSchema.optional(),
    maxConcurrentSubagents: finiteNonNegativeIntegerSchema.optional(),
    maxConcurrentWriters: finiteNonNegativeIntegerSchema.optional(),
    maxConcurrentToolInvocations: finiteNonNegativeIntegerSchema.optional(),
    maxConcurrentShellInvocations: finiteNonNegativeIntegerSchema.optional(),
    maxProcessTreeSizePerShellInvocation: finiteNonNegativeIntegerSchema.optional(),
    maxConcurrencyWaitMs: finiteNonNegativeIntegerSchema.optional(),
    maxArtifactBytes: finiteNonNegativeIntegerSchema.optional(),
  })
  .strict();

export const releaseProfileRestrictionSchema = z
  .object({
    capabilities: capabilityRestrictionsSchema.optional(),
    safety: z
      .object({
        requireSandbox: z.boolean().optional(),
        sandboxUnavailable: z.enum(['fail', 'verified_in_process_read_only']).optional(),
        maxInteractionMode: z.enum(['accept_edits', 'auto', 'full']).optional(),
        maxFilesystemScope: z.enum(['read_only', 'workspace_write', 'full_access']).optional(),
        networkMode: z.enum(['off', 'allowlist']).optional(),
        networkAllowlist: z.array(identitySchema).optional(),
        networkDenylist: z.array(identitySchema).optional(),
        protectedPathPolicy: z.enum(['deny', 'prompt']).optional(),
        protectedPaths: z.array(pathSchema).optional(),
        mcpProviderAllowlist: z.array(identitySchema).optional(),
        mcpProviderDenylist: z.array(identitySchema).optional(),
      })
      .strict()
      .optional(),
    resources: resourceRestrictionSchema.optional(),
    data: z
      .object({
        providerRouteAllowlist: z.array(identitySchema).optional(),
        providerRouteDenylist: z.array(identitySchema).optional(),
        maxWorkspaceDataClassification: z.enum(['public', 'internal', 'confidential']).optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        defaultMode: z.enum(['off', 'metadata']).optional(),
        allowContentOptIn: z.boolean().optional(),
        retentionDays: finiteNonNegativeIntegerSchema.optional(),
        maxTotalBytes: finiteNonNegativeIntegerSchema.optional(),
        maxSessionBytes: finiteNonNegativeIntegerSchema.optional(),
      })
      .strict()
      .optional(),
    telemetry: z
      .object({
        allowed: z.boolean().optional(),
        endpointPolicy: z.enum(['admin_only', 'user_configured']).optional(),
      })
      .strict()
      .optional(),
    requirements: z
      .object({
        minimumApproval: z.enum(['none', 'auto_review', 'user']).optional(),
        minimumVerification: z.enum(['not_required', 'best_effort', 'required']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const releaseProfileRestrictionLayerSchema = z
  .object({
    source: z.enum(['rollout', 'admin', 'user', 'project', 'cli']),
    restrictions: releaseProfileRestrictionSchema,
  })
  .strict();

export type ReleaseProfileRestriction = z.infer<typeof releaseProfileRestrictionSchema>;
export type ReleaseProfileRestrictionLayer = z.infer<typeof releaseProfileRestrictionLayerSchema>;
export type ReleaseProfileRestrictionSource = ReleaseProfileRestrictionLayer['source'];

export class ReleaseProfileEscalationError extends Error {
  readonly source: ReleaseProfileRestrictionSource;
  readonly path: string;
  readonly requested: unknown;
  readonly ceiling: unknown;

  constructor(
    source: ReleaseProfileRestrictionSource,
    path: string,
    requested: unknown,
    ceiling: unknown,
  ) {
    super(`${source} restriction attempted to raise ${path} above the embedded release ceiling.`);
    this.name = 'ReleaseProfileEscalationError';
    this.source = source;
    this.path = path;
    this.requested = requested;
    this.ceiling = ceiling;
  }
}

const RESOURCE_FIELDS = [
  'maxRunDurationMs',
  'maxTurns',
  'maxModelRequests',
  'maxToolInvocations',
  'maxRunInputTokens',
  'maxRunOutputTokens',
  'maxConcurrentSubagents',
  'maxConcurrentWriters',
  'maxConcurrentToolInvocations',
  'maxConcurrentShellInvocations',
  'maxProcessTreeSizePerShellInvocation',
  'maxConcurrencyWaitMs',
  'maxArtifactBytes',
] as const;

const INTERACTION_RANK = { accept_edits: 0, auto: 1, full: 2 } as const;
const FILESYSTEM_RANK = { read_only: 0, workspace_write: 1, full_access: 2 } as const;
const NETWORK_RANK = { off: 0, allowlist: 1 } as const;
const SANDBOX_FALLBACK_RANK = { fail: 0, verified_in_process_read_only: 1 } as const;
const PROTECTED_PATH_RANK = { deny: 0, prompt: 1 } as const;
const DATA_CLASSIFICATION_RANK = { public: 0, internal: 1, confidential: 2 } as const;
const LOGGING_MODE_RANK = { off: 0, metadata: 1 } as const;
const ENDPOINT_POLICY_RANK = { admin_only: 0, user_configured: 1 } as const;
const APPROVAL_RANK = { none: 0, auto_review: 1, user: 2 } as const;
const VERIFICATION_RANK = { not_required: 0, best_effort: 1, required: 2 } as const;

function escalation(
  layer: ReleaseProfileRestrictionLayer,
  path: string,
  requested: unknown,
  ceiling: unknown,
): never {
  throw new ReleaseProfileEscalationError(layer.source, path, requested, ceiling);
}

function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const allowed = new Set(right);
  return left.filter((value) => allowed.has(value));
}

function ensureSubset(
  layer: ReleaseProfileRestrictionLayer,
  path: string,
  requested: readonly string[],
  ceiling: readonly string[],
): void {
  const ceilingValues = new Set(ceiling);
  if (requested.some((value) => !ceilingValues.has(value))) {
    escalation(layer, path, requested, ceiling);
  }
}

function tightenRanked<T extends string>(input: {
  layer: ReleaseProfileRestrictionLayer;
  path: string;
  requested: T | undefined;
  ceiling: T;
  current: T;
  rank: Readonly<Record<T, number>>;
}): T {
  if (input.requested === undefined) return input.current;
  if (input.rank[input.requested] > input.rank[input.ceiling]) {
    escalation(input.layer, input.path, input.requested, input.ceiling);
  }
  return input.rank[input.requested] < input.rank[input.current] ? input.requested : input.current;
}

function tightenRequirement<T extends string>(input: {
  layer: ReleaseProfileRestrictionLayer;
  path: string;
  requested: T | undefined;
  ceiling: T;
  current: T;
  rank: Readonly<Record<T, number>>;
}): T {
  if (input.requested === undefined) return input.current;
  if (input.rank[input.requested] < input.rank[input.ceiling]) {
    escalation(input.layer, input.path, input.requested, input.ceiling);
  }
  return input.rank[input.requested] > input.rank[input.current] ? input.requested : input.current;
}

function requireOnlyTighterBoolean(input: {
  layer: ReleaseProfileRestrictionLayer;
  path: string;
  requested: boolean | undefined;
  ceiling: boolean;
  current: boolean;
  trueIsStricter: boolean;
}): boolean {
  if (input.requested === undefined) return input.current;
  const requestedStrictness = input.requested === input.trueIsStricter ? 1 : 0;
  const ceilingStrictness = input.ceiling === input.trueIsStricter ? 1 : 0;
  if (requestedStrictness < ceilingStrictness) {
    escalation(input.layer, input.path, input.requested, input.ceiling);
  }
  return input.trueIsStricter ? input.current || input.requested : input.current && input.requested;
}

function cloneProfile(profile: ReleaseProfile): ReleaseProfile {
  return structuredClone(profile);
}

/**
 * Compose only restrictions over an embedded artifact ceiling. Every layer is
 * parsed strictly before evaluation, and widening attempts are rejected rather
 * than silently clamped. Call this before creating Runtime/MCP/Skill providers.
 */
export function composeReleaseProfile(input: {
  embedded: unknown;
  layers?: readonly unknown[];
}): ReleaseProfile {
  const ceiling = parseReleaseProfile(input.embedded);
  const effective = cloneProfile(ceiling);

  for (const rawLayer of input.layers ?? []) {
    const layer = releaseProfileRestrictionLayerSchema.parse(rawLayer);
    const restriction = layer.restrictions;

    for (const capability of RELEASE_CAPABILITIES) {
      const requested = restriction.capabilities?.[capability];
      if (!requested) continue;
      const ceilingState = ceiling.capabilities[capability];
      const current = effective.capabilities[capability];
      if (requested.enabled === true && ceilingState.maxRollout === 'off') {
        escalation(layer, `capabilities.${capability}.enabled`, true, false);
      }
      if (
        requested.maxRollout !== undefined &&
        ROLLOUT_STAGE_RANK[requested.maxRollout] > ROLLOUT_STAGE_RANK[ceilingState.maxRollout]
      ) {
        escalation(
          layer,
          `capabilities.${capability}.maxRollout`,
          requested.maxRollout,
          ceilingState.maxRollout,
        );
      }
      const requestedRollout = requested.enabled === false ? 'off' : requested.maxRollout;
      if (
        requestedRollout !== undefined &&
        ROLLOUT_STAGE_RANK[requestedRollout] < ROLLOUT_STAGE_RANK[current.maxRollout]
      ) {
        current.maxRollout = requestedRollout;
      }
    }

    const safety = restriction.safety;
    if (safety) {
      effective.safety.requireSandbox = requireOnlyTighterBoolean({
        layer,
        path: 'safety.requireSandbox',
        requested: safety.requireSandbox,
        ceiling: ceiling.safety.requireSandbox,
        current: effective.safety.requireSandbox,
        trueIsStricter: true,
      });
      effective.safety.sandboxUnavailable = tightenRanked({
        layer,
        path: 'safety.sandboxUnavailable',
        requested: safety.sandboxUnavailable,
        ceiling: ceiling.safety.sandboxUnavailable,
        current: effective.safety.sandboxUnavailable,
        rank: SANDBOX_FALLBACK_RANK,
      });
      effective.safety.maxInteractionMode = tightenRanked({
        layer,
        path: 'safety.maxInteractionMode',
        requested: safety.maxInteractionMode,
        ceiling: ceiling.safety.maxInteractionMode,
        current: effective.safety.maxInteractionMode,
        rank: INTERACTION_RANK,
      });
      effective.safety.maxFilesystemScope = tightenRanked({
        layer,
        path: 'safety.maxFilesystemScope',
        requested: safety.maxFilesystemScope,
        ceiling: ceiling.safety.maxFilesystemScope,
        current: effective.safety.maxFilesystemScope,
        rank: FILESYSTEM_RANK,
      });
      effective.safety.networkMode = tightenRanked({
        layer,
        path: 'safety.networkMode',
        requested: safety.networkMode,
        ceiling: ceiling.safety.networkMode,
        current: effective.safety.networkMode,
        rank: NETWORK_RANK,
      });
      if (safety.networkAllowlist) {
        ensureSubset(
          layer,
          'safety.networkAllowlist',
          safety.networkAllowlist,
          ceiling.safety.networkAllowlist,
        );
        effective.safety.networkAllowlist = intersect(
          effective.safety.networkAllowlist,
          safety.networkAllowlist,
        );
      }
      if (effective.safety.networkAllowlist.length === 0) effective.safety.networkMode = 'off';
      effective.safety.networkDenylist = normalizeSet([
        ...effective.safety.networkDenylist,
        ...(safety.networkDenylist ?? []),
      ]);
      effective.safety.protectedPathPolicy = tightenRanked({
        layer,
        path: 'safety.protectedPathPolicy',
        requested: safety.protectedPathPolicy,
        ceiling: ceiling.safety.protectedPathPolicy,
        current: effective.safety.protectedPathPolicy,
        rank: PROTECTED_PATH_RANK,
      });
      effective.safety.protectedPaths = normalizeSet([
        ...effective.safety.protectedPaths,
        ...(safety.protectedPaths ?? []),
      ]);
      if (safety.mcpProviderAllowlist) {
        ensureSubset(
          layer,
          'safety.mcpProviderAllowlist',
          safety.mcpProviderAllowlist,
          ceiling.safety.mcpProviderAllowlist,
        );
        effective.safety.mcpProviderAllowlist = intersect(
          effective.safety.mcpProviderAllowlist,
          safety.mcpProviderAllowlist,
        );
      }
      effective.safety.mcpProviderDenylist = normalizeSet([
        ...effective.safety.mcpProviderDenylist,
        ...(safety.mcpProviderDenylist ?? []),
      ]);
    }

    for (const field of RESOURCE_FIELDS) {
      const requested = restriction.resources?.[field];
      if (requested === undefined) continue;
      if (requested > ceiling.resources[field]) {
        escalation(layer, `resources.${field}`, requested, ceiling.resources[field]);
      }
      effective.resources[field] = Math.min(effective.resources[field], requested);
    }

    const data = restriction.data;
    if (data) {
      if (data.providerRouteAllowlist) {
        ensureSubset(
          layer,
          'data.providerRouteAllowlist',
          data.providerRouteAllowlist,
          ceiling.data.providerRouteAllowlist,
        );
        effective.data.providerRouteAllowlist = intersect(
          effective.data.providerRouteAllowlist,
          data.providerRouteAllowlist,
        );
      }
      effective.data.providerRouteDenylist = normalizeSet([
        ...effective.data.providerRouteDenylist,
        ...(data.providerRouteDenylist ?? []),
      ]);
      effective.data.maxWorkspaceDataClassification = tightenRanked({
        layer,
        path: 'data.maxWorkspaceDataClassification',
        requested: data.maxWorkspaceDataClassification,
        ceiling: ceiling.data.maxWorkspaceDataClassification,
        current: effective.data.maxWorkspaceDataClassification,
        rank: DATA_CLASSIFICATION_RANK,
      });
    }

    const logging = restriction.logging;
    if (logging) {
      effective.logging.defaultMode = tightenRanked({
        layer,
        path: 'logging.defaultMode',
        requested: logging.defaultMode,
        ceiling: ceiling.logging.defaultMode,
        current: effective.logging.defaultMode,
        rank: LOGGING_MODE_RANK,
      });
      effective.logging.allowContentOptIn = requireOnlyTighterBoolean({
        layer,
        path: 'logging.allowContentOptIn',
        requested: logging.allowContentOptIn,
        ceiling: ceiling.logging.allowContentOptIn,
        current: effective.logging.allowContentOptIn,
        trueIsStricter: false,
      });
      for (const field of ['retentionDays', 'maxTotalBytes', 'maxSessionBytes'] as const) {
        const requested = logging[field];
        if (requested === undefined) continue;
        if (requested > ceiling.logging[field]) {
          escalation(layer, `logging.${field}`, requested, ceiling.logging[field]);
        }
        effective.logging[field] = Math.min(effective.logging[field], requested);
      }
      effective.logging.maxSessionBytes = Math.min(
        effective.logging.maxSessionBytes,
        effective.logging.maxTotalBytes,
      );
    }

    const telemetry = restriction.telemetry;
    if (telemetry) {
      effective.telemetry.allowed = requireOnlyTighterBoolean({
        layer,
        path: 'telemetry.allowed',
        requested: telemetry.allowed,
        ceiling: ceiling.telemetry.allowed,
        current: effective.telemetry.allowed,
        trueIsStricter: false,
      });
      effective.telemetry.endpointPolicy = tightenRanked({
        layer,
        path: 'telemetry.endpointPolicy',
        requested: telemetry.endpointPolicy,
        ceiling: ceiling.telemetry.endpointPolicy,
        current: effective.telemetry.endpointPolicy,
        rank: ENDPOINT_POLICY_RANK,
      });
    }

    const requirements = restriction.requirements;
    if (requirements) {
      effective.requirements.minimumApproval = tightenRequirement({
        layer,
        path: 'requirements.minimumApproval',
        requested: requirements.minimumApproval,
        ceiling: ceiling.requirements.minimumApproval,
        current: effective.requirements.minimumApproval,
        rank: APPROVAL_RANK,
      });
      effective.requirements.minimumVerification = tightenRequirement({
        layer,
        path: 'requirements.minimumVerification',
        requested: requirements.minimumVerification,
        ceiling: ceiling.requirements.minimumVerification,
        current: effective.requirements.minimumVerification,
        rank: VERIFICATION_RANK,
      });
    }
  }

  return parseReleaseProfile(effective);
}
