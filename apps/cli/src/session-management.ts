import {
  type AgentClient,
  ClientError,
  type Command,
  type CompressContextRequest,
  type DeleteSessionRequest,
  type ForkSessionRequest,
  type RenameSessionRequest,
  type ResetCompressionRequest,
} from '@kite-ai/client';

export type ManagementIntent =
  | { kind: 'session.rename'; sessionId: string; request: RenameSessionRequest }
  | { kind: 'session.delete'; sessionId: string; request: DeleteSessionRequest }
  | { kind: 'session.fork'; sessionId: string; request: ForkSessionRequest }
  | { kind: 'context.compress'; sessionId: string; request: CompressContextRequest }
  | { kind: 'context.compression.reset'; sessionId: string; request: ResetCompressionRequest };
export interface ManagementOutcome {
  readonly intent: ManagementIntent;
  readonly status: 'applied' | 'accepted' | 'delete_requested' | 'failed' | 'outcome_unknown';
  readonly command?: Command;
  readonly exitCode: number;
  readonly omittedExtensionState?: true;
}
interface Options {
  client: AgentClient;
  write(line: string): void;
  signal?: AbortSignal;
}
function freezeIntent<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const part of Object.values(value)) freezeIntent(part);
    Object.freeze(value);
  }
  return value;
}
const journals = new WeakMap<
  AgentClient,
  Map<string, { digest: string; promise: Promise<ManagementOutcome> }>
>();
function forkReport(
  receipt: { omittedExtensionState?: unknown; namespaceReport?: unknown } | null,
): boolean {
  if (typeof receipt?.omittedExtensionState !== 'boolean') return false;
  if (receipt.namespaceReport === undefined) return receipt.omittedExtensionState === true;
  if (!Array.isArray(receipt.namespaceReport)) return false;
  const identities = new Set<string>();
  for (const row of receipt.namespaceReport) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !==
        'contentType,contentVersion,copied,extensionId,mode,omitted,rebuilt,ruleVersion' ||
      typeof row.extensionId !== 'string' ||
      typeof row.contentType !== 'string' ||
      !Number.isSafeInteger(row.contentVersion) ||
      row.contentVersion < 1 ||
      !['copy', 'rebuild', 'omit'].includes(row.mode) ||
      !(row.ruleVersion === null || typeof row.ruleVersion === 'string') ||
      ['copied', 'rebuilt', 'omitted'].some(
        (key) => !Number.isSafeInteger(row[key]) || row[key] < 0,
      )
    )
      return false;
    const identity = `${row.extensionId}/${row.contentType}/${row.contentVersion}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return receipt.omittedExtensionState === receipt.namespaceReport.some((row) => row.omitted > 0);
}
function outcome(intent: ManagementIntent, command: Command): ManagementOutcome {
  const expectedSession =
    intent.kind === 'session.fork' ? intent.request.newSessionId : intent.sessionId;
  const expectedKind = intent.kind === 'session.fork' ? 'session.create' : intent.kind;
  const receipt = command.receipt as {
    sourceSessionId?: string;
    sourceSelectionId?: string;
    sessionId?: string;
    outcome?: string;
    omittedExtensionState?: boolean;
    sourceUpperSeq?: string;
    namespaceReport?: unknown;
    stopConfirmed?: boolean;
    session?: { id?: string; title?: string; controlRevision?: string; deletedAt?: number | null };
  } | null;
  const exact =
    command.id === intent.request.commandId &&
    command.originStoreId === intent.request.expectedStoreId &&
    command.sessionId === expectedSession &&
    command.kind === expectedKind;
  const forkExact =
    intent.kind !== 'session.fork' ||
    (receipt?.sourceSessionId === intent.sessionId &&
      receipt.sourceSelectionId === intent.request.expectedContextSelectionId &&
      receipt.sessionId === intent.request.newSessionId &&
      forkReport(receipt) &&
      (intent.request.boundary === undefined ||
        receipt.sourceUpperSeq === (intent.request.boundary?.seq ?? '0')));
  const mutationExact =
    command.status !== 'applied' ||
    (intent.kind === 'session.rename'
      ? receipt?.outcome === 'renamed' &&
        receipt.session?.id === intent.sessionId &&
        receipt.session.title === intent.request.title &&
        receipt.session.controlRevision === String(BigInt(intent.request.ifRevision) + 1n)
      : intent.kind === 'session.delete'
        ? receipt?.outcome === 'delete_requested' &&
          receipt.stopConfirmed === false &&
          receipt.session?.id === intent.sessionId &&
          receipt.session.controlRevision === String(BigInt(intent.request.ifRevision) + 1n) &&
          typeof receipt.session.deletedAt === 'number' &&
          receipt.session.deletedAt > 0
        : true);
  const status =
    !exact || !forkExact || !mutationExact
      ? 'outcome_unknown'
      : command.status === 'rejected'
        ? 'failed'
        : command.status === 'applied'
          ? intent.kind === 'session.delete' && receipt?.outcome === 'delete_requested'
            ? 'delete_requested'
            : 'applied'
          : command.status === 'accepted'
            ? 'accepted'
            : 'outcome_unknown';
  return {
    intent,
    status,
    command,
    exitCode: status === 'applied' ? 0 : status === 'failed' ? 1 : 2,
    ...(intent.kind === 'session.fork' &&
    status === 'applied' &&
    receipt?.omittedExtensionState === true
      ? { omittedExtensionState: true as const }
      : {}),
  };
}
async function refine(fact: ManagementOutcome, options: Options): Promise<ManagementOutcome> {
  if (
    (fact.intent.kind !== 'context.compress' && fact.intent.kind !== 'context.compression.reset') ||
    fact.status !== 'applied'
  )
    return fact;
  const receipt = fact.command?.receipt as { runId?: string } | null;
  if (!receipt?.runId) return { ...fact, status: 'outcome_unknown', exitCode: 2 };
  try {
    const run = await options.client.getRun(receipt.runId, { signal: options.signal });
    if (
      run.id !== receipt.runId ||
      run.sessionId !== fact.intent.sessionId ||
      run.originStoreId !== fact.intent.request.expectedStoreId ||
      run.originCommandId !== fact.intent.request.commandId
    )
      return { ...fact, status: 'outcome_unknown', exitCode: 2 };
    const status =
      run.status === 'completed'
        ? 'applied'
        : run.status === 'failed' || run.status === 'cancelled'
          ? 'failed'
          : run.status === 'interrupted'
            ? 'outcome_unknown'
            : 'accepted';
    return { ...fact, status, exitCode: status === 'applied' ? 0 : status === 'failed' ? 1 : 2 };
  } catch {
    return { ...fact, status: 'outcome_unknown', exitCode: 2 };
  }
}
/** Read the original saved identity; never rebind or repeat the mutation. */
export async function lookupManagementOutcome(
  saved: ManagementIntent,
  options: Options,
): Promise<ManagementOutcome> {
  const intent = freezeIntent(structuredClone(saved));
  try {
    return refine(
      outcome(
        intent,
        await options.client.getCommand(intent.request.commandId, { signal: options.signal }),
      ),
      options,
    );
  } catch {
    return { intent, status: 'outcome_unknown', exitCode: 2 };
  }
}
export function submitManagement(
  saved: ManagementIntent,
  options: Options,
): Promise<ManagementOutcome> {
  const intent = freezeIntent(structuredClone(saved)),
    digest = JSON.stringify(intent);
  let entries = journals.get(options.client);
  if (!entries) {
    entries = new Map();
    journals.set(options.client, entries);
  }
  const prior = entries.get(intent.request.commandId);
  if (prior) {
    if (prior.digest !== digest) return Promise.reject(new ClientError('command_conflict'));
    return prior.promise;
  }
  if (entries.size >= 128) return Promise.reject(new ClientError('management_intent_limit'));
  const promise = Promise.resolve().then(async () => {
    options.write(`management intent saved ${intent.request.commandId} ${intent.kind}`);
    try {
      const result =
        intent.kind === 'session.rename'
          ? await options.client.renameSession(intent.sessionId, intent.request, {
              signal: options.signal,
            })
          : intent.kind === 'session.delete'
            ? await options.client.deleteSession(intent.sessionId, intent.request, {
                signal: options.signal,
              })
            : intent.kind === 'session.fork'
              ? await options.client.forkSession(intent.sessionId, intent.request, {
                  signal: options.signal,
                })
              : intent.kind === 'context.compress'
                ? await options.client.compressContext(intent.sessionId, intent.request, {
                    signal: options.signal,
                  })
                : await options.client.resetCompressionContext(intent.sessionId, intent.request, {
                    signal: options.signal,
                  });
      const fact = await refine(
        outcome(intent, 'command' in result ? result.command : result),
        options,
      );
      options.write(`management ${fact.status} ${intent.request.commandId}`);
      return fact;
    } catch (error) {
      if (
        error instanceof ClientError &&
        (error.code === 'invalid_request' ||
          error.code === 'connection_not_admitted' ||
          error.code === 'capability_unavailable' ||
          error.code === 'store_identity_mismatch' ||
          (error.problem &&
            error.status &&
            [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)))
      )
        return { intent, status: 'failed' as const, exitCode: 1 };
      return lookupManagementOutcome(intent, options);
    }
  });
  entries.set(intent.request.commandId, { digest, promise });
  return promise;
}
export const renameSession = (sessionId: string, request: RenameSessionRequest, options: Options) =>
  submitManagement({ kind: 'session.rename', sessionId, request }, options);
export const deleteSession = (sessionId: string, request: DeleteSessionRequest, options: Options) =>
  submitManagement({ kind: 'session.delete', sessionId, request }, options);
export const forkSession = (sessionId: string, request: ForkSessionRequest, options: Options) =>
  submitManagement({ kind: 'session.fork', sessionId, request }, options);
export const compressContext = (
  sessionId: string,
  request: CompressContextRequest,
  options: Options,
) => submitManagement({ kind: 'context.compress', sessionId, request }, options);
export const resetCompressionContext = (
  sessionId: string,
  request: ResetCompressionRequest,
  options: Options,
) => submitManagement({ kind: 'context.compression.reset', sessionId, request }, options);
