import { verifiedJobProofPredicate } from './job-reconcile-operations';
import type { SqliteOperations } from './operations';
import { closeAbandonedAutomaticTitle } from './session-title-publication';
import { automaticTitleEffect } from './session-title-scope';

/** Physical lock acquisition already excluded the old supervising instance. The enclosing
 * transaction rolls these closures back if any ordinary recovery gate still fails. */
export function closeAbandonedOwnerTitles(db: SqliteOperations, rootId: string): void {
  for (const execution of db.rows(
    "SELECT * FROM execution WHERE root_session_id=? AND run_id IS NULL AND kind='job' AND adapter_id='builtin.session-title/generate' AND state IN('planned','dispatching','running','outcome_unknown') LIMIT 3",
    rootId,
  )) {
    const title = automaticTitleEffect(db, execution);
    if (title) closeAbandonedAutomaticTitle(db, title);
  }
}

/** Shared acquire/release/idle-dispatch group gate; a query does not confer recovery authority. */
export function hasUnsettledOwnerGroup(
  db: SqliteOperations,
  rootId: string,
  storeId: string,
): boolean {
  if (
    db.row(
      'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1',
      rootId,
    )
  )
    return true;
  const executions = db.rows(
    `SELECT e.* FROM execution e WHERE e.root_session_id=? AND e.state IN ('planned','dispatching','running','outcome_unknown') AND (e.origin_store_id=? OR NOT EXISTS(SELECT 1 FROM command WHERE session_id=? AND kind='session.create' AND origin_store_id<>?)) AND ${verifiedJobProofPredicate('e')} LIMIT 3`,
    rootId,
    storeId,
    rootId,
    storeId,
  );
  // At most the one registered Job and its one exact internal Model can qualify.
  if (executions.length >= 3) return true;
  for (const execution of executions) {
    const title = automaticTitleEffect(db, execution);
    if (!title || title.attempt.publication === 'pending') return true;
  }
  return false;
}
