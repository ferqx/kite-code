import { ClientError } from './decode';
import type {
  FileCheckpointDetail,
  FileCheckpointListQuery,
  FileCheckpointPage,
  FileCheckpointRecoveryBoundary,
  FileRestoreStatus,
} from './generated/api';
import { parseCursorSequence } from './sse';

export function validateFileCheckpointTarget(
  sessionId: string,
  pointId?: string,
  restoreId?: string,
): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
    (pointId !== undefined && !/^[a-f0-9]{64}$/.test(pointId)) ||
    (restoreId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(restoreId))
  )
    throw new ClientError('invalid_file_checkpoint_target');
}
export function verifyFileCheckpointObservation<
  T extends
    | FileCheckpointPage
    | FileCheckpointDetail
    | FileRestoreStatus
    | FileCheckpointRecoveryBoundary,
>(value: T, target: { storeId: string; sessionId: string }): T {
  if (value.storeId !== target.storeId || value.sessionId !== target.sessionId)
    throw new ClientError('file_checkpoint_identity_mismatch');
  return value;
}
export function verifyFileCheckpointPage(
  page: FileCheckpointPage,
  query: FileCheckpointListQuery,
): FileCheckpointPage {
  let previous = query.afterKey ?? '';
  for (const item of page.payload.items) {
    const key = `checkpoint/${item.checkpoint.id}/point`;
    if (key <= previous) throw new ClientError('invalid_file_checkpoint_page');
    parseCursorSequence(item.revision);
    parseCursorSequence(item.checkpoint.boundary.messageSeq);
    parseCursorSequence(item.checkpoint.boundary.triggerSeq);
    previous = key;
  }
  if (
    page.payload.items.length > (query.limit ?? 50) ||
    (page.payload.nextAfterKey !== null &&
      (page.payload.items.length !== (query.limit ?? 50) || page.payload.nextAfterKey !== previous))
  )
    throw new ClientError('invalid_file_checkpoint_page');
  return page;
}
export function verifyFileCheckpointDetail(
  detail: FileCheckpointDetail,
  pointId: string,
): FileCheckpointDetail {
  if (
    detail.payload.checkpoint.id !== pointId ||
    new Set(detail.payload.files.map((file) => file.path)).size !== detail.payload.files.length
  )
    throw new ClientError('file_checkpoint_identity_mismatch');
  parseCursorSequence(detail.payload.checkpoint.boundary.messageSeq);
  parseCursorSequence(detail.payload.checkpoint.boundary.triggerSeq);
  for (const file of detail.payload.files) parseCursorSequence(file.recordRevision);
  return detail;
}
export function verifyFileRestoreStatus(
  status: FileRestoreStatus,
  pointId: string,
  restoreId: string,
): FileRestoreStatus {
  const { journal, execution } = status.payload;
  if (
    (journal !== null && (journal.id !== restoreId || journal.checkpointId !== pointId)) ||
    (execution !== null &&
      (journal === null || !('executionId' in journal) || execution.id !== journal.executionId))
  )
    throw new ClientError('file_checkpoint_identity_mismatch');
  if (execution) parseCursorSequence(execution.resultRevision);
  if (journal && 'rootWorkSeq' in journal) parseCursorSequence(journal.rootWorkSeq);
  if (journal && 'headRevision' in journal) {
    parseCursorSequence(journal.headRevision);
    for (const file of journal.fileRevisions) parseCursorSequence(file.revision);
  }
  return status;
}

export function verifyFileCheckpointRecoveryBoundary(
  value: FileCheckpointRecoveryBoundary,
  pointId: string,
): FileCheckpointRecoveryBoundary {
  const trigger = parseCursorSequence(value.trigger.seq),
    boundary = value.boundary === null ? 0n : parseCursorSequence(value.boundary.seq);
  parseCursorSequence(value.checkpoint.boundary.messageSeq);
  parseCursorSequence(value.checkpoint.boundary.triggerSeq);
  if (
    value.checkpoint.id !== pointId ||
    trigger === 0n ||
    boundary >= trigger ||
    (value.boundary !== null && value.boundary.messageId === value.trigger.messageId)
  )
    throw new ClientError('file_checkpoint_identity_mismatch');
  return value;
}
