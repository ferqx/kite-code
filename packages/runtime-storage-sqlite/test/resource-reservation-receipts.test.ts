import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createSqliteCompletedResourceReservationStore } from '../src/resource-reservation-receipts';

function fixture() {
  const db = new Database(':memory:');
  db.run('CREATE TABLE runtime_snapshots(session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)');
  db.run(`CREATE TABLE runtime_resource_reservation_receipts(
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL, state TEXT NOT NULL, reservation_json TEXT NOT NULL,
    terminal_revision INTEGER NOT NULL,
    PRIMARY KEY(session_id,reservation_id))`);
  db.run(`CREATE UNIQUE INDEX one_reconciled_invocation
    ON runtime_resource_reservation_receipts(session_id,run_id,invocation_id)
    WHERE state='reconciled'`);
  const reservation = {
    reservationId: 'reservation-1',
    runId: 'run-1',
    invocationId: 'invocation-1',
    resourceKind: 'model',
    executableUpperBound: { counters: {}, gauges: {} },
    state: 'dispatch_started',
  };
  const before = {
    resourceBudget: {
      status: 'active',
      runId: 'run-1',
      reservations: { 'reservation-1': reservation },
    },
    retainedResourceBudgets: {},
  };
  db.query('INSERT INTO runtime_snapshots VALUES (?,?)').run('session-1', JSON.stringify(before));
  const store = createSqliteCompletedResourceReservationStore(db);
  return { db, store, reservation };
}

test('archives a reconciled reservation exactly and rejects changed receipt facts', () => {
  const { db, store, reservation } = fixture();
  const actual = { source: 'actual', counters: {}, gauges: {} };
  const event = { type: 'resource_budget.reconciled', reservationId: 'reservation-1', actual };
  const transaction = {
    sessionId: 'session-1',
    events: [event],
    metadata: [{ eventId: 'terminal-1', revision: 2 }],
    snapshot: {
      resourceBudget: { status: 'active', runId: 'run-1', reservations: {} },
      retainedResourceBudgets: {},
    },
    completedResourceReservations: [
      { reservation: { ...reservation, actual, state: 'reconciled' } },
    ],
  };
  store.archiveInTransaction(transaction);
  expect(store.lookup('session-1', 'reservation-1')?.state).toBe('reconciled');
  expect(store.findNonReleasedInvocation('session-1', 'run-1', 'invocation-1')?.reservationId).toBe(
    'reservation-1',
  );
  const scope = { sessionId: 'session-1', runId: 'run-1', atRevision: 2 };
  const receipt = store.lookup('session-1', 'reservation-1');
  if (!receipt) throw new Error('Committed receipt is unavailable.');
  expect(store.listForRun?.(scope)).toEqual([receipt]);
  expect(store.listForRun?.({ ...scope, runId: 'another-run' })).toEqual([]);
  expect(store.listForRun?.({ ...scope, sessionId: 'another-session' })).toEqual([]);
  expect(() => store.listForRun?.({ ...scope, atRevision: 1 })).toThrow('exact Run identity');
  expect(() =>
    store.archiveInTransaction({
      ...transaction,
      completedResourceReservations: [
        {
          reservation: {
            ...reservation,
            actual,
            state: 'reconciled',
            resourceKind: 'shell',
          },
        },
      ],
    }),
  ).toThrow('changed its prior authority');
  db.close();
});

test('requires a receipt when a terminal event removes prior State authority', () => {
  const { db, store } = fixture();
  const transaction = {
    sessionId: 'session-1',
    events: [{ type: 'resource_budget.released', reservationId: 'reservation-1' }],
    metadata: [{ eventId: 'terminal-1', revision: 2 }],
    snapshot: {
      resourceBudget: { status: 'active', runId: 'run-1', reservations: {} },
      retainedResourceBudgets: {},
    },
  };
  expect(() => store.archiveInTransaction(transaction)).toThrow('lost its durable receipt');
  db.close();
});

test('archives bounded replacement and its reconciled new reservation in one decision', () => {
  const { db, store } = fixture();
  const held = {
    reservationId: 'held',
    runId: 'run-1',
    invocationId: 'held-invocation',
    resourceKind: 'subagent',
    executableUpperBound: {},
    state: 'reserved',
  };
  db.query('UPDATE runtime_snapshots SET state_json=? WHERE session_id=?').run(
    JSON.stringify({
      resourceBudget: { status: 'active', runId: 'run-1', reservations: { held } },
      retainedResourceBudgets: {},
    }),
    'session-1',
  );
  const turnReservation = {
    reservationId: 'turn',
    runId: 'run-1',
    invocationId: 'turn-invocation',
    resourceKind: 'subagent',
    executableUpperBound: {},
    state: 'reserved',
    replacesReservationId: 'held',
  };
  const replacement = {
    reservationId: 'model',
    runId: 'run-1',
    invocationId: 'model-invocation',
    resourceKind: 'model',
    executableUpperBound: {},
    state: 'reserved',
    parentReservationId: 'turn',
    replacesReservationId: 'held',
  };
  const actual = { source: 'actual', counters: {}, gauges: {} };
  const transaction = {
    sessionId: 'session-1',
    events: [
      {
        type: 'resource_budget.bounded_replaced',
        reservationId: 'held',
        turnReservation,
        replacement,
      },
      { type: 'resource_budget.dispatch_started', reservationId: 'model' },
      { type: 'resource_budget.reconciled', reservationId: 'model', actual },
    ],
    metadata: [1, 2, 3].map((revision) => ({ eventId: `event-${revision}`, revision })),
    snapshot: {
      resourceBudget: { status: 'active', runId: 'run-1', reservations: { turn: turnReservation } },
      retainedResourceBudgets: {},
    },
    completedResourceReservations: [
      { reservation: { ...held, state: 'released' } },
      { reservation: { ...replacement, actual, state: 'reconciled' } },
    ],
  };
  store.assertAdmissionInTransaction(transaction);
  store.archiveInTransaction(transaction);
  expect(store.lookup('session-1', 'held')?.state).toBe('released');
  expect(store.lookup('session-1', 'model')?.state).toBe('reconciled');
  const scope = { sessionId: 'session-1', runId: 'run-1', atRevision: 3 };
  expect(store.listForRun?.(scope)).toHaveLength(2);
  const receipt = store.lookup('session-1', 'model');
  if (!receipt) throw new Error('Committed Model receipt is unavailable.');
  expect(store.listForRun?.({ ...scope, resourceKind: 'model' })).toEqual([receipt]);
  db.close();
});
