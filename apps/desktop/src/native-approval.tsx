import type { Interaction } from '@kite-ai/client';
import {
  type InteractionAnswer,
  type InteractionSubmission,
  requiresInteractionAttachment,
} from '@kite-ai/ui';
import { Approval } from '@kite-ai/ui/desktop';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Original form; the enclosing InteractionCard owns attachment proof and answer authority. */
export function NativeApproval({
  interaction,
  disabled,
  onAnswer,
  completeContent,
  submission,
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  completeContent?: string;
  submission?: InteractionSubmission;
}) {
  let request = object(interaction.request);
  if (requiresInteractionAttachment(interaction)) {
    request = undefined;
    if (completeContent !== undefined) {
      try {
        request = object(JSON.parse(completeContent));
      } catch {}
    }
  }
  const exact =
    request?.definitionId === interaction.definitionId &&
    request?.definitionVersion === interaction.definitionVersion;
  const grants =
    exact && Array.isArray(request?.grants)
      ? request.grants.filter(
          (grant): grant is 'approve_once' | 'same_command' =>
            grant === 'approve_once' || grant === 'same_command',
        )
      : [];
  const input = object(request?.input),
    policy = object(request?.policy);
  const command =
    exact &&
    interaction.definitionId === 'shell.launch' &&
    interaction.definitionVersion === '1' &&
    typeof input?.command === 'string'
      ? input.command
      : undefined;
  const summary = request
    ? `${interaction.definitionId}${typeof input?.path === 'string' ? ` · ${input.path}` : typeof policy?.reason === 'string' ? ` · ${policy.reason}` : ''}`
    : '请先读取并核对完整审批内容。';
  return (
    <article aria-label={`approval ${interaction.id}`}>
      <Approval
        command={command}
        summary={summary}
        grants={grants}
        disabled={disabled || !onAnswer}
        onDecide={(decision) => {
          if (disabled || !onAnswer || (decision !== 'reject' && !grants.includes(decision)))
            return;
          void onAnswer(
            interaction,
            decision === 'reject'
              ? { kind: 'approval', decision: 'deny' }
              : { kind: 'approval', decision: 'approve', grant: decision },
          );
        }}
      />
      {request && (
        <details>
          <summary>完整审批请求</summary>
          <pre>{JSON.stringify(request, null, 2)}</pre>
        </details>
      )}
      {submission && (
        <p role="status">
          {submission.phase === 'unknown'
            ? '审批提交结果未知，请核对原提交。'
            : submission.phase === 'accepted'
              ? '审批回答已保存，执行状态由服务继续核对。'
              : submission.phase === 'failed'
                ? '审批提交失败，请核对原提交。'
                : '正在提交审批回答。'}
        </p>
      )}
    </article>
  );
}
