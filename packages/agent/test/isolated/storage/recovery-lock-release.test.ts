import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { acquireProfileAccess, acquireSessionLock } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import { createLedgerExtension } from '../recovery/job-reconcile-fixture';

async function injected(root: string) {
  const original = fileURLToPath(new URL('../../../src/sqlite.ts', import.meta.url));
  const replaceOnce = (source: string, before: string, after: string) => {
    if (source.split(before).length !== 2) throw Error('fixture_sqlite_import_changed');
    return source.replace(before, after);
  };
  const locksImport = `import {
  acquireExistingSharedFileLock,
  acquireFileLock,
  type FileLock,
  LockBusyError,
} from './platform/locks';`;
  let source = replaceOnce(
    readFileSync(original, 'utf8'),
    locksImport,
    locksImport
      .replace('  acquireFileLock,', '  acquireFileLock as actualAcquireFileLock,')
      .replace(
        '  acquireExistingSharedFileLock,',
        '  acquireExistingSharedFileLock as actualAcquireExistingSharedFileLock,',
      ),
  );
  source = replaceOnce(
    source,
    'acquireProfileAccess, acquireSessionLock,',
    'acquireProfileAccess as actualAcquireProfileAccess, acquireSessionLock as actualAcquireSessionLock,',
  );
  source = replaceOnce(
    source,
    'createOwnedWorker, ownedWorkerAssets',
    'createOwnedWorker as actualCreateOwnedWorker, ownedWorkerAssets',
  )
    .replace(
      /from (['"])(\.[^'"]+)\1/g,
      (_match, quote, specifier) => `from ${quote}${resolve(dirname(original), specifier)}${quote}`,
    )
    .replaceAll('access.lock.release()', 'fixtureReleaseProfile(access.lock)')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(original).href));
  const path = join(root, 'sqlite-release.fixture.ts');
  writeFileSync(
    path,
    `${source}
const fixtureLocks = new Set<FileLock>();
const fixtureWorkers = new Set<ReturnType<typeof actualCreateOwnedWorker>>();
export const faults = { remaining: 0, target: 'session', attempts: 0, terminationFailures:0, terminationAttempts:0,
  get liveWorkers() { return fixtureWorkers.size; }, get liveLocks() { return fixtureLocks.size; },
  async cleanup() { for(const worker of fixtureWorkers) { await worker.terminate(); fixtureWorkers.delete(worker); } for(const lock of fixtureLocks) { lock.release(); fixtureLocks.delete(lock); } }
};
function wrapLock(lock:FileLock, kind:string):FileLock { fixtureLocks.add(lock); return {path:lock.path,mode:lock.mode,release() { if(kind===faults.target) {faults.attempts++;if(faults.remaining>0){faults.remaining--;throw Error('fixture_'+kind+'_unlock_failed');}}lock.release();fixtureLocks.delete(lock); }}; }
function acquireExistingSharedFileLock(...args:Parameters<typeof actualAcquireExistingSharedFileLock>) {return wrapLock(actualAcquireExistingSharedFileLock(...args),'probe');}
function acquireFileLock(...args:Parameters<typeof actualAcquireFileLock>) {return wrapLock(actualAcquireFileLock(...args), args[0].endsWith('migration.lock')?'migration':'file');}
function acquireSessionLock(...args:Parameters<typeof actualAcquireSessionLock>) {return wrapLock(actualAcquireSessionLock(...args),'session');}
function acquireProfileAccess(...args:Parameters<typeof actualAcquireProfileAccess>) {const access=actualAcquireProfileAccess(...args);fixtureLocks.add(access.lock);return access;}
function fixtureReleaseProfile(lock:FileLock){lock.release();fixtureLocks.delete(lock);}
function createOwnedWorker(...args:Parameters<typeof actualCreateOwnedWorker>) {const worker=actualCreateOwnedWorker(...args);fixtureWorkers.add(worker);return {...worker,async terminate(){faults.terminationAttempts++;if(faults.terminationFailures>0){faults.terminationFailures--;throw Error('fixture_worker_termination_unconfirmed');}await worker.terminate();fixtureWorkers.delete(worker);}};}
`,
  );
  return (await import(pathToFileURL(path).href)) as {
    openSqliteStore: typeof openSqliteStore;
    faults: {
      remaining: number;
      target: string;
      attempts: number;
      terminationFailures: number;
      terminationAttempts: number;
      liveWorkers: number;
      liveLocks: number;
      cleanup(): Promise<void>;
    };
  };
}

for (const kind of ['run', 'job'] as const)
  for (const closeRelease of [false, true])
    test(`actual ${kind} recovery lease retains its lock for ${closeRelease ? 'close retry' : 'explicit retry'}`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-recovery-release-')));
      const profile = { dataRoot: join(root, 'data'), profile: 'test' };
      let seed = await openSqliteStore(profile);
      const expectedStoreId = (await seed.getMetadata()).storeId;
      await seed.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(root).href,
      });
      await seed.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'Original recovery work',
      });
      const finish: Extract<ModelEvent, { type: 'finish' }> = {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      let runId = '',
        executionId = '';
      if (kind === 'run') {
        await seed.acceptCommand({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'work',
          request: { kind: 'run.start', content: 'Original planned work' },
        });
        const owner = (await seed.acquireSessionOwner('s', 'original'))!;
        const run = await seed.startRun({
          expectedStoreId,
          owner,
          commandId: 'work',
          configuration: {},
        });
        runId = run.id;
        await seed.beginRunRequirementsInitialization({ expectedStoreId, owner, runId });
        await seed.registerRunRequirements({
          expectedStoreId,
          owner,
          runId,
          requirements: [],
          initialize: true,
        });
        await seed.planExecution({
          expectedStoreId,
          owner,
          executionId: 'model',
          sessionId: 's',
          runId,
          originCommandId: 'work',
          stepId: 'step',
          callId: 'model',
          kind: 'model',
          definitionId: 'fixed',
          definitionVersion: '1',
          input: { messages: [], modelId: 'fixed' },
          decisionSource: { kind: 'fixed' },
        });
        await seed.close();
      } else {
        const runtime = createRuntime({
          store: seed,
          artifacts: createArtifactStore({ profile, store: seed }),
          modelId: 'fixed',
          model: createFixedModel([
            [
              { type: 'tool_call', id: 'launch', name: 'ledger.launch', arguments: '{}' },
              { ...finish, reason: 'tool_calls' },
            ],
            [finish],
          ]),
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'owned' };
            },
          },
          extensions: [createLedgerExtension(join(root, 'ledger.json'))],
        });
        await runtime.submitCommand({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'work',
          request: { kind: 'run.start', content: 'Original external ledger work' },
        });
        await runtime.waitForCommand('work');
        const deadline = Date.now() + 5000;
        for (;;) {
          executionId =
            (await seed.listExecutions('s')).find(
              (item) => item.kind === 'job' && item.status === 'outcome_unknown',
            )?.id ?? '';
          if (executionId) break;
          if (Date.now() >= deadline) throw Error('job_seed_timeout');
          await Bun.sleep(5);
        }
        await runtime.close();
      }
      const selected = await injected(root);
      const operations: string[] = [];
      const store = await selected.openSqliteStore({
        ...profile,
        onTiming: (value) => operations.push(value.operation),
      });
      seed = await openSqliteStore(profile);
      try {
        const base = {
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'resume',
          instanceId: 'replacement',
        };
        const runInput = {
          ...base,
          runId,
          expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
        };
        const checkpoint =
          kind === 'run' ? (await store.verifyRunResume(runInput)).checkpoint! : undefined;
        const begun =
          kind === 'run'
            ? await store.beginRunResume({ ...runInput, checkpoint: checkpoint! })
            : await store.beginJobReconciliation({
                ...base,
                executionId,
                expectedResultRevision: (await store.getExecution(executionId))!.resultRevision,
              });
        expect(begun.lease).not.toBeNull();
        const lease = begun.lease!;
        const wrongRelease =
          lease.kind === 'run_resume'
            ? store.releaseJobRecoveryLease(lease as never)
            : store.releaseRunResumeLease(lease as never);
        expect(await wrongRelease.catch((error: unknown) => error)).toMatchObject({
          code: 'recovery_lease_changed',
        });
        const release = () =>
          lease.kind === 'run_resume'
            ? store.releaseRunResumeLease(lease)
            : store.releaseJobRecoveryLease(lease);
        selected.faults.remaining = 1;
        const failure = await release().catch((error: unknown) => error);
        expect(failure).toMatchObject({ message: 'fixture_session_unlock_failed' });
        expect((await seed.getSession('s'))!.ownerInstanceId).toBeNull();
        expect(await seed.acquireSessionOwner('s', 'peer')).toBeNull();
        if (lease.kind === 'run_resume') {
          const changed = await store
            .commitRunResume({
              expectedStoreId,
              lease,
              expectedConfiguration: {},
              checkpoint: checkpoint!,
            })
            .catch((error: unknown) => error);
          expect(changed).toMatchObject({ code: 'recovery_lease_changed' });
        } else {
          const changed = await store
            .markJobReconciliationDispatch({
              expectedStoreId,
              lease,
              authorization: { revision: 'owned' },
              expectedRecoveryManifest: (await store.getExecution(executionId))!.recoveryManifest!,
            })
            .catch((error: unknown) => error);
          expect(changed).toMatchObject({ code: 'recovery_lease_changed' });
        }
        if (closeRelease) {
          selected.faults.remaining = 1;
          const firstClose = await store.close().catch((error: unknown) => error);
          expect(firstClose).toMatchObject({ message: 'fixture_session_unlock_failed' });
          expect(selected.faults.liveWorkers).toBe(0);
          await store.close();
          expect(selected.faults.attempts).toBe(3);
          expect(operations.filter((method) => method === 'close')).toHaveLength(1);
        } else {
          await Promise.all([release(), release()]);
          expect(selected.faults.attempts).toBe(2);
        }
        expect(
          operations.filter(
            (method) =>
              method === (kind === 'run' ? 'releaseRunResumeLease' : 'releaseJobRecoveryLease'),
          ),
        ).toHaveLength(1);

        const access = acquireProfileAccess(profile);
        try {
          const lock = acquireSessionLock(access, 's');
          lock.release();
        } finally {
          access.lock.release();
        }
      } finally {
        selected.faults.remaining = 0;
        await store.close().catch(() => {});
        await selected.faults.cleanup();
        await seed.close();
        rmSync(root, { recursive: true, force: true });
      }
    }, 15000);

test('migration unlock failure after actual Worker open closes its Worker and profile before rejecting', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-migration-release-')));
  const selected = await injected(root);
  selected.faults.target = 'migration';
  selected.faults.remaining = 1;
  try {
    const failure = await selected
      .openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'fixture_migration_unlock_failed' });
    expect(selected.faults.liveWorkers).toBe(0);
    expect(selected.faults.liveLocks).toBe(0);
  } finally {
    selected.faults.remaining = 0;
    await selected.faults.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('persistent startup migration failure retains exact native cleanup authority on its error', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-migration-retained-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const selected = await injected(root);
  selected.faults.target = 'migration';
  selected.faults.remaining = 2;
  try {
    const failure = (await selected
      .openSqliteStore(profile)
      .catch((error: unknown) => error)) as AggregateError & { retryCleanup(): Promise<void> };
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    expect(
      failure.errors.every((error: Error) => error.message === 'fixture_migration_unlock_failed'),
    ).toBe(true);
    expect(selected.faults.liveWorkers).toBe(0);
    expect(selected.faults.liveLocks).toBe(2);
    expect(() => acquireProfileAccess(profile, 'exclusive')).toThrow('busy');
    await failure.retryCleanup();
    expect(selected.faults.liveLocks).toBe(0);
    await failure.retryCleanup();
    const reopened = await openSqliteStore(profile);
    await reopened.close();
  } finally {
    selected.faults.remaining = 0;
    await selected.faults.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('unconfirmed startup Worker termination is retained and never re-issued by cleanup retry', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-startup-worker-retained-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const selected = await injected(root);
  selected.faults.target = 'migration';
  selected.faults.remaining = 1;
  selected.faults.terminationFailures = 1;
  try {
    const failure = (await selected
      .openSqliteStore(profile)
      .catch((error: unknown) => error)) as AggregateError & { retryCleanup(): Promise<void> };
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      'fixture_migration_unlock_failed',
      'fixture_worker_termination_unconfirmed',
    ]);
    expect(selected.faults.liveWorkers).toBe(1);
    expect(selected.faults.liveLocks).toBe(2);
    const repeated = await failure.retryCleanup().catch((error: unknown) => error);
    expect(repeated).toMatchObject({ message: 'fixture_worker_termination_unconfirmed' });
    expect(selected.faults.terminationAttempts).toBe(1);
    expect(selected.faults.liveWorkers).toBe(1);
    expect(() => acquireProfileAccess(profile, 'exclusive')).toThrow('busy');
  } finally {
    selected.faults.remaining = 0;
    await selected.faults.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

for (const boundary of ['begin', 'recover'] as const)
  test(`actual ${boundary} boundary retains a failed temporary unlock for exact cleanup`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-temporary-release-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const seed = await openSqliteStore(profile);
    const expectedStoreId = (await seed.getMetadata()).storeId;
    await seed.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    await seed.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      subjectId: 'owner',
      title: 'Original temporary boundary',
    });
    await seed.acceptCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Original planned work' },
    });
    const owner = (await seed.acquireSessionOwner('s', 'original'))!;
    const run = await seed.startRun({
      expectedStoreId,
      owner,
      commandId: 'work',
      configuration: {},
    });
    await seed.beginRunRequirementsInitialization({ expectedStoreId, owner, runId: run.id });
    await seed.registerRunRequirements({
      expectedStoreId,
      owner,
      runId: run.id,
      requirements: [],
      initialize: true,
    });
    await seed.planExecution({
      expectedStoreId,
      owner,
      runId: run.id,
      sessionId: 's',
      originCommandId: 'work',
      executionId: 'model',
      kind: 'model',
      stepId: 'step',
      callId: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: { modelId: 'fixed', messages: [] },
      decisionSource: { kind: 'fixed' },
    });
    await seed.close();
    const selected = await injected(root);
    const store = await selected.openSqliteStore(profile);
    const observer = await openSqliteStore(profile);
    try {
      const base = {
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'recovery',
        expectedOwnerGeneration: owner.generation,
      };
      selected.faults.remaining = 1;
      if (boundary === 'begin') {
        const input = { ...base, runId: run.id, instanceId: 'replacement' };
        const raw = new Database(join(profile.dataRoot, 'test/core.db'));
        raw.exec(
          "CREATE TRIGGER recovery_begin_fault BEFORE INSERT ON command WHEN NEW.kind='run.resume' BEGIN SELECT RAISE(ABORT,'fixture_begin_refused'); END",
        );
        raw.close();
        const checkpoint = (await store.verifyRunResume(input)).checkpoint!;
        const failure = (await store
          .beginRunResume({ ...input, checkpoint })
          .catch((error: unknown) => error)) as AggregateError;
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0].message).toContain('fixture_begin_refused');
        expect(failure.errors[1].message).toBe('fixture_session_unlock_failed');
        expect(await observer.acquireSessionOwner('s', 'peer')).toBeNull();
        const next = await store
          .acquireSessionOwner('s', 'replacement')
          .catch((error: unknown) => error);
        expect(next).toMatchObject({ code: 'owner_busy' });
        await store.close();
      } else {
        const input = { ...base, decision: 'interrupt' as const };
        const failure = await store.recoverSession(input).catch((error: unknown) => error);
        expect(failure).toMatchObject({ message: 'fixture_session_unlock_failed' });
        const generation = (await observer.getSession('s'))!.ownerGeneration;
        expect(await observer.acquireSessionOwner('s', 'peer')).toBeNull();
        const original = await observer.getCommand('recovery');
        expect(original?.status).toBe('applied');
        await store.recoverSession(input);
        expect(await observer.getCommand('recovery')).toEqual(original);
        expect((await observer.getSession('s'))!.ownerGeneration).toBe(generation);
      }
      expect(selected.faults.attempts).toBe(2);
      const access = acquireProfileAccess(profile);
      try {
        const lock = acquireSessionLock(access, 's');
        lock.release();
      } finally {
        access.lock.release();
      }
    } finally {
      selected.faults.remaining = 0;
      await store.close().catch(() => {});
      await selected.faults.cleanup();
      await observer.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

for (const target of ['probe', 'session'] as const)
  test(`actual reconcile ${target} unlock failure retries only its retained cleanup before observing ownership`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-reconcile-unlock-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const seed = await openSqliteStore(profile);
    const expectedStoreId = (await seed.getMetadata()).storeId;
    await seed.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    for (const sessionId of ['s', 'other'])
      await seed.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'w',
        commandId: `create-${sessionId}`,
        subjectId: 'owner',
        title: sessionId,
      });
    await seed.acceptCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Original work' },
    });
    const owner = (await seed.acquireSessionOwner('s', 'original'))!;
    const run = await seed.startRun({
      expectedStoreId,
      owner,
      commandId: 'work',
      configuration: {},
    });
    await seed.close();
    const selected = await injected(root);
    const store = await selected.openSqliteStore(profile);
    const observer = await openSqliteStore(profile);
    try {
      const other = (await store.acquireSessionOwner('other', 'live-other'))!;
      const input = {
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'reconcile',
        expectedOwnerGeneration: owner.generation,
      };
      selected.faults.target = target;
      selected.faults.remaining = 1;
      expect(await store.reconcileSession(input).catch((error) => error)).toMatchObject({
        message: `fixture_${target}_unlock_failed`,
      });
      if (target === 'probe') {
        expect(await observer.getCommand('reconcile')).toBeNull();
        expect(await observer.getRun(run.id)).toMatchObject({ isActive: true, status: 'running' });
      } else {
        expect(await observer.getCommand('reconcile')).toMatchObject({ status: 'applied' });
        expect(await observer.getRun(run.id)).toMatchObject({
          isActive: false,
          status: 'interrupted',
        });
      }
      expect(await observer.acquireSessionOwner('s', 'peer')).toBeNull();
      const result = await store.reconcileSession(input);
      expect(result.outcome).toBe('reconciled');
      expect(await observer.getRun(run.id)).toMatchObject({
        isActive: false,
        status: 'interrupted',
      });
      expect(selected.faults.attempts).toBe(target === 'probe' ? 3 : 2);
      expect(await observer.acquireSessionOwner('other', 'unrelated-peer')).toBeNull();
      const cursor = (await observer.getMetadata()).lastChangeCursor;
      expect(await store.reconcileSession(input)).toEqual(result);
      expect((await observer.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(await store.releaseSessionOwner(other)).toBe(true);
      const access = acquireProfileAccess(profile);
      try {
        const lock = acquireSessionLock(access, 's');
        lock.release();
      } finally {
        access.lock.release();
      }
    } finally {
      selected.faults.remaining = 0;
      await store.close().catch(() => {});
      await selected.faults.cleanup();
      await observer.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
