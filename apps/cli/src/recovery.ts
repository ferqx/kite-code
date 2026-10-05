import {
  type AgentClient,
  ClientError,
  type Command,
  decodeJobReportResumeCommand,
  decodeRunResumeCommand,
  decodeSessionRecoveryCommand,
  type RecoverSessionRequest,
  type ResumeJobReportRequest,
  type ResumeRunRequest,
  type Run,
  validateRequest,
} from '@kite-ai/client';

export type RecoveryIntent =
  | { kind: 'interrupt'; sessionId: string; request: RecoverSessionRequest }
  | { kind: 'run'; sessionId: string; request: ResumeRunRequest }
  | {
      kind: 'report';
      sessionId: string;
      reportCommandId: string;
      request: ResumeJobReportRequest;
    };
export interface RecoveryOutcome {
  intent: RecoveryIntent;
  status: 'accepted' | 'resumed' | 'interrupted' | 'suppressed' | 'failed' | 'outcome_unknown';
  exitCode: 0 | 1 | 2;
  command?: Command;
  run?: Run;
  error?: string;
}
export type RecoveryPhase = RecoveryOutcome['status'] | 'submitting';
export interface RecoveryJournal {
  prepare(intent: RecoveryIntent): boolean;
  record(intent: RecoveryIntent, phase: RecoveryPhase): void;
}
export function parseRecoveryIntent(value: unknown): RecoveryIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ClientError('invalid_recovery_intent');
  const raw = value as Record<string, unknown>;
  const keys =
    raw.kind === 'report'
      ? ['kind', 'sessionId', 'reportCommandId', 'request']
      : ['kind', 'sessionId', 'request'];
  if (
    !['run', 'report', 'interrupt'].includes(String(raw.kind)) ||
    Object.keys(raw).sort().join(',') !== keys.sort().join(',') ||
    typeof raw.sessionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.sessionId) ||
    (raw.kind === 'report' &&
      (typeof raw.reportCommandId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(raw.reportCommandId)))
  )
    throw new ClientError('invalid_recovery_intent');
  validateRequest(
    raw.kind === 'run'
      ? 'ResumeRunRequest'
      : raw.kind === 'report'
        ? 'ResumeJobReportRequest'
        : 'RecoverSessionRequest',
    raw.request,
  );
  return seal(raw as RecoveryIntent);
}
interface Options {
  client: AgentClient;
  signal?: AbortSignal;
  journal?: RecoveryJournal;
  waitForRun?: boolean;
  write?(line: string): void;
}
const journals = new WeakMap<
  AgentClient,
  Map<string, { digest: string; promise: Promise<RecoveryOutcome> }>
>();
function seal(input: RecoveryIntent): RecoveryIntent {
  const copy = structuredClone(input);
  Object.freeze(copy.request);
  return Object.freeze(copy);
}
function sameScope(intent: RecoveryIntent, fact: { originStoreId: string; sessionId: string }) {
  return (
    fact.originStoreId === intent.request.expectedStoreId && fact.sessionId === intent.sessionId
  );
}
async function outcome(
  intent: RecoveryIntent,
  command: Command,
  options: Options,
): Promise<RecoveryOutcome> {
  if (
    command.id !== intent.request.commandId ||
    !sameScope(intent, command) ||
    command.kind !==
      (intent.kind === 'run'
        ? 'run.resume'
        : intent.kind === 'report'
          ? 'job.report.resume'
          : 'session.recover')
  )
    throw new ClientError('invalid_response');
  if (command.status === 'rejected' || command.status === 'needs_review')
    return { intent, command, status: 'failed', exitCode: 1 };
  if (intent.kind === 'interrupt') {
    const checked = decodeSessionRecoveryCommand(command);
    if (
      checked.receipt.sessionId !== intent.sessionId ||
      checked.receipt.storeId !== intent.request.expectedStoreId
    )
      throw new ClientError('invalid_response');
    return {
      intent,
      command,
      status: 'interrupted',
      exitCode: checked.receipt.unknownExecutionIds.length ? 2 : 0,
    };
  }
  let runId: string;
  let originalCommandId: string | undefined;
  if (intent.kind === 'run') {
    const checked = decodeRunResumeCommand(command);
    if (checked.status === 'accepted') return { intent, command, status: 'accepted', exitCode: 2 };
    if (checked.receipt.runId !== intent.request.runId) throw new ClientError('invalid_response');
    runId = checked.receipt.runId;
    originalCommandId = checked.receipt.originalCommandId;
  } else {
    const checked = decodeJobReportResumeCommand(command),
      receipt = checked.receipt;
    if (receipt.reportCommandId !== intent.reportCommandId)
      throw new ClientError('invalid_response');
    if (receipt.outcome === 'report_suppressed')
      return { intent, command, status: 'suppressed', exitCode: 1 };
    runId = receipt.runId;
    originalCommandId = intent.reportCommandId;
  }
  let run = await options.client.getRun(runId, { signal: options.signal });
  const verifyRun = () => {
    if (
      !sameScope(intent, run) ||
      run.id !== runId ||
      (originalCommandId !== undefined && run.originCommandId !== originalCommandId)
    )
      throw new ClientError('invalid_response');
  };
  verifyRun();
  while (options.waitForRun && run.isActive && run.status !== 'waiting_interaction') {
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        reject(options.signal?.reason ?? Error('recovery_wait_cancelled'));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      }, 250);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    run = await options.client.getRun(runId, { signal: options.signal });
    verifyRun();
  }
  return {
    intent,
    command,
    run,
    status: 'resumed',
    exitCode:
      run.status === 'completed'
        ? 0
        : ['failed', 'cancelled', 'interrupted'].includes(run.status)
          ? 1
          : 2,
  };
}

/** Reads only the saved recovery command; a selected view never changes this target. */
export async function lookupRecovery(
  input: RecoveryIntent,
  options: Options,
): Promise<RecoveryOutcome> {
  const intent = seal(input);
  try {
    const result = await outcome(
      intent,
      await options.client.getCommand(intent.request.commandId, { signal: options.signal }),
      options,
    );
    options.journal?.record(intent, result.status);
    return result;
  } catch {
    return { intent, status: 'outcome_unknown', exitCode: 2 };
  }
}

/** Exactly one explicit recovery mutation per frozen client intent. */
export function submitRecovery(input: RecoveryIntent, options: Options): Promise<RecoveryOutcome> {
  const intent = seal(input),
    digest = JSON.stringify(intent);
  let entries = journals.get(options.client);
  if (!entries) {
    entries = new Map();
    journals.set(options.client, entries);
  }
  const old = entries.get(intent.request.commandId);
  if (old) {
    if (old.digest !== digest) return Promise.reject(new ClientError('command_conflict'));
    return old.promise;
  }
  if (entries.size >= 128) return Promise.reject(new ClientError('recovery_intent_limit'));
  const promise = Promise.resolve().then(async (): Promise<RecoveryOutcome> => {
    options.write?.(JSON.stringify({ kind: 'recovery.intent', intent }));
    let submitted = false;
    try {
      options.signal?.throwIfAborted();
      if (options.journal && !options.journal.prepare(intent))
        return lookupRecovery(intent, options);
      const capability =
        intent.kind === 'run'
          ? 'run_resume'
          : intent.kind === 'report'
            ? 'job_report_resume'
            : 'session_recovery';
      if (!options.client.serverInfo?.capabilities.includes(capability))
        throw new ClientError('capability_unavailable');
      const original =
        intent.kind === 'interrupt'
          ? undefined
          : intent.kind === 'run'
            ? await options.client.getRun(intent.request.runId, { signal: options.signal })
            : await options.client.getCommand(intent.reportCommandId, { signal: options.signal });
      if (
        original &&
        (!sameScope(intent, original) ||
          original.id !==
            (intent.kind === 'run'
              ? intent.request.runId
              : intent.kind === 'report'
                ? intent.reportCommandId
                : '') ||
          (intent.kind === 'report' && (original as Command).kind !== 'job.report'))
      )
        throw new ClientError('recovery_scope_unavailable');
      options.signal?.throwIfAborted();
      submitted = true;
      const command =
        intent.kind === 'interrupt'
          ? await options.client.recoverSession(intent.sessionId, intent.request, {
              signal: options.signal,
            })
          : intent.kind === 'run'
            ? await options.client.resumeRun(intent.sessionId, intent.request, {
                signal: options.signal,
              })
            : await options.client.resumeJobReport(
                intent.sessionId,
                intent.reportCommandId,
                intent.request,
                { signal: options.signal },
              );
      const result = await outcome(intent, command, options);
      options.journal?.record(intent, result.status);
      return result;
    } catch (error) {
      if (
        !submitted ||
        (error instanceof ClientError &&
          error.problem &&
          error.status &&
          [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status))
      ) {
        try {
          options.journal?.record(intent, 'failed');
        } catch {}
        return {
          intent,
          status: 'failed',
          exitCode: 1,
          error:
            error instanceof ClientError
              ? error.code
              : error instanceof Error &&
                  [
                    'recovery_intent_limit',
                    'recovery_intent_conflict',
                    'recovery_journal_unavailable',
                  ].includes(error.message)
                ? error.message
                : 'recovery_preparation_failed',
        };
      }
      return lookupRecovery(intent, options);
    }
  });
  entries.set(intent.request.commandId, { digest, promise });
  return promise;
}
