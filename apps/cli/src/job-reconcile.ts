import {
  type AgentClient,
  ClientError,
  decodeJobReconcileCommand,
  type JobReconcileCommand,
  type ReconcileJobRequest,
} from '@kite-ai/client';

export interface JobReconcileIntent {
  sessionId: string;
  request: ReconcileJobRequest;
}
export interface JobReconcileOutcome {
  intent: JobReconcileIntent;
  status: 'verified' | 'unresolved' | 'outcome_unknown' | 'failed';
  exitCode: 0 | 1 | 2;
  command?: JobReconcileCommand;
}
interface Options {
  client: AgentClient;
  write(line: string): void;
  signal?: AbortSignal;
}
const journals = new WeakMap<
  AgentClient,
  Map<string, { digest: string; promise: Promise<JobReconcileOutcome> }>
>();
function seal(input: JobReconcileIntent): JobReconcileIntent {
  const copy = structuredClone(input);
  Object.freeze(copy.request);
  return Object.freeze(copy);
}
function fact(intent: JobReconcileIntent, value: unknown): JobReconcileOutcome {
  try {
    const command = decodeJobReconcileCommand(value);
    const request = intent.request;
    if (
      command.id !== request.commandId ||
      command.sessionId !== intent.sessionId ||
      command.originStoreId !== request.expectedStoreId ||
      command.kind !== 'job.reconcile' ||
      (command.receipt !== null &&
        (command.receipt.executionId !== request.executionId ||
          command.receipt.resultRevision !== request.expectedResultRevision))
    )
      throw new ClientError('invalid_response');
    if (command.status === 'applied' && command.receipt) {
      const status = command.receipt.outcome;
      return { intent, command, status, exitCode: status === 'verified' ? 0 : 2 };
    }
    return { intent, command, status: 'outcome_unknown', exitCode: 2 };
  } catch {
    return { intent, status: 'outcome_unknown', exitCode: 2 };
  }
}

/** The only follow-up to an uncertain POST is a read of its original Command. */
export async function lookupJobReconcile(
  input: JobReconcileIntent,
  options: Options,
): Promise<JobReconcileOutcome> {
  const intent = seal(input);
  try {
    return fact(
      intent,
      await options.client.getCommand(intent.request.commandId, { signal: options.signal }),
    );
  } catch {
    return { intent, status: 'outcome_unknown', exitCode: 2 };
  }
}

export function reconcileJob(
  input: JobReconcileIntent,
  options: Options,
): Promise<JobReconcileOutcome> {
  const intent = seal(input);
  const digest = JSON.stringify([
    intent.sessionId,
    intent.request.kind,
    intent.request.expectedStoreId,
    intent.request.commandId,
    intent.request.executionId,
    intent.request.expectedResultRevision,
  ]);
  let entries = journals.get(options.client);
  if (!entries) {
    entries = new Map();
    journals.set(options.client, entries);
  }
  const previous = entries.get(intent.request.commandId);
  if (previous) {
    if (previous.digest !== digest) return Promise.reject(new ClientError('command_conflict'));
    return previous.promise;
  }
  if (entries.size >= 128) return Promise.reject(new ClientError('reconcile_intent_limit'));
  const promise = Promise.resolve().then(async (): Promise<JobReconcileOutcome> => {
    options.write(JSON.stringify({ kind: 'job.reconcile.intent', ...intent }));
    try {
      return fact(
        intent,
        await options.client.reconcileJob(intent.sessionId, intent.request, {
          signal: options.signal,
        }),
      );
    } catch (error) {
      if (
        error instanceof ClientError &&
        ([
          'invalid_request',
          'connection_not_admitted',
          'capability_unavailable',
          'store_identity_mismatch',
        ].includes(error.code) ||
          (error.problem &&
            error.status &&
            [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)))
      )
        return { intent, status: 'failed', exitCode: 1 };
      return lookupJobReconcile(intent, options);
    }
  });
  entries.set(intent.request.commandId, { digest, promise });
  return promise;
}
