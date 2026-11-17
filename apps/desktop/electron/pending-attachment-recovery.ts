import { createHash } from 'node:crypto';
import { type AgentClient, ClientError, type Command, type SessionView } from '@kite-ai/client';
import type { NativeCallerRecord } from '../src/native-bridge';
import type { StoredPendingAttachment } from './pending-attachments';
import type { PrivateData } from './private-data';

const recoveryQueue = new WeakMap<PrivateData, Promise<void>>();
export function recoverRejectedAttachments(
  client: AgentClient,
  data: PrivateData,
  row: NativeCallerRecord,
  command: Command,
  view: SessionView,
): Promise<void> {
  const work = (recoveryQueue.get(data) ?? Promise.resolve())
    .catch(() => {})
    .then(() => performRecovery(client, data, row, command, view));
  recoveryQueue.set(data, work);
  void work.then(
    () => {
      if (recoveryQueue.get(data) === work) recoveryQueue.delete(data);
    },
    () => {
      if (recoveryQueue.get(data) === work) recoveryQueue.delete(data);
    },
  );
  return work;
}

/** A rejected ordinary Command cannot later apply. Read its exact immutable originals;
 * never reuse an input-file import already bound to that rejected Command. */
async function performRecovery(
  client: AgentClient,
  data: PrivateData,
  row: NativeCallerRecord,
  command: Command,
  view: SessionView,
): Promise<void> {
  const attachments = data.attachments;
  if (!attachments || row.phase !== 'rejected' || command.status !== 'rejected') return;
  const original = attachments.recoveryItems(row.intent.request.commandId);
  if (!original?.length) return;
  const request = row.intent.request,
    scope = row.intent.scope;
  const identity = (receipt: Command, current: SessionView) => {
    if (
      !['run.start', 'input.steer', 'input.follow_up'].includes(request.kind) ||
      receipt.id !== request.commandId ||
      receipt.kind !== request.kind ||
      receipt.status !== 'rejected' ||
      receipt.originStoreId !== scope.storeId ||
      receipt.sessionId !== scope.sessionId ||
      receipt.subjectId !== row.intent.subjectId ||
      receipt.requestDigest !== row.intent.requestDigest ||
      client.serverInfo?.storeId !== scope.storeId ||
      client.serverInfo.subjectId !== row.intent.subjectId ||
      current.storeId !== scope.storeId ||
      current.session.id !== scope.sessionId ||
      current.session.workspaceId !== scope.workspaceId ||
      current.session.parentSessionId !== null ||
      current.session.deletedAt !== null
    )
      throw new ClientError('attachment_recovery_unverified');
  };
  const applied = (current: SessionView) =>
    current.runs.some((run) => run.originCommandId === request.commandId) ||
    current.messages.some(
      (message) =>
        message.originCommandId === request.commandId ||
        message.sourceIds?.includes(request.commandId),
    );
  try {
    identity(command, view);
    if (applied(view)) {
      attachments.recoveryNotNeeded(row);
      return;
    }
    const receipt = command.receipt;
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      [
        'runId',
        'businessCommandId',
        'sourceCommandId',
        'observation',
        'humanInputCommandId',
        'decisionCommandId',
      ].some((field) => receipt[field] !== undefined && receipt[field] !== null) ||
      view.session.historyPurgedAt
    )
      throw new ClientError('attachment_recovery_unverified');
    // getView includes only a bounded history prefix. Exhaust the frozen history
    // before declaring there is no durable original input Message. Ordinary Run
    // creation and its original Message are one Service transaction.
    let afterSeq = '0';
    const upperSeq = view.session.nextSeq;
    if (!/^(0|[1-9][0-9]*)$/.test(upperSeq))
      throw new ClientError('attachment_recovery_unverified');
    let complete = BigInt(upperSeq) === 0n;
    for (let pageIndex = 0; !complete && pageIndex < 256; pageIndex++) {
      const messages = await client.listMessages(scope.sessionId, {
        afterSeq,
        upperSeq,
        limit: 200,
        previews: true,
      });
      if (
        messages.some(
          (message) =>
            message.originCommandId === request.commandId ||
            message.sourceIds?.includes(request.commandId),
        )
      ) {
        attachments.recoveryNotNeeded(row);
        return;
      }
      if (messages.length < 200) {
        complete = true;
        break;
      }
      const next = messages.at(-1)!.seq;
      if (BigInt(next) <= BigInt(afterSeq) || BigInt(next) > BigInt(upperSeq))
        throw new ClientError('attachment_recovery_unverified');
      afterSeq = next;
    }
    if (!complete) throw new ClientError('attachment_recovery_history_unavailable');
    const restored: StoredPendingAttachment[] = [];
    for (const item of original) {
      const id = `retry-${createHash('sha256')
        .update(JSON.stringify([scope.storeId, scope.sessionId, request.commandId, item.id]))
        .digest('hex')
        .slice(0, 32)}`;
      if (item.kind === 'reference') {
        if (
          !('files' in request) ||
          !request.files?.some(
            (file) => !file.reference && file.name === item.name && file.uri === item.uri,
          )
        )
          throw new ClientError('attachment_recovery_unverified');
        restored.push({ ...item, id });
        continue;
      }
      const referenceId =
        item.kind === 'image'
          ? `input-image-${item.id}-${scope.sessionId}`
          : `input-file-${createHash('sha256')
              .update(JSON.stringify([scope.storeId, scope.sessionId, item.id]))
              .digest('hex')}`;
      const values =
        item.kind === 'image'
          ? 'images' in request
            ? request.images
            : undefined
          : 'files' in request
            ? request.files
            : undefined;
      const published = values?.find(
          (file) => file.reference?.id === referenceId && file.name === item.name,
        ),
        reference = published?.reference;
      if (
        !reference ||
        reference.storeId !== scope.storeId ||
        reference.sessionId !== scope.sessionId ||
        reference.subjectId !== row.intent.subjectId ||
        reference.hash !== item.hash ||
        reference.size !== String(item.size) ||
        reference.mediaType !== item.mediaType ||
        reference.scope.kind !== 'session' ||
        reference.scope.id !== scope.sessionId
      )
        throw new ClientError('attachment_recovery_unverified');
      const result = await client.readArtifact(
        scope.sessionId,
        { expectedStoreId: scope.storeId, refId: reference.id, scope: reference.scope },
        { expectedReference: reference },
      );
      if (
        result.content.byteLength !== item.size ||
        createHash('sha256').update(result.content).digest('hex') !== item.hash
      )
        throw new ClientError('artifact_content_mismatch');
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < result.content.byteLength; offset += 65536)
        chunks.push(result.content.subarray(offset, offset + 65536));
      restored.push({ ...item, id, chunks });
    }
    const finalCommand = await client.getCommand(request.commandId),
      finalView = await client.getView(scope.sessionId);
    identity(finalCommand, finalView);
    if (applied(finalView)) {
      attachments.recoveryNotNeeded(row);
      return;
    }
    attachments.recover(row, restored);
  } catch (error) {
    const code =
      error instanceof ClientError ? error.code : error instanceof Error ? error.message : '';
    // The verified rejection is still a rejection even when byte recovery fails.
    // Its durable original and recovery marker remain queryable; no POST occurs.
    attachments.recoveryFailed(row, code);
  }
}
