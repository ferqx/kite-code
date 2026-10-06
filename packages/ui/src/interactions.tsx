import type { Interaction, Json } from '@kite-ai/client';
import { useEffect, useRef, useState } from 'react';
import {
  type AttachmentReader,
  interactionAttachment,
  loadInteractionAttachment,
  requiresInteractionAttachment,
} from './attachments';
import { ActionInputForm } from './index';
import { isMcpSourceReview, McpSourceReview } from './mcp-source-review';
import { type PlanReviewDraft, PlanReviewPanel } from './plan-review';
import { questionForm } from './question';
import { type QuestionAnswerDraft, Questionnaire, questionDraftKey } from './questionnaire';

export type InteractionAnswer = NonNullable<Interaction['answer']>;
export interface InteractionSubmission {
  readonly phase: 'saved' | 'submitting' | 'accepted' | 'unknown' | 'failed';
  readonly commandId: string;
  readonly error?: string;
}
type InteractionCardProps = {
  interaction: Interaction;
  submission?: InteractionSubmission;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  onReadAttachment?: AttachmentReader;
  initialQuestionDraft?: QuestionAnswerDraft;
  onQuestionDraftChange?: (draft: QuestionAnswerDraft) => void;
  initialPlanDraft?: PlanReviewDraft;
  onPlanDraftChange?: (draft: PlanReviewDraft) => void;
  completeContent?: string;
};

/** Only public persisted facts cross this component boundary. */
function PlainInteractionCard({
  interaction,
  submission,
  onAnswer,
  initialQuestionDraft,
  onQuestionDraftChange,
  initialPlanDraft,
  onPlanDraftChange,
  completeContent,
}: InteractionCardProps) {
  const disabled = !onAnswer || interaction.state !== 'pending' || submission !== undefined;
  const request = interaction.request;
  const sameCommand =
    request !== null &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    Array.isArray(request.grants) &&
    request.grants.includes('same_command');
  const materials = (
    <>
      <p>
        Source Session: {interaction.sessionId} · Presentation Session:{' '}
        {interaction.presentationSessionId}
      </p>
      <p>Ancestry: {interaction.ancestry.join(' → ')}</p>
      <p>
        {interaction.definitionId} · {interaction.definitionVersion} · attempt {interaction.attempt}
      </p>
      <p>
        Interaction {interaction.id} · revision {interaction.revision}
      </p>
      <p>
        Run: {interaction.runId ?? 'none'} · Execution: {interaction.executionId}
      </p>
      <p>
        Input digest: {interaction.inputDigest} · Policy revision: {interaction.policyRevision}
      </p>
      <pre>{JSON.stringify(interaction.requiredRefs, null, 2)}</pre>
      <pre>{JSON.stringify(interaction.request, null, 2)}</pre>
      {interaction.acceptedDecisionRevision !== null && (
        <p>Decision accepted revision: {interaction.acceptedDecisionRevision}</p>
      )}
      {interaction.answer && <pre>{JSON.stringify(interaction.answer, null, 2)}</pre>}
    </>
  );
  return (
    <article aria-label={`${interaction.kind} ${interaction.id}`}>
      <h3>
        {interaction.kind} · {interaction.state}
      </h3>
      {(interaction.kind === 'question' && onAnswer && questionForm(request)) ||
      interaction.kind === 'plan_review' ? (
        <details>
          <summary>原请求与身份</summary>
          {materials}
        </details>
      ) : (
        materials
      )}
      {submission && (
        <p role="status">
          Answer {submission.phase} · command {submission.commandId}
          {submission.error ? ` · ${submission.error}` : ''}. Acceptance does not prove execution.
        </p>
      )}
      {interaction.kind === 'approval' && !isMcpSourceReview(interaction) && (
        <div>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onAnswer?.(interaction, {
                kind: 'approval',
                decision: 'approve',
                grant: 'approve_once',
              })
            }
            onKeyDown={(event) => {
              if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                void onAnswer?.(interaction, {
                  kind: 'approval',
                  decision: 'approve',
                  grant: 'approve_once',
                });
              }
            }}
          >
            Approve once
          </button>
          {sameCommand && (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAnswer?.(interaction, {
                  kind: 'approval',
                  decision: 'approve',
                  grant: 'same_command',
                })
              }
              onKeyDown={(event) => {
                if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  void onAnswer?.(interaction, {
                    kind: 'approval',
                    decision: 'approve',
                    grant: 'same_command',
                  });
                }
              }}
            >
              本 Session 相同命令
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer?.(interaction, { kind: 'approval', decision: 'deny' })}
            onKeyDown={(event) => {
              if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                void onAnswer?.(interaction, { kind: 'approval', decision: 'deny' });
              }
            }}
          >
            Deny
          </button>
        </div>
      )}
      {isMcpSourceReview(interaction) ? (
        <McpSourceReview
          key={`${interaction.id}/${interaction.revision}`}
          interaction={interaction}
          disabled={disabled}
          onAnswer={onAnswer}
        />
      ) : (
        interaction.kind === 'question' &&
        onAnswer && (
          <QuestionAnswerForm
            key={questionDraftKey(interaction)}
            interaction={interaction}
            disabled={disabled}
            onAnswer={onAnswer}
            initialDraft={initialQuestionDraft}
            onDraftChange={onQuestionDraftChange}
          />
        )
      )}
      {interaction.kind === 'plan_review' && !isMcpSourceReview(interaction) && (
        <PlanReviewPanel
          interaction={interaction}
          disabled={disabled}
          onAnswer={onAnswer}
          initialDraft={initialPlanDraft}
          onDraftChange={onPlanDraftChange}
          completeContent={completeContent}
        />
      )}
      {!onAnswer && <p>Read only</p>}
    </article>
  );
}
function QuestionAnswerForm({
  interaction,
  disabled,
  onAnswer,
  initialDraft,
  onDraftChange,
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  initialDraft?: QuestionAnswerDraft;
  onDraftChange?: (draft: QuestionAnswerDraft) => void;
}) {
  const request = interaction.request;
  const schema =
    request && typeof request === 'object' && !Array.isArray(request) ? request.schema : undefined;
  // Lock synchronously: repeated Enter events in the same React render cannot send twice.
  const busy = useRef(false);
  const form = questionForm(request);
  async function submit(answers: unknown) {
    if (busy.current) return;
    busy.current = true;
    try {
      await onAnswer(interaction, { kind: 'question', answers: answers as Json });
    } finally {
      busy.current = false;
    }
  }
  if (form)
    return (
      <Questionnaire
        form={form}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        disabled={disabled}
        onSubmit={submit}
      />
    );
  return (
    <ActionInputForm
      schema={schema}
      disabled={disabled}
      submitLabel="Submit answer"
      initialDraft={initialDraft?.kind === 'input' ? initialDraft.input : undefined}
      onDraftChange={(input) => onDraftChange?.({ kind: 'input', input })}
      onSubmit={submit}
    />
  );
}

export function InteractionCard(props: InteractionCardProps) {
  if (requiresInteractionAttachment(props.interaction))
    return <AttachmentInteractionCard {...props} />;
  return PlainInteractionCard(props);
}
function AttachmentInteractionCard(props: Parameters<typeof InteractionCard>[0]) {
  const [body, setBody] = useState<{ identity: string; text: string } | undefined>();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'failed' | 'loaded'>('idle');
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  const answered = useRef(false);
  let identity: string;
  try {
    identity = interactionAttachment(props.interaction)!.key;
  } catch {
    identity = 'invalid';
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity/reader changes revoke the view proof and abort its read
  useEffect(() => {
    setBody(undefined);
    setPhase('idle');
    setError(undefined);
    answered.current = false;
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, [identity, props.onReadAttachment]);
  const verified = body?.identity === identity && phase === 'loaded';
  async function load() {
    if (active.current || !props.onReadAttachment || identity === 'invalid') return;
    const controller = new AbortController();
    active.current = controller;
    setPhase('loading');
    setError(undefined);
    try {
      const loaded = await loadInteractionAttachment(
        props.interaction,
        props.onReadAttachment,
        controller.signal,
      );
      if (!controller.signal.aborted && active.current === controller) {
        setBody({ identity: loaded.identity, text: loaded.text });
        setPhase('loaded');
      }
    } catch {
      if (!controller.signal.aborted && active.current === controller) {
        setPhase('failed');
        setError('Complete attachment could not be verified.');
      }
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  }
  return (
    <section aria-label="Complete interaction attachment">
      {PlainInteractionCard({
        ...props,
        completeContent: verified ? body.text : undefined,
        onAnswer:
          verified && props.onAnswer
            ? async (interaction, answer) => {
                if (answered.current) return;
                answered.current = true;
                try {
                  await props.onAnswer!(interaction, answer);
                } catch (error) {
                  answered.current = false;
                  throw error;
                }
              }
            : undefined,
      })}
      <p role="status">
        Attachment {phase}. Full verified content is required before an approval answer can be
        submitted.
      </p>
      {identity === 'invalid' && <p>Attachment identity unavailable</p>}
      {!props.onReadAttachment && <p>Complete attachment reader unavailable</p>}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={!props.onReadAttachment || phase === 'loading' || identity === 'invalid'}
        onClick={() => void load()}
      >
        Load complete attachment
      </button>
      {phase === 'loading' && (
        <button
          type="button"
          onClick={() => {
            active.current?.abort();
            active.current = undefined;
            setPhase('idle');
            setBody(undefined);
          }}
        >
          Cancel attachment loading
        </button>
      )}
      {verified &&
        (props.interaction.kind === 'plan_review' ? (
          <details>
            <summary>完整原附件</summary>
            <pre data-complete-attachment="verified">{body.text}</pre>
          </details>
        ) : (
          <pre data-complete-attachment="verified">{body.text}</pre>
        ))}
    </section>
  );
}
