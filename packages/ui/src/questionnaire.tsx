import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { Interaction, Json } from '@kite-ai/client';
import { type FormEvent, useId, useRef, useState } from 'react';
import { AnswerChoices, useAnswerSubmission } from './answer-form';
import { Button } from './desktop/components/ui/button';
import { Textarea } from './desktop/components/ui/textarea';
import type { ActionInputDraft } from './index';
import {
  type QuestionFieldDraft,
  type QuestionForm,
  questionFieldValue,
  questionLengthError,
  questionValues,
  toggleQuestionChoice,
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
  const { busy, submitting, error, send } = useAnswerSubmission(disabled, onSubmit, (cause) =>
    cause instanceof Error ? cause.message : '回答提交失败',
  );
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
      skipped:
        !form.fields[index]!.required &&
        field.selected === undefined &&
        !field.selectedChoices?.length &&
        (form.fields[index]!.textWithChoices || !field.text.trim()),
    }));
  }
  const remaining = fieldsForAnswer(draft).filter(
    (value, index) => !value.skipped && !questionFieldValue(form.fields[index]!, value),
  ).length;
  const count = form.fields.length;
  const multiStep = count > 1;
  const lastStep = draft.step === count - 1;
  const showRemaining = multiStep && lastStep && remaining > 0 && !disabled && !submitting;
  const field = form.fields[draft.step]!;
  const input = draft.fields[draft.step]!;
  const title = field.title ?? form.title ?? '回答问题';
  const questionTitle = field.multiple
    ? title.replace(/\s*[（(]\s*可?多选\s*[）)]\s*[：:。.]?\s*$/u, '') || title
    : title;
  const textLabel = field.choices.length ? '自定义输入' : '自由回答';
  const customSelected = input.selected === field.choices.length;
  const lengthError = input.text ? questionLengthError(field, input.text) : undefined;
  const editor = field.text && (!field.choices.length || customSelected) && (
    <Textarea
      id={`${formId}-text`}
      aria-label={textLabel}
      aria-invalid={lengthError ? true : undefined}
      aria-describedby={lengthError ? `${formId}-length-error` : undefined}
      placeholder={field.choices.length ? textLabel : '输入你的回答…'}
      rows={field.choices.length ? 1 : 2}
      value={input.text}
      ref={(element) => {
        freeAnswer.current = element;
        if (!element || !focusFreeAnswer.current) return;
        focusFreeAnswer.current = false;
        element.focus();
      }}
      onInput={(event) =>
        edit({ ...current.current.fields[current.current.step]!, text: event.currentTarget.value })
      }
    />
  );
  const textError = editor && lengthError && (
    <span className="questionnaire-error" id={`${formId}-length-error`} role="status">
      {lengthError.kind === 'minimum' ? '至少' : '最多'} {lengthError.bound} 个字符；当前{' '}
      {lengthError.length} 个字符
    </span>
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || busy.current || current.current.step !== form.fields.length - 1) return;
    const answer = questionValues(form, fieldsForAnswer(current.current));
    if (answer) await send(answer.value as Json);
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
          {questionTitle}
        </h3>
        {multiStep && (
          <nav className="questionnaire-progress" aria-label="题目导航">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="上一题"
              disabled={submitting || draft.step === 0}
              onClick={() => goToStep(current.current.step - 1)}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} aria-hidden="true" />
            </Button>
            <span role="status">
              {draft.step + 1}/{count}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="查看下一题"
              disabled={submitting || lastStep}
              onClick={() => goToStep(current.current.step + 1)}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
            </Button>
          </nav>
        )}
      </header>
      <div className="questionnaire-content" key={draft.step}>
        <fieldset aria-labelledby={`${formId}-question`} disabled={disabled || submitting}>
          {field.title && form.title && form.title !== field.title && (
            <p className="questionnaire-description">{form.title}</p>
          )}
          {form.description && <p className="questionnaire-description">{form.description}</p>}
          {field.description && <p className="questionnaire-description">{field.description}</p>}
          <AnswerChoices
            name={`${formId}-${draft.step}`}
            choices={field.choices}
            selected={input.selected}
            multiple={field.multiple}
            selectedChoices={
              customSelected && !field.textWithChoices ? undefined : input.selectedChoices
            }
            onSelect={(selected) => {
              const answer = current.current.fields[current.current.step]!;
              edit(
                field.multiple
                  ? {
                      ...answer,
                      selected: field.textWithChoices ? answer.selected : undefined,
                      selectedChoices: toggleQuestionChoice(answer.selectedChoices, selected),
                    }
                  : { ...answer, selected },
              );
            }}
          >
            {field.text &&
              (field.choices.length ? (
                <div>
                  <div
                    className="questionnaire-choice questionnaire-custom-choice"
                    data-selected={customSelected}
                  >
                    <label className="questionnaire-custom-label">
                      <input
                        type={field.textWithChoices ? 'checkbox' : 'radio'}
                        name={`${formId}-${draft.step}`}
                        aria-label={textLabel}
                        checked={customSelected}
                        onClick={(event) => {
                          // Keep keyboard focus on the native choice control.
                          if (event.detail === 0 || !event.currentTarget.checked) return;
                          if (freeAnswer.current) freeAnswer.current.focus();
                          else focusFreeAnswer.current = true;
                        }}
                        onChange={(event) => {
                          const answer = current.current.fields[current.current.step]!;
                          edit({
                            ...answer,
                            selected: event.currentTarget.checked
                              ? field.choices.length
                              : undefined,
                            selectedChoices: field.textWithChoices
                              ? answer.selectedChoices
                              : undefined,
                          });
                        }}
                      />
                      {!customSelected && (
                        <span className="questionnaire-choice-title">{textLabel}</span>
                      )}
                    </label>
                    {editor}
                  </div>
                  {textError}
                </div>
              ) : (
                <div className="questionnaire-text-answer">
                  {editor}
                  {textError}
                </div>
              ))}
          </AnswerChoices>
        </fieldset>
      </div>
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
        {showRemaining && (
          <p className="questionnaire-incomplete" id={`${formId}-incomplete`} role="status">
            还有 {remaining} 题待答
          </p>
        )}
        <div className="questionnaire-navigation">
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
