import type { Database } from 'bun:sqlite';
import type {
  RuntimeCompletedResourceReservationPort,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function ledgerForRun(state: unknown, runId: string): RecordValue | null {
  const root = record(state);
  const active = record(root?.resourceBudget);
  if (active?.status === 'active' && active.runId === runId) return active;
  return record(record(root?.retainedResourceBudgets)?.[runId]);
}

function reservationInState(
  state: unknown,
  runId: string,
  reservationId: string,
): RecordValue | null {
  return record(record(ledgerForRun(state, runId)?.reservations)?.[reservationId]);
}

/** Private Store authority for terminal reservation receipts. Writes run inside State CAS. */
export function createSqliteCompletedResourceReservationStore(
  db: Database,
): RuntimeCompletedResourceReservationPort & {
  archiveInTransaction<Event, State>(transaction: RuntimeTransactionInput<Event, State>): void;
  assertAdmissionInTransaction<Event, State>(
    transaction: RuntimeTransactionInput<Event, State>,
  ): void;
} {
  const select = db.query<{ reservation_json: string }, [string, string]>(
    'SELECT reservation_json FROM runtime_resource_reservation_receipts WHERE session_id=? AND reservation_id=?',
  );
  const selectInvocation = db.query<
    { reservation_json: string },
    [string, string, string]
  >(`SELECT reservation_json FROM runtime_resource_reservation_receipts
      WHERE session_id=? AND run_id=? AND invocation_id=? AND state='reconciled' LIMIT 1`);
  const selectRun = db.query<
    {
      reservation_id: string;
      invocation_id: string;
      state: string;
      reservation_json: string;
      terminal_revision: number;
    },
    [string, string, string | null, string | null]
  >(`SELECT reservation_id,invocation_id,state,reservation_json,terminal_revision
      FROM runtime_resource_reservation_receipts WHERE session_id=? AND run_id=?
      AND (? IS NULL OR json_extract(reservation_json,'$.resourceKind')=?)`);
  const insert = db.query(
    `INSERT INTO runtime_resource_reservation_receipts
      (session_id,run_id,reservation_id,invocation_id,state,reservation_json,terminal_revision)
      VALUES (?,?,?,?,?,?,?)`,
  );
  const priorSnapshot = db.query<{ state_json: string }, [string]>(
    'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
  );
  const lookup = (sessionId: string, reservationId: string): RecordValue | null => {
    const row = select.get(sessionId, reservationId);
    return row ? record(JSON.parse(row.reservation_json)) : null;
  };
  const findNonReleasedInvocation = (
    sessionId: string,
    runId: string,
    invocationId: string,
  ): RecordValue | null => {
    const row = selectInvocation.get(sessionId, runId, invocationId);
    return row ? record(JSON.parse(row.reservation_json)) : null;
  };
  return {
    lookup,
    listForRun({ sessionId, runId, atRevision, resourceKind }) {
      if (!Number.isSafeInteger(atRevision) || atRevision < 0)
        throw new Error('Archived reservation read has no exact snapshot revision.');
      return selectRun
        .all(sessionId, runId, resourceKind ?? null, resourceKind ?? null)
        .map((row) => {
          const reservation = record(JSON.parse(row.reservation_json));
          if (
            !reservation ||
            reservation.runId !== runId ||
            reservation.reservationId !== row.reservation_id ||
            reservation.invocationId !== row.invocation_id ||
            reservation.state !== row.state ||
            !Number.isSafeInteger(row.terminal_revision) ||
            row.terminal_revision < 1 ||
            row.terminal_revision > atRevision
          )
            throw new Error('Archived reservation has no exact Run identity.');
          return reservation;
        });
    },
    findNonReleasedInvocation,
    assertAdmissionInTransaction(transaction) {
      let before: unknown;
      for (const event of transaction.events) {
        const fact = record(event);
        if (
          fact?.type !== 'resource_budget.reserved' &&
          fact?.type !== 'resource_budget.bounded_replaced'
        )
          continue;
        const reservations =
          fact.type === 'resource_budget.reserved'
            ? [record(fact.reservation)]
            : [record(fact.turnReservation), record(fact.replacement)];
        for (const reservation of reservations) {
          const id = reservation?.reservationId;
          const runId = reservation?.runId;
          const invocationId = reservation?.invocationId;
          if (
            typeof id !== 'string' ||
            typeof runId !== 'string' ||
            typeof invocationId !== 'string'
          )
            throw new Error('Resource reservation admission identity is invalid.');
          if (lookup(transaction.sessionId, id))
            throw new Error('Resource reservation identity was already archived.');
          if (findNonReleasedInvocation(transaction.sessionId, runId, invocationId))
            throw new Error('Invocation already has a non-released archived reservation.');
          for (const reference of [
            reservation?.parentReservationId,
            reservation?.replacesReservationId,
          ]) {
            if (typeof reference !== 'string') continue;
            const parent = reservationInState(transaction.snapshot, runId, reference);
            const archived = parent ? null : lookup(transaction.sessionId, reference);
            if (!parent && !archived && before === undefined) {
              const row = priorSnapshot.get(transaction.sessionId);
              before = row ? JSON.parse(row.state_json) : null;
            }
            const previous: RecordValue | null =
              parent || archived || reservationInState(before, runId, reference);
            if (!previous || previous.runId !== runId)
              throw new Error('Referenced reservation has no same-run authority.');
          }
        }
      }
    },
    archiveInTransaction(transaction) {
      const mutations = transaction.completedResourceReservations ?? [];
      if (
        mutations.length === 0 &&
        !transaction.events.some((event) => {
          const type = record(event)?.type;
          return (
            type === 'resource_budget.reconciled' ||
            type === 'resource_budget.released' ||
            type === 'resource_budget.bounded_replaced' ||
            type === 'resource_budget.cumulative_limits_removed'
          );
        })
      )
        return;
      const beforeRow = priorSnapshot.get(transaction.sessionId);
      const before = beforeRow ? JSON.parse(beforeRow.state_json) : null;
      const newReservations = new Map<string, RecordValue>();
      for (const event of transaction.events) {
        const fact = record(event);
        if (fact?.type === 'resource_budget.reserved') {
          const reservation = record(fact.reservation);
          if (typeof reservation?.reservationId === 'string')
            newReservations.set(reservation.reservationId, reservation);
        } else if (fact?.type === 'resource_budget.bounded_replaced') {
          for (const candidate of [record(fact.turnReservation), record(fact.replacement)]) {
            if (typeof candidate?.reservationId === 'string')
              newReservations.set(candidate.reservationId, candidate);
          }
        }
      }
      const seen = new Set<string>();
      for (const mutation of mutations) {
        const reservation = record(mutation.reservation);
        const id = reservation?.reservationId;
        const runId = reservation?.runId;
        const invocationId = reservation?.invocationId;
        const terminal = reservation?.state;
        if (
          typeof id !== 'string' ||
          typeof runId !== 'string' ||
          typeof invocationId !== 'string' ||
          (terminal !== 'reconciled' && terminal !== 'released') ||
          reservationInState(transaction.snapshot, runId, id) !== null
        )
          throw new Error('Terminal reservation receipt does not match the next State.');
        if (seen.has(id)) throw new Error('Duplicate terminal reservation receipt.');
        seen.add(id);
        const previous = reservationInState(before, runId, id) ?? newReservations.get(id);
        if (!previous || previous.runId !== runId || previous.invocationId !== invocationId)
          throw new Error('Terminal reservation receipt lacks its prior authority.');
        const terminalEventIndex = transaction.events.findIndex((event) => {
          const fact = record(event);
          return (
            (fact?.type === 'resource_budget.reconciled' &&
              terminal === 'reconciled' &&
              fact.reservationId === id &&
              JSON.stringify(fact.actual) === JSON.stringify(reservation?.actual)) ||
            (fact?.type === 'resource_budget.released' &&
              terminal === 'released' &&
              fact.reservationId === id) ||
            (fact?.type === 'resource_budget.bounded_replaced' &&
              terminal === 'released' &&
              fact.reservationId === id) ||
            (fact?.type === 'resource_budget.cumulative_limits_removed' &&
              previous.state === terminal &&
              fact.runId === runId)
          );
        });
        if (terminalEventIndex < 0)
          throw new Error('Terminal reservation receipt lacks the matching event.');
        const terminalRevision = transaction.metadata?.[terminalEventIndex]?.revision;
        if (
          typeof terminalRevision !== 'number' ||
          !Number.isSafeInteger(terminalRevision) ||
          terminalRevision < 0
        )
          throw new Error('Terminal reservation receipt lacks its committed revision.');
        const terminalEvent = transaction.events[terminalEventIndex]!;
        const expected =
          terminal === 'reconciled'
            ? { ...previous, state: terminal, actual: record(terminalEvent)?.actual }
            : { ...previous, state: terminal };
        if (JSON.stringify(expected) !== JSON.stringify(reservation))
          throw new Error('Terminal reservation receipt changed its prior authority.');
        const encoded = JSON.stringify(reservation);
        const existing = select.get(transaction.sessionId, id);
        if (existing) {
          if (existing.reservation_json !== encoded)
            throw new Error('Terminal reservation receipt conflicts with its persisted identity.');
          continue;
        }
        insert.run(
          transaction.sessionId,
          runId,
          id,
          invocationId,
          terminal,
          encoded,
          terminalRevision,
        );
      }
      const beforeRoot = record(before);
      const ledgers = [
        record(beforeRoot?.resourceBudget),
        ...Object.values(record(beforeRoot?.retainedResourceBudgets) ?? {}).map(record),
      ];
      for (const ledger of ledgers) {
        if (!ledger || typeof ledger.runId !== 'string') continue;
        for (const [id, raw] of Object.entries(record(ledger.reservations) ?? {})) {
          const prior = record(raw);
          if (!prior) continue;
          const next = reservationInState(transaction.snapshot, ledger.runId, id);
          if (
            next ||
            (prior.state !== 'reconciled' &&
              prior.state !== 'released' &&
              !transaction.events.some((event) => {
                const fact = record(event);
                return (
                  (fact?.type === 'resource_budget.reconciled' ||
                    fact?.type === 'resource_budget.released' ||
                    fact?.type === 'resource_budget.bounded_replaced') &&
                  fact.reservationId === id
                );
              }))
          )
            continue;
          if (!seen.has(id)) throw new Error('Terminal reservation lost its durable receipt.');
        }
      }
    },
  };
}
