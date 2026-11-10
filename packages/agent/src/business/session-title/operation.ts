import type { Store } from '../../storage/port';
import {
  isStorageRequestSettled,
  isStorageTransactionUnconfirmed,
} from '../../storage/transaction-state';
import { AgentError, type CommandRecord, type OwnerRef } from '../../storage/types';
import { automaticTitleRecord, readAutomaticTitleAttempt } from './state';

/** Host-only coordination of one proven default naming Job. No new work is admitted here. */
export async function openAutomaticTitleOperation(options: {
  store: Store;
  jobExecutionId: string;
  sourceCommandId: string;
  owner: OwnerRef;
  signal: AbortSignal;
  checkpoint(): void;
  wait(cursor: string, signal: AbortSignal): Promise<unknown>;
}) {
  const { store, signal } = options;
  const job = await store.getExecution(options.jobExecutionId);
  if (!job) throw new AgentError('session_title_job_invalid');
  const base = {
    expectedStoreId: job.originStoreId,
    owner: options.owner,
    sessionId: job.sessionId,
    jobExecutionId: job.id,
  };
  let record = await store.getExtensionRecord({
    extensionId: automaticTitleRecord.extensionId,
    sessionId: job.sessionId,
    key: automaticTitleRecord.key,
  });
  const attempt = record && readAutomaticTitleAttempt(record.value);
  if (!record || attempt?.sourceCommandId !== options.sourceCommandId)
    throw new AgentError('session_title_source_invalid');
  // This transaction verifies the complete lifecycle Action -> detached operation lineage.
  record = await store.bindAutomaticSessionTitle({ ...base, expectedRevision: record.revision });
  const businessCommandId = (job.input as { commandId?: unknown } | null)?.commandId;
  if (typeof businessCommandId !== 'string') throw new AgentError('session_title_source_invalid');
  let runId: string | undefined;
  let publication: Parameters<Store['readAutomaticSessionTitlePublication']>[0] | undefined;
  const inspectPublication = async () => {
    if (!publication) throw new AgentError('session_title_publication_unavailable');
    const saved = await store.readAutomaticSessionTitlePublication(publication);
    const attempt = readAutomaticTitleAttempt(saved.record.value);
    if (!attempt) throw new AgentError('session_title_attempt_invalid');
    record = saved.record;
    return { saved, attempt };
  };
  const check = async () => {
    signal.throwIfAborted();
    options.checkpoint();
    const current = await store.getExecution(job.id);
    if (
      !current ||
      current.originStoreId !== base.expectedStoreId ||
      current.ownerGeneration !== options.owner.generation ||
      current.cancelRequestedAt !== null ||
      !['running', 'dispatching'].includes(current.status)
    )
      throw new AgentError('session_title_job_inactive');
  };
  const source = async () => {
    const command = await store.getCommand(businessCommandId);
    if (
      !command ||
      command.sessionId !== job.sessionId ||
      command.originStoreId !== base.expectedStoreId
    )
      throw new AgentError('session_title_source_invalid');
    return command;
  };
  const watch = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    for (;;) {
      await check();
      // Capture before reading facts: activation/settlement cannot fall between read and wait.
      const metadata = await store.getMetadata();
      if (metadata.storeId !== base.expectedStoreId) throw new AgentError('store_mismatch');
      const value = await read();
      if (value !== undefined) return value;
      await options.wait(metadata.lastChangeCursor, signal);
    }
  };
  const closedSource = (command: CommandRecord) =>
    command.cancelRequestedAt !== null || ['rejected', 'needs_review'].includes(command.status);
  return {
    async activated() {
      return watch(async () => {
        const command = await source();
        const session = await store.getSession(job.sessionId);
        if (!session || session.deletedAt !== null || closedSource(command)) return null;
        const candidate = (command.receipt as { runId?: unknown } | null)?.runId;
        if (typeof candidate !== 'string') return undefined;
        const run = await store.getRun(candidate);
        if (!run || run.originCommandId !== command.id || run.sessionId !== session.id)
          throw new AgentError('session_title_run_invalid');
        record = await store.bindAutomaticSessionTitle({
          ...base,
          expectedRevision: record!.revision,
          sourceRunId: run.id,
        });
        runId = run.id;
        if (!run.isActive && run.status !== 'completed') return null;
        const workspace = await store.getWorkspace(session.workspaceId);
        if (!workspace) throw new AgentError('session_title_scope_invalid');
        return { command, session, workspace, run };
      });
    },
    async settled() {
      if (!runId) throw new AgentError('session_title_run_invalid');
      return watch(async () => {
        const command = await source();
        const session = await store.getSession(job.sessionId);
        const run = await store.getRun(runId!);
        if (!run || !session || session.deletedAt !== null || closedSource(command)) return null;
        return run.isActive ? undefined : run;
      });
    },
    async close(reason: string) {
      // Cancellation closes publication while the original owner still supervises real resources.
      options.checkpoint();
      record = await store.closeAutomaticSessionTitle({
        ...base,
        expectedRevision: record!.revision,
        reason,
      });
    },
    async publish(modelExecutionId: string, title: string) {
      await check();
      publication = {
        expectedStoreId: base.expectedStoreId,
        sessionId: base.sessionId,
        jobExecutionId: base.jobExecutionId,
        modelExecutionId,
        title,
      };
      try {
        const result = await store.publishAutomaticSessionTitle({
          ...base,
          expectedRevision: record!.revision,
          modelExecutionId,
          title,
        });
        record = result.record;
        return result;
      } catch (error) {
        // Exactly one write was submitted. A pending original request is never replayed.
        for (;;) {
          const { saved, attempt } = await inspectPublication();
          if (attempt.publication !== 'pending') return saved;
          if (isStorageRequestSettled(error) && !isStorageTransactionUnconfirmed(error)) {
            // Scope/owner/integrity failures stay shared failures. A confirmed local
            // constraint abort or CAS race may retire this one unpublished attempt.
            if (
              !(error instanceof AgentError) ||
              !(
                /^SQLITE_CONSTRAINT(?:_|$)/.test(error.code) ||
                ['record_revision_conflict', 'session_title_run_not_complete'].includes(error.code)
              )
            )
              throw error;
            options.checkpoint();
            try {
              record = await store.closeAutomaticSessionTitle({
                ...base,
                expectedRevision: record!.revision,
                reason: 'title_publication_failed',
              });
            } catch (closeError) {
              const after = await inspectPublication();
              if (after.attempt.publication === 'pending') throw closeError;
              return after.saved;
            }
            return (await inspectPublication()).saved;
          }
          const cursor = (await store.getMetadata()).lastChangeCursor;
          // Read again after the cursor capture so a late original commit cannot be lost.
          const afterCursor = await inspectPublication();
          if (afterCursor.attempt.publication !== 'pending') return afterCursor.saved;
          try {
            await options.wait(cursor, signal);
          } catch (waitError) {
            if (signal.aborted) throw new AgentError('session_title_publication_unconfirmed');
            throw waitError;
          }
        }
      }
    },
    async publicationSettled() {
      return (await inspectPublication()).attempt.publication !== 'pending';
    },
  };
}
