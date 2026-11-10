import type { Store } from '../port';
import { AgentError } from '../types';
import type { SqliteOperations } from './operations';

/** The same original allocation order as getView, without messages or execution projections. */
export function readFirstSessionRun(
  db: SqliteOperations,
  input: Parameters<Store['readFirstSessionRun']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    const run = db.row(
      'SELECT * FROM run WHERE session_id=? ORDER BY rowid ASC LIMIT 1',
      input.sessionId,
    );
    const result = {
      storeId: input.expectedStoreId,
      session: db.session(session),
      snapshotCursor: db.metadata().lastChangeCursor,
      run: run ? db.runRecord(run) : null,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
