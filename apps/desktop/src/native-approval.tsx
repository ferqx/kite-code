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
  attachment,
  embedded = false,
}: {
  embedded?: boolean;
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  completeContent?: string;
  submission?: InteractionSubmission;
  attachment?: { phase: 'idle' | 'loading' | 'failed' | 'loaded'; retry?: () => void };
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
  const shell = ['shell.execute', 'shell.launch', 'shell.command'].includes(
    interaction.definitionId,
  );
  const command =
    exact && shell && interaction.definitionVersion === '1' && typeof input?.command === 'string'
      ? input.command
      : undefined;
  const summary = request
    ? typeof input?.path === 'string'
      ? input.path
      : typeof policy?.reason === 'string'
        ? policy.reason
        : JSON.stringify(input ?? request)
    : attachment?.phase === 'failed'
      ? '完整审批内容核对失败'
      : attachment?.phase === 'loading'
        ? '正在核对完整审批内容…'
        : '完整审批内容尚不可用';
  return (
    <article aria-label={`approval ${interaction.id}`}>
      <Approval
        embedded={embedded}
        command={command}
        summary={summary}
        toolLabel={shell ? 'Shell' : interaction.definitionId}
        fullText={
          request && !command ? JSON.stringify(request.input ?? request, null, 2) : undefined
        }
        attachment={attachment}
        status={
          submission
            ? submission.phase === 'unknown'
              ? '审批提交结果未知，请核对原提交。'
              : submission.phase === 'accepted'
                ? '审批回答已保存，等待执行。'
                : submission.phase === 'failed'
                  ? '审批提交失败，请核对原提交。'
                  : '正在提交审批回答。'
            : undefined
        }
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
    </article>
  );
}
