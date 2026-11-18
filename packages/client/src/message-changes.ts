import { ClientError, validateRequest } from './decode';
import type { MessageChangesPage, MessageChangesQuery } from './generated/api';
import { parseCursorSequence } from './sse';

export function validateMessageChangesQuery(input: MessageChangesQuery) {
  validateRequest('MessageChangesQuery', input);
  for (const value of [input.afterCursor, input.upperCursor, input.upperSeq, input.afterSeq])
    if (value !== undefined) parseCursorSequence(value);
  if (BigInt(input.afterCursor) > BigInt(input.upperCursor))
    throw new ClientError('invalid_cursor');
}

export function verifyMessageChangesPage(
  sessionId: string,
  input: MessageChangesQuery,
  page: MessageChangesPage,
) {
  if (
    page.storeId !== input.storeId ||
    page.sessionId !== sessionId ||
    page.afterCursor !== input.afterCursor ||
    page.upperCursor !== input.upperCursor ||
    (input.upperSeq !== undefined && page.highWaterSeq !== input.upperSeq) ||
    BigInt(page.nextCursor) < BigInt(input.afterCursor) ||
    BigInt(page.nextCursor) > BigInt(input.upperCursor) ||
    (page.nextCursor === input.afterCursor && page.nextCursor !== input.upperCursor)
  )
    throw new ClientError('history_page_identity_mismatch');
  let last = BigInt(input.afterSeq ?? '0');
  const ids = new Set<string>();
  for (const message of page.messages) {
    if (
      message.sessionId !== sessionId ||
      ids.has(message.id) ||
      BigInt(message.seq) <= last ||
      BigInt(message.seq) > BigInt(page.highWaterSeq)
    )
      throw new ClientError('history_page_sequence_mismatch');
    ids.add(message.id);
    last = BigInt(message.seq);
  }
  if (
    page.messages.length + page.removedIds.length > (input.limit ?? 100) ||
    new Set(page.removedIds).size !== page.removedIds.length ||
    page.removedIds.some((id) => ids.has(id)) ||
    (page.nextAfterSeq !== null &&
      (BigInt(page.nextAfterSeq) <= BigInt(input.afterSeq ?? '0') ||
        BigInt(page.nextAfterSeq) < last ||
        BigInt(page.nextAfterSeq) > BigInt(page.highWaterSeq)))
  )
    throw new ClientError('history_page_cursor_mismatch');
  return page;
}
