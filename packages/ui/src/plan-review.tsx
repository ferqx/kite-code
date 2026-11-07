import type { Interaction, Json } from '@kite-ai/client';
import { useId, useRef, useState } from 'react';
import { Button } from './desktop/components/ui/button';
import { Textarea } from './desktop/components/ui/textarea';
import type { InteractionAnswer } from './interactions';
import { SafeMessageMarkdown } from './markdown';
import { questionDraftKey } from './questionnaire';

export type PlanReviewDraft = { feedback: string };
export type PlanDescription =
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
    return { kind: 'readonly', reason: 'Plan request format unknown' };
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
    return { kind: 'readonly', reason: 'Plan identity, version, digest or body unavailable' };
  if (Object.hasOwn(request, 'allowedModes'))
    return { kind: 'readonly', reason: 'Legacy plan request is read only' };
  return {
    kind: 'supported',
    planId,
    version,
    digest,
    content,
  };
}
export function serializePlanReviewAnswer(
  request: Json,
  decision: 'approve' | 'deny' | 'revise',
  feedback = '',
): Extract<InteractionAnswer, { kind: 'plan_review' }> {
  const plan = describePlanReview(request);
  if (plan.kind !== 'supported') throw new Error('plan_review_readonly');
  if (!['approve', 'deny', 'revise'].includes(decision))
    throw new Error('plan_review_decision_invalid');
  if (feedback.length > 8192) throw new Error('feedback_too_long');
  return {
    kind: 'plan_review',
    decision,
    ...(feedback ? { feedback } : {}),
  };
}
export function PlanReviewPanel({
  interaction,
  disabled,
  onAnswer,
  initialDraft,
  onDraftChange,
  completeContent,
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  initialDraft?: PlanReviewDraft;
  onDraftChange?: (draft: PlanReviewDraft) => void;
  completeContent?: string;
}) {
  const plan = describePlanReview(interaction.request);
  const request =
    interaction.request &&
    typeof interaction.request === 'object' &&
    !Array.isArray(interaction.request)
      ? interaction.request
      : {};
  return (
    <section aria-label="Plan review">
      <p>
        Plan {typeof request.planId === 'string' ? request.planId : 'unknown'} · version{' '}
        {typeof request.version === 'string' ? request.version : 'unknown'} · digest{' '}
        {typeof request.digest === 'string' ? request.digest : 'unknown'}
      </p>
      <PlanBody
        content={completeContent ?? (typeof request.content === 'string' ? request.content : '')}
        request={request}
      />
      <p>
        Approve only this exact plan for implementation. Tool permissions stay unchanged; approval
        does not prove execution or completion.
      </p>
      {plan.kind === 'readonly' ? (
        <p>Read only: {plan.reason}</p>
      ) : onAnswer ? (
        <PlanReviewForm
          key={questionDraftKey(interaction)}
          interaction={interaction}
          disabled={disabled}
          onAnswer={onAnswer}
          initialDraft={initialDraft}
          onDraftChange={onDraftChange}
        />
      ) : (
        <p>Read only</p>
      )}
    </section>
  );
}
function PlanBody({ content, request }: { content: string; request: Record<string, Json> }) {
  let plan: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(content);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.kind === 'plan_document' &&
      value.planId === request.planId &&
      String(value.version) === request.version &&
      value.digest === request.digest &&
      typeof value.title === 'string' &&
      typeof value.body === 'string' &&
      Array.isArray(value.steps) &&
      value.steps.every(
        (step: unknown) =>
          step &&
          typeof step === 'object' &&
          'id' in step &&
          typeof step.id === 'string' &&
          'title' in step &&
          typeof step.title === 'string',
      )
    )
      plan = value;
  } catch {
    /* Unknown formats retain their full original body. */
  }
  if (!plan) return <pre>{content || 'Plan body unavailable'}</pre>;
  return (
    <section aria-label="完整计划正文">
      <h4>{plan.title as string}</h4>
      <SafeMessageMarkdown content={plan.body as string} />
      <ol aria-label="计划步骤">
        {(plan.steps as { id: string; title: string }[]).map((step, index) => (
          <li key={`${index}:${step.id}`}>
            {step.title} · {step.id}
          </li>
        ))}
      </ol>
    </section>
  );
}
function PlanReviewForm({
  interaction,
  disabled,
  onAnswer,
  initialDraft,
  onDraftChange,
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  initialDraft?: PlanReviewDraft;
  onDraftChange?: (draft: PlanReviewDraft) => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<PlanReviewDraft>(() => ({
    feedback: initialDraft?.feedback ?? '',
  }));
  const current = useRef(draft);
  function change(next: PlanReviewDraft) {
    current.current = next;
    setDraft(next);
    onDraftChange?.(next);
  }
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  async function answer(decision: 'approve' | 'deny' | 'revise') {
    if (disabled || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onAnswer(
        interaction,
        serializePlanReviewAnswer(interaction.request, decision, current.current.feedback),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Plan review answer failed');
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <label htmlFor={`${formId}-feedback`}>
        Feedback
        <Textarea
          id={`${formId}-feedback`}
          className="field-sizing-fixed min-h-24 max-h-60 resize-y"
          aria-label="Plan review feedback"
          maxLength={8192}
          value={draft.feedback}
          disabled={disabled || submitting}
          onInput={(event) => change({ ...current.current, feedback: event.currentTarget.value })}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <Button
          type="button"
          disabled={disabled || submitting}
          onClick={() => void answer('approve')}
        >
          Approve this exact plan
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || submitting}
          onClick={() => void answer('deny')}
        >
          Deny plan
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || submitting}
          onClick={() => void answer('revise')}
        >
          Request revision
        </Button>
      </div>
    </form>
  );
}
