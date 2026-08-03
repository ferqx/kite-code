import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const compactionRouteIdentityV1Schema = z
  .object({
    version: z.literal(1),
    providerType: z.string().trim().min(1).max(128),
    endpointClass: z.enum(['managed', 'deployment_route', 'custom']),
    deploymentRoute: z.string().trim().min(1).max(256),
    modelIdentity: z.string().trim().min(1).max(256),
    resolvedCapabilitySources: z.array(z.string().trim().min(1).max(256)).max(64),
    summaryLimit: z.number().int().positive(),
    tokenLimit: z.number().int().positive(),
    narrativeLimit: z.number().int().positive(),
    promptPolicyDigest: digestSchema,
    estimatorIdentity: z.string().trim().min(1).max(128),
    toolSkillEnvironmentDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    evaluatorDigest: digestSchema,
    suiteDigest: digestSchema,
    scorerDigest: digestSchema,
    artifactDigest: digestSchema,
  })
  .strict()
  .superRefine((identity, context) => {
    const canonicalSources = [...new Set(identity.resolvedCapabilitySources)].sort();
    if (
      canonicalSources.length !== identity.resolvedCapabilitySources.length ||
      canonicalSources.some((source, index) => source !== identity.resolvedCapabilitySources[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedCapabilitySources'],
        message: 'resolved capability sources must be unique and canonically sorted.',
      });
    }
    if (identity.summaryLimit > identity.tokenLimit) {
      context.addIssue({
        code: 'custom',
        path: ['summaryLimit'],
        message: 'summary limit cannot exceed the route token limit.',
      });
    }
    if (identity.narrativeLimit > identity.tokenLimit) {
      context.addIssue({
        code: 'custom',
        path: ['narrativeLimit'],
        message: 'narrative limit cannot exceed the route token limit.',
      });
    }
  });

export type CompactionRouteIdentityV1 = z.infer<typeof compactionRouteIdentityV1Schema>;

export interface RouteQualificationRecordV1 {
  version: 1;
  kind: 'compaction_route_qualification';
  routeDigest: `sha256:${string}`;
  priorRouteDigest: `sha256:${string}` | null;
  registryDigest: `sha256:${string}`;
  observation: 'not_observed';
  status: 'blocked';
  qualified: false;
  evidenceEligible: false;
  distribution: 'nonDistributable';
  reasonCodes: string[];
  digest: `sha256:${string}`;
}

export function compactionRouteDigest(identity: CompactionRouteIdentityV1): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.compaction.route-identity.v1',
    canonicalJsonBytes(compactionRouteIdentityV1Schema.parse(identity)),
  );
}

/**
 * Source-owned local registry. It tracks expected identities and drift, but it
 * deliberately has no authority or API capable of admitting a live route.
 */
export class LocalCompactionRouteRegistryV1 {
  readonly #expected = new Map<`sha256:${string}`, CompactionRouteIdentityV1>();
  readonly #logicalRoutes = new Map<string, `sha256:${string}`>();

  registerExpected(value: CompactionRouteIdentityV1): RouteQualificationRecordV1 {
    const identity = structuredClone(compactionRouteIdentityV1Schema.parse(value));
    const routeDigest = compactionRouteDigest(identity);
    const logicalRoute = logicalRouteKey(identity);
    const priorRouteDigest = this.#logicalRoutes.get(logicalRoute) ?? null;
    if (priorRouteDigest && priorRouteDigest !== routeDigest) {
      this.#expected.delete(priorRouteDigest);
    }
    this.#expected.set(routeDigest, identity);
    this.#logicalRoutes.set(logicalRoute, routeDigest);

    const reasons = new Set<string>([
      'formal_artifact_missing',
      'live_route_qualification_not_observed',
    ]);
    if (identity.endpointClass === 'custom') reasons.add('custom_endpoint_unqualified');
    if (priorRouteDigest && priorRouteDigest !== routeDigest) {
      reasons.add('route_identity_drift_requires_requalification');
    }
    const registryDigest = this.registryDigest();
    const withoutDigest = {
      version: 1 as const,
      kind: 'compaction_route_qualification' as const,
      routeDigest,
      priorRouteDigest,
      registryDigest,
      observation: 'not_observed' as const,
      status: 'blocked' as const,
      qualified: false as const,
      evidenceEligible: false as const,
      distribution: 'nonDistributable' as const,
      reasonCodes: [...reasons].sort(),
    };
    return {
      ...withoutDigest,
      digest: sha256DomainSeparated(
        'kite.compaction.route-qualification-record.v1',
        canonicalJsonBytes(withoutDigest),
      ),
    };
  }

  expectedIdentity(routeDigest: `sha256:${string}`): CompactionRouteIdentityV1 | null {
    digestSchema.parse(routeDigest);
    const identity = this.#expected.get(routeDigest);
    return identity ? structuredClone(identity) : null;
  }

  registryDigest(): `sha256:${string}` {
    const expected = [...this.#expected.entries()]
      .map(([routeDigest, identity]) => ({ routeDigest, identity }))
      .sort((left, right) => left.routeDigest.localeCompare(right.routeDigest));
    return sha256DomainSeparated(
      'kite.compaction.route-registry.v1',
      canonicalJsonBytes({ expected, qualifiedRouteDigests: [] }),
    );
  }

  qualifiedRouteDigests(): readonly [] {
    return Object.freeze([]);
  }

  routeEnabled(identity: CompactionRouteIdentityV1): false {
    const parsed = compactionRouteIdentityV1Schema.parse(identity);
    const routeDigest = compactionRouteDigest(parsed);
    const expected = this.#expected.get(routeDigest);
    if (expected && compactionRouteDigest(expected) !== routeDigest) {
      throw new Error('Compaction route registry identity drifted after registration.');
    }
    return false;
  }
}

function logicalRouteKey(identity: CompactionRouteIdentityV1): string {
  return [identity.providerType, identity.endpointClass, identity.deploymentRoute].join('\u0000');
}
