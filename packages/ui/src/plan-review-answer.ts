import type { Interaction, Json } from '@kite-ai/client';

export const planReviewFeedbackLimit = 8192;

type PlanDescription =
  | {
      kind: 'supported';
      planId: string;
      version: string;
      digest: string;
      content: string;
    }
  | { kind: 'readonly'; reason: string };

/** Public plan metadata describes information only, never an authorization grant. */
export function describePlanReview(request: Json): PlanDescription {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return { kind: 'readonly', reason: '无法识别计划请求。' };
  const { planId, version, digest, content } = request;
  if (
    typeof planId !== 'string' ||
    !planId ||
    typeof version !== 'string' ||
    !version ||
    typeof digest !== 'string' ||
    !digest ||
    typeof content !== 'string' ||
    !content
  )
    return { kind: 'readonly', reason: '计划身份、版本、摘要或正文缺失。' };
  if (Object.hasOwn(request, 'allowedModes'))
    return { kind: 'readonly', reason: '此历史计划请求仅供阅读。' };
  return { kind: 'supported', planId, version, digest, content };
}

export function serializePlanReviewAnswer(
  request: Json,
  decision: 'approve' | 'deny' | 'revise',
  feedback = '',
  asUserMessage = false,
): Extract<Interaction['answer'], { kind: 'plan_review' }> {
  if (describePlanReview(request).kind !== 'supported') throw new Error('plan_review_readonly');
  if (!['approve', 'deny', 'revise'].includes(decision))
    throw new Error('plan_review_decision_invalid');
  if (feedback.length > planReviewFeedbackLimit) throw new Error('feedback_too_long');
  if (asUserMessage && (!feedback.trim() || decision === 'deny'))
    throw new Error('plan_review_message_invalid');
  return {
    kind: 'plan_review',
    decision,
    ...(feedback ? { feedback } : {}),
    ...(asUserMessage ? { asUserMessage: true } : {}),
  };
}
