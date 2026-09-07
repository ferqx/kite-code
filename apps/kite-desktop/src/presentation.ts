import type { RuntimeClientEvent, RuntimeClientToolResult } from '@kite-ai/runtime-contract';

export interface Message {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly settled: boolean;
  readonly changedFile?: string;
  readonly changeConfirmed?: boolean;
  readonly toolResult?: RuntimeClientToolResult;
}

/** Service text deltas are cumulative; durable model output wins over late deltas. */
export function projectEvent(
  messages: readonly Message[],
  event: RuntimeClientEvent,
): readonly Message[] {
  if (event.type === 'tool.file_changed') {
    const id = `tool:${event.toolId}`;
    const previous = messages.find((message) => message.id === id);
    const change: Message = {
      ...(previous ?? { id, role: 'tool', text: event.summary ?? '文件已变更', settled: false }),
      changeConfirmed: true,
      ...(event.path ? { changedFile: event.path } : {}),
    };
    return previous
      ? messages.map((message) => (message.id === id ? change : message))
      : [...messages, change];
  }
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
        text: [event.summary, event.result.stdout, event.result.stderr].filter(Boolean).join('\n'),
        settled: true,
        toolResult: event.result,
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
  next = { ...previous, ...next };
  return messages.map((message, position) => (position === index ? next : message));
}
