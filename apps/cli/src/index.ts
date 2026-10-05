import {
  type AgentClient,
  type AnswerInteractionRequest,
  type CallerCommandRequest,
  type ClearPermissionGrantsRequest,
  ClientError,
  type Command,
  type ContextQuery,
  canonicalCallerCommandRequest,
  type ExtensionCommandRequest,
  type FollowUpCommandRequest,
  type IncludeResultRequest,
  type Interaction,
  type Json,
  requiresInteractionAttachment,
  type SelectContextRequest,
  type SetPermissionModeRequest,
  type SetWorkspaceTrustRequest,
  type StartCommandRequest,
} from '@kite-ai/client';
import { getContext, includeHistoricalResult, rewindContext } from './context';

import {
  clearPermissionGrants,
  getPermissionGrants,
  getPermissionMode,
  getWorkspaceTrust,
  setPermissionMode,
  setWorkspaceTrust,
} from './permissions';

export type { JobReconcileIntent, JobReconcileOutcome } from './job-reconcile';
export { lookupJobReconcile, reconcileJob } from './job-reconcile';
export type { RecoveryIntent, RecoveryOutcome } from './recovery';
export { lookupRecovery, submitRecovery } from './recovery';

export const EXIT = { success: 0, failed: 1, unknown: 2, waiting: 3, userCancelled: 130 } as const;
export interface CommandOutcome {
  readonly commandId: string;
  readonly status: 'succeeded' | 'failed' | 'outcome_unknown' | 'cancelled' | 'waiting_interaction';
  readonly interactions?: readonly Interaction[];
  readonly answerIntent?: {
    workCommandId: string;
    workSessionId: string;
    phase: 'unknown' | 'accepted' | 'rejected';
    presentationSessionId: string;
    interactionId: string;
    request: AnswerInteractionRequest;
  };
  /** True only after attempting the original cancellation request, including a lost receipt. */
  readonly cancellationAttempted?: true;
  readonly exitCode: number;
}
export interface CLIOptions {
  readonly client: AgentClient;
  /** Trusted host port: first durable write precedes POST; existing IDs are GET-only. */
  readonly caller?: {
    submit(
      sessionId: string,
      request: CallerCommandRequest,
      signal?: AbortSignal,
    ): Promise<Command>;
    lookup(
      sessionId: string,
      request: CallerCommandRequest,
      signal?: AbortSignal,
    ): Promise<Command>;
  };
  /** Saved original answer; unknown recovery queries this identity before observing work. */
  readonly answerIntent?: CommandOutcome['answerIntent'];
  /** Host opt-in; noninteractive execution never opens stdin implicitly. */
  readonly answerInteraction?: (
    interaction: Interaction,
    context: {
      signal: AbortSignal;
      completeAttachment?: {
        identity: string;
        text: string;
        reference: Awaited<ReturnType<AgentClient['readInteractionAttachment']>>['reference'];
      };
    },
  ) => Promise<NonNullable<Interaction['answer']> | undefined>;
  readonly write: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}
/** Only the trusted caller port can establish that this attempt never reached POST. */
function callerPrepareError(
  error: unknown,
): error is { code: 'caller_prepare_unavailable'; notSubmitted: true; reason: string } {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'caller_prepare_unavailable' &&
    'notSubmitted' in error &&
    error.notSubmitted === true &&
    'reason' in error &&
    typeof error.reason === 'string' &&
    /^[a-z_]{1,80}$/.test(error.reason)
  );
}
function receipt(command: Command): Record<string, Json> {
  return command.receipt && typeof command.receipt === 'object' && !Array.isArray(command.receipt)
    ? command.receipt
    : {};
}
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validPlanAnswer(
  interaction: Interaction,
  answer: NonNullable<Interaction['answer']>,
): boolean {
  if (answer.kind !== 'plan_review') return false;
  const request = interaction.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  if (
    ['planId', 'version', 'digest', 'content'].some(
      (key) => typeof request[key] !== 'string' || !request[key],
    )
  )
    return false;
  const modes = request.allowedModes;
  if (
    !Array.isArray(modes) ||
    !modes.length ||
    modes.some((mode) => mode !== 'auto' && mode !== 'accept_edits') ||
    new Set(modes).size !== modes.length
  )
    return false;
  if (
    answer.feedback !== undefined &&
    (typeof answer.feedback !== 'string' || answer.feedback.length > 8192)
  )
    return false;
  return answer.decision === 'approve'
    ? (answer.mode === 'auto' || answer.mode === 'accept_edits') && modes.includes(answer.mode)
    : answer.mode === undefined;
}

export interface RecoveryRunAnchor {
  expectedStoreId: string;
  commandId: string;
  runId: string;
  kind: Command['kind'];
}

/** A 202 is acceptance only. Read the original command and its actual terminal resource. */
async function execute(
  sessionId: string,
  intent:
    | StartCommandRequest
    | FollowUpCommandRequest
    | ExtensionCommandRequest
    | RecoveryRunAnchor,
  options: CLIOptions,
  submit = true,
  recoveryRun?: RecoveryRunAnchor,
): Promise<CommandOutcome> {
  const input = structuredClone(intent);
  const callerRequest =
    !recoveryRun &&
    'content' in input &&
    (input.kind === 'run.start' || input.kind === 'input.follow_up')
      ? input
      : undefined;
  const timeout = options.timeoutMs;
  const interval = options.pollIntervalMs ?? 50;
  if (
    (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) ||
    !Number.isSafeInteger(interval) ||
    interval < 0 ||
    interval > 60_000
  )
    throw new Error('invalid_wait_options');
  const deadline = timeout === undefined ? Infinity : Date.now() + timeout;
  const networkDeadline = new AbortController();
  const deadlineTimer =
    timeout === undefined
      ? undefined
      : setTimeout(() => networkDeadline.abort(new Error('wait_timeout')), timeout);
  const network = { signal: networkDeadline.signal };
  const durableCancel = (
    s: string,
    request: import('@kite-ai/client').CancelCommandRequest,
    n: { signal: AbortSignal },
  ) =>
    options.caller
      ? options.caller.submit(s, request, n.signal)
      : options.client.cancelCommand(s, request, n);
  let interrupted = options.signal?.aborted ?? false;
  const interrupt = () => {
    interrupted = true;
    if (recoveryRun)
      networkDeadline.abort(options.signal?.reason ?? Error('recovery_observation_cancelled'));
  };
  options.signal?.addEventListener('abort', interrupt);
  let cancellationSent = false;
  let answerIntent = options.answerIntent ? structuredClone(options.answerIntent) : undefined;
  const finish = (status: CommandOutcome['status']): CommandOutcome => {
    const exitCode =
      status === 'succeeded'
        ? EXIT.success
        : status === 'failed'
          ? EXIT.failed
          : status === 'cancelled'
            ? EXIT.userCancelled
            : EXIT.unknown;
    options.write(`terminal ${input.commandId} ${status}`);
    return {
      commandId: input.commandId,
      status,
      exitCode,
      ...(answerIntent ? { answerIntent: structuredClone(answerIntent) } : {}),
      ...(cancellationSent ? { cancellationAttempted: true as const } : {}),
    };
  };
  const attempted = new Set<string>();
  if (answerIntent && answerIntent.phase !== 'rejected')
    attempted.add(
      `${answerIntent.request.expectedStoreId}/${answerIntent.interactionId}/${answerIntent.request.expectedRevision}`,
    );
  const validAnswerReceipt = (saved: Command) => {
    const result = receipt(saved);
    return Boolean(
      answerIntent &&
        saved.id === answerIntent.request.commandId &&
        saved.originStoreId === answerIntent.request.expectedStoreId &&
        saved.sessionId === answerIntent.presentationSessionId &&
        saved.kind === 'interaction.answer' &&
        saved.status === 'applied' &&
        result.outcome === 'answer_saved' &&
        result.interactionId === answerIntent.interactionId &&
        /^(0|[1-9][0-9]*)$/.test(answerIntent.request.expectedRevision) &&
        result.decisionRevision === (BigInt(answerIntent.request.expectedRevision) + 1n).toString(),
    );
  };
  const waiting = (interactions: readonly Interaction[]): CommandOutcome => {
    options.write(
      `waiting ${input.commandId} ${interactions.map((value) => `${value.kind}:${value.id}`).join(' ')}`,
    );
    return {
      commandId: input.commandId,
      status: 'waiting_interaction',
      exitCode: EXIT.waiting,
      interactions: structuredClone(interactions),
      answerIntent: structuredClone(answerIntent),
      ...(cancellationSent ? { cancellationAttempted: true as const } : {}),
    };
  };
  try {
    if (interrupted && submit) return finish('cancelled');
    if (
      answerIntent &&
      (answerIntent.workCommandId !== input.commandId ||
        answerIntent.workSessionId !== sessionId ||
        answerIntent.presentationSessionId !== sessionId ||
        answerIntent.request.expectedStoreId !== input.expectedStoreId)
    )
      return finish('outcome_unknown');
    if (recoveryRun && interrupted) return finish('outcome_unknown');
    if (answerIntent?.phase === 'unknown' && interrupted) {
      cancellationSent = true;
      try {
        await durableCancel(
          sessionId,
          {
            kind: 'command.cancel',
            commandId: crypto.randomUUID(),
            targetCommandId: input.commandId,
            expectedStoreId: input.expectedStoreId,
          },
          network,
        );
        options.write(`cancel accepted ${input.commandId}`);
      } catch {
        return finish('outcome_unknown');
      }
    }
    if (answerIntent?.phase === 'unknown') {
      let saved: Command;
      try {
        saved = await options.client.getCommand(answerIntent.request.commandId, network);
      } catch {
        return finish('outcome_unknown');
      }
      if (!validAnswerReceipt(saved)) return finish('outcome_unknown');
      answerIntent = { ...answerIntent, phase: 'accepted' };
      options.write(
        `answer recovered ${answerIntent.request.commandId} ${answerIntent.interactionId}`,
      );
    }
    let accepted: Command;
    try {
      accepted =
        options.caller && callerRequest
          ? await (submit
              ? options.caller.submit(
                  sessionId,
                  callerRequest,
                  AbortSignal.any([network.signal, ...(options.signal ? [options.signal] : [])]),
                )
              : options.caller.lookup(sessionId, callerRequest, network.signal))
          : !submit
            ? await options.client.getCommand(input.commandId, network)
            : input.kind === 'run.start'
              ? await options.client.startRun(sessionId, input as StartCommandRequest, network)
              : input.kind === 'input.follow_up'
                ? await options.client.followUp(sessionId, input as FollowUpCommandRequest, network)
                : await options.client.invokeExtension(
                    sessionId,
                    input as ExtensionCommandRequest,
                    network,
                  );
    } catch (error) {
      if (callerPrepareError(error)) {
        options.write(
          JSON.stringify({ phase: 'not_submitted', code: error.code, reason: error.reason }),
        );
        return finish('failed');
      }
      if (
        submit &&
        error instanceof ClientError &&
        ([
          'invalid_request',
          'connection_not_admitted',
          'data_unavailable',
          'capability_unavailable',
        ].includes(error.code) ||
          (error.problem !== undefined &&
            error.status !== undefined &&
            [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)))
      )
        return finish('failed');
      if (!submit) return finish('outcome_unknown');
      // A lost acceptance response may still have committed. Query the saved identity, never resubmit.
      try {
        accepted =
          options.caller && callerRequest
            ? await options.caller.lookup(sessionId, callerRequest, network.signal)
            : await options.client.getCommand(input.commandId, network);
      } catch {
        return finish('outcome_unknown');
      }
    }
    if (
      accepted.id !== input.commandId ||
      accepted.originStoreId !== input.expectedStoreId ||
      accepted.sessionId !== sessionId ||
      accepted.kind !== input.kind
    )
      return finish('outcome_unknown');
    options.write(`accepted ${input.commandId}`);
    while (Date.now() < deadline) {
      if (recoveryRun && interrupted) return finish('outcome_unknown');
      if (interrupted && !cancellationSent) {
        cancellationSent = true;
        // This new cancellation intent targets the saved command, even before any run ID exists.
        const cancelCommandId = crypto.randomUUID();
        try {
          await durableCancel(
            sessionId,
            {
              kind: 'command.cancel',
              commandId: cancelCommandId,
              targetCommandId: input.commandId,
              expectedStoreId: input.expectedStoreId,
            },
            network,
          );
          options.write(`cancel accepted ${input.commandId}`);
        } catch {
          return finish('outcome_unknown');
        }
      }
      let command: Command;
      try {
        command =
          options.caller && callerRequest
            ? await options.caller.lookup(sessionId, callerRequest, network.signal)
            : await options.client.getCommand(input.commandId, network);
      } catch {
        return finish('outcome_unknown');
      }
      if (
        command.id !== input.commandId ||
        command.kind !== input.kind ||
        command.originStoreId !== input.expectedStoreId ||
        command.sessionId !== sessionId
      )
        return finish('outcome_unknown');
      if (command.status === 'rejected')
        return finish(command.cancelRequestedAt !== null ? 'cancelled' : 'failed');
      if (command.status === 'needs_review') return finish('outcome_unknown');
      if (command.dispatchFailure) {
        options.write(`dispatch blocked ${input.commandId} ${command.dispatchFailure.code}`);
        return finish('outcome_unknown');
      }
      const result = recoveryRun ? { runId: recoveryRun.runId } : receipt(command);
      if (typeof result.runId === 'string') {
        const run = await options.client.getRun(result.runId, network);
        if (
          run.id !== result.runId ||
          run.originCommandId !== input.commandId ||
          run.originStoreId !== input.expectedStoreId ||
          run.sessionId !== sessionId
        )
          return finish('outcome_unknown');
        if (!run.isActive)
          return finish(
            run.status === 'completed'
              ? 'succeeded'
              : run.status === 'cancelled'
                ? 'cancelled'
                : run.status === 'interrupted'
                  ? 'outcome_unknown'
                  : 'failed',
          );
      } else if (typeof result.executionId === 'string') {
        const execution = await options.client.getExecution(result.executionId, network);
        if (execution.sessionId !== sessionId) return finish('outcome_unknown');
        // A predecessor terminal is not the next attempt's terminal while preparation is pending.
        if (result.preparingNextAttempt !== true) {
          if (execution.status === 'succeeded') return finish('succeeded');
          if (execution.status === 'failed') return finish('failed');
          if (execution.status === 'cancelled') return finish('cancelled');
          if (execution.status === 'outcome_unknown') return finish('outcome_unknown');
        }
      }
      if (!interrupted && options.client.serverInfo?.capabilities?.includes('interactions')) {
        const allPending: Interaction[] = [];
        const ids = new Set<string>();
        let afterId: string | undefined;
        do {
          const page = await options.client.listInteractions(
            sessionId,
            {
              storeId: input.expectedStoreId,
              state: 'pending',
              limit: 20,
              ...(afterId ? { afterId } : {}),
            },
            network,
          );
          if (page.interactions.length > 20) throw Error('interaction_page_budget_exceeded');
          let previousId = afterId;
          for (const value of page.interactions) {
            if (
              value.originStoreId !== input.expectedStoreId ||
              value.presentationSessionId !== sessionId ||
              value.state !== 'pending' ||
              ids.has(value.id) ||
              (previousId !== undefined && value.id <= previousId)
            )
              throw Error('interaction_page_identity_mismatch');
            ids.add(value.id);
            previousId = value.id;
            allPending.push(value);
          }
          if (
            page.nextAfterId !== null &&
            (!page.interactions.length ||
              page.nextAfterId !== page.interactions.at(-1)!.id ||
              (afterId !== undefined && page.nextAfterId <= afterId))
          )
            throw Error('interaction_page_cursor_invalid');
          afterId = page.nextAfterId ?? undefined;
        } while (afterId !== undefined);
        let pending = allPending;
        const sameSessionWork = async (value: Interaction): Promise<boolean> => {
          if (
            typeof result.runId === 'string'
              ? value.runId === result.runId
              : value.executionId === result.executionId
          )
            return true;
          if (value.runId !== null || !value.executionId) return false;
          // Nested extension Jobs have no Run of their own. Prove the original work
          // through persisted parent executions, independently of the finite view window.
          let id: string | null | undefined = value.executionId;
          const visited = new Set<string>();
          while (id) {
            if (visited.has(id)) throw Error('interaction_parent_cycle');
            visited.add(id);
            const execution = await options.client.getExecution(id, network);
            if (
              execution.id !== id ||
              execution.originStoreId !== input.expectedStoreId ||
              execution.sessionId !== sessionId ||
              (id === value.executionId && execution.runId !== value.runId)
            )
              throw Error('interaction_parent_identity_mismatch');
            if (
              typeof result.runId === 'string'
                ? execution.runId === result.runId
                : execution.id === result.executionId
            )
              return true;
            if (execution.runId !== null) return false;
            id = execution.parentExecutionId;
          }
          return false;
        };
        const scoped: Interaction[] = [];
        const view = pending.some((value) => value.sessionId !== sessionId)
          ? await options.client.getView(sessionId, network)
          : undefined;
        if (view && view.storeId !== input.expectedStoreId) return finish('outcome_unknown');
        for (const value of pending) {
          if (value.sessionId === sessionId) {
            if (await sameSessionWork(value)) scoped.push(value);
            continue;
          }
          // A background child can share the presentation root. Its actual carrier
          // must belong to the original work, never the selected or active Run.
          const rootIndex = value.ancestry.indexOf(sessionId);
          const child = rootIndex > 0 ? value.ancestry[rootIndex - 1] : undefined;
          if (!child) continue;
          let rootOperation = view!.executions.find(
            (execution) => execution.childSessionId === child,
          );
          if (
            rootOperation &&
            (rootOperation.originStoreId !== input.expectedStoreId ||
              rootOperation.sessionId !== sessionId)
          )
            throw Error('interaction_carrier_identity_mismatch');
          const visited = new Set<string>();
          while (rootOperation && !visited.has(rootOperation.id)) {
            if (
              typeof result.runId === 'string'
                ? rootOperation.runId === result.runId
                : rootOperation.id === result.executionId
            ) {
              scoped.push(value);
              break;
            }
            visited.add(rootOperation.id);
            const parentId = rootOperation.parentExecutionId;
            if (!parentId) break;
            // Retain existing observed carrier evidence, but read absent ancestors
            // by their original ID rather than guessing from the current view.
            rootOperation =
              view!.executions.find((execution) => execution.id === parentId) ??
              (await options.client.getExecution(parentId, network));
            if (
              rootOperation.id !== parentId ||
              rootOperation.originStoreId !== input.expectedStoreId ||
              rootOperation.sessionId !== sessionId
            )
              throw Error('interaction_parent_identity_mismatch');
          }
        }
        pending = scoped;
        if (pending.length) {
          const interaction = structuredClone(pending[0]!);
          if (!options.answerInteraction) return waiting(pending);
          const key = `${interaction.originStoreId}/${interaction.id}/${interaction.revision}`;
          if (!attempted.has(key)) {
            attempted.add(key);
            let answer: NonNullable<Interaction['answer']> | undefined;
            try {
              // Deadline bounds even a host handler that ignores its signal. User cancellation
              // wakes the wait and is sent against the saved original command below.
              const readSignal = options.signal
                ? AbortSignal.any([network.signal, options.signal])
                : network.signal;
              const completeAttachment = requiresInteractionAttachment(interaction)
                ? await options.client.readInteractionAttachment(interaction, {
                    signal: readSignal,
                  })
                : undefined;
              answer = await new Promise((resolve, reject) => {
                const stop = () => {
                  cleanup();
                  resolve(undefined);
                };
                const expire = () => {
                  cleanup();
                  reject(new Error('wait_timeout'));
                };
                const cleanup = () => {
                  options.signal?.removeEventListener('abort', stop);
                  network.signal.removeEventListener('abort', expire);
                };
                options.signal?.addEventListener('abort', stop, { once: true });
                network.signal.addEventListener('abort', expire, { once: true });
                Promise.resolve(
                  options.answerInteraction!(interaction, {
                    ...(completeAttachment
                      ? {
                          completeAttachment: {
                            identity: completeAttachment.identity,
                            text: completeAttachment.text,
                            reference: completeAttachment.reference,
                          },
                        }
                      : {}),
                    signal: options.signal
                      ? AbortSignal.any([network.signal, options.signal])
                      : network.signal,
                  }),
                ).then(
                  (value) => {
                    cleanup();
                    resolve(value);
                  },
                  (error) => {
                    cleanup();
                    reject(error);
                  },
                );
              });
            } catch {
              if (interrupted) continue;
              return waiting(pending);
            }
            if (interrupted) continue;
            if (!answer) return waiting(pending);
            if (interaction.kind === 'plan_review' && !validPlanAnswer(interaction, answer))
              return waiting(pending);
            const request: AnswerInteractionRequest = {
              expectedStoreId: interaction.originStoreId,
              commandId: crypto.randomUUID(),
              expectedRevision: interaction.revision,
              answer: structuredClone(answer),
            };
            answerIntent = {
              workCommandId: input.commandId,
              workSessionId: sessionId,
              phase: 'unknown',
              presentationSessionId: interaction.presentationSessionId,
              interactionId: interaction.id,
              request,
            };
            options.write(`answer saved ${request.commandId} ${interaction.id}`);
            let saved: Command;
            try {
              saved = await options.client.answerInteraction(
                interaction.presentationSessionId,
                interaction.id,
                structuredClone(request),
                network,
              );
            } catch (error) {
              if (
                error instanceof ClientError &&
                ([
                  'invalid_request',
                  'connection_not_admitted',
                  'data_unavailable',
                  'capability_unavailable',
                ].includes(error.code) ||
                  (error.problem !== undefined &&
                    error.status !== undefined &&
                    [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)))
              ) {
                answerIntent = { ...answerIntent, phase: 'rejected' };
                return waiting(pending);
              }
              try {
                saved = await options.client.getCommand(request.commandId, network);
              } catch {
                return waiting(pending);
              }
            }
            if (!validAnswerReceipt(saved)) return waiting(pending);
            answerIntent = { ...answerIntent, phase: 'accepted' };
            options.write(
              `answer accepted ${request.commandId}; ${interaction.kind === 'plan_review' ? 'review information saved; tool permissions unchanged' : 'execution pending'}`,
            );
          }
        }
      }
      await pause(interval);
    }
    return finish('outcome_unknown');
  } catch {
    return finish('outcome_unknown');
  } finally {
    clearTimeout(deadlineTimer);
    networkDeadline.abort();
    options.signal?.removeEventListener('abort', interrupt);
  }
}
export function run(
  sessionId: string,
  input: StartCommandRequest | FollowUpCommandRequest,
  options: CLIOptions,
): Promise<CommandOutcome> {
  if (input?.kind !== 'run.start' && input?.kind !== 'input.follow_up')
    throw new ClientError('invalid_request');
  return execute(sessionId, input, options);
}
/** Observe the saved intent without submitting it again; Ctrl+C still targets that original command. */
export function observeCommand(
  sessionId: string,
  input: StartCommandRequest | FollowUpCommandRequest | ExtensionCommandRequest,
  options: CLIOptions,
): Promise<CommandOutcome> {
  if (
    input?.kind !== 'run.start' &&
    input?.kind !== 'input.follow_up' &&
    input?.kind !== 'extension.invoke'
  )
    throw new ClientError('invalid_request');
  return execute(sessionId, input, options, false);
}
/** Read-only lifecycle observation of an already verified recovered Run. */
export async function observeRecoveryRun(
  sessionId: string,
  anchor: Omit<RecoveryRunAnchor, 'kind'>,
  options: CLIOptions,
): Promise<CommandOutcome> {
  const original = await options.client.getCommand(anchor.commandId, { signal: options.signal });
  if (
    original.id !== anchor.commandId ||
    original.originStoreId !== anchor.expectedStoreId ||
    original.sessionId !== sessionId ||
    !['run.start', 'input.follow_up', 'extension.invoke', 'job.report'].includes(original.kind)
  )
    throw new ClientError('invalid_response');
  const frozen = { ...structuredClone(anchor), kind: original.kind };
  return execute(sessionId, frozen, options, false, frozen);
}
export function invokeExtension(
  sessionId: string,
  input: ExtensionCommandRequest,
  options: CLIOptions,
): Promise<CommandOutcome> {
  if (input?.kind !== 'extension.invoke') throw new ClientError('invalid_request');
  return execute(sessionId, input, options);
}
export async function queryExtension(
  sessionId: string,
  extensionId: string,
  queryId: string,
  input: Json,
  options: CLIOptions,
) {
  const views = await options.client.queryExtension(sessionId, extensionId, queryId, input);
  for (const view of views) options.write(JSON.stringify(view));
  return views;
}

/** Launcher supplies the already chosen and admitted client. Credentials are never argv. */
export async function runNonInteractive(
  args: readonly string[],
  options: CLIOptions,
): Promise<number> {
  const [operation, sessionId, body, extensionId, queryId] = args;
  if (
    !operation ||
    !sessionId ||
    !body ||
    args.some((value) => value === '--token' || value.startsWith('--token='))
  )
    throw new Error('invalid_cli_arguments');
  const input: unknown = JSON.parse(body);
  if (
    [
      'permission-mode',
      'workspace-trust',
      'set-permission-mode',
      'set-workspace-trust',
      'permission-grants',
      'clear-permission-grants',
    ].includes(operation) &&
    args.length !== 3
  )
    throw new Error('invalid_cli_arguments');
  if (
    operation === 'permission-mode' ||
    operation === 'workspace-trust' ||
    operation === 'permission-grants'
  ) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      typeof (input as { storeId?: unknown }).storeId !== 'string'
    )
      throw new ClientError('invalid_request');
    const storeId = (input as { storeId: string }).storeId;
    if (operation === 'permission-mode') await getPermissionMode(sessionId, storeId, options);
    else if (operation === 'permission-grants')
      await getPermissionGrants(sessionId, storeId, options);
    else await getWorkspaceTrust(sessionId, storeId, options);
    return EXIT.success;
  }
  if (operation === 'set-permission-mode')
    return (await setPermissionMode(sessionId, input as SetPermissionModeRequest, options))
      .exitCode;
  if (operation === 'set-workspace-trust')
    return (await setWorkspaceTrust(sessionId, input as SetWorkspaceTrustRequest, options))
      .exitCode;
  if (operation === 'clear-permission-grants')
    return (await clearPermissionGrants(sessionId, input as ClearPermissionGrantsRequest, options))
      .exitCode;
  if (operation === 'context') {
    await getContext(sessionId, input as ContextQuery, options);
    return EXIT.success;
  }
  if (operation === 'rewind')
    return (await rewindContext(sessionId, input as SelectContextRequest, options)).exitCode;
  if (operation === 'include' && extensionId)
    return (
      await includeHistoricalResult(sessionId, extensionId, input as IncludeResultRequest, options)
    ).exitCode;
  if (operation === 'work') {
    if (args.length !== 3 || !options.caller) throw new ClientError('invalid_request');
    const request = input as CallerCommandRequest;
    canonicalCallerCommandRequest(request);
    try {
      const command = await options.caller.submit(sessionId, request, options.signal);
      options.write(JSON.stringify(command));
      if (request.kind === 'run.start' || request.kind === 'input.follow_up')
        return (await observeCommand(sessionId, request, options)).exitCode;
      return command.status === 'rejected'
        ? EXIT.failed
        : command.status === 'applied'
          ? EXIT.success
          : EXIT.unknown;
    } catch (error) {
      if (callerPrepareError(error)) {
        options.write(
          JSON.stringify({ phase: 'not_submitted', code: error.code, reason: error.reason }),
        );
        return EXIT.failed;
      }
      options.write('caller outcome_unknown');
      return EXIT.unknown;
    }
  }
  if (operation === 'run') {
    if (args.length !== 3 || !options.caller) throw new ClientError('invalid_request');
    return (await run(sessionId, input as StartCommandRequest, options)).exitCode;
  }
  if (operation === 'invoke')
    return (await invokeExtension(sessionId, input as ExtensionCommandRequest, options)).exitCode;
  if (operation === 'query' && extensionId && queryId) {
    await queryExtension(sessionId, extensionId, queryId, input as Json, options);
    return EXIT.success;
  }
  throw new Error('invalid_cli_arguments');
}

/** Attach Ctrl+C to this foreground operation only; callers retain lifecycle ownership. */
export async function withCtrlC<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('user_interrupt'));
  process.on('SIGINT', interrupt);
  try {
    return await work(controller.signal);
  } finally {
    process.off('SIGINT', interrupt);
  }
}

export {
  type ContextOutcome,
  getCompleteContext,
  getContext,
  includeHistoricalResult,
  lookupContextOutcome,
  rewindContext,
} from './context';
export {
  clearPermissionGrants,
  createStdioPermissionReader,
  getPermissionGrants,
  getPermissionMode,
  getWorkspaceTrust,
  lookupPermissionOutcome,
  type PermissionChoiceReader,
  type PermissionIntent,
  type PermissionOutcome,
  promptPermissionMode,
  promptWorkspaceTrust,
  setPermissionMode,
  setWorkspaceTrust,
} from './permissions';
export {
  compressContext,
  deleteSession,
  forkSession,
  lookupManagementOutcome,
  type ManagementIntent,
  type ManagementOutcome,
  renameSession,
  resetCompressionContext,
  submitManagement,
} from './session-management';
export {
  createStdioInteractionHandler,
  type StdioInput,
  type StdioInteractionOptions,
} from './stdio-interactions';
