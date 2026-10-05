import type { Interaction, Json } from '@kite-ai/client';
import { useRef, useState } from 'react';
import type { InteractionAnswer } from './interactions';

export type PlanMode = 'auto' | 'accept_edits';
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
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
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
      <pre>{typeof request.content === 'string' ? request.content : 'Plan body unavailable'}</pre>
      <p>
        This answer records review information. It does not grant tool permissions or prove plan
        execution/completion.
      </p>
      {plan.kind === 'readonly' ? (
        <p>Read only: {plan.reason}</p>
      ) : onAnswer ? (
        <PlanReviewForm
          interaction={interaction}
          plan={plan}
          disabled={disabled}
          onAnswer={onAnswer}
        />
      ) : (
        <p>Read only</p>
      )}
    </section>
  );
}
function PlanReviewForm({
  interaction,
  plan,
  disabled,
  onAnswer,
}: {
  interaction: Interaction;
  plan: Extract<PlanDescription, { kind: 'supported' }>;
  disabled: boolean;
  onAnswer: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
}) {
  const [mode, setMode] = useState('');
  const [feedback, setFeedback] = useState('');
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
        serializePlanReviewAnswer(interaction.request, decision, feedback, mode),
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
      <label>
        Explicit mode
        <select
          aria-label="Plan review mode"
          value={mode}
          disabled={disabled || submitting}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="">Select a mode explicitly</option>
          {plan.allowedModes.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Feedback
        <textarea
          aria-label="Plan review feedback"
          maxLength={8192}
          value={feedback}
          disabled={disabled || submitting}
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={disabled || submitting || !mode}>
        Approve this exact plan
      </button>
      <button type="button" disabled={disabled || submitting} onClick={() => void answer('deny')}>
        Deny plan
      </button>
      <button type="button" disabled={disabled || submitting} onClick={() => void answer('revise')}>
        Request revision
      </button>
    </form>
  );
}
