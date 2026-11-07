import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { groupOptions } from './run-resume-group-fixture';

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('group_resume_fixture_timeout');
    await Bun.sleep(5);
  }
}
for (const mode of [
  'group_reconciled',
  'group_reconciled_queued',
  'group_reconciled_approval',
  'group_owned',
  'group_queued',
  'group_activation',
  'group_terminal',
  'group_background_job',
  'group_cleanup',
  'group_approval',
  'group_expired',
  'group_unknown',
  'group_drift',
  'group_binding',
  'group_dynamic',
  'group_dynamic_drift',
  'group_handoff_cancel',
])
  test(`SIGKILL ${mode} resumes original carriers and Runs once`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-group-resume-')));
    const seedMode =
      mode === 'group_reconciled_queued'
        ? 'group_queued'
        : mode === 'group_reconciled_approval'
          ? 'group_approval'
          : mode === 'group_reconciled'
            ? 'group_owned'
            : mode === 'group_cleanup'
              ? 'group_background_job'
              : mode === 'group_dynamic_drift'
                ? 'group_dynamic'
                : [
                      'group_expired',
                      'group_unknown',
                      'group_drift',
                      'group_binding',
                      'group_handoff_cancel',
                    ].includes(mode)
                  ? 'group_owned'
                  : mode;
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
        directory,
        seedMode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      await until(async () => existsSync(join(directory, 'ready.json')));
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        executionId: string;
      };
      child.kill('SIGKILL');
      await child.exited;
      writeFileSync(join(directory, 'resuming'), 'true');
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      store = await openSqliteStore(profile);
      const rootBefore = await store.getView('s');
      const carriers = rootBefore.executions.filter((execution) => execution.childSessionId);
      const children = await Promise.all(
        carriers.map((carrier) => store!.getView(carrier.childSessionId!)),
      );
      for (const view of children) {
        expect(view.session.parentSessionId).toBe('s');
        expect(view.executions.filter((execution) => execution.childSessionId)).toHaveLength(0);
      }
      expect(carriers).toHaveLength(
        seedMode === 'group_background_job' ? 1 : seedMode === 'group_queued' ? 4 : 3,
      );
      expect(children.filter((view) => view.runs[0]?.isActive)).toHaveLength(
        mode === 'group_activation'
          ? 0
          : ['group_queued', 'group_terminal'].includes(seedMode)
            ? 2
            : carriers.length,
      );
      const options = groupOptions(directory, seedMode);
      if (mode === 'group_cleanup') {
        const resolve = options.resolveChildRunConfiguration!;
        options.resolveChildRunConfiguration = async (input) => {
          const configuration = await resolve(input);
          return {
            ...configuration,
            dispose: async () => {
              await configuration.dispose?.();
              if ((configuration.snapshot as { key: string }).key === 'one')
                throw new Error('late_descendant_configuration_cleanup_failed');
            },
          };
        };
      }
      const beforeLedger = readFileSync(join(directory, 'ledger'), 'utf8');
      const sql = new Database(join(directory, 'data', 'test', 'core.db'));
      const firstModel = children[0]!.executions.find((execution) => execution.kind === 'model')!;
      try {
        if (mode === 'group_expired')
          for (const child of children)
            sql.run('UPDATE run SET deadline_at=0 WHERE id=?', [child.runs[0]!.id]);
        if (mode === 'group_unknown')
          sql.run(
            "UPDATE execution SET kind='tool',adapter_id='fixture/uncertain-effect',state='outcome_unknown' WHERE id=?",
            [firstModel.id],
          );
        if (mode === 'group_drift') {
          const resolve = options.resolveRecoveryRunConfiguration!;
          options.resolveRecoveryRunConfiguration = async (input) => {
            const binding = await resolve(input);
            sql.run('UPDATE execution SET output_bytes=output_bytes+1 WHERE id=?', [firstModel.id]);
            return binding;
          };
        }
        if (mode === 'group_binding')
          options.childConfigurations = options.childConfigurations!.map((configuration) => ({
            ...configuration,
            snapshot: { changed: true },
          }));
        if (mode === 'group_dynamic_drift') {
          const resolve = options.resolveRecoveryRunConfiguration!;
          options.resolveRecoveryRunConfiguration = async (input) => {
            const binding = await resolve(input);
            return {
              ...binding,
              readStepCapabilities: async (input) => ({
                ...(await binding.readStepCapabilities!(input)),
                snapshot: { catalogue: 'changed' },
              }),
            };
          };
        }
        const runtimeStore =
          mode === 'group_handoff_cancel'
            ? new Proxy(store, {
                get(target, key) {
                  if (key === 'commitRunResume')
                    return async (input: Parameters<Store['commitRunResume']>[0]) => {
                      const committed = await target.commitRunResume(input);
                      await target.cancelWork({
                        expectedStoreId: ready.expectedStoreId,
                        subjectId: 'owner',
                        sessionId: 's',
                        commandId: 'cancel-at-handoff',
                        kind: 'run.cancel',
                        runId: ready.runId,
                      });
                      return committed;
                    };
                  const value = Reflect.get(target, key);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              })
            : mode === 'group_background_job'
              ? new Proxy(store, {
                  get(target, key) {
                    if (key === 'registerHumanCommand')
                      return async (input: Parameters<Store['registerHumanCommand']>[0]) => {
                        const command = await target.registerHumanCommand(input);
                        if (input.commandId === 'human-with-live-background') {
                          const receipt = command.receipt as { humanInputCommandId: string };
                          const raw = (await target.getCommand(receipt.humanInputCommandId))!;
                          // Fix the real SQL ordering: idle preparation wins before
                          // intake seals the explicit business decision.
                          await target.beginHumanInputProcessing({
                            expectedStoreId: raw.originStoreId,
                            sessionId: raw.sessionId,
                            subjectId: raw.subjectId,
                            inputCommandId: raw.id,
                            inputDigest: raw.requestDigest,
                          });
                        }
                        return command;
                      };
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                  },
                })
              : store;
        runtime = createRuntime({
          store: runtimeStore,
          artifacts: createArtifactStore({ profile, store }),
          ...options,
        });
        const originalCards =
          seedMode === 'group_approval'
            ? (
                await store.listInteractions({
                  expectedStoreId: ready.expectedStoreId,
                  sessionId: 's',
                  state: 'pending',
                })
              ).interactions
            : [];
        if (mode.startsWith('group_reconciled')) {
          const reconciled = await store.reconcileSession({
            ...ready,
            sessionId: 's',
            subjectId: 'owner',
            commandId: 'reconcile',
          });
          ready.expectedOwnerGeneration = reconciled.report!.generation;
          for (const original of [rootBefore, ...children]) {
            const observed = await store.getView(original.session.id);
            for (const run of original.runs.filter((run) => run.isActive))
              expect(observed.runs.find((row) => row.id === run.id)).toMatchObject({
                status: 'interrupted',
                isActive: false,
                reason: 'owner_lost',
              });
            expect(
              observed.executions.every(
                (row) => !['planned', 'running', 'dispatching'].includes(row.status),
              ),
            ).toBe(true);
          }
          expect(
            sql
              .query(
                "SELECT count(*) AS n FROM interaction WHERE state IN('pending','answered') AND accepted_decision_revision IS NULL",
              )
              .get(),
          ).toEqual({ n: 0 });
          expect(
            sql
              .query(
                "SELECT count(*) AS n FROM command WHERE kind='child.start' AND status='accepted'",
              )
              .get(),
          ).toEqual({ n: 0 });
          if (seedMode === 'group_queued')
            expect(reconciled.report!.cancelledExecutionIds.length).toBeGreaterThan(0);
          expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(beforeLedger);
        }
        const input = { ...ready, commandId: 'resume-group', sessionId: 's', subjectId: 'owner' };
        const cards =
          mode === 'group_reconciled_approval'
            ? originalCards
            : seedMode === 'group_approval'
              ? (
                  await store.listInteractions({
                    expectedStoreId: ready.expectedStoreId,
                    sessionId: 's',
                    state: 'pending',
                  })
                ).interactions
              : [];
        if (
          ['group_unknown', 'group_drift', 'group_binding', 'group_dynamic_drift'].includes(mode)
        ) {
          const error = await runtime.resumeRun(input).catch((error) => error);
          expect(error.code).toBe(
            mode === 'group_unknown'
              ? 'run_resume_checkpoint_unavailable'
              : mode === 'group_drift'
                ? 'run_resume_checkpoint_changed'
                : mode === 'group_dynamic_drift'
                  ? 'capability_refresh_required'
                  : 'run_configuration_mismatch',
          );
          expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(beforeLedger);
          expect((await store.getRun(ready.runId))!.isActive).toBe(true);
          for (const view of children)
            for (const execution of view.executions)
              expect((await store.getExecution(execution.id))!.status).toBe(
                mode === 'group_unknown' && execution.id === firstModel.id
                  ? 'outcome_unknown'
                  : execution.status,
              );
          return;
        }
        const receipt = await runtime.resumeRun(input);
        expect(receipt.receipt).toMatchObject({ outcome: 'run_resumed', runId: ready.runId });
        if (seedMode === 'group_approval') {
          expect(cards).toHaveLength(3);
          expect(readFileSync(join(directory, 'ledger'), 'utf8').includes('effect:')).toBe(false);
          for (const card of cards) {
            expect(
              await store.getInteraction({
                expectedStoreId: ready.expectedStoreId,
                sessionId: 's',
                interactionId: card.id,
              }),
            ).toEqual(card);
            await runtime.answerInteraction({
              expectedStoreId: ready.expectedStoreId,
              subjectId: 'owner',
              commandId: `answer-${card.id}`,
              presentationSessionId: 's',
              interactionId: card.id,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
            });
          }
        }
        await until(
          async () =>
            (await store!.getRun(ready.runId))?.status ===
            (mode === 'group_handoff_cancel' ? 'cancelled' : 'completed'),
        );
        if (mode === 'group_handoff_cancel') {
          await until(async () =>
            (await Promise.all(carriers.map((carrier) => store!.getExecution(carrier.id)))).every(
              (execution) => execution?.status === 'cancelled',
            ),
          );
        }
        if (seedMode === 'group_background_job') {
          await until(async () =>
            readFileSync(join(directory, 'ledger'), 'utf8').includes('background-running'),
          );
          expect(
            readFileSync(join(directory, 'ledger'), 'utf8').includes('dispose-config:one'),
          ).toBe(false);
          expect((await store.getSession('s'))!.ownerInstanceId).not.toBeNull();
          const childView = await store.getView(children[0]!.session.id);
          const backgroundOperations = childView.executions.filter(
            (execution) =>
              execution.kind === 'job' && execution.definitionId === 'fixture/background',
          );
          expect(backgroundOperations).toHaveLength(1);
          const background = backgroundOperations[0]!;
          expect(background).toMatchObject({
            sessionId: childView.session.id,
            childSessionId: null,
            cancelWithParent: false,
            rootWorkCommandId: 'work',
            status: 'running',
          });
          const launch = await store.getExecution(background.parentExecutionId!);
          expect(launch).toMatchObject({
            kind: 'tool',
            definitionId: 'fixture_delegate',
            sessionId: childView.session.id,
            runId: children[0]!.runs[0]!.id,
            input: { content: 'background' },
            status: 'succeeded',
          });
          expect(childView.executions.filter((execution) => execution.childSessionId)).toHaveLength(
            0,
          );
          expect(sql.query('SELECT count(*) AS n FROM session').get()).toEqual({ n: 2 });
          expect(
            (await store.getView('s')).executions.filter((execution) => execution.childSessionId),
          ).toHaveLength(1);
          if (mode === 'group_background_job') {
            const supervisionOwner = await store.getSession('s');
            const command = await runtime.submitCommand({
              expectedStoreId: ready.expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              commandId: 'human-with-live-background',
              request: { kind: 'run.start', content: 'New task: human during background work' },
            });
            expect(command.status).toBe('accepted');
            await until(async () => (await store!.getCommand(command.id))?.status === 'applied');
            const applied = (await store.getCommand(command.id))!;
            const application = applied.receipt as { runId: string; businessCommandId: string };
            const business = applied;
            expect(business).toMatchObject({
              status: 'applied',
              request: { content: 'New task: human during background work' },
              rootWorkCommandId: command.id,
              receipt: { runId: application.runId },
            });
            await until(
              async () => (await store!.getRun(application.runId))?.status === 'completed',
            );
            expect(await store.getRun(application.runId)).toMatchObject({
              originCommandId: business.id,
              rootWorkCommandId: command.id,
            });
            const model = (await store.listExecutions('s')).filter(
              (execution) => execution.runId === application.runId && execution.kind === 'model',
            );
            expect(model).toHaveLength(1);
            expect(model[0]).toMatchObject({ status: 'succeeded', originCommandId: business.id });
            const source = await runtime.readModelInput({
              expectedStoreId: ready.expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              executionId: model[0]!.id,
            });
            expect(source.request.messages).toContainEqual({
              role: 'user',
              content: 'New task: human during background work',
              sourceIds: [business.id],
            });
            expect((await store.getExecution(background.id))!.status).toBe('running');
            expect((await store.getSession('s'))!.ownerGeneration).toBe(
              supervisionOwner!.ownerGeneration,
            );
            expect(
              readFileSync(join(directory, 'ledger'), 'utf8').includes('dispose-config:one'),
            ).toBe(false);
          }
          writeFileSync(join(directory, 'release-background'), 'true');
          await until(
            async () => (await store!.getExecution(background.id))?.status === 'succeeded',
          );
          await until(async () =>
            readFileSync(join(directory, 'ledger'), 'utf8').includes('dispose-config:one'),
          );
          const backgroundLedger = readFileSync(join(directory, 'ledger'), 'utf8').split('\n');
          expect(
            backgroundLedger.filter((line) => line === `background-start:${background.id}`),
          ).toHaveLength(1);
          expect(backgroundLedger.filter((line) => line === 'background-running')).toHaveLength(1);
          expect(backgroundLedger.filter((line) => line === 'background-disposed')).toHaveLength(1);
          expect(backgroundLedger.filter((line) => line === 'use-config:one')).toHaveLength(1);
          expect(backgroundLedger.filter((line) => line === 'dispose-config:one')).toHaveLength(1);
          if (mode === 'group_cleanup') {
            const owner = await store.getSession('s');
            expect(await runtime.close().catch((error) => error)).toMatchObject({
              code: 'shutdown_cleanup_unconfirmed',
            });
            expect(runtime.getLifecycleState()).toMatchObject({
              state: 'drain_failed',
              busy: true,
            });
            expect((await store.getSession('s'))!.ownerInstanceId).toBe(owner!.ownerInstanceId);
            expect((await store.getSession('s'))!.ownerGeneration).toBe(owner!.ownerGeneration);
            expect(owner!.ownerInstanceId).not.toBeNull();
            const peer = await openSqliteStore(profile);
            try {
              expect(await peer.acquireSessionOwner('s', 'peer')).toBeNull();
            } finally {
              await peer.close();
            }
            expect((await store.getRun(ready.runId))!.status).toBe('completed');
            return;
          }
        }
        expect(await runtime.resumeRun(input)).toEqual(receipt);
        const rootAfter = await store.getView('s');
        if (mode === 'group_background_job') {
          const publicInput = (await store.getCommand('human-with-live-background'))!;
          const application = publicInput.receipt as { runId: string };
          expect(publicInput).toMatchObject({
            status: 'applied',
            originStoreId: ready.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            request: { content: 'New task: human during background work' },
          });
          expect(publicInput.receipt).not.toHaveProperty('humanInputCommandId');
          expect(rootAfter.runs.map((run) => run.id).sort()).toEqual(
            [ready.runId, application.runId].sort(),
          );
          expect(rootAfter.runs.find((run) => run.id === ready.runId)).toMatchObject({
            originCommandId: 'work',
            rootWorkCommandId: 'work',
            status: 'completed',
          });
          expect(rootAfter.runs.find((run) => run.id === application.runId)).toMatchObject({
            originCommandId: publicInput.id,
            rootWorkCommandId: publicInput.id,
            status: 'completed',
          });
          const beforeReplayLedger = readFileSync(join(directory, 'ledger'), 'utf8');
          const beforeReplay = await store.getView('s');
          expect(
            await runtime.submitCommand({
              expectedStoreId: ready.expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              commandId: publicInput.id,
              request: { kind: 'run.start', content: 'New task: human during background work' },
            }),
          ).toEqual(publicInput);
          expect(await runtime.resumeRun(input)).toEqual(receipt);
          expect(await store.getCommand(publicInput.id)).toEqual(publicInput);
          expect(await store.getView('s')).toEqual(beforeReplay);
          expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(beforeReplayLedger);
        } else expect(rootAfter.runs).toHaveLength(1);
        for (const carrier of carriers) {
          const current = await store.getExecution(carrier.id);
          expect(current).toMatchObject({
            status: ['group_expired', 'group_handoff_cancel'].includes(mode)
              ? 'cancelled'
              : 'succeeded',
            childSessionId: carrier.childSessionId,
          });
          const before = children.find((view) => view.session.id === carrier.childSessionId)!;
          const after = await store.getView(carrier.childSessionId!);
          expect(after.runs).toHaveLength(1);
          expect(after.runs[0]).toMatchObject({
            ...(before.runs[0]
              ? {
                  id: before.runs[0].id,
                  deadlineAt: mode === 'group_expired' ? 0 : before.runs[0].deadlineAt,
                }
              : {}),
            status: ['group_expired', 'group_handoff_cancel'].includes(mode)
              ? 'cancelled'
              : 'completed',
          });
          expect(after.executions.filter((execution) => execution.kind === 'model')).toHaveLength(
            mode === 'group_background_job'
              ? 3
              : mode === 'group_dynamic'
                ? 3
                : ['group_expired', 'group_handoff_cancel'].includes(mode) ||
                    (mode === 'group_terminal' && !before.runs[0]!.isActive)
                  ? 1
                  : before.runs.length
                    ? 2
                    : 1,
          );
        }
        const ledger = readFileSync(join(directory, 'ledger'), 'utf8').trim().split('\n');
        if (mode === 'group_background_job')
          expect(ledger.filter((line) => line === 'dispose-config:one')).toHaveLength(1);
        if (seedMode === 'group_approval')
          expect(ledger.filter((line) => line.startsWith('effect:'))).toHaveLength(3);
        expect(ledger.filter((line) => line === 'parent-model')).toHaveLength(
          mode === 'group_background_job' ? 3 : mode === 'group_handoff_cancel' ? 1 : 2,
        );
        for (const key of seedMode === 'group_background_job'
          ? ['one']
          : seedMode === 'group_queued'
            ? ['one', 'two', 'three', 'four']
            : ['one', 'two', 'three'])
          expect(ledger.filter((line) => line === `child-model:${key}`)).toHaveLength(
            mode === 'group_background_job'
              ? 3
              : mode === 'group_dynamic'
                ? 3
                : ['group_expired', 'group_activation', 'group_handoff_cancel'].includes(mode) ||
                    (seedMode === 'group_queued' && ['three', 'four'].includes(key)) ||
                    (mode === 'group_terminal' && key === 'one')
                  ? 1
                  : 2,
          );
      } finally {
        sql.close();
      }
    } finally {
      writeFileSync(join(directory, 'release-background'), 'true');
      child.kill('SIGKILL');
      await child.exited;
      if (mode === 'group_cleanup') await runtime?.close().catch(() => {});
      else await runtime?.close();
      await store?.close();
      // The deliberate disposer failure retains its original resource/OS permit.
      // Windows rejects removing that still-held profile, as in the single-Run cleanup fixture.
      if (mode !== 'group_cleanup') rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
