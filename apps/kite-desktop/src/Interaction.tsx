import { AskQuestionnaire } from '@kite-ai/kite-client-ui';
import type {
  RuntimeInputInteraction,
  RuntimePlanReviewInteraction,
} from '@kite-ai/runtime-contract';
import type { DesktopClient } from './client';

export function Interaction({
  client,
  sessionId,
  interaction,
  disabled,
  text,
  onTextChange,
  answers,
  onAnswerChange,
  act,
}: {
  client: DesktopClient;
  sessionId: string;
  interaction: RuntimeInputInteraction | RuntimePlanReviewInteraction;
  disabled: boolean;
  text: string;
  onTextChange: (text: string) => void;
  answers?: Readonly<Record<string, string>>;
  onAnswerChange?: (questionId: string, value: string) => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  if (interaction.kind === 'input') {
    const questions = interaction.questions ?? [
      {
        id: 'answer',
        question: interaction.question,
        options: interaction.options,
        allowFreeText: interaction.allowFreeText,
      },
    ];
    const currentAnswers = answers ?? { [questions[0]!.id]: text };
    return (
      <AskQuestionnaire
        title={interaction.title || '需要你的回答'}
        description={interaction.summary}
        questions={questions}
        answers={currentAnswers}
        disabled={disabled}
        onAnswerChange={(questionId, value) => {
          if (questions.length === 1) onTextChange(value);
          onAnswerChange?.(questionId, value);
        }}
        onSubmit={(answer, submittedAnswers) =>
          void act(() =>
            client.respondInput(
              sessionId,
              interaction,
              answer,
              interaction.questions === undefined ? undefined : submittedAnswers,
            ),
          )
        }
        onCancel={() => void act(() => client.respondInput(sessionId, interaction))}
      />
    );
  }

  return (
    <section className="notice" aria-label="计划审核">
      <strong>{interaction.title || '审核计划'}</strong>
      {interaction.summary && <pre className="interaction-text">{interaction.summary}</pre>}
      {interaction.review && <pre className="interaction-text">{interaction.review.text}</pre>}
      {(!interaction.review || interaction.review.truncated) && (
        <p role="alert">
          计划正文不可用或超过显示上限。请提交修改要求，取得完整可读的计划后再批准。
        </p>
      )}
      <p>计划版本 {interaction.plan.version}。批准后按所选权限模式继续执行。</p>
      <button
        type="button"
        disabled={disabled || !interaction.review || interaction.review.truncated}
        onClick={() =>
          void act(() =>
            client.respondPlan(sessionId, interaction, {
              kind: 'plan_review',
              decision: 'accept_edits',
            }),
          )
        }
      >
        批准 · Accept Edits
      </button>
      <button
        type="button"
        disabled={disabled || !interaction.review || interaction.review.truncated}
        onClick={() =>
          void act(() =>
            client.respondPlan(sessionId, interaction, {
              kind: 'plan_review',
              decision: 'auto',
            }),
          )
        }
      >
        批准 · Auto
      </button>
      <p>Accept Edits 按策略审批操作；Auto 自动审查，不确定时再请求授权。</p>
      <textarea
        aria-label="计划修改要求"
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        disabled={disabled}
        maxLength={8192}
      />
      <button
        type="button"
        disabled={disabled || !text.trim()}
        onClick={() =>
          void act(() =>
            client.respondPlan(sessionId, interaction, {
              kind: 'plan_review',
              decision: 'feedback',
              feedback: text,
            }),
          )
        }
      >
        提交修改要求
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          void act(() =>
            client.respondPlan(sessionId, interaction, {
              kind: 'plan_review',
              decision: 'cancel',
            }),
          )
        }
      >
        取消计划
      </button>
    </section>
  );
}
