import process from 'node:process';
import {
  type AgentClient,
  type ClearPermissionGrantsRequest,
  ClientError,
  type PermissionMutation,
  type SetPermissionModeRequest,
  type SetWorkspaceTrustRequest,
} from '@kite-ai/client';
import type { StdioInput } from './stdio-interactions';

interface Options {
  client: AgentClient;
  write(line: string): void;
  signal?: AbortSignal;
}
export type PermissionIntent =
  | { kind: 'permission.mode'; sessionId: string; request: SetPermissionModeRequest }
  | { kind: 'permission.grants.clear'; sessionId: string; request: ClearPermissionGrantsRequest }
  | { kind: 'workspace.trust'; workspaceId: string; request: SetWorkspaceTrustRequest };
export interface PermissionOutcome {
  status: PermissionMutation['state'] | 'not_submitted';
  intent?: PermissionIntent;
  mutation?: PermissionMutation;
  errorCode?: string;
  exitCode: number;
}
function sameChoice(intent: PermissionIntent, fact: PermissionMutation) {
  if (fact.commandId !== intent.request.commandId || fact.kind !== intent.kind) return false;
  if (fact.state !== 'applied') return true;
  if (intent.kind === 'permission.grants.clear' && fact.kind === 'permission.grants.clear')
    return (
      fact.receipt.sessionId === intent.sessionId &&
      BigInt(fact.receipt.revision) > BigInt(intent.request.ifRevision)
    );
  return intent.kind === 'permission.mode' && fact.kind === 'permission.mode'
    ? fact.receipt.mode === intent.request.mode &&
        fact.receipt.makeDefault === intent.request.makeDefault
    : intent.kind === 'workspace.trust' &&
        fact.kind === 'workspace.trust' &&
        fact.receipt.trusted === intent.request.trusted &&
        fact.receipt.canonicalIdentity === intent.request.canonicalIdentity &&
        fact.receipt.externalReadScopeDigest === intent.request.externalReadScopeDigest;
}
function outcome(
  intent: PermissionIntent,
  mutation: PermissionMutation,
  options: Options,
): PermissionOutcome {
  if (!sameChoice(intent, mutation)) throw new ClientError('permission_scope_mismatch');
  options.write(`permission ${intent.request.commandId} ${mutation.kind} ${mutation.state}`);
  return {
    status: mutation.state,
    intent: structuredClone(intent),
    mutation,
    exitCode: mutation.state === 'applied' ? 0 : mutation.state === 'failed' ? 1 : 2,
  };
}
export async function lookupPermissionOutcome(
  intent: PermissionIntent,
  options: Options,
): Promise<PermissionOutcome> {
  const original = structuredClone(intent);
  try {
    return outcome(
      original,
      await options.client.getPermissionMutation(original.request.commandId, {
        storeId: original.request.expectedStoreId,
        signal: options.signal,
      }),
      options,
    );
  } catch (error) {
    const errorCode = error instanceof ClientError ? error.code : 'permission_lookup_unavailable';
    options.write(`permission ${original.request.commandId} outcome_unknown ${errorCode}`);
    return { status: 'outcome_unknown', intent: original, errorCode, exitCode: 2 };
  }
}
async function performSubmit(
  intent: PermissionIntent,
  options: Options,
): Promise<PermissionOutcome> {
  const original = structuredClone(intent);
  try {
    const mutation =
      original.kind === 'permission.mode'
        ? await options.client.setPermissionMode(original.sessionId, original.request, {
            signal: options.signal,
          })
        : original.kind === 'permission.grants.clear'
          ? await options.client.clearPermissionGrants(original.sessionId, original.request, {
              signal: options.signal,
            })
          : await options.client.setWorkspaceTrust(original.workspaceId, original.request, {
              signal: options.signal,
            });
    return outcome(original, mutation, options);
  } catch (error) {
    const errorCode = error instanceof ClientError ? error.code : 'permission_outcome_unknown';
    const knownRejected =
      error instanceof ClientError &&
      (['invalid_request', 'connection_not_admitted', 'capability_unavailable'].includes(
        error.code,
      ) ||
        (error.problem &&
          error.status &&
          [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)));
    if (!knownRejected || options.signal?.aborted)
      return lookupPermissionOutcome(original, options);
    options.write(`permission ${original.request.commandId} rejected ${errorCode}`);
    return { status: 'failed', intent: original, errorCode, exitCode: 1 };
  }
}
const intents = new WeakMap<
  AgentClient,
  Map<string, { digest: string; promise: Promise<PermissionOutcome> }>
>();
function submit(intent: PermissionIntent, options: Options): Promise<PermissionOutcome> {
  const saved = structuredClone(intent),
    digest = JSON.stringify(saved);
  let journal = intents.get(options.client);
  if (!journal) {
    journal = new Map();
    intents.set(options.client, journal);
  }
  const prior = journal.get(saved.request.commandId);
  if (prior) {
    if (prior.digest !== digest) return Promise.reject(new ClientError('command_conflict'));
    return prior.promise;
  }
  if (journal.size >= 128) return Promise.reject(new ClientError('permission_intent_limit'));
  const promise = Promise.resolve().then(() => performSubmit(saved, options));
  journal.set(saved.request.commandId, { digest, promise });
  return promise;
}
export function setPermissionMode(
  sessionId: string,
  request: SetPermissionModeRequest,
  options: Options,
) {
  return submit({ kind: 'permission.mode', sessionId, request }, options);
}
export function setWorkspaceTrust(
  workspaceId: string,
  request: SetWorkspaceTrustRequest,
  options: Options,
) {
  return submit({ kind: 'workspace.trust', workspaceId, request }, options);
}
export function clearPermissionGrants(
  sessionId: string,
  request: ClearPermissionGrantsRequest,
  options: Options,
) {
  return submit({ kind: 'permission.grants.clear', sessionId, request }, options);
}
export async function getPermissionGrants(sessionId: string, storeId: string, options: Options) {
  let page = await options.client.listPermissionGrants(
    sessionId,
    { storeId, limit: 200 },
    { signal: options.signal },
  );
  const initial = page;
  const revision = page.revision,
    upperSeq = page.upperSeq,
    grants = [...page.items],
    ids = new Set(grants.map((row) => row.grant.id));
  if (ids.size !== grants.length) throw new ClientError('invalid_response');
  while (page.nextAfterSeq !== null) {
    page = await options.client.listPermissionGrants(
      sessionId,
      { storeId, limit: 200, upperSeq, afterSeq: page.nextAfterSeq },
      { signal: options.signal },
    );
    if (
      page.storeId !== storeId ||
      page.sessionId !== sessionId ||
      page.upperSeq !== upperSeq ||
      page.highWaterSeq !== initial.highWaterSeq ||
      page.revision !== revision
    )
      throw new ClientError('directory_snapshot_changed');
    for (const row of page.items) {
      if (ids.has(row.grant.id)) throw new ClientError('invalid_response');
      ids.add(row.grant.id);
    }
    grants.push(...page.items);
  }
  const state = {
    storeId,
    sessionId,
    revision,
    upperSeq,
    grants,
    page: { ...initial, items: grants, nextAfterSeq: null },
  };
  options.write(JSON.stringify(state));
  return state;
}
export async function getPermissionMode(sessionId: string, storeId: string, options: Options) {
  const state = await options.client.getPermissionMode(sessionId, {
    storeId,
    signal: options.signal,
  });
  options.write(JSON.stringify(state));
  return state;
}
export async function getWorkspaceTrust(workspaceId: string, storeId: string, options: Options) {
  const state = await options.client.getWorkspaceTrust(workspaceId, {
    storeId,
    signal: options.signal,
  });
  options.write(JSON.stringify(state));
  return state;
}
function unresolved(options: Options): PermissionOutcome {
  options.write('permission not_submitted');
  return { status: 'not_submitted', exitCode: options.signal?.aborted ? 130 : 3 };
}
export interface PermissionChoiceReader {
  readLine(signal?: AbortSignal): Promise<string | undefined>;
}
/** Explicit foreground input has no authority to answer an approval card or cancel an execution. */
export function createStdioPermissionReader(
  input: StdioInput = process.stdin,
): PermissionChoiceReader & { dispose(): void } {
  let disposed = false,
    pending: (() => void) | undefined;
  return {
    readLine(signal) {
      if (disposed || pending || signal?.aborted || input.readableEnded || input.destroyed)
        return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '',
          bytes = 0,
          settled = false;
        const finish = (answer?: string) => {
          if (settled) return;
          settled = true;
          input.off('data', data);
          input.off('end', ended);
          input.off('error', ended);
          signal?.removeEventListener('abort', ended);
          input.pause?.();
          pending = undefined;
          resolve(answer);
        };
        const ended = () => finish();
        const data = (chunk: unknown) => {
          try {
            if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
              finish();
              return;
            }
            const value = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
            bytes += value.byteLength;
            if (bytes > 256) {
              finish();
              return;
            }
            text += decoder.decode(value, { stream: true });
            const end = text.indexOf('\n');
            if (end !== -1) finish(text.slice(0, end).replace(/\r$/, ''));
          } catch {
            finish();
          }
        };
        pending = ended;
        input.on('data', data);
        input.once('end', ended);
        input.once('error', ended);
        signal?.addEventListener('abort', ended, { once: true });
        input.resume?.();
      });
    },
    dispose() {
      disposed = true;
      pending?.();
    },
  };
}
export async function promptPermissionMode(
  sessionId: string,
  storeId: string,
  reader: PermissionChoiceReader,
  options: Options,
): Promise<PermissionOutcome> {
  const observed = structuredClone(await getPermissionMode(sessionId, storeId, options));
  if (observed.scopeSessionId !== sessionId) {
    options.write('child permission mode is inherited; select its root Session explicitly');
    return unresolved(options);
  }
  options.write(
    'Choose ask, accept_edits, auto or full. Append " default" to also save the user default. Enter cancel to leave unchanged.',
  );
  const line = await reader.readLine(options.signal);
  if (options.signal?.aborted || !line || line === 'cancel') return unresolved(options);
  const choice = /^(ask|accept_edits|auto|full)( default)?$/.exec(line);
  if (!choice) return unresolved(options);
  return setPermissionMode(
    sessionId,
    {
      expectedStoreId: observed.storeId,
      commandId: crypto.randomUUID(),
      mode: choice[1] as SetPermissionModeRequest['mode'],
      ifRevision: observed.revision,
      makeDefault: choice[2] !== undefined,
      ifDefaultRevision: observed.defaultRevision,
    },
    options,
  );
}
export async function promptWorkspaceTrust(
  workspaceId: string,
  storeId: string,
  reader: PermissionChoiceReader,
  options: Options,
): Promise<PermissionOutcome> {
  const observed = structuredClone(await getWorkspaceTrust(workspaceId, storeId, options));
  options.write(
    'Review the displayed workspace and extra read scopes. Enter trust, untrust or cancel; trust does not approve every Tool.',
  );
  const line = await reader.readLine(options.signal);
  if (options.signal?.aborted || (line !== 'trust' && line !== 'untrust'))
    return unresolved(options);
  return setWorkspaceTrust(
    workspaceId,
    {
      expectedStoreId: observed.storeId,
      commandId: crypto.randomUUID(),
      canonicalIdentity: observed.canonicalIdentity,
      externalReadScopeDigest: observed.externalReadScopeDigest,
      trusted: line === 'trust',
      ifRevision: observed.revision,
    },
    options,
  );
}
