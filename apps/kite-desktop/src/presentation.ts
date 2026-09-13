import type { Message } from '@kite-ai/kite-client-ui';
import type { RuntimeClientEvent, RuntimeSessionProjection } from '@kite-ai/runtime-contract';

export function isActiveRun(session?: RuntimeSessionProjection) {
  return ['queued', 'running', 'waiting'].includes(session?.currentRun?.status ?? '');
}

export type { Message } from '@kite-ai/kite-client-ui';

/** Service text deltas are cumulative; durable model output wins over late deltas. */
export function projectEvent(
  messages: readonly Message[],
  event: RuntimeClientEvent,
): readonly Message[] {
  return projectEventWithIdentity(messages, event);
}

export function projectEventWithIdentity(
  messages: readonly Message[],
  event: RuntimeClientEvent,
  identity: Readonly<{ turnId?: string }> = {},
): readonly Message[] {
  if (event.type === 'tool.file_changed') {
    const id = `tool:${event.toolId}`;
    const previous = messages.find((message) => message.id === id);
    const change: Message = {
      ...(previous ?? { id, role: 'tool', text: event.summary ?? '文件已变更', settled: false }),
      ...(identity.turnId ? { turnId: identity.turnId } : {}),
      changeConfirmed: true,
      ...(event.path ? { changedFile: event.path } : {}),
    };
    return previous
      ? messages.map((message) => (message.id === id ? change : message))
      : [...messages, change];
  }
  let next: Message;
  switch (event.type) {
    case 'subagent.started':
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        title: event.name,
        text: '',
        settled: false,
        status: 'running',
      };
      break;
    case 'subagent.phase':
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        text: '',
        parentToolCallId: event.parentToolCallId,
        settled: false,
        status: event.status === 'suspended' ? 'waiting' : 'running',
      };
      break;
    case 'subagent.step': {
      const id = `subagent:${event.subagentId}`;
      const previous = messages.find((message) => message.id === id);
      if (previous?.settled) return messages;
      const steps = previous?.steps ?? [];
      const step = {
        id: event.stepId,
        text: event.summary || event.displayLabel || event.toolName,
        status: event.status,
      };
      const existing = steps.find((item) => item.id === step.id);
      if (existing && existing.status !== 'started' && step.status === 'started') return messages;
      next = {
        id,
        role: 'subagent',
        text: previous?.text ?? '',
        settled: false,
        steps: existing
          ? steps.map((item) => (item.id === step.id ? step : item))
          : [...steps, step],
      };
      break;
    }
    case 'subagent.completed':
    case 'subagent.failed':
      next = {
        id: `subagent:${event.subagentId}`,
        role: 'subagent',
        text: event.summary,
        settled: true,
        status: event.type === 'subagent.completed' ? 'completed' : 'failed',
      };
      break;
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
      next = {
        id: `interaction:${event.interaction.interactionId}`,
        role: 'system',
        title: event.interaction.title,
        text:
          event.interaction.kind === 'approval'
            ? (event.interaction.command ?? event.interaction.summary ?? '')
            : (event.interaction.summary ?? ''),
        settled: false,
      };
      break;
    case 'approval.granted':
    case 'approval.rejected':
    case 'input.answered':
    case 'input.cancelled':
    case 'plan.approved':
    case 'interaction.settled': {
      const id = `interaction:${event.interactionId}`;
      const previous = messages.find((message) => message.id === id);
      if (
        event.type === 'interaction.settled' &&
        event.outcome === 'completed' &&
        previous?.settled
      )
        return messages;
      const title =
        event.type === 'approval.granted'
          ? '已批准本次命令，执行结果以工具记录为准'
          : event.type === 'approval.rejected'
            ? '已拒绝本次命令'
            : event.type === 'input.answered'
              ? '回答已提交'
              : event.type === 'input.cancelled'
                ? '已取消回答'
                : event.type === 'plan.approved'
                  ? `计划已批准 · ${event.mode === 'auto' ? 'Auto' : 'Accept Edits'}`
                  : event.outcome === 'cancelled'
                    ? '交互已取消'
                    : event.outcome === 'rejected'
                      ? '交互已拒绝'
                      : event.outcome === 'expired'
                        ? '交互已过期'
                        : '本次确认已提交';
      next = { id, role: 'system', title, text: previous?.text ?? '', settled: true };
      break;
    }
    case 'user.message':
      next = { id: `user:${event.messageId}`, role: 'user', text: event.text, settled: true };
      break;
    case 'model.text_delta':
      next = {
        id: `model:${event.requestId}`,
        role: 'assistant',
        text: event.text,
        settled: false,
      };
      break;
    case 'model.responded':
      next = {
        id: `model:${event.requestId}`,
        role: 'assistant',
        text: event.summary ?? '',
        settled: true,
        finalReply: event.toolCallCount === 0,
      };
      break;
    case 'tool.queued':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary,
        settled: false,
        title: event.displayLabel || event.toolName || '工具执行',
        toolName: event.toolName,
        arguments: event.arguments,
        status: 'running',
      };
      break;
    case 'tool.started':
    case 'tool.progress':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary ?? '正在执行工具',
        settled: false,
        status: 'running',
      };
      break;
    case 'tool.finished':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: [event.summary, event.result.stdout, event.result.stderr].filter(Boolean).join('\n'),
        settled: true,
        toolResult: event.result,
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.displayLabel || event.toolName
          ? { title: event.displayLabel || event.toolName }
          : {}),
        status: event.result.ok ? 'completed' : 'failed',
      };
      break;
    case 'tool.failed':
    case 'tool.rejected':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary,
        settled: true,
        status: event.type === 'tool.failed' ? 'failed' : 'rejected',
      };
      break;
    case 'tool.cancelled':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary ?? '工具已取消',
        settled: true,
        status: 'cancelled',
      };
      break;
    default:
      return messages;
  }
  if (identity.turnId) next = { ...next, turnId: identity.turnId };
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const previous = messages[index]!;
  if (previous.settled && !next.settled) return messages;
  if (next.role === 'assistant' && !next.settled && !next.text.startsWith(previous.text))
    return messages;
  if (!next.text) next = { ...next, text: previous.text };
  next = { ...previous, ...next };
  return messages.map((message, position) => (position === index ? next : message));
}
