import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentKernel } from '../../src/core/runtime/kernel.js';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '../../src/core/runtime/resource-budget.js';
import { planRuntimeBudgetAdmissionV1 } from '../../src/core/runtime/resource-budget-admission.js';
import {
  buildRuntimeEventEnvelopeV24,
  canonicalRuntimeEventEnvelopeBytesV24,
} from '../../src/core/runtime/runtime-event-v24.js';
import { createInitialRuntimeState } from '../../src/core/runtime/state.js';
import {
  type BranchMutationCommitResultV1,
  createRuntimeStore,
  type RuntimeJournalMode,
} from '../../src/core/runtime/store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStorePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `kite-branch-fault-${name}-`));
  temporaryDirectories.push(directory);
  return join(directory, 'runtime.db');
}

function createSettledNamedCut(dbPath: string, threadId: string): void {
  const kernel = createAgentKernel({
    threadId,
    userId: 'fault-matrix-user',
    workspace: '/workspace',
    storePath: dbPath,
  });
  const startedAt = new Date();
  kernel.processEvent({
    type: 'resource_budget.configured',
    runId: `${threadId}-run`,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(
      startedAt.getTime() + LIMITED_RESOURCE_BUDGET_V1.maxRunDurationMs,
    ).toISOString(),
    budget: LIMITED_RESOURCE_BUDGET_V1,
  });
  const continuation = {
    version: 1 as const,
    turnId: kernel.getState().turn.turnId,
    requestedAtRevision: 0,
    summarySourceIdentity: {
      version: 1 as const,
      firstMessageId: 'first',
      coveredThroughMessageId: 'last',
      coveredThroughTurnId: kernel.getState().turn.turnId,
      canonicalSourceDigest: 'a'.repeat(64),
      sourceProjectionPolicyId: 'checkpoint-v3-source:v1' as const,
    },
  };
  const originReceipt = {
    version: 1 as const,
    generation: kernel.getProducerGeneration(),
    attemptId: `${threadId}-attempt`,
    compactionId: `${threadId}-compaction`,
    continuation,
    origin: {
      kind: 'summary_terminal' as const,
      terminalBatchId: `${threadId}-summary-terminal`,
      terminalEventId: 'b'.repeat(64),
      resourceTerminalEventId: 'c'.repeat(64),
    },
  };
  kernel.processEvent({
    type: 'context.normal_reprepare_required_v1',
    receipt: originReceipt,
  });
  const admission = planRuntimeBudgetAdmissionV1(kernel.getState(), {
    type: 'call_model',
    primaryRequestId: `${threadId}-primary-request`,
    resourceEstimate: { inputTokens: 100, maxOutputTokens: 50 },
  });
  if (admission.status !== 'admitted') throw new Error('continuation admission expected');
  const reserved = admission.preparationEvents.find(
    (event) => event.type === 'resource_budget.reserved',
  );
  if (reserved?.type !== 'resource_budget.reserved') throw new Error('reservation expected');
  const consumptionKey = {
    version: 1 as const,
    generation: kernel.getProducerGeneration(),
    consumptionBatchId: `${threadId}-consumption`,
    attemptId: originReceipt.attemptId,
    compactionId: originReceipt.compactionId,
    continuation,
    originReceipt,
    primaryEffectLeaseId: `${threadId}-primary-lease`,
    primaryInvocationId: reserved.reservation.invocationId,
    primaryRequestId: `${threadId}-primary-request`,
    resourceReservationId: reserved.reservation.reservationId,
  };
  kernel.processEventBatch([
    ...admission.preparationEvents.map((event) => ({
      ...event,
      normalReprepareConsumptionKey: consumptionKey,
    })),
    ...admission.dispatchEvents.map((event) => ({
      ...event,
      normalReprepareConsumptionKey: consumptionKey,
    })),
    { type: 'context.normal_reprepare_consumed_v1', consumptionKey },
  ]);
  const terminalBatchId = `${threadId}-primary-terminal`;
  kernel.processEventBatch([
    {
      type: 'model.responded',
      messageId: `${threadId}-response`,
      text: 'settled response',
      contextEvidence: {
        version: 2,
        purpose: 'primary',
        terminalBatchId,
        requestId: consumptionKey.primaryRequestId,
        effectLeaseId: consumptionKey.primaryEffectLeaseId,
        reservationId: consumptionKey.resourceReservationId,
        preparedDigest: 'd'.repeat(64),
        sourceIdentityDigest: 'e'.repeat(64),
        requestIdentityDigest: 'f'.repeat(64),
        finalProviderPayloadDigest: '1'.repeat(64),
        admittedRequestDigest: '2'.repeat(64),
        reclaimReceiptDigest: 'none',
      },
    },
    {
      type: 'resource_budget.reconciled',
      reservationId: consumptionKey.resourceReservationId,
      terminalBatchId,
      actual: createZeroResourceUsageV1(),
    },
  ]);
  kernel.close();
  Bun.gc(true);

  const store = createRuntimeStore(dbPath);
  const state = store.loadSnapshot(threadId);
  const identity = store.loadPersistenceIdentity(threadId);
  store.saveNamedSnapshot(
    threadId,
    'settled-cut',
    state,
    identity.observedHead.eventPosition,
    identity,
  );
  store.close();
}

function seedBranchAuthorityRows(dbPath: string, threadId: string, count: number): void {
  const db = new Database(dbPath);
  // Quota admission is intentionally counter-based and must not scan retained
  // authority bodies. These bounded opaque fillers keep every row/ref/counter
  // cardinality consistent while isolating the limit arithmetic under test.
  const checksum = Buffer.alloc(32, 7);
  const receiptBlob = Buffer.from('{}');
  const completionBlob = Buffer.from('{}');
  const closureBlob = Buffer.from('BCTC000');
  const insertReceipt = db.query(
    'INSERT INTO runtime_branch_mutation_receipts VALUES (?, 1, ?, ?, ?, ?)',
  );
  const insertCompletion = db.query(
    'INSERT INTO runtime_branch_mutation_completions VALUES (?, 1, ?, ?, ?, ?)',
  );
  const insertClosure = db.query(
    'INSERT INTO runtime_branch_copied_terminal_closures VALUES (?, 1, ?, ?, ?, ?)',
  );
  const insertRef = db.query(
    "INSERT INTO runtime_branch_receipt_refs VALUES (?, ?, 'rolling_snapshot', ?)",
  );
  db.transaction(() => {
    db.run('INSERT OR IGNORE INTO runtime_branch_ledgers (target_thread_id) VALUES (?)', [
      threadId,
    ]);
    for (let index = 0; index < count; index++) {
      const receiptId = index.toString(16).padStart(64, '0');
      insertReceipt.run(threadId, receiptId, receiptBlob, checksum, receiptBlob.length);
      insertCompletion.run(threadId, receiptId, completionBlob, checksum, completionBlob.length);
      insertClosure.run(threadId, receiptId, closureBlob, checksum, closureBlob.length);
      insertRef.run(threadId, receiptId, threadId);
    }
    db.run(
      `UPDATE runtime_branch_ledgers
          SET receipt_count = ?, receipt_bytes = ?, closure_count = ?, closure_bytes = ?,
              completion_count = ?, completion_bytes = ?
        WHERE target_thread_id = ?`,
      [
        count,
        count * receiptBlob.length,
        count,
        count * closureBlob.length,
        count,
        count * completionBlob.length,
        threadId,
      ],
    );
  })();
  db.close();
}

function expectAckUnknown(result: BranchMutationCommitResultV1) {
  if (result.status !== 'commit_ack_unknown') throw new Error('ACK-unknown result expected');
  return result;
}

function createAckUnknownFork(
  dbPath: string,
  journalMode: RuntimeJournalMode,
  sourceThreadId: string,
  targetThreadId: string,
) {
  createSettledNamedCut(dbPath, sourceThreadId);
  const store = createRuntimeStore(dbPath, {
    journalMode,
    faultInjectionBranchCommitAckUnknown: true,
  });
  return {
    result: expectAckUnknown(
      store.forkSessionV1(sourceThreadId, '__runtime_current__', targetThreadId),
    ),
    store,
  };
}

describe('ADR-0101 branch authority fault matrix', () => {
  test('receipt, completion, and closure ledgers admit limit-1 to limit and reject limit+1 atomically', () => {
    for (const [seedCount, expectedStatus] of [
      [1_023, 'committed'],
      [1_024, 'resource_saturated'],
    ] as const) {
      const dbPath = temporaryStorePath(`authority-count-${seedCount}`);
      const threadId = `authority-count-${seedCount}`;
      createSettledNamedCut(dbPath, threadId);
      seedBranchAuthorityRows(dbPath, threadId, seedCount);
      const store = createRuntimeStore(dbPath);
      const before = store.loadPersistenceIdentity(threadId);
      expect(store.restoreNamedSnapshotV1(threadId, 'settled-cut').status).toBe(expectedStatus);
      const after = store.loadPersistenceIdentity(threadId);
      expect(after.generation).toBe(before.generation + (expectedStatus === 'committed' ? 1 : 0));
      store.close();

      const db = new Database(dbPath, { readonly: true });
      const counts = db
        .query<
          { receipts: number; completions: number; closures: number },
          [string, string, string]
        >(
          `SELECT
             (SELECT COUNT(*) FROM runtime_branch_mutation_receipts WHERE target_thread_id = ?) AS receipts,
             (SELECT COUNT(*) FROM runtime_branch_mutation_completions WHERE target_thread_id = ?) AS completions,
             (SELECT COUNT(*) FROM runtime_branch_copied_terminal_closures WHERE target_thread_id = ?) AS closures`,
        )
        .get(threadId, threadId, threadId);
      db.close();
      expect(counts).toEqual({
        receipts: 1_024,
        completions: 1_024,
        closures: 1_024,
      });
    }
  });

  for (const journalMode of ['wal', 'delete'] as const) {
    test(`ACK lost, unavailable resolution, GC retention, and delete/recreate are closed in ${journalMode.toUpperCase()} mode`, () => {
      const dbPath = temporaryStorePath(`ack-gc-${journalMode}`);
      const sourceThreadId = `ack-source-${journalMode}`;
      const targetThreadId = `ack-target-${journalMode}`;
      const { result, store } = createAckUnknownFork(
        dbPath,
        journalMode,
        sourceThreadId,
        targetThreadId,
      );
      expect(store.resolveBranchMutationCompletionV1(result).status).toBe('already_committed');
      store.close();
      expect(store.resolveBranchMutationCompletionV1(result)).toEqual({
        status: 'resolution_unavailable',
      });

      let reopened = createRuntimeStore(dbPath, { journalMode });
      expect(reopened.resolveBranchMutationCompletionV1(result).status).toBe('already_committed');
      reopened.close();

      const gc = new Database(dbPath);
      gc.transaction(() => {
        gc.run('DELETE FROM runtime_events WHERE thread_id = ?', [targetThreadId]);
        gc.run('DELETE FROM runtime_snapshots WHERE thread_id = ?', [targetThreadId]);
        gc.run('DELETE FROM runtime_named_snapshots WHERE thread_id = ?', [targetThreadId]);
        gc.run('DELETE FROM runtime_branch_mutation_receipts WHERE target_thread_id = ?', [
          targetThreadId,
        ]);
        gc.run('DELETE FROM runtime_branch_copied_terminal_closures WHERE target_thread_id = ?', [
          targetThreadId,
        ]);
        gc.run('DELETE FROM runtime_branch_receipt_refs WHERE target_thread_id = ?', [
          targetThreadId,
        ]);
        gc.run(
          `UPDATE runtime_branch_ledgers
              SET receipt_count = 0, receipt_bytes = 0, closure_count = 0, closure_bytes = 0,
                  ledger_version = ledger_version + 1
            WHERE target_thread_id = ?`,
          [targetThreadId],
        );
        gc.run('DELETE FROM runtime_event_ledgers WHERE thread_id = ?', [targetThreadId]);
      })();
      gc.close();

      reopened = createRuntimeStore(dbPath, { journalMode });
      expect(reopened.resolveBranchMutationCompletionV1(result).status).toBe('already_committed');
      const deletedIdentity = reopened.loadPersistenceIdentity(targetThreadId);
      reopened.deleteSession(targetThreadId, deletedIdentity);
      expect(reopened.resolveBranchMutationCompletionV1(result).status).toBe(
        'unknown_or_superseded',
      );
      expect(
        reopened.forkSessionV1(sourceThreadId, '__runtime_current__', targetThreadId).status,
      ).toBe('committed');
      expect(reopened.resolveBranchMutationCompletionV1(result).status).toBe(
        'unknown_or_superseded',
      );
      expect(reopened.loadPersistenceIdentity(targetThreadId).generation).toBeGreaterThan(
        result.targetGeneration,
      );
      reopened.close();
    });
  }

  test('counter and receipt-ref mismatches quarantine authority instead of washing it through', () => {
    const dbPath = temporaryStorePath('authority-corruption');
    const { result, store } = createAckUnknownFork(
      dbPath,
      'wal',
      'corruption-source',
      'corruption-target',
    );
    store.close();

    let attacker = new Database(dbPath);
    attacker.run(
      "UPDATE runtime_branch_ledgers SET completion_count = completion_count + 1 WHERE target_thread_id = 'corruption-target'",
    );
    attacker.close();
    let verifier = createRuntimeStore(dbPath);
    expect(() =>
      verifier.loadBranchMutationAuthorityV1(
        result.targetThreadId,
        result.targetGeneration,
        result.receiptId,
      ),
    ).toThrow('counters are corrupt');
    expect(verifier.resolveBranchMutationCompletionV1(result)).toEqual({
      status: 'collision_or_corruption',
    });
    verifier.close();

    attacker = new Database(dbPath);
    attacker.run(
      "UPDATE runtime_branch_ledgers SET completion_count = completion_count - 1 WHERE target_thread_id = 'corruption-target'",
    );
    attacker.run(
      "DELETE FROM runtime_branch_receipt_refs WHERE target_thread_id = 'corruption-target'",
    );
    attacker.close();
    verifier = createRuntimeStore(dbPath);
    expect(() =>
      verifier.loadBranchMutationAuthorityV1(
        result.targetThreadId,
        result.targetGeneration,
        result.receiptId,
      ),
    ).toThrow('reference is corrupt');
    expect(verifier.resolveBranchMutationCompletionV1(result)).toEqual({
      status: 'collision_or_corruption',
    });
    verifier.close();
  });

  test('fence row boundaries and ledger mismatches reject the new incarnation with zero writes', () => {
    const dbPath = temporaryStorePath('fence-boundary');
    const store = createRuntimeStore(dbPath);
    const exactLimitThreadId = 'x'.repeat(192);
    store.loadPersistenceIdentity(exactLimitThreadId);
    expect(() => store.loadPersistenceIdentity('y'.repeat(193))).toThrow(
      'runtime_fence_row_oversized',
    );

    let verifier = new Database(dbPath, { readonly: true });
    expect(
      verifier
        .query<{ count: number; bytes: number }, []>(
          'SELECT fence_count AS count, fence_bytes AS bytes FROM runtime_fence_ledger',
        )
        .get(),
    ).toEqual({ count: 1, bytes: 256 });
    verifier.close();

    const attacker = new Database(dbPath);
    attacker.run('UPDATE runtime_fence_ledger SET fence_count = fence_count - 1');
    attacker.close();
    expect(() => store.loadPersistenceIdentity('fence-after-corruption')).toThrow(
      'does not match its retained catalog',
    );
    verifier = new Database(dbPath, { readonly: true });
    expect(
      verifier
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_thread_fences WHERE thread_id = 'fence-after-corruption'",
        )
        .get()?.count,
    ).toBe(0);
    verifier.close();
    store.close();
  });

  test('event-ledger counter mismatch rejects an otherwise valid strict append with zero writes', () => {
    const dbPath = temporaryStorePath('event-counter-corruption');
    const threadId = 'event-counter-corruption';
    const store = createRuntimeStore(dbPath);
    store.saveSnapshot(threadId, { schemaVersion: 24, revision: 0 });
    const identity = store.loadPersistenceIdentity(threadId);
    const payload = {
      type: 'user.command_invoked' as const,
      commandId: 'counter-corruption',
      command: '/counter-corruption',
    };
    const envelope = buildRuntimeEventEnvelopeV24({
      threadId,
      generation: identity.generation,
      revision: 1,
      occurredAt: '2026-08-11T00:00:00.000Z',
      payload,
    });
    const attacker = new Database(dbPath);
    attacker.run(
      `INSERT INTO runtime_event_ledgers
         (thread_id, source_event_count, source_event_bytes, source_raw_event_digest,
          named_catalog_count, named_catalog_bytes, named_catalog_digest,
          tail_start_position, tail_event_count, tail_event_bytes, ledger_version)
       VALUES (?, 0, 0, ?, 0, 0, ?, 0, 1, 1, 1)`,
      [threadId, '0'.repeat(64), '1'.repeat(64)],
    );
    attacker.close();

    expect(() =>
      store.appendEventsAndSnapshot(
        threadId,
        [payload],
        { schemaVersion: 24, revision: 1 },
        [
          {
            eventId: envelope.eventId,
            revision: envelope.revision,
            occurredAt: envelope.occurredAt,
            generation: envelope.generation,
            schemaVersion: 24,
            canonicalBytes: Buffer.byteLength(
              canonicalRuntimeEventEnvelopeBytesV24(envelope),
              'utf8',
            ),
          },
        ],
        undefined,
        identity,
      ),
    ).toThrow('does not match retained rows');
    expect(store.loadEvents(threadId)).toEqual([]);
    expect(store.loadPersistenceIdentity(threadId)).toEqual(identity);
    store.close();
  });

  test('event-tail count and byte quotas admit the exact limit and reject limit+1 with zero writes', () => {
    for (const boundary of ['count', 'bytes'] as const) {
      const dbPath = temporaryStorePath(`event-${boundary}`);
      const threadId = `event-${boundary}`;
      const store = createRuntimeStore(dbPath);
      store.saveSnapshot(threadId, { schemaVersion: 24, revision: 0 });
      const initialIdentity = store.loadPersistenceIdentity(threadId);
      store.close();

      const initialCount = boundary === 'count' ? 49_999 : 512;
      const payload = {
        type: 'user.command_invoked' as const,
        commandId: `${boundary}-limit`,
        command: '/limit',
      };
      const envelope = buildRuntimeEventEnvelopeV24({
        threadId,
        generation: initialIdentity.generation,
        revision: initialCount + 1,
        occurredAt: '2026-08-11T00:00:01.000Z',
        payload,
      });
      const addedBytes = Buffer.byteLength(canonicalRuntimeEventEnvelopeBytesV24(envelope), 'utf8');
      const initialBytes = boundary === 'count' ? initialCount : 64 * 1024 * 1024 - addedBytes;
      const perEventBytes = Math.floor(initialBytes / initialCount);
      const extraByteRows = initialBytes % initialCount;
      const db = new Database(dbPath);
      const insert = db.query(
        `INSERT INTO runtime_events
           (thread_id, event_json, event_id, revision, occurred_at, producer_generation, canonical_bytes)
         VALUES (?, '{}', ?, ?, '2026-08-11T00:00:00.000Z', 1, ?)`,
      );
      db.transaction(() => {
        for (let index = 1; index <= initialCount; index++) {
          const canonicalBytes = perEventBytes + (index <= extraByteRows ? 1 : 0);
          insert.run(threadId, `${boundary}-${index}`, index, canonicalBytes);
        }
        db.run(
          `INSERT INTO runtime_event_ledgers
             (thread_id, source_event_count, source_event_bytes, source_raw_event_digest,
              named_catalog_count, named_catalog_bytes, named_catalog_digest,
              tail_start_position, tail_event_count, tail_event_bytes, ledger_version)
           VALUES (?, 0, 0, ?, 0, 0, ?, 0, ?, ?, 1)`,
          [threadId, '0'.repeat(64), '1'.repeat(64), initialCount, initialBytes],
        );
      })();
      db.close();

      const runtime = createRuntimeStore(dbPath);
      const identity = runtime.loadPersistenceIdentity(threadId);
      runtime.appendEventsAndSnapshot(
        threadId,
        [payload],
        { schemaVersion: 24, revision: initialCount + 1 },
        [
          {
            eventId: envelope.eventId,
            revision: envelope.revision,
            occurredAt: envelope.occurredAt,
            generation: envelope.generation,
            schemaVersion: 24,
            canonicalBytes: addedBytes,
          },
        ],
        undefined,
        identity,
      );
      const atLimit = runtime.loadPersistenceIdentity(threadId);
      const overflowPayload = {
        ...payload,
        commandId: `${boundary}-overflow`,
        command: '/overflow',
      };
      const overflowEnvelope = buildRuntimeEventEnvelopeV24({
        threadId,
        generation: atLimit.generation,
        revision: initialCount + 2,
        occurredAt: '2026-08-11T00:00:02.000Z',
        payload: overflowPayload,
      });
      const overflowBytes = Buffer.byteLength(
        canonicalRuntimeEventEnvelopeBytesV24(overflowEnvelope),
        'utf8',
      );
      expect(() =>
        runtime.appendEventsAndSnapshot(
          threadId,
          [overflowPayload],
          { schemaVersion: 24, revision: initialCount + 2 },
          [
            {
              eventId: overflowEnvelope.eventId,
              revision: overflowEnvelope.revision,
              occurredAt: overflowEnvelope.occurredAt,
              generation: overflowEnvelope.generation,
              schemaVersion: 24,
              canonicalBytes: overflowBytes,
            },
          ],
          undefined,
          atLimit,
        ),
      ).toThrow('resource_saturated');
      expect(runtime.loadPersistenceIdentity(threadId)).toEqual(atLimit);
      runtime.close();
    }
  });

  for (const journalMode of ['wal', 'delete'] as const) {
    test(`two-connection branch lock contention is bounded and mutation-free in ${journalMode.toUpperCase()} mode`, () => {
      const dbPath = temporaryStorePath(`lock-${journalMode}`);
      const sourceThreadId = `lock-source-${journalMode}`;
      const store = createRuntimeStore(dbPath, { journalMode });
      store.saveSnapshot(
        sourceThreadId,
        createInitialRuntimeState({
          threadId: sourceThreadId,
          userId: 'fault-matrix-user',
          workspace: '/workspace',
        }),
      );
      const locker = new Database(dbPath);
      locker.run('PRAGMA busy_timeout = 0');
      locker.run('BEGIN IMMEDIATE');
      const startedAt = performance.now();
      expect(
        store.forkSessionV1(sourceThreadId, '__runtime_current__', `lock-target-${journalMode}`),
      ).toEqual({ status: 'contention_timeout' });
      expect(performance.now() - startedAt).toBeLessThan(750);
      locker.run('ROLLBACK');
      locker.close();
      expect(store.loadSnapshot(`lock-target-${journalMode}`)).toBeNull();
      store.close();
    });
  }
});
