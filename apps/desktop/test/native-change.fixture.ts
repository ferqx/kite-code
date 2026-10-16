import type { Change } from '@kite-ai/client';

/** A real public notification envelope; its scope controls selected-view invalidation. */
export function sessionChange(sessionId: string | null, cursor = '1'): Change {
  return {
    cursor,
    sessionId,
    objectId: sessionId ?? 'workspace',
    type: 'session.updated',
    revision: '1',
    payload: null,
  };
}
