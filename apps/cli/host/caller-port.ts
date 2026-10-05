import type { AgentClient, Command } from '@kite-ai/client';
import type {
  TuiCallerIntent,
  TuiCallerOutcome,
  TuiCallerPort,
  TuiDraftPort,
} from '@kite-ai/ui/tui';
import {
  callerDigest,
  callerRequestDigest,
  callerTarget,
  callerTextDigest,
  freezeCaller,
  parseCallerIntent,
} from './caller-intents';
import type { openCallerJournal } from './caller-journal';

/** Missing or mismatched public authority metadata never confirms an original caller. */
async function checked(
  intent: TuiCallerIntent,
  command: Command,
  client: AgentClient,
  signal?: AbortSignal,
  admit: () => void = () => {},
): Promise<TuiCallerOutcome> {
  const facts = command as Command & { requestDigest?: string; subjectId?: string | null };
  if (
    command.id !== intent.request.commandId ||
    command.originStoreId !== intent.scope.storeId ||
    command.sessionId !== intent.scope.sessionId ||
    command.kind !== intent.request.kind ||
    facts.requestDigest !== intent.requestDigest ||
    !Object.hasOwn(facts, 'subjectId')
  )
    throw Error('caller_receipt_unavailable');
  if (facts.subjectId !== intent.subjectId) throw Error('caller_receipt_identity_mismatch');
  admit();
  const view = await client.getView(intent.scope.sessionId, { signal });
  if (
    view.storeId !== intent.scope.storeId ||
    view.session.id !== intent.scope.sessionId ||
    view.session.workspaceId !== intent.scope.workspaceId
  )
    throw Error('caller_receipt_identity_mismatch');
  if (command.status === 'needs_review') return { intent, phase: 'unknown' };
  if (command.status === 'rejected') return { intent, phase: 'rejected', command };
  if (command.status === 'accepted') return { intent, phase: 'accepted', command };
  const receipt = command.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    throw Error('caller_receipt_unavailable');
  if (
    intent.request.kind === 'execution.cancel' &&
    (receipt.kind !== 'execution.cancel' ||
      receipt.executionId !== intent.request.executionId ||
      receipt.outcome !== 'cancel_requested')
  )
    throw Error('caller_receipt_identity_mismatch');
  if (
    intent.request.kind === 'command.cancel' &&
    (receipt.kind !== 'command.cancel' ||
      receipt.targetCommandId !== intent.request.targetCommandId ||
      receipt.outcome !== 'cancel_requested')
  )
    throw Error('caller_receipt_identity_mismatch');
  if (intent.request.kind === 'extension.invoke') {
    if (typeof receipt.executionId !== 'string' || receipt.preparingNextAttempt !== false)
      throw Error('caller_receipt_unavailable');
    admit();
    const execution = await client.getExecution(receipt.executionId, { signal });
    if (
      execution.id !== receipt.executionId ||
      execution.originStoreId !== intent.scope.storeId ||
      execution.sessionId !== intent.scope.sessionId ||
      execution.runId !== null ||
      execution.kind !== 'job' ||
      execution.definitionId !== `${intent.request.extensionId}/${intent.request.actionId}` ||
      execution.definitionVersion !== intent.request.definitionVersion
    )
      throw Error('caller_receipt_identity_mismatch');
    // Command applied is not a credential/result proof, even for a terminal Execution.
  }
  if (['run.start', 'input.steer', 'input.follow_up'].includes(intent.request.kind)) {
    if (typeof receipt.runId !== 'string') throw Error('caller_receipt_identity_mismatch');
    admit();
    const run = await client.getRun(receipt.runId, { signal });
    if (
      run.id !== receipt.runId ||
      run.originStoreId !== intent.scope.storeId ||
      run.sessionId !== intent.scope.sessionId
    )
      throw Error('caller_receipt_identity_mismatch');
    if (intent.request.kind === 'input.steer') {
      if (
        run.id !== intent.request.targetRunId ||
        receipt.contextSelectionId !== intent.request.contextSelectionId
      )
        throw Error('caller_receipt_identity_mismatch');
    } else if (run.originCommandId !== intent.request.commandId)
      throw Error('caller_receipt_identity_mismatch');
  }
  return { intent, phase: 'applied', command };
}
export function createTuiCallerPort(input: {
  client: AgentClient;
  storeId: string;
  journal: ReturnType<typeof openCallerJournal>;
  drafts?: TuiDraftPort;
  signal?: AbortSignal;
}): TuiCallerPort {
  const first = new WeakSet<TuiCallerIntent>();
  const admit = (intent: TuiCallerIntent) => {
    const info = input.client.serverInfo;
    if (
      !info ||
      info.storeId !== input.storeId ||
      intent.scope.storeId !== info.storeId ||
      intent.request.expectedStoreId !== info.storeId ||
      info.subjectId !== intent.subjectId
    )
      throw Error('caller_receipt_identity_mismatch');
  };
  const lookup = async (
    intent: TuiCallerIntent,
    signal?: AbortSignal,
  ): Promise<TuiCallerOutcome> => {
    const original = freezeCaller(parseCallerIntent(intent));
    try {
      admit(original);
      const result = await checked(
        original,
        await input.client.getCommand(original.request.commandId, { signal }),
        input.client,
        signal,
        () => admit(original),
      );
      admit(original);
      signal?.throwIfAborted();
      input.journal.record(original, result.phase);
      return result;
    } catch {
      return { intent: original, phase: 'unknown' };
    }
  };
  return {
    async list() {
      return input.journal.list().map((row) => ({
        intent: freezeCaller(row.intent),
        phase: ['applied', 'rejected'].includes(row.phase) ? row.phase : 'unknown',
      }));
    },
    async prepare(scope, rawRequest) {
      // Match the public validated wire body: optional undefined fields are omitted by JSON.
      const requestDigest = callerRequestDigest(rawRequest);
      const request = JSON.parse(JSON.stringify(rawRequest)) as typeof rawRequest;
      const candidate = freezeCaller(
        parseCallerIntent({
          scope,
          request,
          target: callerTarget(scope, request),
          subjectId: input.client.serverInfo?.subjectId,
          bodyDigest: callerDigest(request),
          requestDigest,
        }),
      );
      admit(candidate);
      const existing = input.journal
        .list()
        .find((row) => row.intent.request.commandId === request.commandId);
      if (existing) {
        const { draft: _draft, ...old } = existing.intent;
        if (callerDigest(old) !== callerDigest(candidate)) throw Error('caller_intent_conflict');
        return freezeCaller(existing.intent);
      }
      let intent = candidate;
      if (input.drafts && ['run.start', 'input.steer', 'input.follow_up'].includes(request.kind)) {
        if (!input.drafts.flush()) throw Error('caller_draft_unavailable');
        const row = input.drafts
          .list()
          .find(
            (row) =>
              row.storeId === scope.storeId &&
              row.sessionId === scope.sessionId &&
              row.workspaceId === scope.workspaceId,
          );
        if (row) {
          const draft = await input.drafts.original(row.id);
          if (draft.association !== 'current') throw Error('caller_draft_unavailable');
          intent = freezeCaller(
            parseCallerIntent({
              ...candidate,
              draft: {
                id: draft.id,
                revision: draft.revision,
                textDigest: callerTextDigest(draft.text),
              },
            }),
          );
        }
      }
      admit(intent);
      const view = await input.client.getView(scope.sessionId, { signal: input.signal });
      if (
        scope.storeId !== input.storeId ||
        view.storeId !== scope.storeId ||
        view.session.id !== scope.sessionId ||
        view.session.workspaceId !== scope.workspaceId ||
        view.session.deletedAt !== null
      )
        throw Error('caller_scope_unavailable');
      if (request.kind === 'execution.cancel') {
        const job = await input.client.getExecution(request.executionId, { signal: input.signal });
        if (
          job.id !== request.executionId ||
          job.originStoreId !== scope.storeId ||
          job.sessionId !== scope.sessionId ||
          job.kind !== 'job' ||
          !['planned', 'dispatching', 'running'].includes(job.status) ||
          job.cancelRequestedAt !== null
        )
          throw Error('caller_job_scope_unavailable');
      }
      if (request.kind === 'command.cancel') {
        const target = await input.client.getCommand(request.targetCommandId, {
          signal: input.signal,
        });
        if (
          target.id !== request.targetCommandId ||
          target.originStoreId !== scope.storeId ||
          target.sessionId !== scope.sessionId
        )
          throw Error('caller_cancel_scope_unavailable');
      }
      if (input.journal.prepare(intent)) first.add(intent);
      return intent;
    },
    async submit(intent) {
      const original = freezeCaller(parseCallerIntent(intent));
      if (!first.has(intent)) return lookup(original);
      first.delete(intent);
      try {
        admit(original);
        const r = original.request,
          s = original.scope.sessionId;
        const command =
          r.kind === 'run.start'
            ? await input.client.startRun(s, r, { signal: input.signal })
            : r.kind === 'input.steer'
              ? await input.client.steer(s, r, { signal: input.signal })
              : r.kind === 'input.follow_up'
                ? await input.client.followUp(s, r, { signal: input.signal })
                : r.kind === 'command.cancel'
                  ? await input.client.cancelCommand(s, r, { signal: input.signal })
                  : r.kind === 'execution.cancel'
                    ? await input.client.cancelExecution(s, r, { signal: input.signal })
                    : await input.client.invokeExtension(s, r, { signal: input.signal });
        const result = await checked(original, command, input.client, input.signal, () =>
          admit(original),
        );
        admit(original);
        input.signal?.throwIfAborted();
        input.journal.record(original, result.phase);
        return result;
      } catch {
        try {
          input.journal.record(original, 'unknown');
        } catch {}
        return { intent: original, phase: 'unknown' };
      }
    },
    lookup: (intent, signal) => lookup(intent, signal),
    async clear(intent) {
      input.journal.clear(intent);
    },
  };
}

export class CLICallerPrepareError extends Error {
  readonly code = 'caller_prepare_unavailable';
  readonly notSubmitted = true;
  readonly reason: string;
  constructor(error: unknown) {
    super('caller_prepare_unavailable');
    this.reason =
      error instanceof Error &&
      [
        'caller_intent_limit',
        'caller_capacity_exceeded',
        'caller_journal_unavailable',
        'caller_scope_unavailable',
        'caller_cancel_scope_unavailable',
        'caller_job_scope_unavailable',
      ].includes(error.message)
        ? error.message
        : 'caller_prepare_unavailable';
  }
}
/** Ordinary CLI shares durable storage, without inventing a UI draft. */
export function createCLICallerPort(input: {
  client: AgentClient;
  storeId: string;
  journal: ReturnType<typeof openCallerJournal>;
  onPrepared?: (intent: TuiCallerIntent) => void;
}): NonNullable<import('../src').CLIOptions['caller']> {
  const port = createTuiCallerPort(input);
  const original = (sessionId: string, request: import('@kite-ai/client').CallerCommandRequest) => {
    callerRequestDigest(request);
    const row = input.journal
      .list()
      .find((row) => row.intent.request.commandId === request.commandId);
    if (
      !row ||
      row.intent.scope.sessionId !== sessionId ||
      row.intent.scope.storeId !== request.expectedStoreId ||
      row.intent.bodyDigest !== callerDigest(JSON.parse(JSON.stringify(request)))
    )
      throw Error('caller_original_unknown');
    return row.intent;
  };
  const command = (result: TuiCallerOutcome) => {
    if (!result.command || result.phase === 'unknown') throw Error('caller_original_unknown');
    return result.command;
  };
  return {
    async submit(sessionId, request, signal) {
      signal?.throwIfAborted();
      callerRequestDigest(request);
      // Existing IDs are never re-prepared against today's subject or scope.
      let rows: ReturnType<typeof input.journal.list>;
      try {
        rows = input.journal.list();
      } catch (error) {
        throw new CLICallerPrepareError(error);
      }
      const row = rows.find((row) => row.intent.request.commandId === request.commandId);
      if (row) {
        input.onPrepared?.(row.intent);
        return command(
          await port.lookup(original(sessionId, request), signal ?? new AbortController().signal),
        );
      }
      const submitting = createTuiCallerPort({ ...input, signal });
      let intent: TuiCallerIntent;
      try {
        const view = await input.client.getView(sessionId, { signal });
        intent = await submitting.prepare(
          { storeId: request.expectedStoreId, sessionId, workspaceId: view.session.workspaceId },
          request,
        );
        input.onPrepared?.(intent);
        signal?.throwIfAborted();
      } catch (error) {
        throw new CLICallerPrepareError(error);
      }
      return command(await submitting.submit(intent));
    },
    async lookup(sessionId, request, signal) {
      return command(
        await port.lookup(original(sessionId, request), signal ?? new AbortController().signal),
      );
    },
  };
}
