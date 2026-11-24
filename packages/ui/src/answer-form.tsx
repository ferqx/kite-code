import { type ReactNode, useRef, useState } from 'react';

export function AnswerChoices({
  name,
  choices,
  selected,
  multiple = false,
  selectedChoices,
  onSelect,
  children,
}: {
  name: string;
  choices: readonly { title: string; description?: string; recommended?: boolean }[];
  selected?: number;
  multiple?: boolean;
  selectedChoices?: readonly number[];
  onSelect: (index: number) => void;
  children?: ReactNode;
}) {
  return (
    <div className="questionnaire-choices">
      {choices.map(({ title, description, recommended }, index) => {
        const descriptionId = `${name}-choice-${index}`;
        const checked = multiple ? selectedChoices?.includes(index) === true : selected === index;
        return (
          <label className="questionnaire-choice" data-selected={checked} key={index}>
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={name}
              value={index}
              aria-label={title}
              aria-describedby={description ? descriptionId : undefined}
              checked={checked}
              onChange={() => onSelect(index)}
            />
            <span className="questionnaire-choice-copy">
              <span className="questionnaire-choice-title">
                <span>{title}</span>
                {recommended && <span className="questionnaire-recommended">推荐</span>}
              </span>
              {description && (
                <span className="questionnaire-choice-description" id={descriptionId}>
                  {description}
                </span>
              )}
            </span>
          </label>
        );
      })}
      {children}
    </div>
  );
}

export function useAnswerSubmission<Answer>(
  disabled: boolean,
  onSubmit: (answer: Answer) => void | Promise<void>,
  errorText: (error: unknown) => string,
) {
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  async function send(answer: Answer) {
    if (disabled || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(answer);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  return { busy, submitting, error, send };
}
