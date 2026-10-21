import type { Interaction, Json } from '@kite-ai/client';
import { type FormEvent, useId, useRef, useState } from 'react';
import type { ActionInputDraft } from './index';
import {
  type QuestionFieldDraft,
  type QuestionForm,
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
      <button
        className="questionnaire-info-button"
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
      </button>
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
  function change(next: typeof draft) {
    current.current = next;
    setDraft(next);
    onDraftChange?.(next);
  }
  function edit(next: QuestionFieldDraft) {
    change({
      ...current.current,
      fields: current.current.fields.map((field, index) =>
        index === current.current.step ? next : field,
      ),
    });
  }
  function answers(value: typeof draft) {
    return questionValues(
      form,
      value.fields.map((field, index) => ({
        ...field,
        skipped:
          !form.fields[index]!.required && field.selected === undefined && !field.text.trim(),
      })),
    );
  }
  const field = form.fields[draft.step]!;
  const input = draft.fields[draft.step]!;
  const lengthError = questionLengthError(field, input.text);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const answer = answers(current.current);
    if (disabled || busy.current || current.current.step !== form.fields.length - 1 || !answer)
      return;
    await send(answer.value as Json);
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
        <h3>{form.title ?? '需要你的回答'}</h3>
        <p role="status">
          问题 {draft.step + 1} / {form.fields.length}
        </p>
      </header>
      {form.description && <p className="questionnaire-description">{form.description}</p>}
      <fieldset key={draft.step} disabled={disabled || submitting}>
        <legend>{field.title ?? '回答问题'}</legend>
        {field.description && <p className="questionnaire-description">{field.description}</p>}
        <div className="questionnaire-choices">
          {field.choices.map((choice, index) => (
            <div
              className="questionnaire-choice"
              data-selected={input.selected === index}
              key={index}
            >
              <label>
                <input
                  type="radio"
                  name={`${formId}-${draft.step}`}
                  value={index}
                  aria-label={choice.title}
                  checked={input.selected === index}
                  onChange={() =>
                    edit({ ...current.current.fields[current.current.step]!, selected: index })
                  }
                />
                <ChoiceTitle title={choice.title} />
              </label>
              {choice.description && (
                <ChoiceInformation title={choice.title} description={choice.description} />
              )}
            </div>
          ))}
          {field.text && (
            <div className="questionnaire-free-answer">
              {field.choices.length > 0 && (
                <div
                  className="questionnaire-choice"
                  data-selected={input.selected === field.choices.length}
                >
                  <label>
                    <input
                      type="radio"
                      name={`${formId}-${draft.step}`}
                      aria-label="自由回答"
                      checked={input.selected === field.choices.length}
                      onChange={() =>
                        edit({
                          ...current.current.fields[current.current.step]!,
                          selected: field.choices.length,
                        })
                      }
                    />
                    <span>自由回答</span>
                  </label>
                </div>
              )}
              {(!field.choices.length || input.selected === field.choices.length) && (
                <label className="questionnaire-text-answer">
                  {!field.choices.length && <span>自由回答</span>}
                  <textarea
                    aria-label="自由回答"
                    placeholder="输入你的回答…"
                    rows={3}
                    value={input.text}
                    onInput={(event) =>
                      edit({
                        ...current.current.fields[current.current.step]!,
                        text: event.currentTarget.value,
                      })
                    }
                  />
                  {lengthError && (
                    <span className="questionnaire-error" role="status">
                      {lengthError.kind === 'minimum' ? '至少' : '最多'} {lengthError.bound}{' '}
                      个字符；当前 {lengthError.length}
                    </span>
                  )}
                </label>
              )}
            </div>
          )}
        </div>
      </fieldset>
      <footer className="questionnaire-actions">
        {form.alternative && (
          <div className="questionnaire-alternative">
            <button
              className="questionnaire-cancel"
              type="button"
              disabled={disabled || submitting}
              title={cancel ? '跳过这些问题，继续当前任务' : form.alternative.description}
              onClick={() => void send(form.alternative!.value as Json)}
            >
              {cancel ? '取消回答' : form.alternative.title}
            </button>
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
            <button
              key="previous-question"
              type="button"
              disabled={submitting}
              onClick={() => change({ ...current.current, step: current.current.step - 1 })}
            >
              上一题
            </button>
          )}
          {draft.step < form.fields.length - 1 ? (
            <button
              className="questionnaire-primary"
              key="next-question"
              type="button"
              disabled={submitting}
              onClick={() => change({ ...current.current, step: current.current.step + 1 })}
            >
              下一题
            </button>
          ) : (
            <button
              className="questionnaire-primary"
              key="submit-questionnaire"
              type="submit"
              disabled={disabled || submitting || !answers(draft)}
            >
              {submitting ? '正在提交…' : '提交回答'}
            </button>
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
