import { createHash } from 'node:crypto';
import type { RuntimeCrossSessionAgentMailMutation } from '@kite-ai/runtime-host/storage';
import type { CrossSessionMailOutboxRecord } from '@kite-ai/runtime-storage-sqlite';
import type { KiteSessionAppServerStorageOwner } from '../kite-session-app-server-storage';
import type { CrossSessionQueueMailModelPort } from './agent-mail-model-input';
import type { CrossSessionQueueMailPort } from './agent-mailbox-port';
import type { RuntimeEvent } from './state-runtime';

type MailAcceptance = Parameters<CrossSessionQueueMailPort['acceptQueueMailCommand']>[0];
type ModelAdmission = Parameters<CrossSessionQueueMailModelPort['persistPreparedInput']>[0];

/** Host callbacks must commit the Event and Store mutation in one owned Session decision. */
export interface CrossSessionMailDecisionCommitters {
  acceptSource(
    input: MailAcceptance & {
      readonly mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'accept_queue' }>;
    },
  ): Promise<void>;
  acceptInterruptSource?(
    input: NonNullable<
      Parameters<NonNullable<CrossSessionQueueMailPort['acceptInterruptCommand']>>[0]
    > & {
      readonly mutation: Extract<
        RuntimeCrossSessionAgentMailMutation,
        { kind: 'request_interrupt' | 'request_queued_interrupt' }
      >;
    },
  ): Promise<void>;
  receiveTarget(input: {
    readonly targetSessionId: string;
    readonly event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }>;
    readonly mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_queue' }>;
  }): Promise<void>;
  prepareModel(
    input: ModelAdmission & {
      readonly mutation: Extract<
        RuntimeCrossSessionAgentMailMutation,
        { kind: 'prepare_queue_input' }
      >;
    },
  ): Promise<boolean>;
}

function targetEvent(
  outbox: CrossSessionMailOutboxRecord,
  sequence: number,
): Extract<RuntimeEvent, { type: 'agent.mail_accepted' }> {
  if (outbox.mode !== 'queue_only' && outbox.mode !== 'reply')
    throw new Error('TriggerTurn outbox cannot be delivered as ordinary Agent mail.');
  return {
    type: 'agent.mail_accepted',
    messageId: outbox.messageId,
    senderAgentId: outbox.sourceSessionId,
    targetAgentId: outbox.targetSessionId,
    mode: outbox.mode,
    source: {
      runId: outbox.sourceRunId,
      turnId: outbox.sourceTurnId,
      modelInvocationId: outbox.sourceModelInvocationId,
      toolCallId: outbox.sourceToolCallId,
      effectAttemptId: outbox.sourceEffectAttemptId,
      ...(outbox.sourceTaskId ? { sourceTaskId: outbox.sourceTaskId } : {}),
    },
    bodyRef: { ...outbox.bodyRef, kind: 'agent_mail' },
    bodyDigest: outbox.bodyRef.integrityIdentifier,
    sequence,
  };
}

/** All Store reads run under the exact source or target execution owner. */
export function createCrossSessionAgentMailComposition(input: {
  readonly owner: KiteSessionAppServerStorageOwner;
  readonly committers: Pick<CrossSessionMailDecisionCommitters, 'receiveTarget'> &
    Partial<
      Pick<
        CrossSessionMailDecisionCommitters,
        'acceptSource' | 'acceptInterruptSource' | 'prepareModel'
      >
    >;
  /** Serializes one target's receipt read, sequence allocation, and Host commit. */
  readonly runTargetDelivery: (
    targetSessionId: string,
    operation: () => Promise<void>,
  ) => Promise<void>;
}): Readonly<{
  mailbox: CrossSessionQueueMailPort;
  modelInput: CrossSessionQueueMailModelPort;
  recoverPending(
    sourceSessionId: string,
    limit?: number,
    afterMessageId?: string,
  ): Promise<Readonly<{ delivered: number; nextCursor?: string }>>;
  recoverPendingReplies(
    sourceSessionId: string,
    limit?: number,
    afterMessageId?: string,
  ): Promise<Readonly<{ delivered: number; nextCursor?: string }>>;
}> {
  const { owner, committers } = input;
  const raw = owner.storage.crossSessionQueueMail;
  const outcomeReader = raw;
  const under = <Result>(sessionId: string, operation: () => Result): Result =>
    owner.runWithSessionExecution(sessionId, operation);
  const deliver = async (sourceSessionId: string, messageId: string): Promise<void> => {
    const outbox = under(sourceSessionId, () => raw.readOutbox(sourceSessionId, messageId));
    if (!outbox) throw new Error('Cross-Session mail has no durable source outbox.');
    if (outbox.mode !== 'queue_only' && outbox.mode !== 'reply')
      throw new Error('Cross-Session ordinary delivery received a TriggerTurn outbox.');
    await input.runTargetDelivery(outbox.targetSessionId, async () => {
      const received = under(outbox.targetSessionId, () =>
        raw.readInboxReceipt(outbox.targetSessionId, messageId),
      );
      if (received) return;
      const sequence = under(outbox.targetSessionId, () =>
        raw.nextTargetSequence(outbox.targetSessionId),
      );
      await committers.receiveTarget({
        targetSessionId: outbox.targetSessionId,
        event: targetEvent(outbox, sequence),
        mutation: {
          kind: 'receive_queue',
          sourceSessionId,
          messageId,
          receivedAtMs: Date.now(),
        },
      });
    });
    under(sourceSessionId, () => raw.confirmDelivered(sourceSessionId, messageId));
  };
  const mailbox: CrossSessionQueueMailPort = {
    listDirectChildren(parentSessionId, currentRunId, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error('Direct child tree page size is invalid.');
      return under(parentSessionId, () => {
        const parent = owner.storage.sessions.loadSnapshot(parentSessionId);
        if (!parent || parent.session.threadId !== parentSessionId)
          throw new Error('Direct child tree has no source Session.');
        const entries: ReturnType<typeof owner.listChildSessions>['entries'][number][] = [];
        const seenCursors = new Set<string>();
        let cursor: Parameters<typeof owner.listChildSessions>[2];
        do {
          const page = owner.listChildSessions(parentSessionId, limit, cursor);
          entries.push(...page.entries);
          cursor = page.nextCursor;
          if (cursor) {
            const cursorKey = JSON.stringify(cursor);
            if (seenCursors.has(cursorKey))
              throw new Error('Direct child tree pagination did not advance.');
            seenCursors.add(cursorKey);
          }
        } while (cursor);
        return entries.flatMap((entry) => {
          const child = owner.readChildSession(parentSessionId, entry.sessionId);
          const state = child?.state;
          if (
            !state ||
            state.session.threadId !== entry.sessionId ||
            state.session.projectId !== parent.session.projectId ||
            state.session.canonicalWorkspaceDigest !== parent.session.canonicalWorkspaceDigest ||
            (state.childSessionOrigin &&
              state.childSessionOrigin.parentSessionId !== parentSessionId)
          )
            return [];
          const unread = raw.readUnreadDirectChildMail(
            parentSessionId,
            currentRunId,
            entry.sessionId,
          );
          const terminal = state.childSessionOrigin?.terminal;
          return [
            {
              agentId: entry.sessionId,
              status:
                state.turn.status === 'active'
                  ? 'running'
                  : (terminal?.status ?? (state.childSessionOrigin ? 'idle' : 'queued')),
              ...(state.turn.status === 'active' && state.activeTaskId
                ? { currentTaskId: state.activeTaskId }
                : {}),
              unreadCount: unread.count,
            },
          ];
        });
      });
    },
    readDirectChildInboxWatermark: (parentSessionId, currentRunId) =>
      under(parentSessionId, () =>
        raw.readDirectChildInboxWatermark(parentSessionId, currentRunId),
      ),
    ...(outcomeReader.readLastFollowupOutcomeForDirectChild
      ? {
          readLastFollowupOutcomeForDirectChild: (
            sourceSessionId: string,
            currentRunId: string,
            childSessionId: string,
          ) =>
            under(sourceSessionId, () =>
              outcomeReader.readLastFollowupOutcomeForDirectChild!(
                sourceSessionId,
                currentRunId,
                childSessionId,
              ),
            ),
        }
      : {}),
    ...(outcomeReader.readDirectChildFollowupOutcomeWatermark
      ? {
          readDirectChildFollowupOutcomeWatermark: (
            sourceSessionId: string,
            currentRunId: string,
          ) =>
            under(sourceSessionId, () =>
              outcomeReader.readDirectChildFollowupOutcomeWatermark!(sourceSessionId, currentRunId),
            ),
        }
      : {}),
    readActiveChildGrant(childSessionId, taskId, grantId) {
      const lineage = owner.readSessionLineage(childSessionId);
      const parentSessionId = lineage?.parentSessionId;
      if (!parentSessionId) return null;
      const child = under(childSessionId, () => {
        const state = owner.storage.sessions.loadSnapshot(childSessionId);
        const generation = owner.storage.currentExecutionGeneration(childSessionId);
        const runId = `run_${createHash('sha256')
          .update(`kite.child-run.v1\0${childSessionId}`)
          .digest('hex')}`;
        const run = owner.storage.runs?.get(childSessionId, runId);
        return { state, generation, run };
      });
      const origin = child.state?.childSessionOrigin;
      const authority = owner.readChildExecutionAuthority(parentSessionId, childSessionId);
      if (
        !origin ||
        origin.parentSessionId !== parentSessionId ||
        origin.childInvocationId !== taskId ||
        origin.terminal ||
        origin.taskInputAdmitted !== true ||
        child.state?.activeTaskId !== taskId ||
        child.state.turn.status !== 'active' ||
        (child.run?.status !== 'running' && child.run?.status !== 'waiting') ||
        authority?.status !== 'active' ||
        String(authority.controllerGeneration) !== child.generation
      )
        return null;
      // The active child Tool already holds the child execution scope. Store
      // rechecks the sealed parent grant and grantId in the source transaction.
      return grantId ? { parentSessionId, grantDigest: origin.grantDigest } : null;
    },
    readTarget(sourceSessionId, targetSessionId) {
      const source = owner.readSessionLineage(sourceSessionId);
      const target = owner.readSessionLineage(targetSessionId);
      if (
        !source ||
        !target ||
        (target.parentSessionId !== sourceSessionId && source.parentSessionId !== targetSessionId)
      )
        return null;
      // The source Tool may be executing inside its own Session scope. Snapshot
      // reads are read-only; Store freezes the target Run in accept_queue.
      const state = owner.storage.sessions.loadSnapshot(targetSessionId);
      if (!state || state.session.threadId !== targetSessionId) return null;
      return {
        sessionId: targetSessionId,
        parentSessionId: target.parentSessionId,
        status: state.childSessionOrigin?.terminal
          ? ('context_unavailable' as const)
          : state.turn.status === 'active'
            ? ('active' as const)
            : ('waiting' as const),
      };
    },
    readInterruptTarget(sourceSessionId, targetSessionId) {
      return under(sourceSessionId, () =>
        raw.readInterruptTarget(sourceSessionId, targetSessionId),
      );
    },
    lookupInterruptReceipt: (request) =>
      under(request.scopeSessionId, () => owner.storage.commandReceipts.lookup(request)),
    readInterruptIntent: (sourceSessionId, commandId) =>
      under(sourceSessionId, () => raw.readInterruptIntent(sourceSessionId, commandId)),
    async acceptInterruptCommand(value) {
      if (!committers.acceptInterruptSource)
        throw new Error('Cross-Session interrupt source has no active Tool commit callback.');
      const queued = value.intent.targetRunId === null;
      if (
        queued &&
        (!value.intent.queuedIntentEventId ||
          value.intent.targetOwnerGeneration !== null ||
          value.intent.targetRevision !== 0)
      )
        throw new Error('Queued interrupt has no exact parent child-intent identity.');
      if (!queued && (!value.intent.targetOwnerGeneration || value.intent.targetRevision < 1))
        throw new Error('Active interrupt has no exact target owner identity.');
      const mutation: Extract<
        RuntimeCrossSessionAgentMailMutation,
        { kind: 'request_interrupt' | 'request_queued_interrupt' }
      > = queued
        ? {
            ...value.intent,
            kind: 'request_queued_interrupt',
            targetRunId: null,
            targetOwnerGeneration: null,
            targetRevision: 0,
            queuedIntentEventId: value.intent.queuedIntentEventId!,
          }
        : {
            ...value.intent,
            kind: 'request_interrupt',
            targetRunId: value.intent.targetRunId!,
            targetOwnerGeneration: value.intent.targetOwnerGeneration!,
          };
      await committers.acceptInterruptSource({ ...value, mutation });
    },
    readFollowupTarget(sourceSessionId, targetSessionId) {
      const target = under(sourceSessionId, () =>
        raw.readFollowupTarget(sourceSessionId, targetSessionId),
      );
      if (!target || target.targetSessionId !== targetSessionId) return null;
      return {
        sessionId: targetSessionId,
        parentSessionId: sourceSessionId,
        status: target.status,
        checkpointReady: target.checkpointReady,
        ...(target.originRole ? { originRole: target.originRole } : {}),
        ...(target.originalGrantDigest ? { originalGrantDigest: target.originalGrantDigest } : {}),
        ...(target.observedTargetRevision !== undefined
          ? { observedTargetRevision: target.observedTargetRevision }
          : {}),
      };
    },
    lookupFollowupReceipt: (input) =>
      under(input.scopeSessionId, () => owner.storage.commandReceipts.lookup(input)),
    nextSourceSequence: (sessionId) => under(sessionId, () => raw.nextSourceSequence(sessionId)),
    lookupOutbox: (sessionId, messageId) =>
      under(sessionId, () => raw.readOutbox(sessionId, messageId)),
    async acceptQueueMailCommand(value) {
      if (!committers.acceptSource)
        throw new Error('Cross-Session mail source has no active Tool commit callback.');
      await committers.acceptSource({
        ...value,
        mutation: {
          kind: 'accept_queue',
          messageId: value.event.messageId,
          targetSessionId: value.intent.targetSessionId,
          commandId: value.receipt.commandId,
          requestDigest: value.receipt.requestDigest,
          sourceRunId: value.event.source.runId,
          sourceTurnId: value.event.source.turnId,
          sourceModelInvocationId: value.event.source.modelInvocationId,
          sourceToolCallId: value.event.source.toolCallId,
          sourceEffectAttemptId: value.event.source.effectAttemptId,
          ...(value.event.source.sourceTaskId
            ? { sourceTaskId: value.event.source.sourceTaskId }
            : {}),
          ...(value.intent.sourceGrantId ? { sourceGrantId: value.intent.sourceGrantId } : {}),
          ...(value.intent.sourceGrantDigest
            ? { sourceGrantDigest: value.intent.sourceGrantDigest }
            : {}),
          sourceSequence: value.event.sequence,
          bodyText: value.intent.bodyText,
          acceptedAtMs: value.intent.acceptedAtMs,
        },
      });
    },
    deliverQueueMail: deliver,
  };
  const modelInput: CrossSessionQueueMailModelPort = {
    readPendingForModel({ targetSessionId, targetTaskId }) {
      const { rows, fromSequence } = under(targetSessionId, () => ({
        rows: raw.listQueuedInbox(targetSessionId, targetTaskId, 8),
        fromSequence: raw.readPreparedThrough(targetSessionId, targetTaskId),
      }));
      return {
        fromSequence,
        rows: rows.map((row) => ({
          messageId: row.messageId,
          sequence: row.sequence,
          sourceSessionId: row.sourceSessionId,
          sourceTaskId: row.sourceTaskId,
          bodyText: row.bodyText,
        })),
      };
    },
    async persistPreparedInput(value) {
      if (!committers.prepareModel)
        throw new Error('Cross-Session mail input has no active Model commit callback.');
      return committers.prepareModel({
        ...value,
        mutation: {
          kind: 'prepare_queue_input',
          modelInvocationId: value.invocationId,
          modelAdmissionId: value.modelAdmissionId,
          currentRunId: value.targetTaskId,
          fromSequence: value.fromSequence,
          throughSequence: value.throughSequence,
          messageIds: value.messageIds,
        },
      });
    },
  };
  return Object.freeze({
    mailbox,
    modelInput,
    async recoverPending(sourceSessionId, limit = 100, afterMessageId) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Cross-Session mail recovery page limit is invalid.');
      // App Server acquires the source owner even after its Run has settled.
      // A foreign or recovery-required owner fails closed and can be retried later.
      const page = under(sourceSessionId, () =>
        raw.listPendingOutbox(sourceSessionId, limit, afterMessageId),
      );
      for (const item of page) await deliver(sourceSessionId, item.messageId);
      return {
        delivered: page.length,
        ...(page.length === limit ? { nextCursor: page.at(-1)!.messageId } : {}),
      };
    },
    async recoverPendingReplies(sourceSessionId, limit = 100, afterMessageId) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Cross-Session reply recovery page limit is invalid.');
      const page = under(sourceSessionId, () =>
        raw.listPendingTerminalReplies(sourceSessionId, limit, afterMessageId),
      );
      for (const item of page) await deliver(sourceSessionId, item.messageId);
      return {
        delivered: page.length,
        ...(page.length === limit ? { nextCursor: page.at(-1)!.messageId } : {}),
      };
    },
  });
}

/** Bootstrap owns target delivery; active effects supply only their own leased commit callback. */
export function createCrossSessionAgentMailBinding(input: {
  readonly owner: KiteSessionAppServerStorageOwner;
  readonly receiveTarget: CrossSessionMailDecisionCommitters['receiveTarget'];
  readonly runTargetDelivery: (
    targetSessionId: string,
    operation: () => Promise<void>,
  ) => Promise<void>;
  readonly scheduleDelivery?: (sourceSessionId: string, messageId: string) => void | Promise<void>;
  /** Target-owned scan of a durable interrupt intent. */
  readonly scheduleInterrupt?: (
    targetSessionId: string,
    sourceSessionId: string,
    commandId: string,
  ) => void | Promise<void>;
  /** TriggerTurn has its own target receipt and recovery path. */
  readonly scheduleFollowup?: (
    sourceSessionId: string,
    submissionId: string,
  ) => void | Promise<void>;
}): Readonly<{
  bindForEffect(
    committers: Readonly<{
      acceptSource?: CrossSessionMailDecisionCommitters['acceptSource'];
      acceptInterruptSource?: CrossSessionMailDecisionCommitters['acceptInterruptSource'];
      prepareModel?: CrossSessionMailDecisionCommitters['prepareModel'];
    }>,
  ): Readonly<{
    mailbox: CrossSessionQueueMailPort;
    modelInput: CrossSessionQueueMailModelPort;
    scheduleDelivery?: (sourceSessionId: string, messageId: string) => void | Promise<void>;
    scheduleInterrupt?: (
      targetSessionId: string,
      sourceSessionId: string,
      commandId: string,
    ) => void | Promise<void>;
    scheduleFollowup?: (sourceSessionId: string, submissionId: string) => void | Promise<void>;
  }>;
  recoverPending: ReturnType<typeof createCrossSessionAgentMailComposition>['recoverPending'];
  recoverPendingReplies: ReturnType<
    typeof createCrossSessionAgentMailComposition
  >['recoverPendingReplies'];
}> {
  const shared = createCrossSessionAgentMailComposition({
    owner: input.owner,
    committers: { receiveTarget: input.receiveTarget },
    runTargetDelivery: input.runTargetDelivery,
  });
  return Object.freeze({
    bindForEffect(committers) {
      const scoped = createCrossSessionAgentMailComposition({
        owner: input.owner,
        committers: { receiveTarget: input.receiveTarget, ...committers },
        runTargetDelivery: input.runTargetDelivery,
      });
      return Object.freeze({
        mailbox: scoped.mailbox,
        modelInput: scoped.modelInput,
        ...(input.scheduleDelivery ? { scheduleDelivery: input.scheduleDelivery } : {}),
        ...(input.scheduleFollowup ? { scheduleFollowup: input.scheduleFollowup } : {}),
        ...(input.scheduleInterrupt ? { scheduleInterrupt: input.scheduleInterrupt } : {}),
      });
    },
    recoverPending: shared.recoverPending,
    recoverPendingReplies: shared.recoverPendingReplies,
  });
}
