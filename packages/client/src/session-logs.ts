import { ClientError } from './decode';
import type { BrowserSessionLogQuery, SessionLogPage } from './generated/api';
import { parseCursorSequence } from './sse';

export function validateSessionLogTarget(sessionId: string): void {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
    throw new ClientError('invalid_session_log_target');
}

export function validateSessionLogBounds(query: BrowserSessionLogQuery): void {
  try {
    const after = parseCursorSequence(query.afterCursor);
    if (query.upperCursor !== undefined && after > parseCursorSequence(query.upperCursor))
      throw new ClientError('invalid_page_bounds');
  } catch {
    throw new ClientError('invalid_page_bounds');
  }
}

export function verifySessionLogPage(
  page: SessionLogPage,
  target: { storeId: string; sessionId: string },
  query: BrowserSessionLogQuery,
): SessionLogPage {
  if (page.storeId !== target.storeId || page.sessionId !== target.sessionId)
    throw new ClientError('session_log_identity_mismatch');
  try {
    const after = parseCursorSequence(query.afterCursor);
    const upper = parseCursorSequence(page.upperCursor);
    const floor = parseCursorSequence(page.replayFloor);
    const snapshot = parseCursorSequence(page.snapshotCursor);
    if (
      floor > after ||
      after > upper ||
      upper > snapshot ||
      (query.upperCursor !== undefined && query.upperCursor !== page.upperCursor) ||
      page.entries.length > (query.limit ?? 200) ||
      page.complete !== (page.nextAfterCursor === null)
    )
      throw new ClientError('invalid_session_log_page');
    let previous = after;
    for (const entry of page.entries) {
      const position = parseCursorSequence(entry.cursor);
      parseCursorSequence(entry.revision);
      if (
        entry.sessionId !== target.sessionId ||
        position <= previous ||
        position > upper ||
        (entry.modelExecutionId !== null &&
          (entry.category !== 'execution' ||
            entry.details.kind !== 'model' ||
            entry.details.executionId !== entry.modelExecutionId ||
            entry.objectId !== entry.modelExecutionId))
      )
        throw new ClientError('invalid_session_log_page');
      previous = position;
    }
    if (
      !page.complete &&
      (page.entries.length === 0 ||
        page.nextAfterCursor !== page.entries.at(-1)!.cursor ||
        parseCursorSequence(page.nextAfterCursor!) >= upper)
    )
      throw new ClientError('invalid_session_log_page');
    if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 512 * 1024)
      throw new ClientError('response_too_large');
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError('invalid_session_log_page');
  }
  return page;
}
