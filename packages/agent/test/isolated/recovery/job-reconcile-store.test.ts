import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type {
  JobReconciliationReceipt,
  JobRecoveryLease,
  Json,
  OwnerRef,
} from '../../../src/storage/types';
import { createLedgerExtension } from './job-reconcile-fixture';

async function denied(promise: Promise<unknown>, code?: string) {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (code) expect((error as { code: string }).code).toBe(code);
}
async function fixture(extra?: 'job' | 'tool') {
  const dataRoot = mkdtempSync('/private/tmp/kite-job-reconcile-store-'),
    profile = { dataRoot, profile: 'test' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: `file://${dataRoot}`,
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    subjectId: 'owner',
    workspaceId: 'w',
    title: 's',
  });
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    extensions: [createLedgerExtension(join(dataRoot, 'external-ledger.json'))],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixed' };
      },
    },
    modelId: 'fixed',
    model: createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'launch',
          name: 'ledger.launch',
          arguments: '{}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]),
  });
  await runtime.submitCommand({
    expectedStoreId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'fixed' },
  });
  await runtime.waitForCommand('work');
  const deadline = Date.now() + 4000;
  while (
    (await store.getView('s')).executions.filter(
      (e) => e.kind === 'job' && e.status === 'outcome_unknown',
    ).length < 1
  ) {
    if (Date.now() > deadline) throw Error('seed_timeout');
    await Bun.sleep(5);
  }
  const view = await store.getView('s'),
    job = view.executions.find((e) => e.kind === 'job')!;
  const other = extra ? view.executions.find((e) => e.kind === 'tool') : null;
  await runtime.close();
  store = await openSqliteStore(profile);
  const original = (await store.getExecution(job.id))!;
  const manifest = original.recoveryManifest!;
  const input = {
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    commandId: 'proof',
    executionId: job.id,
    expectedResultRevision: original.resultRevision,
  };
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  if (extra)
    db.run("UPDATE execution SET state='outcome_unknown',kind=? WHERE id=?", [extra, other!.id]);
  const receipt = (
    supervision: JobReconciliationReceipt['supervision'] = 'ended',
  ): JobReconciliationReceipt => ({
    executionId: job.id,
    resultRevision: original.resultRevision,
    outcome: supervision === 'ended' ? 'verified' : 'unresolved',
    supervision,
    result: { outcome: 'succeeded', content: 'verified fact' },
    evidence: { originalHandle: 'job' },
    reason: null,
    evidenceSource: 'adapter_reconcile',
  });
  return {
    store,
    profile,
    id: job.id,
    otherId: other?.id,
    manifest,
    expectedStoreId,
    original,
    input,
    db,
    receipt,
    async dispatch(lease: JobRecoveryLease) {
      return store.markJobReconciliationDispatch({
        expectedStoreId,
        lease,
        authorization: { revision: 'fixed' },
        expectedRecoveryManifest: manifest,
      });
    },
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('verified proof is append-only, hides lease phase, reuses receipts and precisely unlocks ordinary ownership', async () => {
  const f = await fixture();
  try {
    f.db.run("UPDATE execution SET delivery='pending',delivery_target_session_id='s' WHERE id=?", [
      f.id,
    ]);
    await denied(f.store.acquireSessionOwner('s', 'ordinary'), 'recovery_required');
    expect(await f.store.getJobReconciliationReceipt(f.input)).toBeNull();
    const begun = await f.store.beginJobReconciliation({
      ...f.input,
      instanceId: 'reconciler',
    });
    expect(begun.command.status).toBe('accepted');
    expect(begun.command.receipt).toBeNull();
    expect(begun.lease).not.toBeNull();
    await denied(f.store.acquireSessionOwner('s', 'ordinary'), 'owner_busy');
    await denied(
      f.store.startRun({
        expectedStoreId: f.expectedStoreId,
        owner: begun.lease as unknown as OwnerRef,
        commandId: 'work',
        configuration: {},
      }),
    );
    const peer = await openSqliteStore(f.profile);
    try {
      await denied(
        peer.beginJobReconciliation({
          ...f.input,
          commandId: 'peer',
          instanceId: 'peer',
        }),
        'owner_busy',
      );
    } finally {
      await peer.close();
    }
    expect((await f.dispatch(begun.lease!)).receipt).toBeNull();
    await denied(f.dispatch(begun.lease!), 'reconciliation_already_dispatched');
    const finished = await f.store.finishJobReconciliation({
      expectedStoreId: f.expectedStoreId,
      lease: begun.lease!,
      authorization: { revision: 'fixed' },
      receipt: f.receipt(),
    });
    expect(finished.receipt).toEqual({ ...f.receipt() });
    expect(await f.store.getExecution(f.id)).toEqual({
      ...f.original,
      delivery: 'suppressed',
      deliveryReason: 'explicit_reconciliation',
      deliveryTargetSessionId: 's',
    });
    await f.store.releaseJobRecoveryLease(begun.lease!);
    expect(
      (
        await f.store.beginJobReconciliation({
          ...f.input,
          instanceId: 'again',
        })
      ).lease,
    ).toBeNull();
    const reused = await f.store.beginJobReconciliation({
      ...f.input,
      commandId: 'second',
      instanceId: 'again',
    });
    expect(reused.lease).toBeNull();
    expect(reused.command.receipt).toEqual({ ...f.receipt() });
    const owner = await f.store.acquireSessionOwner('s', 'ordinary');
    expect(owner).not.toBeNull();
    expect(await f.store.releaseSessionOwner(owner!)).toBe(true);
  } finally {
    await f.close();
  }
});

for (const extra of ['job', 'tool'] as const)
  test(`verified target does not exempt another unknown ${extra}`, async () => {
    const f = await fixture(extra);
    try {
      const { lease } = await f.store.beginJobReconciliation({
        ...f.input,
        instanceId: 'reconciler',
      });
      await f.dispatch(lease!);
      await f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization: { revision: 'fixed' },
        receipt: f.receipt(),
      });
      await f.store.releaseJobRecoveryLease(lease!);
      await denied(f.store.acquireSessionOwner('s', 'ordinary'), 'recovery_required');
      expect((await f.store.getExecution(f.otherId!))!.status).toBe('outcome_unknown');
    } finally {
      await f.close();
    }
  });

for (const supervision of ['running', 'unknown'] as const)
  test(`${supervision} supervision cannot unblock unknown Job`, async () => {
    const f = await fixture();
    try {
      const { lease } = await f.store.beginJobReconciliation({
        ...f.input,
        instanceId: 'reconciler',
      });
      await f.dispatch(lease!);
      await denied(
        f.store.finishJobReconciliation({
          expectedStoreId: f.expectedStoreId,
          lease: lease!,
          authorization: { revision: 'fixed' },
          receipt: { ...f.receipt(supervision), outcome: 'verified' },
        }),
        'invalid_reconciliation_receipt',
      );
      await f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization: { revision: 'fixed' },
        receipt: f.receipt(supervision),
      });
      await f.store.releaseJobRecoveryLease(lease!);
      await denied(f.store.acquireSessionOwner('s', 'ordinary'), 'recovery_required');
      expect(
        (
          await f.store.beginJobReconciliation({
            ...f.input,
            instanceId: 'repeat',
          })
        ).lease,
      ).toBeNull();
      const retry = await f.store.beginJobReconciliation({
        ...f.input,
        commandId: 'new-proof',
        instanceId: 'retry',
      });
      expect(retry.lease).not.toBeNull();
      await f.store.releaseJobRecoveryLease(retry.lease!);
      expect(await f.store.getExecution(f.id)).toEqual({
        ...f.original,
        delivery: 'suppressed',
        deliveryReason: 'explicit_reconciliation',
      });
    } finally {
      await f.close();
    }
  });

test('preflight rejects foreign scope and revision without writing; dispatch and finish repeat permission CAS', async () => {
  const f = await fixture();
  try {
    const before = (await f.store.getMetadata()).lastChangeCursor;
    for (const [patch, code] of [
      [{ subjectId: 'other' }, 'permission_denied'],
      [{ expectedStoreId: 'foreign' }, 'store_identity_mismatch'],
      [{ expectedResultRevision: '999' }, 'result_revision_conflict'],
      [{ executionId: 'missing' }, 'job_reconciliation_unavailable'],
    ] as const) {
      await denied(f.store.getJobReconciliationReceipt({ ...f.input, ...patch }), code);
      expect(await f.store.getCommand('proof')).toBeNull();
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    const { lease } = await f.store.beginJobReconciliation({
      ...f.input,
      instanceId: 'reconciler',
    });
    await denied(
      f.store.markJobReconciliationDispatch({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization: { revision: 'fixed' },
        expectedRecoveryManifest: {
          ...(f.manifest as Record<string, Json>),
          adapterVersion: '2',
        },
      }),
      'recovery_manifest_changed',
    );
    const authorization = {
      revision: 'fixed',
      controlReads: [{ kind: 'permission.mode' as const, scope: 'session:s', revision: '1' }],
    };
    await denied(
      f.store.markJobReconciliationDispatch({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization,
        expectedRecoveryManifest: f.manifest,
      }),
      'permission_control_changed',
    );
    await f.dispatch(lease!);
    await denied(
      f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization,
        receipt: f.receipt(),
      }),
      'permission_control_changed',
    );
    expect((await f.store.getCommand('proof'))!.receipt).toBeNull();
    await f.store.releaseJobRecoveryLease(lease!);
    await denied(
      f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization: { revision: 'fixed' },
        receipt: f.receipt(),
      }),
    );
  } finally {
    await f.close();
  }
});

test('event failure rolls back proof and delivery; lost accepted ID never gains a fresh lease', async () => {
  const f = await fixture();
  try {
    f.db.run("UPDATE execution SET delivery='pending',delivery_target_session_id='s' WHERE id=?", [
      f.id,
    ]);
    const { lease } = await f.store.beginJobReconciliation({
      ...f.input,
      instanceId: 'reconciler',
    });
    await f.dispatch(lease!);
    f.db.run(
      "CREATE TRIGGER fail_proof BEFORE INSERT ON change_event WHEN NEW.type='job.reconciliation_finished' BEGIN SELECT RAISE(ABORT,'fixture final fault'); END",
    );
    await denied(
      f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: lease!,
        authorization: { revision: 'fixed' },
        receipt: f.receipt(),
      }),
    );
    expect((await f.store.getCommand('proof'))!.status).toBe('accepted');
    expect((await f.store.getCommand('proof'))!.receipt).toBeNull();
    expect((await f.store.getExecution(f.id))!.delivery).toBe('pending');
    expect((await f.store.getExecution(f.id))!.result).toEqual(f.original.result);
    f.db.run('DROP TRIGGER fail_proof');
    await f.store.releaseJobRecoveryLease(lease!);
    expect(
      (
        await f.store.beginJobReconciliation({
          ...f.input,
          instanceId: 'repeat',
        })
      ).lease,
    ).toBeNull();
    await denied(f.store.acquireSessionOwner('s', 'ordinary'), 'recovery_required');
  } finally {
    await f.close();
  }
});

test('manifest seal is immutable after dispatch, command intent conflicts and exact revision proof fences stay closed', async () => {
  const f = await fixture();
  try {
    const begun = await f.store.beginJobReconciliation({
      ...f.input,
      instanceId: 'reconciler',
    });
    await f.dispatch(begun.lease!);
    await denied(
      f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: begun.lease!,
        authorization: { revision: 'fixed' },
        receipt: { ...f.receipt(), result: { outcome: 'succeeded' } },
      }),
      'invalid_reconciliation_receipt',
    );
    await f.store.finishJobReconciliation({
      expectedStoreId: f.expectedStoreId,
      lease: begun.lease!,
      authorization: { revision: 'fixed' },
      receipt: f.receipt(),
    });
    await f.store.releaseJobRecoveryLease(begun.lease!);
    const owner = (await f.store.acquireSessionOwner('s', 'normal'))!;
    // Recovery sealing stays bound to the original dispatch owner; a new ordinary lease cannot mutate it.
    await denied(
      f.store.sealJobRecoveryManifest({
        expectedStoreId: f.expectedStoreId,
        owner,
        executionId: f.id,
        manifest: {
          ...(f.manifest as Record<string, never>),
          private: 'changed',
        },
      }),
    );
    await f.store.releaseSessionOwner(owner);
    f.db.run('UPDATE execution SET result_revision=result_revision+1 WHERE id=?', [f.id]);
    await denied(f.store.acquireSessionOwner('s', 'new'), 'recovery_required');
    await denied(
      f.store.getJobReconciliationReceipt({
        ...f.input,
        expectedResultRevision: String(BigInt(f.original.resultRevision) + 1n),
      }),
      'command_conflict',
    );
    expect((await f.store.getExecution(f.id))!.result).toEqual(f.original.result);
    expect(JSON.stringify((await f.store.getCommand('proof'))!.request)).not.toContain(
      'external-ledger.json',
    );
  } finally {
    await f.close();
  }
});

test('consumed history stays untouched; readonly and cross-root recovery remain forbidden', async () => {
  const f = await fixture();
  try {
    f.db.run("UPDATE execution SET delivery='consumed',delivery_reason=NULL WHERE id=?", [f.id]);
    const before = (await f.store.getExecution(f.id))!;
    const begun = await f.store.beginJobReconciliation({
      ...f.input,
      instanceId: 'reconciler',
    });
    await f.dispatch(begun.lease!);
    await f.store.finishJobReconciliation({
      expectedStoreId: f.expectedStoreId,
      lease: begun.lease!,
      authorization: { revision: 'fixed' },
      receipt: f.receipt(),
    });
    await f.store.releaseJobRecoveryLease(begun.lease!);
    expect(await f.store.getExecution(f.id)).toEqual(before);
    await f.store.createSession({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'foreign',
      commandId: 'foreign-create',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 'foreign',
    });
    await denied(
      f.store.getJobReconciliationReceipt({
        ...f.input,
        sessionId: 'foreign',
        commandId: 'foreign-proof',
      }),
      'job_reconciliation_unavailable',
    );
    expect(await f.store.getCommand('foreign-proof')).toBeNull();
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      await denied(
        readonly.beginJobReconciliation({
          ...f.input,
          commandId: 'readonly',
          instanceId: 'readonly',
        }),
        'read_only',
      );
    } finally {
      await readonly.close();
    }
  } finally {
    await f.close();
  }
});

test('known terminal target is rejected by readonly preflight before any reconciliation Command', async () => {
  const f = await fixture();
  try {
    f.db.run("UPDATE execution SET state='succeeded' WHERE id=?", [f.id]);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await denied(f.store.getJobReconciliationReceipt(f.input), 'job_reconciliation_unavailable');
    await denied(
      f.store.beginJobReconciliation({ ...f.input, instanceId: 'reconciler' }),
      'job_reconciliation_unavailable',
    );
    expect(await f.store.getCommand('proof')).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('independent accepted query is never ordinary scheduled work, survives recovery and supports precise cancellation', async () => {
  const f = await fixture();
  try {
    const first = await f.store.beginJobReconciliation({ ...f.input, instanceId: 'query' });
    await f.store.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-query',
      targetCommandId: 'proof',
    });
    expect((await f.store.getCommand('proof'))!.status).toBe('accepted');
    expect((await f.store.getCommand('proof'))!.receipt).toBeNull();
    await denied(f.dispatch(first.lease!), 'reconciliation_cancelled');
    expect((await f.store.getExecution(f.id))!.cancelRequestedAt).toBe(
      f.original.cancelRequestedAt,
    );
    await f.store.releaseJobRecoveryLease(first.lease!);
    const second = await f.store.beginJobReconciliation({
      ...f.input,
      commandId: 'second-query',
      instanceId: 'query',
    });
    await f.dispatch(second.lease!);
    await f.store.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-dispatched-query',
      targetCommandId: 'second-query',
    });
    await denied(
      f.store.finishJobReconciliation({
        expectedStoreId: f.expectedStoreId,
        lease: second.lease!,
        authorization: { revision: 'fixed' },
        receipt: f.receipt(),
      }),
      'reconciliation_cancelled',
    );
    await f.store.releaseJobRecoveryLease(second.lease!);
    const third = await f.store.beginJobReconciliation({
      ...f.input,
      commandId: 'third-query',
      instanceId: 'query',
    });
    await f.dispatch(third.lease!);
    await f.store.finishJobReconciliation({
      expectedStoreId: f.expectedStoreId,
      lease: third.lease!,
      authorization: { revision: 'fixed' },
      receipt: f.receipt(),
    });
    await f.store.releaseJobRecoveryLease(third.lease!);
    expect(await f.store.listAcceptedCommands('s')).toEqual([]);
    const owner = (await f.store.acquireSessionOwner('s', 'ordinary'))!;
    expect(owner).not.toBeNull();
    expect(await f.store.releaseSessionOwner(owner)).toBe(true);
    const session = (await f.store.getSession('s'))!;
    await f.store.recoverSession({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'interrupt',
      expectedOwnerGeneration: session.ownerGeneration,
      decision: 'interrupt',
    });
    for (const id of ['proof', 'second-query']) {
      expect((await f.store.getCommand(id))!.status).toBe('accepted');
      expect((await f.store.getCommand(id))!.receipt).toBeNull();
    }
  } finally {
    await f.close();
  }
});
