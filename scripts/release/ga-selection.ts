import { z } from 'zod';
import {
  RELEASE_CAPABILITIES,
  type ReleaseCapability,
  releaseCapabilitySchema,
} from '#kite-cli/config/release-capabilities';
import { canonicalJson, sha256DomainSeparated } from './canonical-json';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const GA_STABLE_MILESTONE_BY_CAPABILITY_: Readonly<Record<ReleaseCapability, string>> =
  Object.freeze({
    builtin_read_tools: 'MS:LIMITED-SLO',
    builtin_write_tools: 'MS:LIMITED-SLO',
    shell: 'MS:LIMITED-SLO',
    plan: 'MS:LIMITED-SLO',
    tool_search: 'MS:LIMITED-SLO',
    mcp_read: 'MS:LIMITED-SLO',
    mcp_write: 'MS:5B-STABLE',
    skills_readonly: 'MS:5C-READONLY-STABLE',
    skills_effectful: 'MS:5C-EFFECTFUL-STABLE',
    verification: 'MS:5A-STABLE',
    manual_compaction: 'MS:4-MANUAL-STABLE',
    auto_compaction: 'MS:6A-AUTO-STABLE',
    full_interaction_mode: 'MS:LIMITED-SLO',
    content_session_logging: 'MS:LIMITED-SLO',
    remote_telemetry: 'MS:LIMITED-SLO',
  });

export const gaSelectionSchema = z
  .object({
    version: z.literal(1),
    selectionId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    selectedCapabilities: z.array(
      z
        .object({
          capability: releaseCapabilitySchema,
          stableMilestone: z.string().regex(/^MS:[A-Z0-9.-]+$/),
          decisionDigest: digestSchema,
        })
        .strict(),
    ),
    forcedOffCapabilities: z.array(releaseCapabilitySchema),
    approvedBy: z.array(z.string().min(1).max(128)),
  })
  .strict();

export type GASelection = z.infer<typeof gaSelectionSchema>;

export interface StableCapabilityDecision {
  capability: ReleaseCapability;
  stableMilestone: string;
  decisionDigest: `sha256:${string}`;
  status: 'stable';
  fresh: true;
}

const stableCapabilityDecisionSchema = z
  .object({
    capability: releaseCapabilitySchema,
    stableMilestone: z.string().regex(/^MS:[A-Z0-9.-]+$/),
    decisionDigest: digestSchema,
    status: z.literal('stable'),
    fresh: z.literal(true),
  })
  .strict();

export interface GASelectionValidation {
  selection: GASelection;
  selectionDigest: `sha256:${string}`;
}

export interface GAGateRecord {
  schema: 'GAGateRecord';
  status: 'blocked' | 'passed';
  gaEligible: boolean;
  selectionDigest: `sha256:${string}`;
  candidate: GACandidateIdentity;
  dependencyDecisionDigests: `sha256:${string}`[];
  reasonCodes: string[];
  forcedOffCapabilities: ReleaseCapability[];
  recordDigest: `sha256:${string}`;
}

const GA_DEPENDENCY_IDS_ = [
  'ms_limited_approved',
  'ms_limited_slo',
  'ms_2a_rc',
  'ms_3_ops_ready',
  'd03_closed',
  'd05_closed',
  'd10_closed',
  'maintainer_security_review',
  'production_support_set',
] as const;
type GADependencyId = (typeof GA_DEPENDENCY_IDS_)[number];

interface TrustedGADependencyVerifier {
  dependency: GADependencyId;
  verifierIdentity: string;
  decisionDigest: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  routeDigest: `sha256:${string}`;
  cohortDigest: `sha256:${string}`;
  verifiedAt: string;
  selectionDigest: `sha256:${string}`;
}

const TRUSTED_GA_DEPENDENCY_VERIFIERS_: readonly TrustedGADependencyVerifier[] = Object.freeze([]);

export interface GACandidateIdentity {
  artifactDigest: `sha256:${string}`;
  profileDigest: `sha256:${string}`;
  routeDigest: `sha256:${string}`;
  cohortDigest: `sha256:${string}`;
}

export interface GADependencyDecision extends GACandidateIdentity {
  schema: 'GADependencyDecision';
  dependency: GADependencyId;
  status: 'passed';
  verifierIdentity: string;
  verifiedAt: string;
  decisionDigest: `sha256:${string}`;
}

const gaCandidateIdentitySchema = z
  .object({
    artifactDigest: digestSchema,
    profileDigest: digestSchema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
  })
  .strict();

const gaDependencyDecisionSchema = gaCandidateIdentitySchema.extend({
  schema: z.literal('GADependencyDecision'),
  dependency: z.enum(GA_DEPENDENCY_IDS_),
  status: z.literal('passed'),
  verifierIdentity: z.string().min(1).max(256),
  verifiedAt: z.iso.datetime({ offset: true }),
  decisionDigest: digestSchema,
});

export function validateGaSelection(
  rawSelection: unknown,
  stableDecisions: readonly StableCapabilityDecision[],
): GASelectionValidation {
  const selection = gaSelectionSchema.parse(rawSelection);
  const selected = new Set<ReleaseCapability>();
  const forcedOff = new Set(selection.forcedOffCapabilities);
  if (forcedOff.size !== selection.forcedOffCapabilities.length) {
    throw new Error('GA selection repeats a forced-off capability.');
  }
  const parsedDecisions = z.array(stableCapabilityDecisionSchema).parse(stableDecisions);
  const decisions = new Map(parsedDecisions.map((decision) => [decision.capability, decision]));
  if (decisions.size !== stableDecisions.length) {
    throw new Error('Stable capability decision registry repeats a capability.');
  }

  for (const entry of selection.selectedCapabilities) {
    if (selected.has(entry.capability) || forcedOff.has(entry.capability)) {
      throw new Error(
        'GA capability must appear exactly once across selected and forced-off sets.',
      );
    }
    selected.add(entry.capability);
    if (entry.stableMilestone !== GA_STABLE_MILESTONE_BY_CAPABILITY_[entry.capability]) {
      throw new Error(`GA capability ${entry.capability} cites an unregistered stable milestone.`);
    }
    const decision = decisions.get(entry.capability);
    if (
      decision?.status !== 'stable' ||
      decision.fresh !== true ||
      decision.stableMilestone !== entry.stableMilestone ||
      decision.decisionDigest !== entry.decisionDigest
    ) {
      throw new Error(`GA capability ${entry.capability} lacks an exact fresh stable decision.`);
    }
  }
  const covered = new Set([...selected, ...forcedOff]);
  if (
    covered.size !== RELEASE_CAPABILITIES.length ||
    RELEASE_CAPABILITIES.some((capability) => !covered.has(capability))
  ) {
    throw new Error('GA selection must explicitly select or force off every release capability.');
  }
  if (selection.approvedBy.length !== new Set(selection.approvedBy).size) {
    throw new Error('GA selection repeats an approver identity.');
  }
  const canonicalSelection: GASelection = {
    ...selection,
    selectedCapabilities: [...selection.selectedCapabilities].sort((left, right) =>
      left.capability.localeCompare(right.capability),
    ),
    forcedOffCapabilities: [...selection.forcedOffCapabilities].sort(),
    approvedBy: [...selection.approvedBy].sort(),
  };
  return {
    selection: canonicalSelection,
    selectionDigest: sha256DomainSeparated(
      'kite.release.ga-selection.v1',
      canonicalJson(canonicalSelection),
    ),
  };
}

/** Gate-only projection. It cannot assemble or publish an artifact. */
export function evaluateGaSelectionGate(input: {
  validation: GASelectionValidation;
  candidate: GACandidateIdentity;
  dependencies: readonly GADependencyDecision[];
}): GAGateRecord {
  const candidate = gaCandidateIdentitySchema.parse(input.candidate) as GACandidateIdentity;
  const dependencies = z.array(gaDependencyDecisionSchema).parse(input.dependencies);
  const reasons: string[] = [];
  if (TRUSTED_GA_DEPENDENCY_VERIFIERS_.length === 0) {
    reasons.push('authenticated_ga_dependency_verifier_not_configured');
  }
  const decisions = new Map<GADependencyId, GADependencyDecision>();
  for (const dependency of dependencies) {
    if (decisions.has(dependency.dependency)) {
      throw new Error(`GA dependency ${dependency.dependency} is duplicated.`);
    }
    decisions.set(dependency.dependency, dependency as GADependencyDecision);
    if (
      TRUSTED_GA_DEPENDENCY_VERIFIERS_.length > 0 &&
      !TRUSTED_GA_DEPENDENCY_VERIFIERS_.some(
        (trusted) =>
          trusted.dependency === dependency.dependency &&
          trusted.verifierIdentity === dependency.verifierIdentity &&
          trusted.decisionDigest === dependency.decisionDigest &&
          trusted.artifactDigest === dependency.artifactDigest &&
          trusted.profileDigest === dependency.profileDigest &&
          trusted.routeDigest === dependency.routeDigest &&
          trusted.cohortDigest === dependency.cohortDigest &&
          trusted.verifiedAt === dependency.verifiedAt &&
          trusted.selectionDigest === input.validation.selectionDigest,
      )
    ) {
      reasons.push(`dependency_verifier_untrusted:${dependency.dependency}`);
    }
    if (
      dependency.artifactDigest !== candidate.artifactDigest ||
      dependency.profileDigest !== candidate.profileDigest ||
      dependency.routeDigest !== candidate.routeDigest ||
      dependency.cohortDigest !== candidate.cohortDigest
    ) {
      reasons.push(`dependency_identity_mismatch:${dependency.dependency}`);
    }
  }
  const requireDependency = (dependency: GADependencyId, missingReason: string): void => {
    if (!decisions.has(dependency)) reasons.push(missingReason);
  };
  requireDependency('ms_limited_approved', 'ms_limited_approved_missing');
  requireDependency('ms_limited_slo', 'ms_limited_slo_missing');
  requireDependency('ms_2a_rc', 'ms_2a_rc_missing');
  requireDependency('ms_3_ops_ready', 'ms_3_ops_ready_missing');
  requireDependency('maintainer_security_review', 'maintainer_security_review_missing');
  requireDependency('production_support_set', 'production_support_set_empty');
  const selected = new Set(
    input.validation.selection.selectedCapabilities.map((entry) => entry.capability),
  );
  if (selected.has('remote_telemetry')) requireDependency('d03_closed', 'd03_open');
  if (selected.has('full_interaction_mode')) requireDependency('d05_closed', 'd05_open');
  if (
    (selected.has('skills_readonly') || selected.has('skills_effectful')) &&
    !decisions.has('d10_closed')
  ) {
    reasons.push('d10_open');
  }
  if (input.validation.selection.selectedCapabilities.length === 0) {
    reasons.push('no_stable_capability_selected');
  }
  if (input.validation.selection.approvedBy.length === 0)
    reasons.push('selection_approval_missing');
  reasons.sort();
  const status: GAGateRecord['status'] = reasons.length === 0 ? 'passed' : 'blocked';
  const withoutDigest: Omit<GAGateRecord, 'recordDigest'> = {
    schema: 'GAGateRecord',
    status,
    gaEligible: status === 'passed',
    selectionDigest: input.validation.selectionDigest,
    candidate,
    dependencyDecisionDigests: dependencies
      .map((dependency) => dependency.decisionDigest as `sha256:${string}`)
      .sort(),
    reasonCodes: reasons,
    forcedOffCapabilities: [...input.validation.selection.forcedOffCapabilities],
  };
  return {
    ...withoutDigest,
    recordDigest: sha256DomainSeparated(
      'kite.release.ga-gate-record.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
