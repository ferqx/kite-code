import type { WebPresentationBlock, WebPresentationMessage } from './types';

export function mergeMessages(
  current: readonly WebPresentationMessage[],
  incoming: readonly WebPresentationMessage[],
): readonly WebPresentationMessage[] {
  const messages = new Map(current.map((message) => [message.messageId, message]));
  for (const message of incoming) {
    messages.set(message.messageId, mergeHistoryMessage(messages.get(message.messageId), message));
  }
  return [...messages.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
  );
}

function mergeHistoryMessage(
  current: WebPresentationMessage | undefined,
  incoming: WebPresentationMessage,
): WebPresentationMessage {
  if (!current) return incoming;
  const currentBlock = current.blocks[0];
  const incomingBlock = incoming.blocks[0];
  if (
    current.blocks.length !== 1 ||
    incoming.blocks.length !== 1 ||
    !isToolBlock(currentBlock) ||
    !isToolBlock(incomingBlock) ||
    currentBlock.toolId !== incomingBlock.toolId ||
    incomingBlock.label !== 'Tool' ||
    currentBlock.label === 'Tool'
  ) {
    return incoming;
  }
  return { ...incoming, blocks: [{ ...incomingBlock, label: currentBlock.label }] };
}

function isToolBlock(
  block: WebPresentationBlock | undefined,
): block is Extract<
  WebPresentationBlock,
  { readonly kind: 'tool_activity' | 'tool_result' | 'tool_rejected' }
> {
  return (
    block?.kind === 'tool_activity' ||
    block?.kind === 'tool_result' ||
    block?.kind === 'tool_rejected'
  );
}
