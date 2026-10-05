import { type AgentClient, ClientError } from '@kite-ai/client';
import {
  FileCheckpointDetailSchema,
  FileCheckpointPageSchema,
  FileRestoreStatusSchema,
} from './http/schema/file-checkpoints';

const queries = [
  'files.checkpoints',
  'files.checkpoint.detail',
  'files.checkpoint.restore-status',
] as const;
/** Catalogue authority is actual registration, independent of user supplied query identifiers. */
export async function supportsFileCheckpoints(client: AgentClient, signal: AbortSignal) {
  if (
    client.serverInfo?.dataAvailability !== 'available' ||
    !client.serverInfo.capabilities.includes('extension_queries')
  )
    return false;
  const catalogue = await client.listExtensions({ signal });
  const files = catalogue.filter((entry) => entry.extensionId === 'builtin.files');
  return (
    files.length === 1 &&
    queries.every((id) => {
      const matching = files[0]!.queries.filter((query) => query.id === id);
      return matching.length === 1 && matching[0]!.version === '1';
    })
  );
}
export async function fileCheckpointResponse(
  client: AgentClient,
  currentStoreId: string,
  sessionId: string,
  operation: 'list' | 'detail' | 'status',
  input:
    | { afterKey?: string; limit?: number }
    | { pointId: string }
    | { checkpointId: string; restoreId: string },
  signal: AbortSignal,
) {
  if (!(await supportsFileCheckpoints(client, signal)))
    throw new ClientError('capability_unavailable');
  const before = await client.getView(sessionId, { signal });
  if (
    before.storeId !== currentStoreId ||
    before.session.id !== sessionId ||
    before.session.deletedAt !== null
  )
    throw new ClientError('browser_identity_mismatch');
  const index = operation === 'list' ? 0 : operation === 'detail' ? 1 : 2;
  const values = await client.queryExtension(sessionId, 'builtin.files', queries[index], input, {
    signal,
  });
  const view = values[0];
  const types = [
    'builtin.files.checkpoints',
    'builtin.files.checkpoint.preview',
    'builtin.files.checkpoint.restore-status',
  ];
  if (
    values.length !== 1 ||
    !view ||
    view.extensionId !== 'builtin.files' ||
    view.contentVersion !== 1 ||
    view.contentType !== types[index] ||
    view.actions.length !== 0
  )
    throw new ClientError('file_checkpoint_response_invalid');
  const after = await client.getView(sessionId, { signal });
  signal.throwIfAborted();
  if (
    after.storeId !== currentStoreId ||
    after.session.id !== sessionId ||
    after.session.workspaceId !== before.session.workspaceId ||
    after.session.deletedAt !== null
  )
    throw new ClientError('browser_identity_mismatch');
  const value = {
    storeId: currentStoreId,
    sessionId,
    workspaceId: before.session.workspaceId,
    payload: view.payload,
  };
  const schema =
    operation === 'list'
      ? FileCheckpointPageSchema
      : operation === 'detail'
        ? FileCheckpointDetailSchema
        : FileRestoreStatusSchema;
  return schema.parse(value);
}
