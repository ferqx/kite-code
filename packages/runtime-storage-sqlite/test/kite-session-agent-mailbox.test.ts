import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  RuntimeAgentMailboxMutation,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import { createKiteHomeArtifactStore } from '../src/kite-home-artifacts';
import { initializeKiteSessionStoreIfNeeded } from '../src/kite-home-store';
import {
  applyKiteSessionAgentMailboxMutations,
  createKiteSessionAgentMetadataPort,
  KiteSessionAgentMailboxError,
  settleRootAgentRunInTransaction,
  startRootAgentRunInTransaction,
} from '../src/kite-session-agent-mailbox';

type Event = Readonly<Record<string, unknown>>;
const sessionId = 'session-1';

function fixture(): Database {
  const db = new Database(':memory:', { strict: true });
  initializeKiteSessionStoreIfNeeded(db);
  db.query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,display_name,created_at,updated_at)
    VALUES ('workspace-1','/workspace','sha256:${'1'.repeat(64)}','project-1','digest-1','Workspace',1,1)`).run();
  db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,name,updated_at,run_index_from_revision)
    VALUES (?,'workspace-1','project-1','digest-1',27,'kite-agent-server-api-v1-2026-08-29',0,'',1,0)`).run(
    sessionId,
  );
  return db;
}

function commit(
  db: Database,
  events: readonly Event[],
  mutations: readonly RuntimeAgentMailboxMutation[],
  receipt?: RuntimeTransactionInput<Event, object>['commandReceipt'],
  snapshot: object = {},
): void {
  db.transaction(() =>
    applyKiteSessionAgentMailboxMutations(
      db,
      {
        sessionId,
        events,
        snapshot,
        agentMailboxMutations: mutations,
        ...(receipt
          ? {
              commandReceipt: receipt,
              requiredEffectLease: {
                effectId: receipt.commandId,
                ownerId: 'tool-owner',
                observedAtMs: receipt.committedAt,
              },
            }
          : {}),
      },
      mutations.some((mutation) => mutation.kind === 'turn_started') ? '1' : undefined,
    ),
  )();
}

function agents(db: Database): void {
  db.query(
    "INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms) VALUES (? ,? ,NULL,NULL,'idle',0,1)",
  ).run(sessionId, sessionId);
  const child = {
    kind: 'create_agent',
    agentId: 'child-1',
    parentAgentId: sessionId,
    initialTaskId: 'child-1',
    createdAtMs: 2,
  } as const;
  const turn = {
    kind: 'turn_started',
    agentId: 'child-1',
    taskId: 'child-1',
    turnOrdinal: 1,
  } as const;
  commit(
    db,
    [
      {
        type: 'agent.created',
        agentId: 'child-1',
        parentAgentId: sessionId,
        initialTaskId: 'child-1',
      },
      {
        type: 'agent.turn_started',
        agentId: 'child-1',
        taskId: 'child-1',
        turnOrdinal: 1,
        ownerGeneration: '1',
        grantDigest: `sha256:${'a'.repeat(64)}`,
      },
    ],
    [child, turn],
  );
}

function mail(sequence: number, bodyText = `message ${sequence}`) {
  const hex = createHash('sha256').update(bodyText).digest('hex');
  const messageId = `mail-${sequence}`;
  const mutation = {
    kind: 'accept_mail',
    messageId,
    senderAgentId: sessionId,
    targetAgentId: 'child-1',
    mode: 'queue_only',
    source: {
      runId: 'run-1',
      turnId: 'turn-1',
      modelInvocationId: 'model-1',
      toolCallId: `tool-${sequence}`,
      effectAttemptId: `attempt-${sequence}`,
    },
    bodyRef: {
      artifactId: `pa_${hex}`,
      kind: 'agent_mail',
      integrityIdentifier: `sha256:${hex}`,
      byteLength: Buffer.byteLength(bodyText),
    },
    bodyDigest: `sha256:${hex}`,
    bodyText,
    requestDigest: hex,
    sequence,
    acceptedAtMs: sequence + 10,
  } as const;
  const event = {
    type: 'agent.mail_accepted',
    messageId,
    senderAgentId: sessionId,
    targetAgentId: 'child-1',
    mode: 'queue_only',
    source: mutation.source,
    bodyRef: mutation.bodyRef,
    bodyDigest: mutation.bodyDigest,
    sequence,
  };
  const receipt = {
    scopeSessionId: sessionId,
    commandId: messageId,
    requestDigest: hex,
    targetSessionId: sessionId,
    originalReceiptJson: '{}',
    committedRevision: 1,
    committedAt: sequence + 10,
  };
  return { mutation, event, receipt };
}

describe('Store11 Agent mailbox transaction rows', () => {
  test('binds root mail only to the matching active recipient Run', () => {
    const db = fixture();
    try {
      agents(db);
      const start = (runId: string, revision: number): void => {
        const run = {
          sessionId,
          runId,
          startCommandId: `start-${runId}`,
          phase: 'building' as const,
          status: 'queued' as const,
          createdRevision: revision,
          lastRevision: revision,
          createdAtMs: revision,
        };
        db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          sessionId,
          runId,
          run.startCommandId,
          'building',
          'queued',
          revision,
          revision,
          revision,
        );
        db.transaction(() =>
          startRootAgentRunInTransaction(db, {
            sessionId,
            events: [{ type: 'turn.started', turnId: runId }],
            snapshot: {},
            runMutation: { type: 'insert', run },
          }),
        )();
      };
      const sendToRoot = (sequence: number, sourceRunId: string): void => {
        const base = mail(sequence);
        const source = { ...base.mutation.source, runId: sourceRunId };
        const mutation = {
          ...base.mutation,
          senderAgentId: 'child-1',
          targetAgentId: sessionId,
          source,
        };
        const event = { ...base.event, senderAgentId: 'child-1', targetAgentId: sessionId, source };
        commit(db, [event], [mutation], base.receipt);
      };
      start('run-a', 1);
      sendToRoot(1, 'run-a');
      expect(
        db
          .query<{ recipient_run_id: string | null }, []>(
            "SELECT recipient_run_id FROM agent_mail WHERE message_id='mail-1'",
          )
          .get()?.recipient_run_id,
      ).toBe('run-a');
      db.query(
        "UPDATE agent_nodes SET status='idle',current_task_id=NULL WHERE session_id=? AND agent_id=?",
      ).run(sessionId, sessionId);
      start('run-b', 2);
      sendToRoot(2, 'run-a');
      expect(
        db
          .query<{ recipient_run_id: string | null }, []>(
            "SELECT recipient_run_id FROM agent_mail WHERE message_id='mail-2'",
          )
          .get()?.recipient_run_id,
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  test('child settlement requires the stored owner generation and advances a proven checkpoint', () => {
    const db = fixture();
    try {
      agents(db);
      const canonicalJson = '{"artifactFormatVersion":1,"messages":[]}';
      const digest = createHash('sha256').update(canonicalJson).digest('hex');
      const checkpointRef = {
        artifactId: `pa_${digest}`,
        kind: 'subagent_checkpoint' as const,
        integrityIdentifier: `sha256:${digest}`,
        byteLength: Buffer.byteLength(canonicalJson),
      };
      createKiteHomeArtifactStore(db).writeSubagentCheckpoint({
        ref: checkpointRef,
        artifactFormatVersion: 1,
        canonicalJson,
        createdAt: 3,
      });
      const mutation = {
        kind: 'task_settled',
        agentId: 'child-1',
        taskId: 'child-1',
        checkpointRef,
      } as const;
      const event = {
        type: 'agent.task_settled',
        agentId: 'child-1',
        taskId: 'child-1',
        checkpointRef,
      };
      expect(() => commit(db, [{ ...event, ownerGeneration: '2' }], [mutation])).toThrow(
        KiteSessionAgentMailboxError,
      );
      expect(
        createKiteSessionAgentMetadataPort(db).readAgent(sessionId, sessionId, 'child-1'),
      ).toMatchObject({ status: 'active' });
      commit(db, [{ ...event, ownerGeneration: '1' }], [mutation]);
      expect(
        createKiteSessionAgentMetadataPort(db).readAgent(sessionId, sessionId, 'child-1'),
      ).toMatchObject({ status: 'idle' });
      expect(
        db
          .query<{ latest_checkpoint_artifact_id: string }, []>(
            "SELECT latest_checkpoint_artifact_id FROM agent_nodes WHERE agent_id='child-1'",
          )
          .get()?.latest_checkpoint_artifact_id,
      ).toBe(checkpointRef.artifactId);
    } finally {
      db.close();
    }
  });
  test('closes only the exact root task after the canonical Run terminal row and event', () => {
    const db = fixture();
    try {
      agents(db);
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms)
        VALUES (?,'run-1','start-1','building','queued',0,0,1)`).run(sessionId);
      db.transaction(() =>
        startRootAgentRunInTransaction(db, {
          sessionId,
          events: [{ type: 'turn.started', turnId: 'run-1' }],
          snapshot: {},
          runMutation: {
            type: 'insert',
            run: {
              sessionId,
              runId: 'run-1',
              startCommandId: 'start-1',
              phase: 'building',
              status: 'queued',
              createdRevision: 0,
              lastRevision: 0,
              createdAtMs: 1,
            },
          },
        }),
      )();
      db.query(
        "UPDATE runtime_runs SET status='completed',last_revision=1,started_at_ms=1,finished_at_ms=2 WHERE session_id=? AND run_id='run-1'",
      ).run(sessionId);
      const terminal = {
        sessionId,
        events: [{ type: 'run.completed', turnId: 'turn-1', output: '' }],
        snapshot: {},
        runMutation: {
          type: 'transition' as const,
          transition: {
            sessionId,
            runId: 'run-1',
            expectedLastRevision: 0,
            next: {
              sessionId,
              runId: 'run-1',
              startCommandId: 'start-1',
              phase: 'building' as const,
              status: 'completed' as const,
              createdRevision: 0,
              lastRevision: 1,
              createdAtMs: 1,
              startedAtMs: 1,
              finishedAtMs: 2,
            },
          },
        },
      };
      db.transaction(() =>
        settleRootAgentRunInTransaction(db, {
          ...terminal,
          runMutation: {
            ...terminal.runMutation,
            transition: { ...terminal.runMutation.transition, runId: 'other-run' },
          },
        }),
      )();
      expect(
        createKiteSessionAgentMetadataPort(db).readAgent(sessionId, sessionId, sessionId),
      ).toMatchObject({ status: 'active', currentTaskId: 'run-1' });
      db.transaction(() => settleRootAgentRunInTransaction(db, terminal))();
      expect(
        createKiteSessionAgentMetadataPort(db).readAgent(sessionId, sessionId, sessionId),
      ).toMatchObject({ status: 'idle', currentTaskId: null });
    } finally {
      db.close();
    }
  });
  test('accepts exact private body and receipt scope, then prepares an ordered batch once', () => {
    const db = fixture();
    try {
      agents(db);
      const first = mail(1, 'x'.repeat(5_000));
      commit(db, [first.event], [first.mutation], first.receipt);
      const second = mail(2);
      commit(db, [second.event], [second.mutation], second.receipt);
      const metadata = createKiteSessionAgentMetadataPort(db);
      expect(metadata.readAgent(sessionId, sessionId, 'child-1')).toMatchObject({
        unreadCount: 2,
        mailRevision: 2,
        preparedThroughSequence: 0,
      });
      const prepared = {
        kind: 'prepare_input',
        targetAgentId: 'child-1',
        modelInvocationId: 'model-2',
        modelAdmissionId: 'model-2',
        fromSequence: 0,
        throughSequence: 2,
        messageIds: ['mail-1', 'mail-2'],
      } as const;
      const event = {
        type: 'agent.mail_input_prepared',
        targetAgentId: 'child-1',
        invocationId: 'model-2',
        modelAdmissionId: 'model-2',
        fromSequence: 0,
        throughSequence: 2,
        messageIds: ['mail-1', 'mail-2'],
      };
      const modelPrepared = {
        type: 'model.invocation_prepared',
        invocationId: 'model-2',
        budget: { kind: 'no_budget' },
      };
      const snapshot = { resourceBudget: { status: 'unconfigured', reservations: {} } };
      commit(db, [modelPrepared, event], [prepared], undefined, snapshot);
      commit(db, [modelPrepared, event], [prepared], undefined, snapshot);
      expect(metadata.readAgent(sessionId, sessionId, 'child-1')).toMatchObject({
        unreadCount: 0,
        preparedThroughSequence: 2,
      });
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM agent_mail WHERE status='prepared'",
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  test('rejects digest conflict and missing receipt while preserving ninth pending mail order', () => {
    const db = fixture();
    try {
      agents(db);
      const first = mail(1);
      expect(() => commit(db, [first.event], [first.mutation])).toThrow(
        KiteSessionAgentMailboxError,
      );
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail').get()?.count,
      ).toBe(0);
      for (let i = 1; i <= 8; i++) {
        const next = mail(i);
        commit(db, [next.event], [next.mutation], next.receipt);
      }
      const ninth = mail(9);
      commit(db, [ninth.event], [ninth.mutation], ninth.receipt);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail').get()?.count,
      ).toBe(9);
      expect(
        db
          .query<{ sequence: number }, []>('SELECT sequence FROM agent_mail ORDER BY sequence')
          .all()
          .map((row) => row.sequence),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const changed = { ...first.mutation, requestDigest: 'f'.repeat(64) };
      expect(() =>
        commit(db, [first.event], [changed], {
          ...first.receipt,
          requestDigest: changed.requestDigest,
        }),
      ).toThrow('conflicts');
      const messageIds = Array.from({ length: 9 }, (_, index) => `mail-${index + 1}`);
      commit(
        db,
        [
          {
            type: 'model.invocation_prepared',
            invocationId: 'model-9',
            budget: { kind: 'no_budget' },
          },
          {
            type: 'agent.mail_input_prepared',
            targetAgentId: 'child-1',
            invocationId: 'model-9',
            modelAdmissionId: 'model-9',
            fromSequence: 0,
            throughSequence: 9,
            messageIds,
          },
        ],
        [
          {
            kind: 'prepare_input',
            targetAgentId: 'child-1',
            modelInvocationId: 'model-9',
            modelAdmissionId: 'model-9',
            fromSequence: 0,
            throughSequence: 9,
            messageIds,
          },
        ],
        undefined,
        { resourceBudget: { status: 'unconfigured', reservations: {} } },
      );
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM agent_mail WHERE status='prepared'",
          )
          .get()?.count,
      ).toBe(9);
    } finally {
      db.close();
    }
  });

  test('prepares only against the exact model reservation in the persisted State', () => {
    const db = fixture();
    try {
      agents(db);
      const first = mail(1);
      commit(db, [first.event], [first.mutation], first.receipt);
      const mutation = {
        kind: 'prepare_input',
        targetAgentId: 'child-1',
        modelInvocationId: 'model-3',
        modelAdmissionId: 'res-3',
        fromSequence: 0,
        throughSequence: 1,
        messageIds: ['mail-1'],
      } as const;
      const events = [
        {
          type: 'model.invocation_prepared',
          invocationId: 'model-3',
          budget: { kind: 'reservation', reservationId: 'res-3' },
        },
        {
          type: 'agent.mail_input_prepared',
          targetAgentId: 'child-1',
          invocationId: 'model-3',
          modelAdmissionId: 'res-3',
          fromSequence: 0,
          throughSequence: 1,
          messageIds: ['mail-1'],
        },
      ];
      const reservation = {
        reservationId: 'res-3',
        runId: 'funding-run',
        invocationId: 'model-invocation:model-3',
        resourceKind: 'model',
        state: 'reserved',
      };
      expect(() =>
        commit(db, events, [mutation], undefined, {
          resourceBudget: {
            status: 'active',
            runId: 'other',
            reservations: { 'res-3': reservation },
          },
        }),
      ).toThrow(KiteSessionAgentMailboxError);
      expect(
        createKiteSessionAgentMetadataPort(db).readAgent(sessionId, sessionId, 'child-1'),
      ).toMatchObject({ unreadCount: 1, preparedThroughSequence: 0 });
      expect(() =>
        commit(db, events, [mutation], undefined, {
          resourceBudget: {
            status: 'active',
            runId: 'funding-run',
            reservations: { 'res-3': { ...reservation, invocationId: 'model-3' } },
          },
        }),
      ).toThrow(KiteSessionAgentMailboxError);
      commit(db, events, [mutation], undefined, {
        resourceBudget: {
          status: 'active',
          runId: 'funding-run',
          reservations: { 'res-3': reservation },
        },
      });
      expect(
        createKiteSessionAgentMetadataPort(db).readAgent(sessionId, sessionId, 'child-1'),
      ).toMatchObject({ unreadCount: 0, preparedThroughSequence: 1 });
    } finally {
      db.close();
    }
  });

  test('prepares old-funded child mail from one retained ledger after Run rotation', () => {
    const db = fixture();
    try {
      agents(db);
      const first = mail(1);
      commit(db, [first.event], [first.mutation], first.receipt);
      const mutation = {
        kind: 'prepare_input',
        targetAgentId: 'child-1',
        modelInvocationId: 'model-old',
        modelAdmissionId: 'reserve-old',
        fromSequence: 0,
        throughSequence: 1,
        messageIds: ['mail-1'],
      } as const;
      const events = [
        {
          type: 'model.invocation_prepared',
          invocationId: 'model-old',
          budget: { kind: 'reservation', reservationId: 'reserve-old' },
        },
        {
          type: 'agent.mail_input_prepared',
          targetAgentId: 'child-1',
          invocationId: 'model-old',
          modelAdmissionId: 'reserve-old',
          fromSequence: 0,
          throughSequence: 1,
          messageIds: ['mail-1'],
        },
      ];
      const reservation = {
        reservationId: 'reserve-old',
        runId: 'old-run',
        invocationId: 'model-invocation:model-old',
        resourceKind: 'model',
        state: 'reserved',
      };
      const current = { status: 'active', runId: 'new-run', reservations: {} };
      const retained = {
        'old-run': {
          status: 'active',
          runId: 'old-run',
          reservations: { 'reserve-old': reservation },
        },
      };
      const metadata = createKiteSessionAgentMetadataPort(db);
      expect(() =>
        commit(db, events, [mutation], undefined, {
          resourceBudget: current,
          retainedResourceBudgets: {
            'old-run': {
              ...retained['old-run'],
              reservations: { 'reserve-old': { ...reservation, runId: 'wrong-run' } },
            },
          },
        }),
      ).toThrow(KiteSessionAgentMailboxError);
      expect(() =>
        commit(db, events, [mutation], undefined, {
          resourceBudget: {
            ...current,
            reservations: { 'reserve-old': { ...reservation, runId: 'new-run' } },
          },
          retainedResourceBudgets: retained,
        }),
      ).toThrow(KiteSessionAgentMailboxError);
      expect(metadata.readAgent(sessionId, sessionId, 'child-1')).toMatchObject({
        unreadCount: 1,
        preparedThroughSequence: 0,
      });
      commit(db, events, [mutation], undefined, {
        resourceBudget: current,
        retainedResourceBudgets: retained,
      });
      expect(metadata.readAgent(sessionId, sessionId, 'child-1')).toMatchObject({
        unreadCount: 0,
        preparedThroughSequence: 1,
      });
    } finally {
      db.close();
    }
  });

  test('metadata scope reveals ancestors and descendants but not sibling Agents or bodies', () => {
    const db = fixture();
    try {
      agents(db);
      const sibling = {
        kind: 'create_agent',
        agentId: 'child-2',
        parentAgentId: sessionId,
        initialTaskId: 'child-2',
        createdAtMs: 3,
      } as const;
      commit(
        db,
        [
          {
            type: 'agent.created',
            agentId: 'child-2',
            parentAgentId: sessionId,
            initialTaskId: 'child-2',
          },
          {
            type: 'agent.turn_started',
            agentId: 'child-2',
            taskId: 'child-2',
            turnOrdinal: 1,
            ownerGeneration: '1',
            grantDigest: `sha256:${'b'.repeat(64)}`,
          },
        ],
        [sibling, { kind: 'turn_started', agentId: 'child-2', taskId: 'child-2', turnOrdinal: 1 }],
      );
      const metadata = createKiteSessionAgentMetadataPort(db);
      expect(metadata.listAgents(sessionId, 'child-1').map((agent) => agent.agentId)).toEqual([
        sessionId,
        'child-1',
      ]);
      expect(metadata.readAgent(sessionId, 'child-1', 'child-2')).toBeNull();
      expect(metadata.listAgents(sessionId, sessionId).map((agent) => agent.agentId)).toEqual([
        sessionId,
        'child-1',
        'child-2',
      ]);
      expect(metadata.readAgent(sessionId, sessionId, 'child-1')).not.toHaveProperty('bodyText');
    } finally {
      db.close();
    }
  });
});
