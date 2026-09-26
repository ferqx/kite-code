import { expect, test } from 'bun:test';
import type { CrossSessionMailOutboxRecord } from '@kite-ai/runtime-storage-sqlite';
import type { KiteSessionAppServerStorageOwner } from '#kite-service/bootstrap/kite-session-app-server-storage';
import {
  type CrossSessionMailDecisionCommitters,
  createCrossSessionAgentMailBinding,
  createCrossSessionAgentMailComposition,
} from '#kite-service/bootstrap/runtime/cross-session-agent-mail-composition';

const runTargetDelivery = async (_targetSessionId: string, operation: () => Promise<void>) =>
  operation();

test('followup target readiness is read under the source owner and only from Store proof', () => {
  const reads: string[] = [];
  const owner = {
    runWithSessionExecution<Result>(sessionId: string, operation: () => Result): Result {
      reads.push(sessionId);
      return operation();
    },
    storage: {
      crossSessionQueueMail: {
        readFollowupTarget: (sourceSessionId: string, targetSessionId: string) => {
          expect([sourceSessionId, targetSessionId]).toEqual(['parent', 'child']);
          return {
            targetSessionId: 'child',
            status: 'idle',
            targetRunId: null,
            checkpointReady: true,
          };
        },
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const composition = createCrossSessionAgentMailComposition({
    owner,
    committers: { receiveTarget: async () => undefined },
    runTargetDelivery,
  });
  expect(composition.mailbox.readFollowupTarget?.('parent', 'child')).toEqual({
    sessionId: 'child',
    parentSessionId: 'parent',
    status: 'idle',
    checkpointReady: true,
  });
  expect(reads).toEqual(['parent']);
});

test('effect binding fails closed when its leased source or model callback is absent', async () => {
  const owner = {
    storage: { crossSessionQueueMail: {} },
  } as unknown as KiteSessionAppServerStorageOwner;
  const scheduleDelivery = async () => undefined;
  const binding = createCrossSessionAgentMailBinding({
    owner,
    receiveTarget: async () => undefined,
    runTargetDelivery,
    scheduleDelivery,
  });
  const scoped = binding.bindForEffect({});
  expect(scoped.scheduleDelivery).toBe(scheduleDelivery);
  await expect(
    scoped.mailbox.acceptQueueMailCommand(
      {} as Parameters<typeof scoped.mailbox.acceptQueueMailCommand>[0],
    ),
  ).rejects.toThrow('active Tool commit callback');
  await expect(
    scoped.modelInput.persistPreparedInput(
      {} as Parameters<typeof scoped.modelInput.persistPreparedInput>[0],
    ),
  ).rejects.toThrow('active Model commit callback');
});

test('recovery delivers one source outbox through target receipt and confirms it', async () => {
  const outbox: CrossSessionMailOutboxRecord = {
    mode: 'queue_only',
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    messageId: 'mail-1',
    commandId: 'mail-1',
    requestDigest: 'a'.repeat(64),
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceModelInvocationId: 'model-1',
    sourceToolCallId: 'tool-1',
    sourceEffectAttemptId: 'attempt-1',
    sourceTaskId: null,
    sourceGrantId: null,
    sourceGrantDigest: null,
    targetRunId: 'run-child',
    sourceSequence: 1,
    sourceRevision: 3,
    acceptedAtMs: 1,
    deliveredTargetRevision: null,
    bodyRef: {
      artifactId: `pa_${'b'.repeat(64)}`,
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 5,
    },
  };
  let ownerSession: string | null = null;
  let inboxPresent = false;
  let confirmed = false;
  const decisions: unknown[] = [];
  const owner = {
    runWithSessionExecution<Result>(sessionId: string, operation: () => Result): Result {
      const prior = ownerSession;
      ownerSession = sessionId;
      try {
        return operation();
      } finally {
        ownerSession = prior;
      }
    },
    storage: {
      crossSessionQueueMail: {
        readOutbox: (sessionId: string) => {
          expect(ownerSession).toBe(sessionId);
          return outbox;
        },
        readInboxReceipt: (sessionId: string) => {
          expect(ownerSession).toBe(sessionId);
          return inboxPresent ? { sequence: 1, targetRevision: 4 } : null;
        },
        nextTargetSequence: (sessionId: string) => {
          expect(ownerSession).toBe(sessionId);
          return 1;
        },
        confirmDelivered: (sessionId: string) => {
          expect(ownerSession).toBe(sessionId);
          confirmed = true;
          return outbox;
        },
        listPendingOutbox: (sessionId: string) => {
          expect(ownerSession).toBe(sessionId);
          return confirmed ? [] : [outbox];
        },
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const committers: CrossSessionMailDecisionCommitters = {
    async acceptSource() {
      throw new Error('Recovery must not accept a second source command.');
    },
    async receiveTarget(input) {
      decisions.push(input);
      inboxPresent = true;
    },
    async prepareModel() {
      throw new Error('Delivery must not prepare model input.');
    },
  };
  const composition = createCrossSessionAgentMailComposition({
    owner,
    committers,
    runTargetDelivery,
  });
  expect(await composition.recoverPending('parent')).toEqual({ delivered: 1 });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    targetSessionId: 'child',
    event: {
      type: 'agent.mail_accepted',
      senderAgentId: 'parent',
      targetAgentId: 'child',
      source: { runId: 'run-1', toolCallId: 'tool-1' },
      sequence: 1,
    },
    mutation: { kind: 'receive_queue', sourceSessionId: 'parent', messageId: 'mail-1' },
  });
  expect(confirmed).toBe(true);
  expect(await composition.recoverPending('parent')).toEqual({ delivered: 0 });
  expect(decisions).toHaveLength(1);
});

test('QueueOnly recovery never delivers a TriggerTurn outbox as ordinary mail', async () => {
  const trigger = {
    mode: 'trigger_turn',
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    messageId: 'followup-1',
  } as CrossSessionMailOutboxRecord;
  let received = 0;
  let confirmed = 0;
  const owner = {
    runWithSessionExecution<Result>(_sessionId: string, operation: () => Result): Result {
      return operation();
    },
    storage: {
      crossSessionQueueMail: {
        readOutbox: () => trigger,
        listPendingOutbox: () => [trigger],
        confirmDelivered: () => {
          confirmed++;
          return trigger;
        },
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const composition = createCrossSessionAgentMailComposition({
    owner,
    committers: {
      async receiveTarget() {
        received++;
      },
    },
    runTargetDelivery,
  });
  await expect(composition.recoverPending('parent')).rejects.toThrow('TriggerTurn outbox');
  await expect(composition.mailbox.deliverQueueMail('parent', 'followup-1')).rejects.toThrow(
    'TriggerTurn outbox',
  );
  expect(received).toBe(0);
  expect(confirmed).toBe(0);
});

test('direct child tree reads only matching lineage and current-Run unread counts', () => {
  const reads: string[] = [];
  const parentSession = {
    threadId: 'parent',
    projectId: 'project',
    canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
  };
  const childState = (sessionId: string, digest = parentSession.canonicalWorkspaceDigest) => ({
    session: { ...parentSession, threadId: sessionId, canonicalWorkspaceDigest: digest },
    turn: { status: 'active' },
    activeTaskId: 'task',
    childSessionOrigin: { parentSessionId: 'parent' },
  });
  const owner = {
    runWithSessionExecution<Result>(sessionId: string, operation: () => Result): Result {
      reads.push(`owner:${sessionId}`);
      return operation();
    },
    listChildSessions: (_parent: string, limit: number) => {
      expect(limit).toBe(63);
      return {
        entries: [{ sessionId: 'child' }, { sessionId: 'foreign-workspace' }],
      };
    },
    readChildSession: (_parent: string, sessionId: string) => ({
      state:
        sessionId === 'child'
          ? childState(sessionId)
          : childState(sessionId, `sha256:${'b'.repeat(64)}`),
    }),
    storage: {
      sessions: { loadSnapshot: () => ({ session: parentSession }) },
      crossSessionQueueMail: {
        readUnreadDirectChildMail: (_parent: string, run: string, child: string) => {
          reads.push(`child:${run}:${child}`);
          return { count: 2, throughSequence: 7 };
        },
        readDirectChildInboxWatermark: (_parent: string, run: string) => {
          reads.push(`inbox:${run}`);
          return { unreadCount: 2, throughSequence: 7 };
        },
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const mailbox = createCrossSessionAgentMailComposition({
    owner,
    committers: { async receiveTarget() {} },
    runTargetDelivery,
  }).mailbox;
  expect(mailbox.listDirectChildren?.('parent', 'run-1', 63)).toEqual([
    { agentId: 'child', status: 'running', currentTaskId: 'task', unreadCount: 2 },
  ]);
  expect(mailbox.readDirectChildInboxWatermark?.('parent', 'run-1')).toEqual({
    unreadCount: 2,
    throughSequence: 7,
  });
  expect(reads).toEqual(['owner:parent', 'child:run-1:child', 'owner:parent', 'inbox:run-1']);
});

test('target queue serializes concurrent source deliveries before sequence allocation', async () => {
  const receipts = new Map<string, number>();
  const sequences: number[] = [];
  let queue = Promise.resolve();
  const owner = {
    runWithSessionExecution<Result>(_sessionId: string, operation: () => Result): Result {
      return operation();
    },
    storage: {
      crossSessionQueueMail: {
        readOutbox: (sourceSessionId: string, messageId: string) => ({
          mode: 'queue_only',
          sourceSessionId,
          targetSessionId: 'target',
          messageId,
          sourceRunId: 'run',
          sourceTurnId: 'turn',
          sourceModelInvocationId: 'model',
          sourceToolCallId: 'tool',
          sourceEffectAttemptId: 'attempt',
          sourceTaskId: null,
          bodyRef: {
            artifactId: `pa_${'a'.repeat(64)}`,
            integrityIdentifier: `sha256:${'a'.repeat(64)}`,
            byteLength: 1,
          },
        }),
        readInboxReceipt: (_target: string, messageId: string) =>
          receipts.has(messageId) ? { sequence: receipts.get(messageId) } : null,
        nextTargetSequence: () => receipts.size + 1,
        confirmDelivered: () => ({}),
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const composition = createCrossSessionAgentMailComposition({
    owner,
    committers: {
      async receiveTarget({ event }) {
        await Promise.resolve();
        if (receipts.has(event.messageId)) throw new Error('duplicate target receipt');
        receipts.set(event.messageId, event.sequence);
        sequences.push(event.sequence);
      },
    },
    runTargetDelivery(_target, operation) {
      const next = queue.then(operation);
      queue = next.catch(() => undefined);
      return next;
    },
  });
  await Promise.all([
    composition.mailbox.deliverQueueMail('source-a', 'mail-a'),
    composition.mailbox.deliverQueueMail('source-b', 'mail-b'),
  ]);
  expect(sequences).toEqual([1, 2]);
  expect(receipts.size).toBe(2);
});

test('child grant precheck requires live State, Run, and owner generation', () => {
  let runStatus: 'running' | 'completed' = 'running';
  let generation = '7';
  let originTask = 'task-1';
  const owner = {
    readSessionLineage: (sessionId: string) =>
      sessionId === 'child' ? { parentSessionId: 'parent' } : null,
    readChildExecutionAuthority: () => ({ status: 'active', controllerGeneration: 7 }),
    readChildSealedGrant: () => ({
      sealedGrantJson: JSON.stringify({ grantId: 'grant-1' }),
      sealedGrantDigest: `sha256:${'b'.repeat(64)}`,
    }),
    runWithSessionExecution<Result>(_sessionId: string, operation: () => Result): Result {
      return operation();
    },
    storage: {
      sessions: {
        loadSnapshot: () => ({
          activeTaskId: 'task-1',
          turn: { status: 'active' },
          childSessionOrigin: {
            parentSessionId: 'parent',
            childInvocationId: originTask,
            grantDigest: `sha256:${'b'.repeat(64)}`,
            taskInputAdmitted: true,
          },
        }),
      },
      runs: { get: () => ({ status: runStatus }) },
      currentExecutionGeneration: () => generation,
      crossSessionQueueMail: {},
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const committers = {
    acceptSource: async () => {},
    receiveTarget: async () => {},
    prepareModel: async () => true,
  } satisfies CrossSessionMailDecisionCommitters;
  const mailbox = createCrossSessionAgentMailComposition({
    owner,
    committers,
    runTargetDelivery,
  }).mailbox;
  expect(mailbox.readActiveChildGrant('child', 'task-1', 'grant-1')).toEqual({
    parentSessionId: 'parent',
    grantDigest: `sha256:${'b'.repeat(64)}`,
  });
  // The source transaction rechecks the exact sealed grantId under Store authority.
  expect(mailbox.readActiveChildGrant('child', 'task-1', '')).toBeNull();
  runStatus = 'completed';
  expect(mailbox.readActiveChildGrant('child', 'task-1', 'grant-1')).toBeNull();
  runStatus = 'running';
  generation = '8';
  expect(mailbox.readActiveChildGrant('child', 'task-1', 'grant-1')).toBeNull();
  generation = '7';
  originTask = 'other-task';
  expect(mailbox.readActiveChildGrant('child', 'task-1', 'grant-1')).toBeNull();
});

test('queued mail is read only for its persisted target Run', () => {
  const requestedRuns: string[] = [];
  const owner = {
    runWithSessionExecution<Result>(_sessionId: string, operation: () => Result): Result {
      return operation();
    },
    storage: {
      crossSessionQueueMail: {
        readPreparedThrough: (_target: string, currentRunId: string) =>
          currentRunId === 'old-run' ? 0 : 5,
        listQueuedInbox: (_target: string, currentRunId: string) => {
          requestedRuns.push(currentRunId);
          return currentRunId === 'old-run'
            ? [{ messageId: 'old-mail', sequence: 7, sourceSessionId: 'child', bodyText: 'old' }]
            : [];
        },
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const committers = {
    acceptSource: async () => {},
    receiveTarget: async () => {},
    prepareModel: async () => true,
  } satisfies CrossSessionMailDecisionCommitters;
  const input = createCrossSessionAgentMailComposition({
    owner,
    committers,
    runTargetDelivery,
  }).modelInput;
  expect(
    input.readPendingForModel({
      targetSessionId: 'parent',
      targetTaskId: 'later-run',
      modelInvocationId: 'later-model',
    }),
  ).toEqual({ fromSequence: 5, rows: [] });
  expect(requestedRuns).toEqual(['later-run']);
  expect(
    input.readPendingForModel({
      targetSessionId: 'parent',
      targetTaskId: 'old-run',
      modelInvocationId: 'old-model',
    }),
  ).toMatchObject({
    fromSequence: 0,
    rows: [{ messageId: 'old-mail', sequence: 7, bodyText: 'old' }],
  });
});

test('idle direct child remains a QueueOnly target without starting its Run', () => {
  let runLookup = 0;
  const owner = {
    readSessionLineage: (sessionId: string) =>
      sessionId === 'parent'
        ? { parentSessionId: null }
        : sessionId === 'child'
          ? { parentSessionId: 'parent' }
          : null,
    runWithSessionExecution<Result>(_sessionId: string, operation: () => Result): Result {
      return operation();
    },
    storage: {
      sessions: {
        loadSnapshot: () => ({
          session: { threadId: 'child' },
          turn: { status: 'idle' },
        }),
      },
      runs: {
        get: () => {
          runLookup++;
          return null;
        },
      },
      crossSessionQueueMail: {},
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const committers = {
    acceptSource: async () => {},
    receiveTarget: async () => {},
    prepareModel: async () => true,
  } satisfies CrossSessionMailDecisionCommitters;
  const mailbox = createCrossSessionAgentMailComposition({
    owner,
    committers,
    runTargetDelivery,
  }).mailbox;
  expect(mailbox.readTarget('parent', 'child')).toEqual({
    sessionId: 'child',
    parentSessionId: 'parent',
    status: 'waiting',
  });
  expect(mailbox.readTarget('unrelated', 'child')).toBeNull();
  expect(runLookup).toBe(0);
});

test('source transaction forwards child grant proof to Store mutation', async () => {
  const accepted: unknown[] = [];
  const owner = {
    storage: { crossSessionQueueMail: {} },
  } as unknown as KiteSessionAppServerStorageOwner;
  const committers: CrossSessionMailDecisionCommitters = {
    async acceptSource(input) {
      accepted.push(input);
    },
    async receiveTarget() {},
    async prepareModel() {
      return true;
    },
  };
  const composition = createCrossSessionAgentMailComposition({
    owner,
    committers,
    runTargetDelivery,
  });
  const event = {
    type: 'agent.mail_accepted',
    messageId: 'mail-1',
    senderAgentId: 'child',
    targetAgentId: 'parent',
    mode: 'queue_only',
    source: {
      runId: 'child-run',
      turnId: 'turn',
      modelInvocationId: 'model',
      toolCallId: 'tool',
      effectAttemptId: 'attempt',
      sourceTaskId: 'task',
    },
    bodyRef: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'agent_mail',
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 5,
    },
    bodyDigest: `sha256:${'b'.repeat(64)}`,
    sequence: 1,
  } as const;
  await composition.mailbox.acceptQueueMailCommand({
    event,
    receipt: {
      scopeSessionId: 'child',
      targetSessionId: 'child',
      commandId: 'mail-1',
      requestDigest: 'a'.repeat(64),
      committedAt: 1,
    },
    intent: {
      sourceSessionId: 'child',
      targetSessionId: 'parent',
      messageId: 'mail-1',
      commandId: 'mail-1',
      requestDigest: 'a'.repeat(64),
      sourceRunId: 'child-run',
      sourceGrantId: 'grant-1',
      sourceGrantDigest: `sha256:${'c'.repeat(64)}`,
      bodyText: 'reply',
      acceptedAtMs: 1,
    },
  });
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    mutation: {
      kind: 'accept_queue',
      sourceTaskId: 'task',
      sourceGrantId: 'grant-1',
      sourceGrantDigest: `sha256:${'c'.repeat(64)}`,
    },
  });
});

test('followup outcome metadata is read under the exact source owner without consuming inbox', () => {
  const scopes: string[] = [];
  const owner = {
    runWithSessionExecution<Result>(sessionId: string, operation: () => Result): Result {
      scopes.push(sessionId);
      return operation();
    },
    storage: {
      crossSessionQueueMail: {
        readLastFollowupOutcomeForDirectChild: (source: string, run: string, child: string) => {
          expect([source, run, child]).toEqual(['parent', 'current-run', 'child']);
          return {
            submissionId: 'submission-1',
            status: 'unknown' as const,
            taskId: 'followup-task',
            sourceRevision: 8,
          };
        },
        readDirectChildFollowupOutcomeWatermark: (source: string, run: string) => {
          expect([source, run]).toEqual(['parent', 'current-run']);
          return { count: 1, throughRevision: 8 };
        },
      },
    },
  } as unknown as KiteSessionAppServerStorageOwner;
  const composition = createCrossSessionAgentMailComposition({
    owner,
    committers: { receiveTarget: async () => undefined },
    runTargetDelivery,
  });
  expect(
    composition.mailbox.readLastFollowupOutcomeForDirectChild?.('parent', 'current-run', 'child'),
  ).toMatchObject({ status: 'unknown', taskId: 'followup-task' });
  expect(
    composition.mailbox.readDirectChildFollowupOutcomeWatermark?.('parent', 'current-run'),
  ).toEqual({ count: 1, throughRevision: 8 });
  expect(scopes).toEqual(['parent', 'parent']);
});
