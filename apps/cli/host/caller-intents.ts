import { createHash } from 'node:crypto';
import { canonicalCallerCommandRequest, validateRequest } from '@kite-ai/client';
import type { TuiCallerIntent, TuiCallerRequest } from '@kite-ai/ui/tui';

/** Closed transport target mapping; CLI persistence does not initialize an Ink renderer. */
export function callerTarget(
  scope: TuiCallerIntent['scope'],
  request: TuiCallerRequest,
): TuiCallerIntent['target'] {
  switch (request.kind) {
    case 'extension.invoke':
    case 'run.start':
      return { kind: 'session', id: scope.sessionId };
    case 'input.steer':
      return {
        kind: 'run',
        id: request.targetRunId,
        contextSelectionId: request.contextSelectionId,
      };
    case 'input.follow_up':
      return {
        kind: 'after_run',
        id: request.afterRunId,
        contextSelectionId: request.contextSelectionId,
      };
    case 'command.cancel':
      return { kind: 'command', id: request.targetCommandId };
    case 'execution.cancel':
      return { kind: 'execution', id: request.executionId };
    default:
      throw Error('caller_intent_invalid');
  }
}

function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw Error('caller_intent_invalid');
}
export function callerCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(callerCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${callerCanonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw Error('caller_intent_invalid');
  return json;
}
export const callerDigest = (value: unknown) =>
  createHash('sha256').update(callerCanonical(value)).digest('hex');
export const callerTextDigest = (text: string) => createHash('sha256').update(text).digest('hex');
const schemas = {
  'run.start': 'StartCommandRequest',
  'input.steer': 'SteerCommandRequest',
  'input.follow_up': 'FollowUpCommandRequest',
  'command.cancel': 'CancelCommandRequest',
  'execution.cancel': 'CancelExecutionRequest',
} as const;
export function parseCallerIntent(raw: unknown): TuiCallerIntent {
  const hasDraft = !!raw && typeof raw === 'object' && 'draft' in raw;
  closed(raw, [
    'scope',
    'request',
    'target',
    'subjectId',
    'bodyDigest',
    'requestDigest',
    ...(hasDraft ? ['draft'] : []),
  ]);
  closed(raw.scope, ['storeId', 'sessionId', 'workspaceId']);
  for (const id of Object.values(raw.scope))
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw Error('caller_intent_invalid');
  if (!raw.request || typeof raw.request !== 'object' || Array.isArray(raw.request))
    throw Error('caller_intent_invalid');
  const request = raw.request as TuiCallerRequest;
  if (request.kind === 'extension.invoke') {
    canonicalCallerCommandRequest(request);
    if (hasDraft) throw Error('caller_intent_invalid');
  } else {
    if (!(request.kind in schemas)) throw Error('caller_intent_invalid');
    validateRequest(schemas[request.kind], request);
  }
  if (
    request.expectedStoreId !== raw.scope.storeId ||
    raw.bodyDigest !== callerDigest(request) ||
    raw.requestDigest !== callerRequestDigest(request) ||
    typeof raw.subjectId !== 'string' ||
    !raw.subjectId ||
    raw.subjectId.length > 256
  )
    throw Error('caller_intent_invalid');
  const expected = callerTarget(raw.scope as TuiCallerIntent['scope'], request);
  if (callerCanonical(raw.target) !== callerCanonical(expected))
    throw Error('caller_intent_invalid');
  if (hasDraft) {
    closed(raw.draft, ['id', 'revision', 'textDigest']);
    if (
      typeof raw.draft.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.draft.id) ||
      typeof raw.draft.revision !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(raw.draft.revision) ||
      BigInt(raw.draft.revision) > 9223372036854775807n ||
      typeof raw.draft.textDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.draft.textDigest)
    )
      throw Error('caller_intent_invalid');
  }
  return structuredClone(raw) as TuiCallerIntent;
}
export function freezeCaller<T>(input: T): T {
  if (input !== null && typeof input === 'object') {
    for (const part of Object.values(input)) freezeCaller(part);
    Object.freeze(input);
  }
  return input;
}

export const callerRequestDigest = (request: TuiCallerRequest) =>
  createHash('sha256').update(canonicalCallerCommandRequest(request)).digest('hex');
