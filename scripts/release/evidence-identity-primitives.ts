import { z } from 'zod';

/**
 * The two canonical identity primitives that may be shared by independent
 * diagnostic contracts.  This module intentionally contains no bundle,
 * evaluator, or release-control vocabulary.
 */
export const releaseIdentityDigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const releaseIdentityCommitV1Schema = z.string().regex(/^[a-f0-9]{40}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonEmptySchema = z.string().trim().min(1);

export const releaseArtifactIdentityV1Schema = z
  .object({
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    commit: releaseIdentityCommitV1Schema,
    payloadSha256: releaseIdentityDigestV1Schema,
    canonicalManifestDigest: releaseIdentityDigestV1Schema,
    behaviorDigest: releaseIdentityDigestV1Schema,
    profileDigest: releaseIdentityDigestV1Schema,
    gatePolicyDigest: releaseIdentityDigestV1Schema,
  })
  .strict();

const githubExecutionIdentityV1Schema = z
  .object({
    source: z.literal('github_actions'),
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    workflowPath: nonEmptySchema,
    workflowRef: nonEmptySchema,
    workflowSha: releaseIdentityCommitV1Schema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    ref: nonEmptySchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    job: nonEmptySchema,
    commit: releaseIdentityCommitV1Schema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const localSyntheticExecutionIdentityV1Schema = z
  .object({
    source: z.literal('local_synthetic'),
    fixtureId: nonEmptySchema,
    runner: nonEmptySchema,
    commit: releaseIdentityCommitV1Schema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const externalExecutionIdentityV1Schema = z
  .object({
    source: z.literal('external'),
    reviewerIdentity: nonEmptySchema,
    recordIdentity: nonEmptySchema,
    commit: releaseIdentityCommitV1Schema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

const githubMaintainerReviewExecutionIdentityV1Schema = z
  .object({
    source: z.literal('github_maintainer_review'),
    canonicalRepository: nonEmptySchema,
    repositoryId: nonEmptySchema,
    workflowPath: nonEmptySchema,
    workflowRef: nonEmptySchema,
    workflowSha: releaseIdentityCommitV1Schema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    ref: nonEmptySchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    actorIdentity: nonEmptySchema,
    reviewerIdentity: nonEmptySchema,
    recordIdentity: nonEmptySchema,
    commit: releaseIdentityCommitV1Schema,
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
  })
  .strict();

export const releaseEvidenceExecutionIdentityV1Schema = z.discriminatedUnion('source', [
  githubExecutionIdentityV1Schema,
  localSyntheticExecutionIdentityV1Schema,
  externalExecutionIdentityV1Schema,
  githubMaintainerReviewExecutionIdentityV1Schema,
]);

export type ReleaseArtifactIdentityV1 = z.infer<typeof releaseArtifactIdentityV1Schema>;
export type ReleaseEvidenceExecutionIdentityV1 = z.infer<
  typeof releaseEvidenceExecutionIdentityV1Schema
>;

export function sameReleaseArtifactIdentityV1(
  left: ReleaseArtifactIdentityV1,
  right: ReleaseArtifactIdentityV1,
): boolean {
  return (
    left.canonicalRepository === right.canonicalRepository &&
    left.repositoryId === right.repositoryId &&
    left.commit === right.commit &&
    left.payloadSha256 === right.payloadSha256 &&
    left.canonicalManifestDigest === right.canonicalManifestDigest &&
    left.behaviorDigest === right.behaviorDigest &&
    left.profileDigest === right.profileDigest &&
    left.gatePolicyDigest === right.gatePolicyDigest
  );
}
