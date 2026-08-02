import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  computeProviderEndpointIdentityDigest,
  providerRouteIdentityV1Schema,
} from './provider-data-policy';

export const providerRouteCandidateV1Schema = z
  .object({
    version: z.literal(1),
    candidateId: z.string().trim().min(1),
    decisionId: z.literal('D-14'),
    status: z.literal('blocked_policy_evidence'),
    route: providerRouteIdentityV1Schema,
    endpointIdentityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    modelIds: z.array(z.string().trim().min(1)).min(1),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    officialSources: z
      .array(
        z
          .object({
            purpose: z.enum([
              'model_catalog',
              'open_platform_terms',
              'privacy_policy',
              'context_cache',
            ]),
            url: z.string().url(),
          })
          .strict(),
      )
      .length(4)
      .superRefine((sources, context) => {
        const allowedHostByPurpose = {
          model_catalog: 'api-docs.deepseek.com',
          context_cache: 'api-docs.deepseek.com',
          open_platform_terms: 'cdn.deepseek.com',
          privacy_policy: 'cdn.deepseek.com',
        } as const;
        for (const [index, source] of sources.entries()) {
          const url = new URL(source.url);
          if (
            url.protocol !== 'https:' ||
            url.username !== '' ||
            url.password !== '' ||
            url.port !== '' ||
            url.hostname !== allowedHostByPurpose[source.purpose]
          ) {
            context.addIssue({
              code: 'custom',
              path: [index, 'url'],
              message: `official ${source.purpose} source must use its pinned DeepSeek HTTPS origin`,
            });
          }
        }
        const purposes = sources.map((source) => source.purpose);
        const expected = [
          'context_cache',
          'model_catalog',
          'open_platform_terms',
          'privacy_policy',
        ];
        if (
          new Set(purposes).size !== expected.length ||
          [...purposes].sort().some((purpose, index) => purpose !== expected[index])
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'candidate must contain exactly one official source for every required purpose',
          });
        }
      }),
    assessment: z
      .object({
        processingRegion: z.literal('unknown'),
        fixedContentRetention: z.literal('not_published'),
        trainingUse: z.literal('not_prohibited_by_published_policy'),
        dpa: z.literal('not_verified'),
        downstreamDisclosure: z.literal('required_not_implemented'),
        productionContentAllowed: z.literal(false),
      })
      .strict(),
    blockers: z
      .array(
        z.enum([
          'api_content_retention_not_contractually_bounded',
          'api_training_opt_out_not_verified',
          'dpa_not_verified',
          'end_user_disclosure_not_implemented',
        ]),
      )
      .length(4),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (Date.parse(candidate.expiresAt) <= Date.parse(candidate.observedAt)) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'candidate must expire' });
    }
    if (
      computeProviderEndpointIdentityDigest(candidate.route) !== candidate.endpointIdentityDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['endpointIdentityDigest'],
        message: 'candidate endpoint identity digest mismatch',
      });
    }
    if (new Set(candidate.blockers).size !== candidate.blockers.length) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: 'blockers must be unique' });
    }
  });

export const providerRouteCandidateBundleV1Schema = z
  .object({
    version: z.literal(1),
    decisionId: z.literal('D-14'),
    revision: z.string().trim().min(1),
    candidates: z.array(providerRouteCandidateV1Schema),
  })
  .strict();

export type ProviderRouteCandidateV1 = z.infer<typeof providerRouteCandidateV1Schema>;
export type ProviderRouteCandidateBundleV1 = z.infer<typeof providerRouteCandidateBundleV1Schema>;

/** Candidate assets are never consumed by production admission. */
export function loadProviderRouteCandidateBundleV1(
  now: Date = new Date(),
): ProviderRouteCandidateBundleV1 {
  const path = new URL(
    '../../../release/provider-data-policies/candidates-v1.json',
    import.meta.url,
  );
  const bundle = providerRouteCandidateBundleV1Schema.parse(
    JSON.parse(readFileSync(fileURLToPath(path), 'utf8')),
  );
  if (!Number.isFinite(now.getTime())) throw new Error('candidate review time is invalid');
  if (bundle.candidates.some((candidate) => Date.parse(candidate.expiresAt) <= now.getTime())) {
    throw new Error('provider route candidate policy evidence is stale');
  }
  return bundle;
}
