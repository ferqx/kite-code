import { verifiedJobProofPredicate } from './job-reconcile-operations';
import type { SqliteOperations } from './operations';

/** Shared acquire/release/idle-dispatch group gate; a query does not confer recovery authority. */
export function hasUnsettledOwnerGroup(
  db: SqliteOperations,
  rootId: string,
  storeId: string,
): boolean {
  return !!(
    db.row(
      'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1',
      rootId,
    ) ||
    db.row(
      `SELECT e.id FROM execution e WHERE e.root_session_id=? AND e.state IN ('planned','dispatching','running','outcome_unknown') AND (e.origin_store_id=? OR NOT EXISTS(SELECT 1 FROM command WHERE session_id=? AND kind='session.create' AND origin_store_id<>?)) AND ${verifiedJobProofPredicate('e')}`,
      rootId,
      storeId,
      rootId,
      storeId,
    )
  );
}
