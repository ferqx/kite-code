import { AgentError } from '../types';
import { internalModelSourceTarget } from './internal-model';
import type { SqliteOperations } from './operations';
import { readTitleJob, type TitleRow } from './session-title-proof';

/** A complete immutable default naming lineage, never an adapter name/purpose exemption. */
export function automaticTitleEffect(db: SqliteOperations, execution: TitleRow) {
  const job =
    execution.kind === 'job'
      ? execution
      : execution.kind === 'model'
        ? internalModelSourceTarget(db, execution)
        : null;
  if (job?.adapter_id !== 'builtin.session-title/generate') return null;
  try {
    return readTitleJob(db, {
      expectedStoreId: db.metadata().storeId,
      sessionId: String(job.session_id),
      jobExecutionId: String(job.id),
    });
  } catch (error) {
    if (
      error instanceof AgentError &&
      [
        'session_title_attempt_invalid',
        'session_title_source_invalid',
        'session_title_job_invalid',
        'permission_denied',
      ].includes(error.code)
    )
      return null;
    throw error;
  }
}
