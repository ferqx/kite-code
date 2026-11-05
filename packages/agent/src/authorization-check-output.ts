import { type ShellRiskLevel, shellRiskAnswer, shellRiskDecision } from './shell-risk-review';

export type AuthorizationCheckAnswer = {
  decision: 'approve_once' | 'reject' | 'ask_user';
  reason: string;
};
export type AuthorizationCheckOutput = {
  kind: 'authorization_check_output';
  version: 1;
  modelExecutionId: string;
  modelOutputDigest: string;
  contentHash: string;
  answer: AuthorizationCheckAnswer;
  reviewPurpose?: 'shell_risk';
  risk?: ShellRiskLevel;
};
export const authorizationCheckOutputMediaType =
  'application/vnd.kite.authorization-check-output+json';
export const authorizationCheckOutputRefId = (digest: string) => `check-output-${digest}`;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function authorizationCheckAnswer(value: unknown): AuthorizationCheckAnswer | null {
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
    decision: value.decision as AuthorizationCheckAnswer['decision'],
    reason: value.reason,
  };
}
/** Preserve the raw Model JSON; only the selected trusted contract derives a decision. */
export function authorizationCheckAnswerForContract(
  value: unknown,
  purpose?: 'shell_risk',
): { answer: AuthorizationCheckAnswer; risk?: ShellRiskLevel } | null {
  if (purpose === 'shell_risk') {
    const risk = shellRiskAnswer(value);
    return risk ? { answer: shellRiskDecision(risk), risk: risk.risk } : null;
  }
  const answer = authorizationCheckAnswer(value);
  return answer ? { answer } : null;
}
/** Finite purpose-bound receipt; no private ModelOutput head or original subject is exposed. */
export function authorizationCheckOutput(value: unknown): AuthorizationCheckOutput | null {
  if (
    !object(value) ||
    ![
      'answer,contentHash,kind,modelExecutionId,modelOutputDigest,version',
      'answer,contentHash,kind,modelExecutionId,modelOutputDigest,reviewPurpose,risk,version',
    ].includes(Object.keys(value).sort().join(',')) ||
    value.kind !== 'authorization_check_output' ||
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
  const answer = authorizationCheckAnswer(value.answer);
  if (!answer) return null;
  const risk =
    value.reviewPurpose === 'shell_risk'
      ? shellRiskAnswer({ risk: value.risk, reason: answer.reason })
      : null;
  if (
    (Object.hasOwn(value, 'reviewPurpose') || Object.hasOwn(value, 'risk')) &&
    (!risk || shellRiskDecision(risk).decision !== answer.decision)
  )
    return null;
  return {
    kind: value.kind,
    version: value.version,
    modelExecutionId: value.modelExecutionId,
    modelOutputDigest: value.modelOutputDigest,
    contentHash: value.contentHash,
    answer,
    ...(risk ? { reviewPurpose: 'shell_risk' as const, risk: risk.risk } : {}),
  };
}
