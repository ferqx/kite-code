import type { Interaction, Json } from '@kite-ai/client';
import { useId, useRef, useState } from 'react';
import { Button } from './desktop/components/ui/button';
import { SelectField } from './desktop/components/ui/select-field';
import { Textarea } from './desktop/components/ui/textarea';
import type { InteractionAnswer } from './interactions';
import { SafeMessageMarkdown } from './markdown';
import { questionDraftKey } from './questionnaire';

export type PlanMode = 'auto' | 'accept_edits';
export type PlanReviewDraft = { mode: string; feedback: string };
export type PlanDescription =
  | {
      kind: 'supported';
      planId: string;
      version: string;
      digest: string;
      content: string;
      allowedModes: readonly PlanMode[];
    }
  | { kind: 'readonly'; reason: string };
/** Public plan metadata describes information only, never an authorization grant. */
export function describePlanReview(request: Json): PlanDescription {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return { kind: 'readonly', reason: 'Plan request format unknown' };
  const { planId, version, digest, content, allowedModes } = request;
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
  if (
    !Array.isArray(allowedModes) ||
    !allowedModes.length ||
    allowedModes.some((mode) => mode !== 'auto' && mode !== 'accept_edits') ||
    new Set(allowedModes).size !== allowedModes.length
  )
    return { kind: 'readonly', reason: 'Supported explicit plan modes unavailable' };
  return {
    kind: 'supported',
    planId,
    version,
    digest,
    content,
    allowedModes: allowedModes as PlanMode[],
  };
}
export function serializePlanReviewAnswer(
  request: Json,
  decision: 'approve' | 'deny' | 'revise',
  feedback = '',
  mode?: string,
): Extract<InteractionAnswer, { kind: 'plan_review' }> {
  const plan = describePlanReview(request);
  if (plan.kind !== 'supported') throw new Error('plan_review_readonly');
  if (feedback.length > 8192) throw new Error('feedback_too_long');
  if (decision === 'approve' && (!mode || !plan.allowedModes.includes(mode as PlanMode)))
    throw new Error('explicit_plan_mode_required');
  return {
    kind: 'plan_review',
    decision,
    ...(feedback ? { feedback } : {}),
    ...(decision === 'approve' ? { mode } : {}),
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
        This answer records review information. It does not grant tool permissions or prove plan
        execution/completion.
      </p>
      {plan.kind === 'readonly' ? (
        <p>Read only: {plan.reason}</p>
      ) : onAnswer ? (
        <PlanReviewForm
          key={questionDraftKey(interaction)}
          interaction={interaction}
          plan={plan}
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
  plan,
  disabled,
  onAnswer,
  initialDraft,
  onDraftChange,
}: {
  interaction: Interaction;
  plan: Extract<PlanDescription, { kind: 'supported' }>;
  disabled: boolean;
  onAnswer: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  initialDraft?: PlanReviewDraft;
  onDraftChange?: (draft: PlanReviewDraft) => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<PlanReviewDraft>(() => ({
    mode: plan.allowedModes.includes(initialDraft?.mode as PlanMode) ? initialDraft!.mode : '',
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
        serializePlanReviewAnswer(
          interaction.request,
          decision,
          current.current.feedback,
          current.current.mode,
        ),
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
        void answer('approve');
      }}
    >
      <label htmlFor={`${formId}-mode`}>
        Explicit mode
        <SelectField
          id={`${formId}-mode`}
          aria-label="Plan review mode"
          value={draft.mode}
          disabled={disabled || submitting}
          onValueChange={(value) => change({ ...current.current, mode: value })}
          options={[
            { value: '', label: 'Select a mode explicitly' },
            ...plan.allowedModes.map((value) => ({ value, label: value })),
          ]}
        />
      </label>
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
        <Button type="submit" disabled={disabled || submitting || !draft.mode}>
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
