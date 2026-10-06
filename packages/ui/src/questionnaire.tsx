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
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={`${title}的说明`}
        aria-describedby={hovered || focused ? id : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        ⓘ
      </button>
      {(hovered || focused) && (
        <span
          id={id}
          role="tooltip"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 1,
            width: 'max-content',
            maxWidth: 'min(32rem, 80vw)',
            padding: '0.5rem',
            border: '1px solid currentColor',
            background: 'Canvas',
            color: 'CanvasText',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {title}
          {'\n'}
          {description}
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
  return (
    <form aria-label="Questionnaire" onSubmit={submit}>
      {form.title && <h3>{form.title}</h3>}
      {form.description && <p style={{ whiteSpace: 'pre-wrap' }}>{form.description}</p>}
      <p role="status">
        问题 {draft.step + 1}/{form.fields.length}
      </p>
      <fieldset key={draft.step} disabled={disabled || submitting} style={{ minWidth: 0 }}>
        <legend>{field.title ?? '回答问题'}</legend>
        {field.description && <p style={{ whiteSpace: 'pre-wrap' }}>{field.description}</p>}
        {field.choices.map((choice, index) => (
          <div key={index}>
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
              {choice.title}
            </label>
            {choice.description && (
              <ChoiceInformation title={choice.title} description={choice.description} />
            )}
          </div>
        ))}
        {field.text && (
          <div>
            {field.choices.length > 0 && (
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
                自由回答
              </label>
            )}
            {(!field.choices.length || input.selected === field.choices.length) && (
              <label>
                {!field.choices.length && '自由回答'}
                <textarea
                  aria-label="自由回答"
                  value={input.text}
                  onInput={(event) =>
                    edit({
                      ...current.current.fields[current.current.step]!,
                      text: event.currentTarget.value,
                    })
                  }
                />
                {lengthError && (
                  <span role="status">
                    {lengthError.kind === 'minimum' ? '至少' : '最多'} {lengthError.bound}{' '}
                    个字符；当前 {lengthError.length}
                  </span>
                )}
              </label>
            )}
          </div>
        )}
      </fieldset>
      <div>
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
            key="next-question"
            type="button"
            disabled={submitting}
            onClick={() => change({ ...current.current, step: current.current.step + 1 })}
          >
            下一题
          </button>
        ) : (
          <button
            key="submit-questionnaire"
            type="submit"
            disabled={disabled || submitting || !answers(draft)}
          >
            提交回答
          </button>
        )}
      </div>
      {form.alternative && (
        <div>
          <button
            type="button"
            disabled={disabled || submitting}
            onClick={() => void send(form.alternative!.value as Json)}
          >
            {form.alternative.title}
          </button>
          {form.alternative.description && (
            <ChoiceInformation
              title={form.alternative.title}
              description={form.alternative.description}
            />
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
