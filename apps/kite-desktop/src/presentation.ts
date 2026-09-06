import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';

export interface Message {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly settled: boolean;
}

/** Service text deltas are cumulative; durable model output wins over late deltas. */
export function projectEvent(
  messages: readonly Message[],
  event: RuntimeClientEvent,
): readonly Message[] {
  let next: Message;
  switch (event.type) {
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
      };
      break;
    case 'tool.queued':
      next = { id: `tool:${event.toolId}`, role: 'tool', text: event.summary, settled: false };
      break;
    case 'tool.started':
    case 'tool.progress':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary ?? '正在执行工具',
        settled: false,
      };
      break;
    case 'tool.finished':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: `${event.summary}\n${event.result.stdout || event.result.stderr}`,
        settled: true,
      };
      break;
    case 'tool.failed':
    case 'tool.rejected':
      next = { id: `tool:${event.toolId}`, role: 'tool', text: event.summary, settled: true };
      break;
    case 'tool.cancelled':
      next = {
        id: `tool:${event.toolId}`,
        role: 'tool',
        text: event.summary ?? '工具已取消',
        settled: true,
      };
      break;
    default:
      return messages;
  }
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const previous = messages[index]!;
  if (previous.settled && !next.settled) return messages;
  if (next.role === 'assistant' && !next.settled && !next.text.startsWith(previous.text))
    return messages;
  if (next.settled && !next.text) next = { ...next, text: previous.text };
  return messages.map((message, position) => (position === index ? next : message));
}
