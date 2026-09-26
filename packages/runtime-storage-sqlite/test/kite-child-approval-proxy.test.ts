import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  decideChildApprovalProxyInTransaction,
  KITE_CHILD_APPROVAL_PROXY_DDL,
  KITE_CHILD_APPROVAL_PROXY_PARENT_INDEX,
  listPendingChildApprovalProxies,
  markChildApprovalAppliedInTransaction,
  openChildApprovalProxyInTransaction,
  readChildApprovalProxy,
  synchronizeChildApprovalProxyInTransaction,
  validateChildApprovalProxyContinuity,
} from '../src/kite-child-approval-proxy';

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new Database(':memory:');
  databases.push(database);
  database.run('PRAGMA foreign_keys=ON');
  database.run(
    `CREATE TABLE runtime_sessions (session_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL) STRICT`,
  );
  database.run(`CREATE TABLE runtime_events (
    session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
    sequence INTEGER NOT NULL, event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    PRIMARY KEY(session_id,sequence)) STRICT`);
  database.run(`CREATE TABLE child_session_intents (
    child_thread_id TEXT PRIMARY KEY NOT NULL,
    parent_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
    child_invocation_id TEXT NOT NULL, origin_tool_call_id TEXT NOT NULL,
    grant_digest TEXT NOT NULL, dispatch_ack_event_id TEXT,
    failure_receipt_digest TEXT, parent_claim_settled_event_id TEXT) STRICT`);
  database.run(`CREATE TABLE runtime_command_receipts (
    scope_session_id TEXT NOT NULL, command_id TEXT NOT NULL,
    request_digest TEXT NOT NULL, target_session_id TEXT NOT NULL,
    committed_revision INTEGER NOT NULL,
    PRIMARY KEY(scope_session_id,command_id)) STRICT`);
  database.run(KITE_CHILD_APPROVAL_PROXY_DDL);
  database.run(KITE_CHILD_APPROVAL_PROXY_PARENT_INDEX);
  database.query('INSERT INTO runtime_sessions VALUES (?,?)').run('parent', 9);
  database.query('INSERT INTO runtime_sessions VALUES (?,?)').run('child', 15);
  database
    .query(`INSERT INTO child_session_intents VALUES (?,?,?,?,?,?,NULL,NULL)`)
    .run('child', 'parent', 'child-invocation', 'parent-task-tool', 'sha256:grant', 'ack');
  const request = {
    type: 'approval.requested',
    interactionId: 'child-approval',
    toolCallId: 'child-tool',
    approval: { tool: 'shell_execute', summary: 'Read external file' },
  };
  const eventJson = JSON.stringify(request);
  database.query('INSERT INTO runtime_events VALUES (?,?,?)').run('child', 12, eventJson);
  const approvalDigest = `sha256:${createHash('sha256').update(eventJson).digest('hex')}`;
  const open = () =>
    openChildApprovalProxyInTransaction(database, {
      childThreadId: 'child',
      childInteractionId: 'child-approval',
      childGeneration: 3,
      childRequestRevision: 12,
      childToolCallId: 'child-tool',
      approvalDigest,
    });
  return { database, open, approvalDigest };
}

describe('private child approval proxy', () => {
  test('binds a canonical child request to exact parent lineage and replays only an identical tuple', () => {
    const { database, open, approvalDigest } = fixture();
    const proxy = open();
    expect(proxy.parentSessionId).toBe('parent');
    expect(proxy.childInvocationId).toBe('child-invocation');
    expect(proxy.parentToolCallId).toBe('parent-task-tool');
    expect(proxy.status).toBe('pending');
    expect(open()).toEqual(proxy);
    validateChildApprovalProxyContinuity(database);
    expect(readChildApprovalProxy(database, 'another-parent', proxy.proxyInteractionId)).toBeNull();
    expect(listPendingChildApprovalProxies(database, 'parent', 1)).toEqual([proxy]);
    expect(() =>
      openChildApprovalProxyInTransaction(database, {
        childThreadId: 'child',
        childInteractionId: 'child-approval',
        childGeneration: 3,
        childRequestRevision: 12,
        childToolCallId: 'forged',
        approvalDigest,
      }),
    ).toThrow('canonical Event');
  });

  test('fences duplicate and conflicting parent decisions, then proves child application from Event', () => {
    const { database, open, approvalDigest } = fixture();
    const pending = open();
    const decision = {
      parentSessionId: 'parent',
      proxyInteractionId: pending.proxyInteractionId,
      childRequestRevision: 12,
      childGeneration: 3,
      approvalDigest,
      decision: 'approve_once' as const,
      parentCommandId: 'command-1',
      parentCommandDigest: 'a'.repeat(64),
      parentDecisionRevision: 9,
    };
    expect(() => decideChildApprovalProxyInTransaction(database, decision)).toThrow(
      'command receipt',
    );
    database
      .query('INSERT INTO runtime_command_receipts VALUES (?,?,?,?,?)')
      .run('parent', 'command-1', 'a'.repeat(64), 'parent', 9);
    const decided = decideChildApprovalProxyInTransaction(database, decision);
    expect(decided.status).toBe('decided');
    expect(decideChildApprovalProxyInTransaction(database, decision)).toEqual(decided);
    expect(() =>
      decideChildApprovalProxyInTransaction(database, {
        ...decision,
        decision: 'reject',
      }),
    ).toThrow('already been decided');
    expect(() =>
      markChildApprovalAppliedInTransaction(database, {
        parentSessionId: 'parent',
        proxyInteractionId: pending.proxyInteractionId,
        decision: 'approve_once',
        childAppliedRevision: 13,
      }),
    ).toThrow('canonical decision Event');
    database.query('INSERT INTO runtime_events VALUES (?,?,?)').run(
      'child',
      13,
      JSON.stringify({
        type: 'approval.granted',
        interactionId: 'child-approval',
        toolCallId: 'child-tool',
        generation: 3,
        grant: 'approve_once',
        receiptId: 'receipt-1',
      }),
    );
    const applied = markChildApprovalAppliedInTransaction(database, {
      parentSessionId: 'parent',
      proxyInteractionId: pending.proxyInteractionId,
      decision: 'approve_once',
      childAppliedRevision: 13,
    });
    expect(applied.status).toBe('applied');
    expect(listPendingChildApprovalProxies(database, 'parent', 10)).toEqual([]);
    expect(
      markChildApprovalAppliedInTransaction(database, {
        parentSessionId: 'parent',
        proxyInteractionId: pending.proxyInteractionId,
        decision: 'approve_once',
        childAppliedRevision: 13,
      }),
    ).toEqual(applied);
    validateChildApprovalProxyContinuity(database);
    database.query('UPDATE runtime_events SET event_json=? WHERE session_id=? AND sequence=?').run(
      JSON.stringify({
        type: 'approval.rejected',
        interactionId: 'child-approval',
        toolCallId: 'child-tool',
        generation: 3,
      }),
      'child',
      13,
    );
    expect(() => validateChildApprovalProxyContinuity(database)).toThrow('application Event');
  });

  test('persists a parent rejection and applies only the matching child rejection Event', () => {
    const { database, open, approvalDigest } = fixture();
    const pending = open();
    database
      .query('INSERT INTO runtime_command_receipts VALUES (?,?,?,?,?)')
      .run('parent', 'reject-command', 'b'.repeat(64), 'parent', 9);
    const decided = decideChildApprovalProxyInTransaction(database, {
      parentSessionId: 'parent',
      proxyInteractionId: pending.proxyInteractionId,
      childRequestRevision: 12,
      childGeneration: 3,
      approvalDigest,
      decision: 'reject',
      parentCommandId: 'reject-command',
      parentCommandDigest: 'b'.repeat(64),
      parentDecisionRevision: 9,
    });
    expect(decided.status).toBe('decided');
    database.query('INSERT INTO runtime_events VALUES (?,?,?)').run(
      'child',
      13,
      JSON.stringify({
        type: 'approval.rejected',
        interactionId: 'child-approval',
        toolCallId: 'child-tool',
        generation: 3,
        reason: 'Rejected by parent.',
        owner: { kind: 'root_tool', toolCallId: 'child-tool' },
      }),
    );
    const applied = markChildApprovalAppliedInTransaction(database, {
      parentSessionId: 'parent',
      proxyInteractionId: pending.proxyInteractionId,
      decision: 'reject',
      childAppliedRevision: 13,
    });
    expect(applied.status).toBe('applied');
    expect(applied.decision).toBe('reject');
    expect(listPendingChildApprovalProxies(database, 'parent', 10)).toEqual([]);
    validateChildApprovalProxyContinuity(database);
  });

  test('opens from the child canonical decision transaction and rejects an unbound generation', () => {
    const { database, approvalDigest } = fixture();
    const request = JSON.parse(
      database
        .query<{ event_json: string }, []>(
          "SELECT event_json FROM runtime_events WHERE session_id='child' AND sequence=12",
        )
        .get()!.event_json,
    ) as Record<string, unknown>;
    request.owner = { kind: 'root_tool', toolCallId: 'child-tool' };
    const eventJson = JSON.stringify(request);
    database
      .query('UPDATE runtime_events SET event_json=? WHERE session_id=? AND sequence=?')
      .run(eventJson, 'child', 12);
    expect(approvalDigest).not.toBe(
      `sha256:${createHash('sha256').update(eventJson).digest('hex')}`,
    );
    expect(() =>
      synchronizeChildApprovalProxyInTransaction(
        database,
        {
          sessionId: 'child',
          events: [request],
          snapshot: {
            pendingApprovals: new Map([
              ['child-approval', { toolCallId: 'child-tool', generation: undefined }],
            ]),
          },
        },
        12,
      ),
    ).toThrow('post-event pending');
    synchronizeChildApprovalProxyInTransaction(
      database,
      {
        sessionId: 'child',
        events: [request],
        snapshot: {
          pendingApprovals: new Map([
            ['child-approval', { toolCallId: 'child-tool', generation: 4 }],
          ]),
        },
      },
      12,
    );
    const [proxy] = listPendingChildApprovalProxies(database, 'parent', 1);
    expect(proxy?.childGeneration).toBe(4);
    expect(proxy?.approvalDigest).toBe(
      `sha256:${createHash('sha256').update(eventJson).digest('hex')}`,
    );
  });

  test('child cancellation closes an unanswered approval without inventing a parent decision', () => {
    const { database, open } = fixture();
    const proxy = open();
    const rejected = {
      type: 'approval.rejected',
      interactionId: 'child-approval',
      toolCallId: 'child-tool',
      generation: 3,
      reason: 'Child was cancelled.',
      owner: { kind: 'root_tool', toolCallId: 'child-tool' },
    };
    database
      .query('INSERT INTO runtime_events VALUES (?,?,?)')
      .run('child', 13, JSON.stringify(rejected));
    synchronizeChildApprovalProxyInTransaction(
      database,
      {
        sessionId: 'child',
        events: [rejected],
        snapshot: { pendingApprovals: new Map() },
      },
      13,
    );
    expect(readChildApprovalProxy(database, 'parent', proxy.proxyInteractionId)?.status).toBe(
      'unknown',
    );
    expect(listPendingChildApprovalProxies(database, 'parent', 10)).toEqual([]);
    validateChildApprovalProxyContinuity(database);
  });
});
