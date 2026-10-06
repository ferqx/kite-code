import { validateMcpCommandRequest } from '@kite-ai/client';
import type { NativeMcpOperation } from '../src/mcp-bridge';

export function parseNativeMcpOperation(value: unknown): NativeMcpOperation {
  const fail = (): never => {
    throw Error('invalid_native_request');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as NativeMcpOperation;
  const keys = {
    select: ['kind', 'serverId', 'enabled', 'scope'],
    connect: ['kind', 'serverId'],
    approve: ['kind', 'serverId'],
    refresh: ['kind', 'serverId', 'commandId'],
    reconnect: ['kind', 'serverId', 'commandId'],
    bind: ['kind', 'serverId', 'expiresAt'],
    login: ['kind', 'serverId'],
    authRefresh: ['kind', 'serverId'],
    clear: ['kind', 'serverId'],
    revoke: ['kind', 'serverId'],
    add: ['kind', 'scope', 'name', 'entry'],
    remove: ['kind', 'serverId', 'scope'],
  } as const;
  if (
    typeof row.kind !== 'string' ||
    !Object.hasOwn(keys, row.kind) ||
    Object.keys(row).sort().join(',') !== [...keys[row.kind]].sort().join(',')
  )
    fail();
  if (
    'serverId' in row &&
    (typeof row.serverId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.serverId))
  )
    fail();
  if ('scope' in row && row.scope !== 'user' && row.scope !== 'workspace') fail();
  if (
    'commandId' in row &&
    (typeof row.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.commandId))
  )
    fail();
  if (row.kind === 'select' && typeof row.enabled !== 'boolean') fail();
  if (row.kind === 'bind' && (!Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0)) fail();
  if (row.kind === 'add') {
    const hash = '0'.repeat(64);
    validateMcpCommandRequest({
      expectedStoreId: 'validation',
      commandId: 'validation',
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.source.add',
      definitionVersion: '1',
      input: {
        scope: row.scope,
        name: row.name,
        entry: row.entry,
        expectedReadSet: {
          scopeDigest: hash,
          user: {
            identity: { kind: 'user', pathDigest: hash, rootIdentity: hash },
            etag: hash,
            error: null,
          },
          workspace:
            row.scope === 'workspace'
              ? {
                  identity: { kind: 'workspace', pathDigest: hash, rootIdentity: hash },
                  etag: hash,
                  error: null,
                }
              : null,
          approvalEtag: hash,
          bindingEtag: hash,
          variablesDigest: hash,
        },
      },
    });
  }
  return structuredClone(row);
}
