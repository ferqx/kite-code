export type AuthorizationReviewAnswer = {
  decision: 'approve_once' | 'reject' | 'ask_user';
  reason: string;
};
export type AuthorizationReviewOutput = {
  kind: 'authorization_review_output';
  version: 1;
  modelExecutionId: string;
  modelOutputDigest: string;
  contentHash: string;
  answer: AuthorizationReviewAnswer;
};
export const authorizationReviewOutputMediaType =
  'application/vnd.kite.authorization-review-output+json';
export const authorizationReviewOutputRefId = (digest: string) => `review-output-${digest}`;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function authorizationReviewAnswer(value: unknown): AuthorizationReviewAnswer | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'decision,reason' ||
    typeof value.decision !== 'string' ||
    !['approve_once', 'reject', 'ask_user'].includes(value.decision) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 8192
  )
    return null;
  return {
    decision: value.decision as AuthorizationReviewAnswer['decision'],
    reason: value.reason,
  };
}
/** Finite purpose-bound receipt; no private ModelOutput head or original subject is exposed. */
export function authorizationReviewOutput(value: unknown): AuthorizationReviewOutput | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'answer,contentHash,kind,modelExecutionId,modelOutputDigest,version' ||
    value.kind !== 'authorization_review_output' ||
    value.version !== 1 ||
    typeof value.modelExecutionId !== 'string' ||
    !value.modelExecutionId ||
    value.modelExecutionId.length > 256 ||
    typeof value.modelOutputDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.modelOutputDigest) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash)
  )
    return null;
  const answer = authorizationReviewAnswer(value.answer);
  if (!answer) return null;
  return {
    kind: value.kind,
    version: value.version,
    modelExecutionId: value.modelExecutionId,
    modelOutputDigest: value.modelOutputDigest,
    contentHash: value.contentHash,
    answer,
  };
}
