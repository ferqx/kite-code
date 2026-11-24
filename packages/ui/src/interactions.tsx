import { type Interaction, type Json, readApprovalOptions } from '@kite-ai/client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type AttachmentReader,
  interactionAttachment,
  loadInteractionAttachment,
  requiresInteractionAttachment,
} from './attachments';
import { Button } from './desktop/ui';
import { ActionInputForm } from './index';
import { isMcpSourceReview, McpSourceReview } from './mcp-source-review';
import { type PlanReviewAttachment, type PlanReviewDraft, PlanReviewPanel } from './plan-review';
import { questionForm } from './question';
import { type QuestionAnswerDraft, Questionnaire, questionDraftKey } from './questionnaire';

export type InteractionAnswer = NonNullable<Interaction['answer']>;
type AnswerHandler = (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
export interface InteractionSubmission {
  readonly phase: 'saved' | 'submitting' | 'accepted' | 'unknown' | 'failed';
  readonly commandId: string;
  readonly error?: string;
}
type InteractionCardProps = {
  interaction: Interaction;
  submission?: InteractionSubmission;
  onAnswer?: AnswerHandler;
  onReadAttachment?: AttachmentReader;
  initialQuestionDraft?: QuestionAnswerDraft;
  onQuestionDraftChange?: (draft: QuestionAnswerDraft) => void;
  initialPlanDraft?: PlanReviewDraft;
  onPlanDraftChange?: (draft: PlanReviewDraft) => void;
  completeContent?: string;
  /** Compact tool approvals still verify the complete attachment before enabling answers. */
  compactApproval?: boolean;
  /** The native plan card omits the diagnostic identity disclosure. */
  inlinePlanReview?: boolean;
  planAnswerPaused?: boolean;
  planDocumentTarget?: HTMLElement | null;
  planDocument?: { content?: string; expanded?: boolean };
  onPlanDocumentChange?: (document: { content?: string; expanded?: boolean }) => void;
  renderApproval?: (props: {
    interaction: Interaction;
    disabled: boolean;
    onAnswer?: InteractionCardProps['onAnswer'];
    completeContent?: string;
    submission?: InteractionSubmission;
    attachment?: { phase: 'idle' | 'loading' | 'failed' | 'loaded'; retry?: () => void };
  }) => ReactNode;
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
  inlinePlanReview,
  planAnswerPaused,
  planDocumentTarget,
  planDocument,
  onPlanDocumentChange,
  planAttachment,
  renderApproval,
  attachment,
}: InteractionCardProps & {
  attachment?: { phase: 'idle' | 'loading' | 'failed' | 'loaded'; retry?: () => void };
  planAttachment?: PlanReviewAttachment;
}) {
  const disabled = !onAnswer || interaction.state !== 'pending' || submission !== undefined;
  const mcpSourceReview = isMcpSourceReview(interaction);
  if (interaction.kind === 'plan_review' && !mcpSourceReview)
    return (
      <PlanReviewPanel
        interaction={interaction}
        disabled={disabled || !!planAnswerPaused}
        onAnswer={onAnswer}
        initialDraft={initialPlanDraft}
        onDraftChange={onPlanDraftChange}
        completeContent={completeContent}
        attachment={planAttachment}
        documentTarget={planDocumentTarget}
        documentExpanded={planDocument?.expanded}
        onDocumentExpanded={(expanded) => onPlanDocumentChange?.({ expanded })}
        submission={submission}
        showPlanIdentity={!inlinePlanReview}
      >
        <InteractionMaterials interaction={interaction} />
      </PlanReviewPanel>
    );
  if (interaction.kind === 'approval' && !mcpSourceReview && renderApproval)
    return renderApproval({
      interaction,
      disabled,
      onAnswer,
      completeContent,
      submission,
      attachment,
    });
  const request = interaction.request;
  const structuredQuestion =
    interaction.kind === 'question' && !!onAnswer && !!questionForm(request);
  const approvalOptions = readApprovalOptions(request);
  return (
    <article
      className={structuredQuestion ? 'answer-interaction question-interaction' : undefined}
      data-answer-interaction={interaction.kind === 'question' && !mcpSourceReview ? '' : undefined}
      aria-label={structuredQuestion ? '补充问题' : `${interaction.kind} ${interaction.id}`}
    >
      {!structuredQuestion && (
        <h3>
          {interaction.kind} · {interaction.state}
        </h3>
      )}
      {!structuredQuestion && <InteractionMaterials interaction={interaction} />}
      {submission && structuredQuestion && (
        <p className="question-submission" data-phase={submission.phase} role="status">
          {
            {
              saved: '回答已保存，正在提交…',
              submitting: '正在提交回答…',
              accepted: '回答已提交，正在继续…',
              unknown: '回答提交结果尚未确认。',
              failed: '回答提交失败。',
            }[submission.phase]
          }
          {submission.error && ` ${submission.error}`}
        </p>
      )}
      {submission && !structuredQuestion && (
        <p role="status">
          {`Answer ${submission.phase} · command ${submission.commandId}${submission.error ? ` · ${submission.error}` : ''}. Acceptance does not prove execution.`}
        </p>
      )}
      {interaction.kind === 'approval' && !mcpSourceReview && (
        <div className="actions">
          {approvalOptions.map((option) => (
            <div key={option.optionId}>
              <Button
                type="button"
                disabled={disabled}
                onClick={() =>
                  onAnswer?.(interaction, {
                    kind: 'approval',
                    decision: 'approve',
                    optionId: option.optionId,
                  })
                }
              >
                {option.presentation.label}
              </Button>
              {option.presentation.details.map((detail, index) => (
                <p key={index}>{detail}</p>
              ))}
            </div>
          ))}
          <Button
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
          </Button>
        </div>
      )}
      {mcpSourceReview ? (
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
      {!onAnswer && <p>Read only</p>}
    </article>
  );
}

function InteractionMaterials({ interaction }: { interaction: Interaction }) {
  return (
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
  const form = questionForm(request, interaction.definitionId === 'ask_user');
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
  const [body, setBody] = useState<{ identity: string; text: string; reader: AttachmentReader }>();
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
  const verified =
    body?.identity === identity && body.reader === props.onReadAttachment && phase === 'loaded';
  async function load() {
    const reader = props.onReadAttachment;
    if (active.current || !reader || identity === 'invalid') return;
    const controller = new AbortController();
    active.current = controller;
    setPhase('loading');
    setError(undefined);
    try {
      const loaded = await loadInteractionAttachment(props.interaction, reader, controller.signal);
      if (!controller.signal.aborted && active.current === controller) {
        setBody({ identity: loaded.identity, text: loaded.text, reader });
        setPhase('loaded');
        if (props.interaction.kind === 'plan_review')
          props.onPlanDocumentChange?.({ content: loaded.text });
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
  function cancel() {
    active.current?.abort();
    active.current = undefined;
    setPhase('idle');
    setBody(undefined);
  }
  const read = props.onReadAttachment && identity !== 'invalid' ? () => void load() : undefined;
  const compact =
    props.compactApproval &&
    props.interaction.kind === 'approval' &&
    !isMcpSourceReview(props.interaction);
  const plan = props.interaction.kind === 'plan_review' && !isMcpSourceReview(props.interaction);
  // The existing loader validates identity, length, digest and UTF-8 before proof is published.
  // Only the compact approval presentation reads automatically; other forms keep their reader.
  useEffect(() => {
    if (compact && phase === 'idle') read?.();
  });
  const card = PlainInteractionCard({
    ...props,
    completeContent: verified
      ? body.text
      : !props.onAnswer && props.interaction.kind === 'plan_review'
        ? props.planDocument?.content
        : undefined,
    attachment: compact ? { phase, retry: read } : undefined,
    planAttachment: plan ? { phase, read, cancel } : undefined,
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
  });
  if (plan) return card;
  if (compact)
    return (
      <section
        className="compact-approval-attachment"
        data-complete-attachment={verified ? 'verified' : undefined}
      >
        {card}
      </section>
    );
  return (
    <section aria-label="Complete interaction attachment">
      {card}
      <p role="status">
        Attachment {phase}. Full verified content is required before an approval answer can be
        submitted.
      </p>
      {identity === 'invalid' && <p>Attachment identity unavailable</p>}
      {!props.onReadAttachment && <p>Complete attachment reader unavailable</p>}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <Button type="button" disabled={!read || phase === 'loading'} onClick={read}>
          Load complete attachment
        </Button>
        {phase === 'loading' && (
          <Button type="button" onClick={cancel}>
            Cancel attachment loading
          </Button>
        )}
      </div>
      {verified && <pre data-complete-attachment="verified">{body.text}</pre>}
    </section>
  );
}
