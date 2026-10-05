import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  FileCheckpointDetailSchema,
  FileCheckpointPageSchema,
  FileCheckpointRecoveryBoundarySchema,
  FileRestoreStatusSchema,
} from './http/schema/file-checkpoints';

const definitions = [
  ['files.checkpoints', 'builtin.files.checkpoints'],
  ['files.checkpoint.detail', 'builtin.files.checkpoint.preview'],
  ['files.checkpoint.restore-status', 'builtin.files.checkpoint.restore-status'],
  ['files.checkpoint.recovery-boundary', 'builtin.files.checkpoint.recovery-boundary'],
] as const;

export function supportsFileRecovery(runtime: AgentRuntime | undefined): boolean {
  const files =
    runtime?.getExtensionCatalogue().filter((entry) => entry.extensionId === 'builtin.files') ?? [];
  return (
    files.length === 1 &&
    definitions.every(([id]) => {
      const matches = files[0]!.queries.filter((query) => query.id === id);
      return matches.length === 1 && matches[0]!.version === '1';
    })
  );
}

/** The host supplies subject and actual Store scope; payload never supplies query authority. */
export async function nativeFileCheckpointResponse(
  runtime: AgentRuntime,
  subjectId: string,
  sessionId: string,
  operation: 'list' | 'detail' | 'status' | 'boundary',
  input:
    | { afterKey?: string; limit?: number }
    | { pointId: string }
    | { checkpointId: string; restoreId: string },
  signal: AbortSignal,
) {
  if (!supportsFileRecovery(runtime)) throw new AgentError('capability_unavailable');
  signal.throwIfAborted();
  const storeId = (await runtime.getMetadata()).storeId;
  const before = await runtime.getView(sessionId);
  if (
    before.storeId !== storeId ||
    before.session.id !== sessionId ||
    before.session.deletedAt !== null
  )
    throw new AgentError('file_checkpoint_identity_mismatch');
  const index =
    operation === 'list' ? 0 : operation === 'detail' ? 1 : operation === 'status' ? 2 : 3;
  const [queryId, contentType] = definitions[index]!;
  const values = await runtime.queryExtension({
    expectedStoreId: storeId,
    sessionId,
    subjectId,
    extensionId: 'builtin.files',
    queryId,
    input,
  });
  const view = values[0];
  signal.throwIfAborted();
  if (
    values.length !== 1 ||
    !view ||
    view.extensionId !== 'builtin.files' ||
    view.contentType !== contentType ||
    view.contentVersion !== 1 ||
    view.actions.length !== 0
  )
    throw new AgentError('file_checkpoint_response_invalid');
  const after = await runtime.getView(sessionId);
  if (
    (await runtime.getMetadata()).storeId !== storeId ||
    after.storeId !== storeId ||
    after.session.id !== sessionId ||
    after.session.workspaceId !== before.session.workspaceId ||
    after.session.deletedAt !== null ||
    (operation === 'boundary' &&
      after.session.contextSelectionId !== before.session.contextSelectionId)
  )
    throw new AgentError('file_checkpoint_identity_mismatch');
  signal.throwIfAborted();
  if (operation === 'boundary') {
    const value = FileCheckpointRecoveryBoundarySchema.parse(view.payload);
    if (
      value.storeId !== storeId ||
      value.sessionId !== sessionId ||
      value.workspaceId !== before.session.workspaceId ||
      value.contextSelectionId !== before.session.contextSelectionId ||
      !('pointId' in input) ||
      value.checkpoint.id !== input.pointId
    )
      throw new AgentError('file_checkpoint_identity_mismatch');
    return value;
  }
  const value = {
    storeId,
    sessionId,
    workspaceId: before.session.workspaceId,
    payload: view.payload,
  };
  if (operation === 'list') return FileCheckpointPageSchema.parse(value);
  if (operation === 'detail') {
    const detail = FileCheckpointDetailSchema.parse(value);
    if (!('pointId' in input) || detail.payload.checkpoint.id !== input.pointId)
      throw new AgentError('file_checkpoint_identity_mismatch');
    return detail;
  }
  const status = FileRestoreStatusSchema.parse(value);
  const { journal, execution } = status.payload;
  if (
    !('checkpointId' in input) ||
    (journal !== null &&
      (journal.checkpointId !== input.checkpointId || journal.id !== input.restoreId)) ||
    (execution !== null &&
      (journal === null || !('executionId' in journal) || execution.id !== journal.executionId))
  )
    throw new AgentError('file_checkpoint_identity_mismatch');
  return status;
}
