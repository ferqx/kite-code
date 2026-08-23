import { z } from 'zod';

export const PINNED_RELEASE_REPOSITORY = 'ferqx/kite-code' as const;
export const PINNED_RELEASE_REPOSITORY_ID = 'R_kgDOSKbi8g' as const;
export const PINNED_RELEASE_WORKFLOW_PATH = '.github/workflows/release-candidate.yml' as const;
export const PINNED_GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com' as const;
export const REAL_RELEASE_PROVENANCE_VERIFICATION_ENABLED = false as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const releaseProvenanceClaimsSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('github_actions_oidc'),
    canonicalRepository: z.literal(PINNED_RELEASE_REPOSITORY),
    repositoryId: z.literal(PINNED_RELEASE_REPOSITORY_ID),
    repositoryVisibility: z.enum(['private', 'public']),
    workflowPath: z.literal(PINNED_RELEASE_WORKFLOW_PATH),
    workflowRef: z.string().trim().min(1),
    workflowSha: commitSchema,
    oidcIssuer: z.literal(PINNED_GITHUB_OIDC_ISSUER),
    ref: z.string().regex(/^refs\/tags\/v[0-9][0-9A-Za-z._-]*$/),
    commit: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    artifactDigest: digestSchema,
    subjects: z
      .object({
        payloadSha256: digestSchema,
        canonicalManifestDigest: digestSchema,
        sbomSha256: digestSchema,
      })
      .strict(),
    gateReplayStatus: z.literal('passed'),
    sigstoreBundleVerified: z.boolean(),
    githubAttestationVerified: z.boolean(),
    nativePlatformSignatureVerified: z.boolean(),
    nonDistributable: z.boolean(),
  })
  .strict()
  .superRefine((claims, context) => {
    const expectedWorkflowRef = `${PINNED_RELEASE_REPOSITORY}/${PINNED_RELEASE_WORKFLOW_PATH}@${claims.ref}`;
    if (claims.workflowRef !== expectedWorkflowRef) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message:
          'workflowRef must bind the pinned workflow path to the exact protected release tag',
      });
    }
  });

export type ReleaseProvenanceClaims = z.infer<typeof releaseProvenanceClaimsSchema>;

export class ReleaseProvenanceIdentityError extends Error {
  readonly code: 'claims_invalid' | 'identity_mismatch';

  constructor(code: 'claims_invalid' | 'identity_mismatch') {
    super(`Release provenance identity verification failed: ${code}`);
    this.name = 'ReleaseProvenanceIdentityError';
    this.code = code;
  }
}

export interface BlockedReleaseProvenanceEvaluation {
  status: 'blocked';
  reason:
    | 'repository_private'
    | 'real_attestation_verifier_disabled'
    | 'signature_or_attestation_unverified'
    | 'native_platform_signature_unverified'
    | 'non_distributable_input';
  productionAccepted: false;
  identityContractMatched: true;
}

/**
 * Validate the complete pinned identity projection. This is not a substitute
 * for cryptographic Sigstore/GitHub attestation verification, which is disabled.
 */
export function evaluateReleaseProvenanceIdentity(input: {
  claims: unknown;
  expected: {
    commit: string;
    workflowSha: string;
    artifactDigest: string;
    payloadSha256: string;
    canonicalManifestDigest: string;
    sbomSha256: string;
  };
}): BlockedReleaseProvenanceEvaluation {
  const parsed = releaseProvenanceClaimsSchema.safeParse(input.claims);
  if (!parsed.success) throw new ReleaseProvenanceIdentityError('claims_invalid');
  const claims = parsed.data;
  const expected = input.expected;
  if (
    claims.commit !== expected.commit ||
    claims.workflowSha !== expected.workflowSha ||
    claims.artifactDigest !== expected.artifactDigest ||
    claims.subjects.payloadSha256 !== expected.payloadSha256 ||
    claims.subjects.canonicalManifestDigest !== expected.canonicalManifestDigest ||
    claims.subjects.sbomSha256 !== expected.sbomSha256
  ) {
    throw new ReleaseProvenanceIdentityError('identity_mismatch');
  }
  if (claims.nonDistributable) return blocked('non_distributable_input');
  if (claims.repositoryVisibility === 'private') return blocked('repository_private');
  if (!claims.sigstoreBundleVerified || !claims.githubAttestationVerified) {
    return blocked('signature_or_attestation_unverified');
  }
  if (!claims.nativePlatformSignatureVerified) {
    return blocked('native_platform_signature_unverified');
  }
  return blocked('real_attestation_verifier_disabled');
}

function blocked(
  reason: BlockedReleaseProvenanceEvaluation['reason'],
): BlockedReleaseProvenanceEvaluation {
  return { status: 'blocked', reason, productionAccepted: false, identityContractMatched: true };
}
