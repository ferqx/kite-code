import type { Interaction, Json } from '@kite-ai/client';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Button } from './desktop/components/ui/button';
import { Textarea } from './desktop/components/ui/textarea';
import type { ActionInputDraft } from './index';
import {
  type QuestionFieldDraft,
  type QuestionForm,
  questionFieldValue,
  questionLengthError,
  questionValues,
} from './question';

export type QuestionAnswerDraft =
  | { kind: 'questionnaire'; step: number; fields: QuestionFieldDraft[] }
  | { kind: 'input'; input: ActionInputDraft };

/** A reconnect does not create another question; a changed original request does. */
export function questionDraftKey(card: Interaction): string {
  return JSON.stringify([
    card.originStoreId,
    card.sessionId,
    card.presentationSessionId,
    card.id,
    card.revision,
    card.inputDigest,
  ]);
}

function ChoiceInformation({ title, description }: { title: string; description: string }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <span className="questionnaire-information">
      <Button
        className="questionnaire-info-button"
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label={`${title}的说明`}
        aria-describedby={hovered || focused ? id : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M12 11v6m0-10v.01"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </Button>
      {(hovered || focused) && (
        <span id={id} role="tooltip" className="questionnaire-tooltip">
          <strong>{title}</strong>
          <span>{description}</span>
        </span>
      )}
    </span>
  );
}

function ChoiceTitle({ title }: { title: string }) {
  const recommended = title.endsWith(' (Recommended)');
  return (
    <span className="questionnaire-choice-title">
      <span>{recommended ? title.slice(0, -14) : title}</span>
      {recommended && <span className="questionnaire-recommended">推荐</span>}
    </span>
  );
}

export function Questionnaire({
  form,
  initialDraft,
  onDraftChange,
  disabled,
  onSubmit,
}: {
  form: QuestionForm;
  initialDraft?: QuestionAnswerDraft;
  onDraftChange?: (draft: QuestionAnswerDraft) => void;
  disabled: boolean;
  onSubmit: (answers: Json) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Extract<QuestionAnswerDraft, { kind: 'questionnaire' }>>(() =>
    initialDraft?.kind === 'questionnaire'
      ? initialDraft
      : {
          kind: 'questionnaire' as const,
          step: 0,
          fields: form.fields.map(() => ({ text: '' })),
        },
  );
  const current = useRef(draft);
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const formId = useId();
  const focusQuestion = useRef(false);
  const focusFreeAnswer = useRef(false);
  const freeAnswer = useRef<HTMLTextAreaElement>(null);

  function change(next: typeof draft) {
    current.current = next;
    setDraft(next);
    onDraftChange?.(next);
  }
  function goToStep(step: number) {
    if (busy.current || step === current.current.step || step < 0 || step >= form.fields.length)
      return;
    focusQuestion.current = true;
    change({ ...current.current, step });
  }
  function edit(next: QuestionFieldDraft) {
    change({
      ...current.current,
      fields: current.current.fields.map((field, index) =>
        index === current.current.step ? next : field,
      ),
    });
  }
  function fieldsForAnswer(value: typeof draft) {
    return value.fields.map((field, index) => ({
      ...field,
      skipped: !form.fields[index]!.required && field.selected === undefined && !field.text.trim(),
    }));
  }
  const steps = fieldsForAnswer(draft).map((value, index) => {
    if (value.skipped) return '可选';
    return questionFieldValue(form.fields[index]!, value) ? '已回答' : '待回答';
  });
  const remaining = steps.filter((step) => step === '待回答').length;
  const multiStep = steps.length > 1;
  const lastStep = draft.step === steps.length - 1;
  const showRemaining = multiStep && lastStep && remaining > 0 && !disabled && !submitting;
  const field = form.fields[draft.step]!;
  const input = draft.fields[draft.step]!;
  const textLabel = field.choices.length ? '自定义输入' : '自由回答';
  const lengthError = input.text ? questionLengthError(field, input.text) : undefined;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || busy.current || current.current.step !== form.fields.length - 1) return;
    const answer = questionValues(form, fieldsForAnswer(current.current));
    if (answer) await send(answer.value as Json);
  }
  async function send(answer: Json) {
    if (disabled || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回答提交失败');
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  const cancel = form.alternative?.title === 'Cancel answering';
  return (
    <form className="questionnaire" aria-label="Questionnaire" onSubmit={submit}>
      <header className="questionnaire-header">
        <h3
          id={`${formId}-question`}
          tabIndex={-1}
          ref={(heading) => {
            if (!heading || !focusQuestion.current) return;
            focusQuestion.current = false;
            heading.focus();
          }}
        >
          {field.title ?? form.title ?? '回答问题'}
        </h3>
        {multiStep && (
          <nav className="questionnaire-progress" aria-label="题目导航">
            <p className="sr-only" role="status">
              问题 {draft.step + 1} / {steps.length}
            </p>
            {steps.map((status, index) => {
              const label = `第 ${index + 1} 题，${status}`;
              const active = draft.step === index;
              return (
                <Button
                  className="questionnaire-step"
                  key={index}
                  type="button"
                  size="icon-xs"
                  variant={active ? 'default' : 'outline'}
                  aria-label={label}
                  title={label}
                  aria-current={active ? 'step' : undefined}
                  data-answered={status === '已回答' || undefined}
                  disabled={submitting}
                  onClick={() => goToStep(index)}
                >
                  {index + 1}
                </Button>
              );
            })}
            {showRemaining && (
              <p className="questionnaire-incomplete" id={`${formId}-incomplete`} role="status">
                还有 {remaining} 题待答
              </p>
            )}
          </nav>
        )}
      </header>
      <fieldset
        key={draft.step}
        aria-labelledby={`${formId}-question`}
        disabled={disabled || submitting}
      >
        <div className="questionnaire-content">
          {field.title && form.title && form.title !== field.title && (
            <p className="questionnaire-description">{form.title}</p>
          )}
          {form.description && <p className="questionnaire-description">{form.description}</p>}
          {field.description && <p className="questionnaire-description">{field.description}</p>}
          <div className="questionnaire-choices">
            {field.choices.map((choice, index) => {
              const descriptionId = `${formId}-choice-${index}`;
              return (
                <label
                  className="questionnaire-choice"
                  data-selected={input.selected === index}
                  key={index}
                >
                  <input
                    type="radio"
                    name={`${formId}-${draft.step}`}
                    value={index}
                    aria-label={choice.title}
                    aria-describedby={choice.description ? descriptionId : undefined}
                    checked={input.selected === index}
                    onChange={() =>
                      edit({ ...current.current.fields[current.current.step]!, selected: index })
                    }
                  />
                  <span className="questionnaire-choice-copy">
                    <ChoiceTitle title={choice.title} />
                    {choice.description && (
                      <span className="questionnaire-choice-description" id={descriptionId}>
                        {choice.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            {field.text && (
              <div>
                {field.choices.length > 0 && (
                  <label
                    className="questionnaire-choice"
                    data-selected={input.selected === field.choices.length}
                  >
                    <input
                      type="radio"
                      name={`${formId}-${draft.step}`}
                      aria-label={textLabel}
                      checked={input.selected === field.choices.length}
                      onClick={(event) => {
                        // Arrow keys should keep focus in the native radio group.
                        if (event.detail === 0) return;
                        if (freeAnswer.current) freeAnswer.current.focus();
                        else focusFreeAnswer.current = true;
                      }}
                      onChange={() =>
                        edit({
                          ...current.current.fields[current.current.step]!,
                          selected: field.choices.length,
                        })
                      }
                    />
                    <span>{textLabel}</span>
                  </label>
                )}
                {(!field.choices.length || input.selected === field.choices.length) && (
                  <label className="questionnaire-text-answer" htmlFor={`${formId}-text`}>
                    {!field.choices.length && <span>{textLabel}</span>}
                    <Textarea
                      id={`${formId}-text`}
                      aria-label={textLabel}
                      aria-invalid={lengthError ? true : undefined}
                      aria-describedby={lengthError ? `${formId}-length-error` : undefined}
                      placeholder="输入你的回答…"
                      rows={2}
                      value={input.text}
                      ref={(element) => {
                        freeAnswer.current = element;
                        if (!element || !focusFreeAnswer.current) return;
                        focusFreeAnswer.current = false;
                        element.focus();
                      }}
                      onInput={(event) =>
                        edit({
                          ...current.current.fields[current.current.step]!,
                          text: event.currentTarget.value,
                        })
                      }
                    />
                    {lengthError && (
                      <span
                        className="questionnaire-error"
                        id={`${formId}-length-error`}
                        role="status"
                      >
                        {lengthError.kind === 'minimum' ? '至少' : '最多'} {lengthError.bound}{' '}
                        个字符；当前 {lengthError.length}
                      </span>
                    )}
                  </label>
                )}
              </div>
            )}
          </div>
        </div>
      </fieldset>
      <footer className="questionnaire-actions">
        {form.alternative && (
          <div className="questionnaire-alternative">
            <Button
              className="questionnaire-cancel"
              variant="ghost"
              size="sm"
              type="button"
              disabled={disabled || submitting}
              title={cancel ? '跳过这些问题，继续当前任务' : form.alternative.description}
              onClick={() => void send(form.alternative!.value as Json)}
            >
              {cancel ? '取消回答' : form.alternative.title}
            </Button>
            {!cancel && form.alternative.description && (
              <ChoiceInformation
                title={form.alternative.title}
                description={form.alternative.description}
              />
            )}
          </div>
        )}
        <div className="questionnaire-navigation">
          {draft.step > 0 && (
            <Button
              key="previous-question"
              variant="outline"
              size="sm"
              type="button"
              disabled={submitting}
              onClick={() => goToStep(current.current.step - 1)}
            >
              上一题
            </Button>
          )}
          {!lastStep ? (
            <Button
              key="next-question"
              size="sm"
              type="button"
              disabled={submitting}
              onClick={() => goToStep(current.current.step + 1)}
            >
              下一题
            </Button>
          ) : (
            <Button
              key="submit-questionnaire"
              size="sm"
              type="submit"
              aria-describedby={showRemaining ? `${formId}-incomplete` : undefined}
              disabled={disabled || submitting || remaining > 0}
            >
              {submitting && !disabled ? '正在提交…' : '提交回答'}
            </Button>
          )}
        </div>
      </footer>
      {error && (
        <p className="questionnaire-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
