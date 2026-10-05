import { validateRequest } from './decode';
import type {
  CancelCommandRequest,
  CancelExecutionRequest,
  FollowUpCommandRequest,
  StartCommandRequest,
  SteerCommandRequest,
} from './generated/api';
import { canonicalModelBody } from './model-input';

type SourceIdentity = { kind: 'user' | 'workspace'; pathDigest: string; rootIdentity: string };
type SourceRead = { identity: SourceIdentity; etag: string | null; error: string | null };
type AuthCallerRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'extension.invoke';
  extensionId: 'builtin.mcp.sources';
  actionId: 'mcp.auth.login' | 'mcp.auth.refresh' | 'mcp.auth.clear' | 'mcp.auth.revoke';
  definitionVersion: '1';
  input: {
    serverId: string;
    expectedReadSet: {
      scopeDigest: string;
      user: SourceRead;
      workspace: SourceRead | null;
      approvalEtag: string | null;
      bindingEtag: string | null;
      variablesDigest: string;
    };
  };
};

export type CallerCommandRequest =
  | StartCommandRequest
  | SteerCommandRequest
  | FollowUpCommandRequest
  | CancelCommandRequest
  | CancelExecutionRequest;

/** Exact persisted Command request bytes, without its HTTP identity envelope. */
export function canonicalCallerCommandRequest(
  input: CallerCommandRequest | AuthCallerRequest,
): string {
  const names = {
    'run.start': 'StartCommandRequest',
    'input.steer': 'SteerCommandRequest',
    'input.follow_up': 'FollowUpCommandRequest',
    'command.cancel': 'CancelCommandRequest',
    'execution.cancel': 'CancelExecutionRequest',
  } as const;
  if (input.kind === 'extension.invoke') {
    validateRequest('ExtensionCommandRequest', input);
    const closed = (value: unknown, keys: string[]): Record<string, unknown> => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== keys.sort().join(',')
      )
        throw Error('caller_request_invalid');
      return value as Record<string, unknown>;
    };
    const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const nullableHash = (value: unknown) => value === null || hash(value);
    closed(input, [
      'expectedStoreId',
      'commandId',
      'kind',
      'extensionId',
      'actionId',
      'definitionVersion',
      'input',
    ]);
    if (
      input.extensionId !== 'builtin.mcp.sources' ||
      input.definitionVersion !== '1' ||
      !['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(
        input.actionId,
      )
    )
      throw Error('caller_request_invalid');
    const body = closed(input.input, ['serverId', 'expectedReadSet']);
    if (typeof body.serverId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.serverId))
      throw Error('caller_request_invalid');
    const reads = closed(body.expectedReadSet, [
      'scopeDigest',
      'user',
      'workspace',
      'approvalEtag',
      'bindingEtag',
      'variablesDigest',
    ]);
    if (
      !hash(reads.scopeDigest) ||
      !hash(reads.variablesDigest) ||
      !nullableHash(reads.approvalEtag) ||
      !nullableHash(reads.bindingEtag)
    )
      throw Error('caller_request_invalid');
    const read = (value: unknown, kind: string) => {
      const row = closed(value, ['identity', 'etag', 'error']);
      const identity = closed(row.identity, ['kind', 'pathDigest', 'rootIdentity']);
      if (
        identity.kind !== kind ||
        !hash(identity.pathDigest) ||
        !hash(identity.rootIdentity) ||
        !nullableHash(row.etag) ||
        (row.error !== null && typeof row.error !== 'string')
      )
        throw Error('caller_request_invalid');
    };
    read(reads.user, 'user');
    if (reads.workspace !== null) read(reads.workspace, 'workspace');
  } else validateRequest(names[input.kind], input);
  const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  delete request.expectedStoreId;
  delete request.commandId;
  return canonicalModelBody(request);
}
