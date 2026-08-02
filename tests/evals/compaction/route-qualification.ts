import { z } from 'zod';
import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const routeIdentitySchema = z
  .object({
    version: z.literal(1),
    providerType: z.string().min(1).max(128),
    endpointClass: z.enum(['managed', 'deployment_route', 'custom']),
    deploymentRoute: z.string().min(1).max(256),
    modelIdentity: z.string().min(1).max(256),
    resolvedCapabilitySources: z.array(z.string().min(1).max(256)).max(64),
    summaryLimit: z.number().int().positive(),
    tokenLimit: z.number().int().positive(),
    narrativeLimit: z.number().int().positive(),
    promptPolicyDigest: digest,
    estimatorIdentity: z.string().min(1).max(128),
    toolSkillEnvironmentDigest: digest,
    providerDataPolicyDigest: digest,
    evaluatorDigest: digest,
    suiteDigest: digest,
    scorerDigest: digest,
    artifactDigest: digest,
  })
  .strict();

export type CompactionRouteIdentityV1 = z.infer<typeof routeIdentitySchema>;

export interface RouteQualificationRecordV1 {
  version: 1;
  kind: 'compaction_route_qualification';
  routeDigest: `sha256:${string}`;
  observation: 'not_observed';
  status: 'blocked';
  qualified: false;
  evidenceEligible: false;
  distribution: 'nonDistributable';
  reasonCodes: string[];
  digest: `sha256:${string}`;
}

export function compactionRouteDigest(identity: CompactionRouteIdentityV1): `sha256:${string}` {
  return sha256Digest(canonicalJsonBytes(routeIdentitySchema.parse(identity)));
}

/** Local registry has deliberately no API capable of producing a qualified route. */
export class LocalCompactionRouteRegistryV1 {
  readonly #expected = new Map<`sha256:${string}`, CompactionRouteIdentityV1>();

  registerExpected(value: CompactionRouteIdentityV1): RouteQualificationRecordV1 {
    const identity = structuredClone(routeIdentitySchema.parse(value));
    const routeDigest = compactionRouteDigest(identity);
    this.#expected.set(routeDigest, identity);
    const reasons = [
      'live_route_qualification_not_observed',
      'formal_artifact_missing',
      ...(identity.endpointClass === 'custom' ? ['custom_endpoint_unqualified'] : []),
    ].sort();
    const withoutDigest = {
      version: 1 as const,
      kind: 'compaction_route_qualification' as const,
      routeDigest,
      observation: 'not_observed' as const,
      status: 'blocked' as const,
      qualified: false as const,
      evidenceEligible: false as const,
      distribution: 'nonDistributable' as const,
      reasonCodes: reasons,
    };
    return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
  }

  expectedIdentity(routeDigest: `sha256:${string}`): CompactionRouteIdentityV1 | null {
    const identity = this.#expected.get(routeDigest);
    return identity ? structuredClone(identity) : null;
  }

  qualifiedRouteDigests(): readonly [] {
    return [];
  }

  routeEnabled(identity: CompactionRouteIdentityV1): false {
    routeIdentitySchema.parse(identity);
    return false;
  }
}

export function syntheticRouteIdentity(): CompactionRouteIdentityV1 {
  return {
    version: 1,
    providerType: 'synthetic-provider',
    endpointClass: 'custom',
    deploymentRoute: 'local-fixture-only',
    modelIdentity: 'synthetic-model-v1',
    resolvedCapabilitySources: ['fixture:synthetic'],
    summaryLimit: 4_096,
    tokenLimit: 16_384,
    narrativeLimit: 8_192,
    promptPolicyDigest: `sha256:${'1'.repeat(64)}`,
    estimatorIdentity: 'synthetic-estimator-v1',
    toolSkillEnvironmentDigest: `sha256:${'2'.repeat(64)}`,
    providerDataPolicyDigest: `sha256:${'3'.repeat(64)}`,
    evaluatorDigest: `sha256:${'4'.repeat(64)}`,
    suiteDigest: `sha256:${'5'.repeat(64)}`,
    scorerDigest: `sha256:${'6'.repeat(64)}`,
    artifactDigest: `sha256:${'7'.repeat(64)}`,
  };
}
