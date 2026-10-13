import type { Message, Run } from '@kite-ai/client';

type ReplyRun = Pick<Run, 'id' | 'sessionId' | 'originStoreId' | 'status' | 'isActive'>;

/** Hosts prove Run metadata and loaded bodies; this projection performs no reads. */
export function completeRunReplies({
  messages,
  runs,
  sessionId,
  fullContent,
  copyScope = 'run',
}: {
  messages: readonly Message[];
  runs: readonly ReplyRun[];
  sessionId: string;
  fullContent?: (message: Message) => string | undefined;
  /** Web copies the whole Run; Native's product contract copies only its final reply. */
  copyScope?: 'run' | 'final';
}): ReadonlyMap<string, { runId: string; text?: string }> {
  const replies = new Map<string, { runId: string; text?: string }>();
  for (const run of runs) {
    if (
      run.sessionId !== sessionId ||
      !run.originStoreId ||
      run.status !== 'completed' ||
      run.isActive
    )
      continue;
    const own = messages
      .filter(
        (message) =>
          message.sessionId === sessionId && !message.originMessage && message.runId === run.id,
      )
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
    const assistant = own.filter((message) => message.role === 'assistant');
    const last = assistant.at(-1);
    if (
      last?.status !== 'complete' ||
      last.contentFormat === 'unsupported' ||
      last.toolCalls?.length ||
      (last.outputBody && (!last.outputBody.complete || last.outputBody.toolCallCount !== 0)) ||
      own.some((message) => message.role === 'tool' && BigInt(message.seq) > BigInt(last.seq))
    )
      continue;
    const parts: string[] = [];
    let complete = true;
    for (const message of copyScope === 'final' ? [last] : assistant) {
      if (
        message.status !== 'complete' ||
        message.contentFormat === 'unsupported' ||
        (message.outputBody && !message.outputBody.complete)
      ) {
        complete = false;
        break;
      }
      const text = message.outputBody
        ? message.outputBody.contentBytes === '0'
          ? ''
          : fullContent?.(message)
        : message.content;
      if (text === undefined) {
        complete = false;
        break;
      }
      if (text.length) parts.push(text);
    }
    const text = complete ? parts.join('\n\n') : undefined;
    replies.set(last.id, { runId: run.id, ...(text ? { text } : {}) });
  }
  return replies;
}
