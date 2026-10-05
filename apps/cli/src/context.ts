import {
  type AgentClient,
  ClientError,
  type Command,
  type ContextQuery,
  type IncludeResultRequest,
  type SelectContextRequest,
} from '@kite-ai/client';
import type { CLIOptions } from './index';

export interface ContextOutcome {
  readonly sessionId: string;
  readonly kind: 'rewind' | 'include';
  readonly executionId?: string;
  readonly request: SelectContextRequest | IncludeResultRequest;
  readonly status: 'applied' | 'queued' | 'failed' | 'outcome_unknown';
  readonly command?: Command;
  readonly exitCode: number;
}
const submissions = new WeakMap<
  AgentClient,
  Map<string, { digest: string; promise: Promise<ContextOutcome> }>
>();
export async function getContext(sessionId: string, input: ContextQuery, options: CLIOptions) {
  const page = await options.client.getContext(sessionId, structuredClone(input), {
    signal: options.signal,
  });
  options.write(JSON.stringify(page));
  return page;
}
function mutateContext(
  sessionId: string,
  kind: ContextOutcome['kind'],
  executionId: string | undefined,
  request: SelectContextRequest | IncludeResultRequest,
  options: CLIOptions,
): Promise<ContextOutcome> {
  const frozen = structuredClone(request);
  const digest = JSON.stringify([sessionId, kind, executionId, frozen]);
  let entries = submissions.get(options.client);
  if (!entries) {
    entries = new Map();
    submissions.set(options.client, entries);
  }
  const previous = entries.get(frozen.commandId);
  if (previous) {
    if (previous.digest !== digest) return Promise.reject(new ClientError('command_conflict'));
    return previous.promise;
  }
  if (entries.size >= 128) return Promise.reject(new ClientError('context_intent_limit'));
  const promise = Promise.resolve().then(async () => {
    options.write(`context intent saved ${frozen.commandId} ${kind}`);
    let command: Command | undefined;
    let status: ContextOutcome['status'] = 'outcome_unknown';
    try {
      const response =
        kind === 'rewind'
          ? await options.client.rewind(sessionId, frozen as SelectContextRequest, {
              signal: options.signal,
            })
          : await options.client.includeResult(
              sessionId,
              executionId!,
              frozen as IncludeResultRequest,
              { signal: options.signal },
            );
      command = response.command;
    } catch (error) {
      if (knownRejection(error)) status = 'failed';
      else
        try {
          command = await options.client.getCommand(frozen.commandId, { signal: options.signal });
        } catch {
          /* Saved original intent remains available in the outcome; never resubmit. */
        }
    }
    if (command) {
      if (
        command.id !== frozen.commandId ||
        command.originStoreId !== frozen.expectedStoreId ||
        command.sessionId !== sessionId ||
        command.kind !== (kind === 'include' ? 'result.include' : 'context.select')
      )
        status = 'outcome_unknown';
      else
        status =
          command.status === 'applied'
            ? 'applied'
            : command.status === 'rejected'
              ? 'failed'
              : queued(command, kind, frozen)
                ? 'queued'
                : 'outcome_unknown';
    }
    options.write(`context ${status} ${frozen.commandId}; no execution replay`);
    return {
      sessionId,
      kind,
      executionId,
      request: frozen,
      status,
      command,
      exitCode: status === 'applied' ? 0 : status === 'failed' ? 1 : 2,
    };
  });
  entries.set(frozen.commandId, { digest, promise });
  return promise;
}
export function rewindContext(sessionId: string, input: SelectContextRequest, options: CLIOptions) {
  return mutateContext(sessionId, 'rewind', undefined, input, options);
}
export function includeHistoricalResult(
  sessionId: string,
  executionId: string,
  input: IncludeResultRequest,
  options: CLIOptions,
) {
  return mutateContext(sessionId, 'include', executionId, input, options);
}

/** Explicit read-only reconciliation keeps the complete original mutation identity. */
export async function lookupContextOutcome(
  saved: ContextOutcome,
  options: CLIOptions,
): Promise<ContextOutcome> {
  const original = structuredClone(saved);
  let command: Command;
  try {
    command = await options.client.getCommand(original.request.commandId, {
      signal: options.signal,
    });
  } catch {
    return { ...original, status: 'outcome_unknown', exitCode: 2 };
  }
  const exact =
    command.id === original.request.commandId &&
    command.sessionId === original.sessionId &&
    command.originStoreId === original.request.expectedStoreId &&
    command.kind === (original.kind === 'include' ? 'result.include' : 'context.select');
  const status: ContextOutcome['status'] = exact
    ? command.status === 'applied'
      ? 'applied'
      : command.status === 'rejected'
        ? 'failed'
        : queued(command, original.kind, original.request)
          ? 'queued'
          : 'outcome_unknown'
    : 'outcome_unknown';
  options.write(`context ${status} ${original.request.commandId}; no execution replay`);
  return {
    ...original,
    status,
    command,
    exitCode: status === 'applied' ? 0 : status === 'failed' ? 1 : 2,
  };
}

function queued(
  command: Command,
  kind: ContextOutcome['kind'],
  request: ContextOutcome['request'],
): boolean {
  const receipt = command.receipt as { outcome?: string; runId?: string } | null;
  return (
    kind === 'include' &&
    'targetRunId' in request &&
    !!request.targetRunId &&
    command.status === 'accepted' &&
    receipt?.outcome === 'result_queued' &&
    receipt.runId === request.targetRunId
  );
}

function knownRejection(error: unknown): boolean {
  return (
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
  );
}

/** Both streams share the first selection/high-water; completion never truncates at a page. */
export async function getCompleteContext(
  sessionId: string,
  input: ContextQuery,
  options: CLIOptions,
): Promise<import('@kite-ai/client').SelectedContextPage> {
  const query = structuredClone(input);
  let frozen: import('@kite-ai/client').SelectedContextPage | undefined;
  let afterSeq = query.afterSeq ?? '0',
    afterSourceId = query.afterSourceId,
    messageDone = false,
    sourceDone = false;
  const messageIds = new Set<string>(),
    sourceIds = new Set<string>();
  for (;;) {
    const priorAfterSeq = afterSeq,
      priorAfterSourceId = afterSourceId;
    const page = await options.client.getContext(
      sessionId,
      {
        ...query,
        afterSeq,
        ...(afterSourceId ? { afterSourceId } : {}),
        ...(frozen
          ? { upperSeq: frozen.highWaterSeq, contextSelectionId: frozen.selection.id }
          : {}),
        messageLimit: 200,
        sourceLimit: 100,
      },
      { signal: options.signal },
    );
    if (
      page.selection.sessionId !== sessionId ||
      (query.contextSelectionId && page.selection.id !== query.contextSelectionId) ||
      (frozen &&
        (JSON.stringify(page.selection) !== JSON.stringify(frozen.selection) ||
          page.highWaterSeq !== frozen.highWaterSeq ||
          page.compression?.id !== frozen.compression?.id))
    )
      throw new ClientError('context_identity_mismatch');
    if (!frozen) frozen = { ...page, messages: [], resultSources: [] };
    if (!messageDone) {
      for (const message of page.messages) {
        if (
          message.sessionId !== sessionId ||
          BigInt(message.seq) <= BigInt(afterSeq) ||
          BigInt(message.seq) > BigInt(frozen.highWaterSeq) ||
          messageIds.has(message.id)
        )
          throw new ClientError('context_cursor_invalid');
        messageIds.add(message.id);
        frozen.messages.push(message);
        afterSeq = message.seq;
      }
      if (page.nextAfterSeq === null) {
        messageDone = true;
        afterSeq = frozen.highWaterSeq;
      } else {
        if (page.nextAfterSeq !== afterSeq || afterSeq === priorAfterSeq)
          throw new ClientError('context_cursor_invalid');
      }
    }
    if (!sourceDone) {
      for (const source of page.resultSources) {
        if (
          source.sessionId !== sessionId ||
          source.originStoreId !== query.storeId ||
          sourceIds.has(source.id)
        )
          throw new ClientError('context_source_identity_mismatch');
        sourceIds.add(source.id);
        frozen.resultSources.push(source);
        afterSourceId = source.id;
      }
      if (page.nextAfterSourceId === null) sourceDone = true;
      else if (page.nextAfterSourceId !== afterSourceId || afterSourceId === priorAfterSourceId)
        throw new ClientError('context_cursor_invalid');
    }
    if (messageDone && sourceDone)
      return {
        ...frozen,
        nextAfterSeq: null,
        nextAfterSourceId: null,
        snapshotCursor: page.snapshotCursor,
      };
  }
}
