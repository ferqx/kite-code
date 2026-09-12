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
  act,
}: {
  client: DesktopClient;
  sessionId: string;
  interaction: RuntimeInputInteraction | RuntimePlanReviewInteraction;
  disabled: boolean;
  text: string;
  onTextChange: (text: string) => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <section className="notice" aria-label={interaction.kind === 'input' ? '补充问题' : '计划审核'}>
      <strong>
        {interaction.title || (interaction.kind === 'input' ? '需要你的回答' : '审核计划')}
      </strong>
      {interaction.summary && <pre className="interaction-text">{interaction.summary}</pre>}
      {interaction.kind === 'input' ? (
        <>
          <p>{interaction.question}</p>
          {interaction.options?.map((option) => (
            <button
              type="button"
              key={option.id}
              disabled={disabled}
              onClick={() => void act(() => client.respondInput(sessionId, interaction, option.id))}
            >
              {option.label}
              {option.description && <small> — {option.description}</small>}
            </button>
          ))}
          {interaction.allowFreeText && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(() => client.respondInput(sessionId, interaction, text));
              }}
            >
              <textarea
                aria-label="回答问题"
                value={text}
                onChange={(event) => onTextChange(event.target.value)}
                disabled={disabled}
                maxLength={8192}
              />
              <button type="submit" disabled={disabled || !text.trim()}>
                提交回答
              </button>
            </form>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => void act(() => client.respondInput(sessionId, interaction))}
          >
            取消回答
          </button>
        </>
      ) : (
        <>
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
        </>
      )}
    </section>
  );
}
