import { InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Questionnaire } from '@shadcn/react/questionnaire';
import { type FormEvent, useState } from 'react';
import { Button } from './components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';

export interface AskQuestionnaireOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskQuestionnaireQuestion {
  id: string;
  question: string;
  options?: readonly AskQuestionnaireOption[];
  allowFreeText: boolean;
}

export interface AskQuestionnaireProps {
  title: string;
  description?: string;
  questions: readonly AskQuestionnaireQuestion[];
  answers: Readonly<Record<string, string>>;
  disabled?: boolean;
  onAnswerChange: (questionId: string, value: string) => void;
  onSubmit: (answer: string, answers: Readonly<Record<string, string>>) => void;
  onCancel: () => void;
}

export function AskQuestionnaire({
  title,
  description,
  questions,
  answers,
  disabled = false,
  onAnswerChange,
  onSubmit,
  onCancel,
}: AskQuestionnaireProps) {
  const [current, setCurrent] = useState(0);
  const isAnswered = (question: AskQuestionnaireQuestion) => {
    const answer = answers[question.id];
    if (typeof answer !== 'string' || answer.trim().length === 0) return false;
    return (
      question.allowFreeText || question.options?.some((option) => option.id === answer) === true
    );
  };
  const allAnswered = questions.length > 0 && questions.every(isAnswered);
  const items = questions.map((question) => ({
    name: question.id,
    required: true,
    choices: (question.options ?? []).map((option) => ({ value: option.id, disabled })),
  }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = Object.fromEntries(
      questions.flatMap((question) => {
        const value = answers[question.id];
        return typeof value === 'string' && value.trim() ? [[question.id, value.trim()]] : [];
      }),
    );
    if (Object.keys(submitted).length !== questions.length || !questions.every(isAnswered)) return;
    const displayAnswer = (question: AskQuestionnaireQuestion) => {
      const value = submitted[question.id]!;
      return question.options?.find((option) => option.id === value)?.label ?? value;
    };
    const summary =
      questions.length === 1
        ? displayAnswer(questions[0]!)
        : questions
            .map((question) => `${question.question}: ${displayAnswer(question)}`)
            .join('\n');
    onSubmit(summary, submitted);
  }

  return (
    <section className="notice ask-questionnaire" aria-label="补充问题">
      <strong className="ask-questionnaire-heading">{title}</strong>
      {description && <p className="ask-questionnaire-description">{description}</p>}
      <TooltipProvider delayDuration={300}>
        <Questionnaire.Root
          className="ask-questionnaire-form"
          items={items}
          item={questions[current]?.id}
          onItemChange={(item) => {
            const index = questions.findIndex((question) => question.id === item);
            if (index >= 0) setCurrent(index);
          }}
          shortcuts="letters"
          onSubmit={submit}
        >
          {questions.length > 1 && (
            <div className="ask-questionnaire-progress" role="status">
              问题 {current + 1} / {questions.length}
            </div>
          )}
          {questions.map((question) => {
            const selectedOption = question.options?.some(
              (option) => option.id === answers[question.id],
            );
            const freeText = selectedOption ? '' : (answers[question.id] ?? '');
            return (
              <Questionnaire.Item key={question.id} name={question.id} required>
                <Questionnaire.Title className="ask-questionnaire-title">
                  {question.question}
                </Questionnaire.Title>
                <Questionnaire.Choices className="ask-questionnaire-choices">
                  {(question.options ?? []).map((option) => (
                    <Questionnaire.Choice
                      className="ask-questionnaire-choice"
                      key={option.id}
                      value={option.id}
                      checked={answers[question.id] === option.id}
                      onChange={() => onAnswerChange(question.id, option.id)}
                      disabled={disabled}
                    >
                      <Questionnaire.ChoiceInput className="ask-questionnaire-choice-input" />
                      <Questionnaire.ChoiceLabel className="ask-questionnaire-choice-label">
                        <span>{option.label}</span>
                      </Questionnaire.ChoiceLabel>
                      {option.description && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              className="ask-questionnaire-info"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`查看 ${option.label} 的详细信息`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                            >
                              <HugeiconsIcon icon={InformationCircleIcon} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent
                            className="kite-client ask-questionnaire-info-content"
                            side="top"
                            sideOffset={6}
                          >
                            <strong>{option.label}</strong>
                            <span>{option.description}</span>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </Questionnaire.Choice>
                  ))}
                  {question.allowFreeText && (
                    <Questionnaire.Input
                      className="ask-questionnaire-input"
                      aria-label={
                        questions.length === 1 ? '回答问题' : `回答：${question.question}`
                      }
                      placeholder="输入其他回答…"
                      value={freeText}
                      onChange={(event) => onAnswerChange(question.id, event.target.value)}
                      disabled={disabled}
                      maxLength={8192}
                    />
                  )}
                </Questionnaire.Choices>
                <Questionnaire.Error className="ask-questionnaire-error">
                  请选择一个选项或输入回答。
                </Questionnaire.Error>
              </Questionnaire.Item>
            );
          })}
          <div className="ask-questionnaire-actions">
            <button type="button" disabled={disabled} onClick={onCancel}>
              取消回答
            </button>
            {current > 0 && (
              <button type="button" disabled={disabled} onClick={() => setCurrent(current - 1)}>
                上一题
              </button>
            )}
            {current < questions.length - 1 ? (
              <button
                className="primary"
                type="button"
                disabled={disabled}
                onClick={() => setCurrent(current + 1)}
              >
                下一题
              </button>
            ) : (
              <button className="primary" type="submit" disabled={disabled || !allAnswered}>
                提交回答
              </button>
            )}
          </div>
        </Questionnaire.Root>
      </TooltipProvider>
    </section>
  );
}
