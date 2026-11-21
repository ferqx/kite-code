import { ArrowDown01Icon, ArrowUp02Icon, File01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { Interaction, Json } from '@kite-ai/client';
import { memo, type ReactNode, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnswerChoices, useAnswerSubmission } from './answer-form';
import { Button } from './desktop/components/ui/button';
import { ScrollArea } from './desktop/components/ui/scroll-area';
import { Textarea } from './desktop/components/ui/textarea';
import { MessageContent } from './desktop/MessageContent';
import { parseDesktopMarkdown } from './desktop/markdown-parser';
import { PromptEditor } from './desktop/PromptEditor';
import { ReadGate } from './desktop/ReadGate';
import type { InteractionAnswer, InteractionSubmission } from './interactions';
import {
  describePlanReview,
  planReviewFeedbackLimit,
  serializePlanReviewAnswer,
} from './plan-review-answer';
import { questionDraftKey } from './questionnaire';

type PlanDecision = Extract<InteractionAnswer, { kind: 'plan_review' }>['decision'];
type PlanAnswerHandler = (
  interaction: Interaction,
  answer: InteractionAnswer,
) => void | Promise<void>;
export type PlanReviewDraft = { feedback: string; decision?: PlanDecision };

const planDecisions = [
  { decision: 'approve', title: '批准此版本' },
  { decision: 'revise', title: '要求修改' },
  { decision: 'deny', title: '拒绝计划' },
] as const;
export type PlanReviewAttachment = {
  phase: 'idle' | 'loading' | 'failed' | 'loaded';
  read?: () => void;
  cancel: () => void;
};
export function PlanReviewPanel({
  interaction,
  disabled,
  onAnswer,
  initialDraft,
  onDraftChange,
  completeContent,
  attachment,
  submission,
  documentTarget,
  documentExpanded,
  onDocumentExpanded,
  showPlanIdentity = true,
  children,
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: PlanAnswerHandler;
  initialDraft?: PlanReviewDraft;
  onDraftChange?: (draft: PlanReviewDraft) => void;
  completeContent?: string;
  attachment?: PlanReviewAttachment;
  submission?: InteractionSubmission;
  /** Native places the document in this message and renders the controls at the call site. */
  documentTarget?: HTMLElement | null;
  documentExpanded?: boolean;
  onDocumentExpanded?: (expanded: boolean) => void;
  showPlanIdentity?: boolean;
  children?: ReactNode;
}) {
  const plan = describePlanReview(interaction.request);
  const request =
    interaction.request &&
    typeof interaction.request === 'object' &&
    !Array.isArray(interaction.request)
      ? interaction.request
      : {};
  const answer = interaction.answer?.kind === 'plan_review' ? interaction.answer : undefined;
  const nativeDocument = !showPlanIdentity;
  const version = typeof request.version === 'string' ? request.version : undefined;
  const submissionStatus =
    submission &&
    {
      saved: '正在提交审阅答复…',
      submitting: '正在提交审阅答复…',
      accepted: '答复已提交，待确认',
      unknown: '答复结果待确认',
      failed: '答复提交失败',
    }[submission.phase];
  const status =
    answer && interaction.acceptedDecisionRevision === interaction.revision
      ? {
          approve: '已批准',
          deny: nativeDocument ? '已跳过' : '已拒绝',
          revise: answer.asUserMessage ? '已回复' : '已要求修改',
        }[answer.decision]
      : interaction.state === 'cancelled'
        ? '已取消'
        : answer
          ? '答复已保存，待确认'
          : (submissionStatus ?? '等待审阅');
  const needsAttachment = attachment && completeContent === undefined;
  const pending = interaction.state === 'pending';
  const documentStatus = pending ? undefined : status;
  const document = (
    <>
      {needsAttachment ? (
        <>
          {nativeDocument && <PlanDocumentHeading version={version} status={documentStatus} />}
          <div className="plan-review-attachment" aria-busy={attachment.phase === 'loading'}>
            {attachment.read ? (
              <>
                <Button
                  size={nativeDocument ? 'xs' : 'sm'}
                  variant={nativeDocument ? 'secondary' : 'outline'}
                  disabled={attachment.phase === 'loading'}
                  data-plan-document-load=""
                  onClick={attachment.read}
                >
                  读取完整计划
                </Button>
                {attachment.phase === 'loading' && (
                  <Button
                    size={nativeDocument ? 'xs' : 'sm'}
                    variant="ghost"
                    onClick={attachment.cancel}
                  >
                    取消读取
                  </Button>
                )}
              </>
            ) : (
              <p role="status">暂时无法读取完整计划。</p>
            )}
            {attachment.phase === 'failed' && <p role="alert">完整计划未能核实，请重新读取。</p>}
          </div>
        </>
      ) : (
        <PlanBody
          content={completeContent ?? (typeof request.content === 'string' ? request.content : '')}
          request={request}
          inline={nativeDocument}
          version={version}
          status={nativeDocument ? documentStatus : undefined}
          initialExpanded={documentExpanded}
          onExpanded={onDocumentExpanded}
        />
      )}
      {answer?.feedback && !answer.asUserMessage && (
        <section className="plan-review-feedback" aria-label="审阅意见">
          <h4>审阅意见</h4>
          <p>{answer.feedback}</p>
        </section>
      )}
      {attachment && completeContent !== undefined && (
        <details className="plan-review-original">
          <summary>完整原附件</summary>
          <pre data-complete-attachment="verified">{completeContent}</pre>
        </details>
      )}
      {showPlanIdentity && (
        <details className="plan-review-original">
          <summary>原请求与身份</summary>
          {children ?? <pre>{JSON.stringify(request, null, 2)}</pre>}
        </details>
      )}
    </>
  );
  if (documentTarget !== undefined && pending) {
    if (!documentTarget) return null;
    return (
      <>
        {createPortal(
          <section className="plan-review plan-review-document-card" aria-label="计划内容">
            {document}
          </section>,
          documentTarget,
        )}
        <NativePlanReviewForm
          key={questionDraftKey(interaction)}
          interaction={interaction}
          disabled={disabled || !!needsAttachment}
          readonlyReason={plan.kind === 'readonly' ? plan.reason : undefined}
          submissionStatus={submissionStatus}
          onViewDocument={
            needsAttachment
              ? () => {
                  documentTarget.focus({ preventScroll: true });
                  documentTarget.scrollIntoView({ block: 'nearest' });
                }
              : undefined
          }
          onAnswer={onAnswer}
          initialDraft={initialDraft}
          onDraftChange={onDraftChange}
        />
      </>
    );
  }
  return (
    <section
      className={[
        'plan-review',
        nativeDocument && 'plan-review-document-card',
        pending && 'answer-interaction',
      ]
        .filter(Boolean)
        .join(' ')}
      data-answer-interaction={pending ? '' : undefined}
      aria-label="计划审阅"
    >
      {!nativeDocument && (
        <header className="plan-review-header">
          <h3>计划审阅</h3>
          {version && <span>版本 {version}</span>}
          <span className="plan-review-status" role="status">
            {status}
          </span>
        </header>
      )}
      {document}
      {plan.kind === 'readonly' ? (
        <p role="status">{plan.reason}</p>
      ) : onAnswer && pending && !needsAttachment ? (
        <PlanReviewForm
          key={questionDraftKey(interaction)}
          interaction={interaction}
          disabled={disabled}
          onAnswer={onAnswer}
          initialDraft={initialDraft}
          onDraftChange={onDraftChange}
        />
      ) : null}
    </section>
  );
}

function PlanDocumentHeading({
  title = '计划',
  version,
  status,
  action,
}: {
  title?: string;
  version?: string;
  status?: string;
  action?: ReactNode;
}) {
  return (
    <header className="plan-review-document-heading">
      <HugeiconsIcon icon={File01Icon} aria-hidden="true" />
      <h4 className="plan-review-title">{title}</h4>
      {(version || status || action) && (
        <div className="plan-review-document-tools">
          {(version || status) && (
            <div className="plan-review-document-meta">
              {version && <span>第 {version} 版</span>}
              {status && <span role="status">{status}</span>}
            </div>
          )}
          {action}
        </div>
      )}
    </header>
  );
}

const PlanBody = memo(function PlanBody({
  content,
  request,
  inline,
  version,
  status,
  initialExpanded,
  onExpanded,
}: {
  content: string;
  request: Record<string, Json>;
  inline: boolean;
  version?: string;
  status?: string;
  initialExpanded?: boolean;
  onExpanded?: (expanded: boolean) => void;
}) {
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
  if (inline) {
    return (
      <ExpandablePlanBody
        title={plan?.title as string | undefined}
        version={version}
        status={status}
        markdown={plan?.body as string | undefined}
        initialExpanded={initialExpanded}
        onExpanded={onExpanded}
      >
        {plan ? (
          <PlanMarkdown
            body={plan.body as string}
            steps={plan.steps as { id: string; title: string }[]}
          />
        ) : content ? (
          <pre className="plan-review-source">{content}</pre>
        ) : null}
      </ExpandablePlanBody>
    );
  }
  if (!plan)
    return content ? (
      <ScrollArea
        viewportClassName="plan-review-reading"
        viewportProps={{ role: 'region', 'aria-label': '计划原文', tabIndex: 0 }}
      >
        <pre className="plan-review-source">{content}</pre>
      </ScrollArea>
    ) : (
      <p>计划正文不可用。</p>
    );
  return (
    <div className="plan-review-document">
      <h4 className="plan-review-title">{plan.title as string}</h4>
      <ScrollArea
        viewportClassName="plan-review-reading"
        viewportProps={{ role: 'region', 'aria-label': '完整计划正文', tabIndex: 0 }}
      >
        <PlanMarkdown
          body={plan.body as string}
          steps={plan.steps as { id: string; title: string }[]}
        />
      </ScrollArea>
    </div>
  );
});
function PlanMarkdown({ body, steps }: { body: string; steps: { id: string; title: string }[] }) {
  return (
    <>
      <MessageContent text={body} />
      <section className="plan-review-steps">
        <h5>计划步骤</h5>
        <div className="typeset typeset-chat">
          <ol aria-label="计划步骤">
            {steps.map((step, index) => (
              <li key={`${index}:${step.id}`}>{step.title}</li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}

function planExcerpt(markdown: string | undefined) {
  if (!markdown) return;
  const sample = markdown.slice(0, 4096);
  const tree = parseDesktopMarkdown(sample);
  if (!('children' in tree) || !Array.isArray(tree.children)) return;
  const paragraph = tree.children.find((node) => node.type === 'paragraph');
  const range = paragraph?.position;
  return range ? sample.slice(range.start.offset, range.end.offset) : undefined;
}

function ExpandablePlanBody({
  title,
  version,
  status,
  markdown,
  initialExpanded = false,
  onExpanded,
  children,
}: {
  title?: string;
  version?: string;
  status?: string;
  markdown?: string;
  initialExpanded?: boolean;
  onExpanded?: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const bodyId = useId();
  const excerpt = !expanded && planExcerpt(markdown);
  return (
    <div className="plan-review-document">
      <PlanDocumentHeading
        title={title}
        version={version}
        status={status}
        action={
          children && (
            <Button
              className="plan-review-document-toggle"
              variant="ghost"
              size="xs"
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              onClick={() => {
                const next = !expanded;
                setExpanded(next);
                onExpanded?.(next);
              }}
            >
              {expanded ? '收起完整计划' : '展开完整计划'}
              <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden="true" />
            </Button>
          )
        }
      />
      {excerpt && (
        <div className="plan-review-excerpt">
          <MessageContent text={excerpt} />
        </div>
      )}
      {expanded && children && (
        <section id={bodyId} className="plan-review-expanded" aria-label="完整计划正文">
          {children}
        </section>
      )}
      {!children && <p>计划正文不可用。</p>}
    </div>
  );
}

function NativePlanReviewForm({
  interaction,
  disabled,
  readonlyReason,
  submissionStatus,
  onViewDocument,
  onAnswer,
  initialDraft,
  onDraftChange,
}: {
  interaction: Interaction;
  disabled: boolean;
  readonlyReason?: string;
  submissionStatus?: string;
  onViewDocument?: () => void;
  onAnswer?: PlanAnswerHandler;
  initialDraft?: PlanReviewDraft;
  onDraftChange?: (draft: PlanReviewDraft) => void;
}) {
  const unavailable = disabled || !onAnswer || !!readonlyReason;
  const [feedback, setFeedback] = useState(initialDraft?.feedback ?? '');
  const { submitting, error, send } = useAnswerSubmission(
    unavailable,
    ({ decision, feedback }: { decision: PlanDecision; feedback?: string }) =>
      onAnswer?.(
        interaction,
        serializePlanReviewAnswer(interaction.request, decision, feedback, decision !== 'deny'),
      ),
    () => '审阅答复提交失败，请重试。',
  );
  const blocked = unavailable || submitting;
  const canReply = !blocked && !!feedback.trim() && feedback.length <= planReviewFeedbackLimit;
  function reply() {
    if (canReply) void send({ decision: 'revise', feedback });
  }
  return (
    <section className="plan-review-composer" aria-label="计划审阅" data-answer-interaction="">
      {readonlyReason ? (
        <p className="plan-review-composer-note" role="status">
          {readonlyReason}
        </p>
      ) : (
        <form
          aria-busy={submitting || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            reply();
          }}
        >
          <header className="plan-review-composer-heading">
            <h3>计划审阅</h3>
            <fieldset className="plan-review-composer-decisions">
              <legend className="sr-only">审阅决定</legend>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={blocked}
                onClick={() => void send({ decision: 'deny' })}
              >
                跳过
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={blocked}
                onClick={() => void send({ decision: 'approve', feedback: '开始实施此计划' })}
              >
                实施此计划
              </Button>
            </fieldset>
          </header>
          {onViewDocument && (
            <Button
              size="xs"
              variant="link"
              className="plan-review-locate"
              onClick={onViewDocument}
            >
              请先查看完整计划
            </Button>
          )}
          {submissionStatus && (
            <p className="plan-review-composer-note" role="status">
              {submissionStatus}
            </p>
          )}
          <div className="plan-review-composer-reply">
            <ReadGate blocked={blocked}>
              <PromptEditor
                scopeKey={questionDraftKey(interaction)}
                label="审阅意见"
                placeholder="输入修改建议或其他回复"
                disabled={false}
                maxLength={planReviewFeedbackLimit}
                value={feedback}
                onChange={(text) => {
                  setFeedback(text);
                  onDraftChange?.({ feedback: text });
                }}
                onSend={reply}
              />
            </ReadGate>
            <Button
              type="submit"
              size="icon"
              className="primary composer-action"
              aria-label="发送审阅意见"
              title="发送审阅意见"
              disabled={!canReply}
            >
              <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} aria-hidden="true" />
            </Button>
          </div>
          {error && !disabled && (
            <p className="questionnaire-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
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
  onAnswer: PlanAnswerHandler;
  initialDraft?: PlanReviewDraft;
  onDraftChange?: (draft: PlanReviewDraft) => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<PlanReviewDraft>(() => initialDraft ?? { feedback: '' });
  const current = useRef(draft);
  const { submitting, error, send } = useAnswerSubmission(
    disabled,
    ({ decision, feedback }: { decision: PlanDecision; feedback: string }) =>
      onAnswer(interaction, serializePlanReviewAnswer(interaction.request, decision, feedback)),
    () => '审阅答复提交失败，请重试。',
  );
  function change(next: PlanReviewDraft) {
    current.current = next;
    setDraft(next);
    onDraftChange?.(next);
  }
  return (
    <form
      className="questionnaire plan-review-form"
      aria-label="审阅决定"
      onSubmit={(event) => {
        event.preventDefault();
        const { decision, feedback } = current.current;
        if (decision) void send({ decision, feedback });
      }}
    >
      <fieldset disabled={disabled || submitting}>
        <div className="questionnaire-content">
          <AnswerChoices
            name={`${formId}-decision`}
            choices={planDecisions}
            selected={planDecisions.findIndex(({ decision }) => decision === draft.decision)}
            onSelect={(index) =>
              change({ ...current.current, decision: planDecisions[index]!.decision })
            }
          />
          <label className="questionnaire-text-answer" htmlFor={`${formId}-feedback`}>
            <span>审阅意见（选填）</span>
            <Textarea
              id={`${formId}-feedback`}
              rows={2}
              maxLength={planReviewFeedbackLimit}
              value={draft.feedback}
              disabled={disabled || submitting}
              onInput={(event) =>
                change({ ...current.current, feedback: event.currentTarget.value })
              }
            />
          </label>
        </div>
      </fieldset>
      <footer className="questionnaire-actions">
        <div className="questionnaire-navigation">
          <Button type="submit" size="sm" disabled={disabled || submitting || !draft.decision}>
            {submitting && !disabled ? '正在提交…' : '提交审阅'}
          </Button>
        </div>
      </footer>
      {error && !disabled && (
        <p className="questionnaire-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
