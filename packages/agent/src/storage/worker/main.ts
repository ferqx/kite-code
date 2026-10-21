import type { ProfileAccess } from '../../platform/profile';
import { assertSelectedSqliteEngine, type SqliteEngineSelection } from '../../sqlite-engine';
import {
  ArtifactVerificationPending,
  disposeArtifactVerification,
} from '../sqlite/artifact-operations';
import { openDatabase } from '../sqlite/connection';
import { runnableCommandPredicate } from '../sqlite/job-report-operations';
import { SqliteOperations } from '../sqlite/operations';
import { hasUnsettledOwnerGroup } from '../sqlite/owner-dispatch';
import { readRecoveryToolHistory } from '../sqlite/recovery-history';
import { getRecoveryReceipt } from '../sqlite/recovery-operations';
import { UnstartedSqliteWrite } from '../sqlite/write-lock';
import { AgentError, type OwnerRef } from '../types';
import { deserializeStorageError, type StorageWorkerError, serializeStorageError } from './error';
import type { WorkerRequest } from './protocol';
import { WorkerQueue } from './queue';
import type { DbTiming } from './timing';

let operations: SqliteOperations | undefined;
declare const self: Worker;
const queue = new WorkerQueue();
let scheduled = false;
const arrivals = new Map<number, number>();
function pump(): void {
  scheduled = false;
  const request = queue.next();
  if (request) execute(request);
  if (queue.size) {
    scheduled = true;
    if (request) setImmediate(pump);
    else setTimeout(pump, 25);
  }
}
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    queue.push(event.data);
    arrivals.set(event.data.id, performance.now());
    if (!scheduled) {
      scheduled = true;
      setImmediate(pump);
    }
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error: {
        code: 'storage_queue_full',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
function execute(request: WorkerRequest): void {
  const { id, method, args } = request;
  const arrived = arrivals.get(id) ?? performance.now();
  const began = performance.now();
  const tracked = operations;
  const failure = serializeStorageError;
  let closeFinalizationAttempted = false;
  const post = (
    message: {
      id: number;
      result?: unknown;
      error?: StorageWorkerError;
    },
    finalized = closeFinalizationAttempted,
  ): void => {
    try {
      if (tracked) disposeArtifactVerification(tracked, id);
    } catch (error) {
      message = {
        id,
        error: failure(
          message.error
            ? new AggregateError(
                [deserializeStorageError(message.error), error],
                'Artifact verification and reader cleanup failed.',
                { cause: deserializeStorageError(message.error) },
              )
            : error,
        ),
      };
    }
    if (!finalized) {
      try {
        (operations ?? tracked)?.releaseStatements();
      } catch (error) {
        // Cleanup failure is a real failed ACK, even when the business transaction
        // committed. Never finalize a second time here or retry that transaction.
        message = {
          id,
          error: failure(
            message.error
              ? new AggregateError(
                  [deserializeStorageError(message.error), error],
                  'Database operation and statement cleanup failed.',
                  { cause: deserializeStorageError(message.error) },
                )
              : error,
          ),
        };
      }
    }
    if (method !== 'close') {
      try {
        (operations ?? tracked)?.assertRequestSettled(
          message.error ? deserializeStorageError(message.error) : undefined,
        );
      } catch (error) {
        if (!message.error) message = { id, error: failure(error) };
      }
    }
    arrivals.delete(id);
    const timing: DbTiming = {
      operation: method,
      requestId: id,
      queueWaitMs: began - arrived,
      ...(method === 'open' ? {} : (tracked?.getTiming() ?? {})),
      totalMs: performance.now() - arrived,
      outcome: message.error ? 'failed' : 'succeeded',
    };
    self.postMessage({ ...message, timing });
  };
  try {
    if (method === 'close') tracked?.resetTiming();
    else tracked?.beginRequest(id);
    if (method === 'open') {
      const input = args[0] as {
        access: ProfileAccess;
        readOnly: boolean;
        engine: SqliteEngineSelection | null;
      };
      if (input.engine === undefined) throw new AgentError('sqlite_engine_selection_invalid');
      if (input.engine) assertSelectedSqliteEngine(input.engine);
      operations = new SqliteOperations(
        openDatabase(input.access, input.readOnly, input.engine),
        input.readOnly,
      );
      // Live requests yield between short native waits. Startup retains its own
      // bounded format/initialization checks before any request is admitted.
      if (!input.readOnly) operations.db.run('PRAGMA busy_timeout=25');
      post({ id, result: operations.metadata() });
      return;
    }
    if (!operations) throw new AgentError('store_not_open');
    let result: unknown;
    if (method === 'close') {
      // Release outstanding prepared statements and the SQLite handle before close ACK.
      // close(false) can leave a zombie connection until Worker garbage collection.
      closeFinalizationAttempted = true;
      operations.releaseStatements();
      operations.db.close(true);
      operations = undefined;
      result = null;
    } else if (method === 'getRecoveryReceipt') result = getRecoveryReceipt(operations, args[0]);
    else if (method === 'readRecoveryToolHistory')
      result = readRecoveryToolHistory(operations, args[0]);
    else if (method === 'acquireSessionOwner')
      result = operations.tx(() => {
        const sessionId = String(args[0]);
        const instanceId = String(args[1]);
        const session = operations!.row('SELECT * FROM session WHERE id=?', sessionId);
        if (!session || session.delete_requested) throw new AgentError('session_not_found');
        if (session.parent_id !== null) throw new AgentError('group_root_required');
        if (hasUnsettledOwnerGroup(operations!, sessionId, operations!.metadata().storeId))
          throw new AgentError('recovery_required');
        if (BigInt(session.owner_generation!) >= 9223372036854775807n)
          throw new AgentError('sequence_exhausted');
        operations!.run(
          'UPDATE session SET owner_generation=owner_generation+1,owner_instance=? WHERE id=?',
          instanceId,
          sessionId,
        );
        const updated = operations!.row(
          'SELECT owner_generation FROM session WHERE id=?',
          sessionId,
        )!;
        return { sessionId, instanceId, generation: String(updated.owner_generation) };
      });
    else if (method === 'inspectOwnerDispatch')
      result = operations.tx(() => {
        const input = args[0] as Parameters<import('../port').Store['inspectOwnerDispatch']>[0];
        operations!.identity(input.expectedStoreId);
        operations!.owner(input.owner, input.sessionId);
        const root = input.owner.sessionId;
        const hasUnsettledWork = hasUnsettledOwnerGroup(operations!, root, input.expectedStoreId);
        const hasPendingCommands = !!operations!.row(
          `SELECT id FROM command WHERE session_id=? AND status='accepted' AND kind NOT IN('job.reconcile','run.resume') AND ${runnableCommandPredicate()} LIMIT 1`,
          input.sessionId,
        );
        // A detached Job is not the ordinary Action's primary receipt Execution.
        // Only actual current-owner identity can establish this submission boundary.
        const hasUncommittedAction = !!operations!.row(
          `SELECT e.id FROM command c JOIN execution e
          ON e.id=json_extract(c.receipt_json,'$.executionId')
          WHERE c.session_id=? AND c.kind='extension.invoke' AND c.status='applied'
          AND c.origin_store_id=? AND e.origin_store_id=c.origin_store_id
          AND e.origin_command_id=c.id AND e.session_id=c.session_id
          AND e.root_session_id=? AND e.owner_generation=?
          AND e.root_work_command_id=c.root_work_command_id AND e.root_work_seq=c.root_work_seq
          AND e.kind='job' AND e.run_id IS NULL AND e.state IN('planned','dispatching','running')
          AND json_extract(c.request_json,'$.kind')=c.kind
          AND e.adapter_id=json_extract(c.request_json,'$.extensionId') || '/' || json_extract(c.request_json,'$.actionId')
          AND e.definition_version=json_extract(c.request_json,'$.definitionVersion') LIMIT 1`,
          input.sessionId,
          input.expectedStoreId,
          root,
          input.owner.generation,
        );
        return { hasPendingCommands, hasUnsettledWork, hasUncommittedAction };
      });
    else if (method === 'releaseSessionOwner')
      result = operations.tx(() => {
        const owner = args[0] as OwnerRef;
        operations!.owner(owner);
        if (
          hasUnsettledOwnerGroup(operations!, owner.sessionId, operations!.metadata().storeId) ||
          operations!.row(
            `SELECT id FROM command WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND status='accepted' AND kind NOT IN('job.reconcile','run.resume') AND ${runnableCommandPredicate()}`,
            owner.sessionId,
          )
        )
          return false;
        operations!.run('UPDATE session SET owner_instance=NULL WHERE id=?', owner.sessionId);
        return true;
      });
    else result = operations.call(method, args);
    if (method !== 'close') operations?.assertRequestSettled();
    post({ id, result });
  } catch (error) {
    if (error instanceof ArtifactVerificationPending) {
      try {
        operations!.releaseStatements();
        operations!.assertRequestSettled();
      } catch (cleanup) {
        post({ id, error: failure(cleanup) }, true);
        return;
      }
      queue.deferArtifactVerification(request);
      return;
    }
    if (error instanceof UnstartedSqliteWrite) {
      // No callback, SQL commit, adapter or external effect has run. Keep the exact
      // request ID and admission slot; other queue categories may continue observing.
      try {
        operations!.releaseStatements();
      } catch (cleanup) {
        post({ id, error: failure(cleanup) }, true);
        return;
      }
      queue.deferUnstartedWrite(request);
      return;
    }
    let rejected = error;
    if (method !== 'close') {
      try {
        (operations ?? tracked)?.assertRequestSettled(error);
      } catch (unsettled) {
        rejected = unsettled;
      }
    }
    post({
      id,
      error: failure(rejected),
    });
  }
}
