import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, JobEvent } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { canonicalJson } from '../../../src/json';
import { acquireProfileMaintenanceAccess } from '../../../src/platform/profile';
import { createRuntime, type RunConfiguration } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(read: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > end) throw Error('report fixture deadline');
    await Bun.sleep(5);
  }
}
async function rejects(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e) => e);
  expect((error as { code?: string }).code).toBe(code);
}

for (const mode of [
  'success',
  'version',
  'cancel',
  'rewind',
  'missing',
  'deny',
  'static',
  'human_before',
  'preparation_shutdown',
  'background',
  'cleanup_failure',
  'foreign_creator',
] as const) {
  test(`actual cold report resume ${mode} restores exact binding only after explicit work`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cold-report-resume-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const childReady = gate(),
      childRelease = gate(),
      reportReady = gate(),
      reportRelease = gate(),
      preparationReady = gate(),
      jobReady = gate(),
      jobRelease = gate();
    const requests: ModelRequest[] = [];
    let disposals = 0,
      recoveryResolves = 0,
      ordinaryResolves = 0,
      recoveryPolicies = 0;
    const parent: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'delegate',
            name: 'task',
            arguments: JSON.stringify({
              key: 'child',
              role: 'reader',
              resultDisposition: 'after_turn',
              cancellation: 'detached',
              input: { content: 'child result' },
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          if (requests.length === 3) {
            reportReady.release();
            await reportRelease.promise;
          }
          if (mode === 'background' && requests.length === 3) {
            yield { type: 'tool_call', id: 'background', name: 'fixture.hold', arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
            return;
          }
          yield { type: 'text_delta', text: 'accurate response' };
          yield finish;
        }
      },
    };
    const child: ModelAdapter = {
      async *stream() {
        childReady.release();
        await childRelease.promise;
        yield { type: 'text_delta', text: 'accurate child result' };
        yield finish;
      },
    };
    const task = createTaskExtension({
      roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
      afterTurn: { enabled: true },
    });
    const permission = {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    };
    const policy = {
      async authorize() {
        return { allowed: true, revision: 'original-policy' };
      },
    };
    const held: Extension = {
      id: 'held',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.hold',
          version: '1',
          description: 'test owned background lease',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            await context.operations.ensure({
              key: 'hold-lease',
              cancellation: 'detached',
              request: {
                kind: 'job',
                definitionId: 'fixture.held',
                definitionVersion: '1',
                input: {},
              },
            });
            await jobReady.promise;
            return { outcome: 'succeeded', content: 'background registered' };
          },
        },
      ],
      jobs: [
        {
          id: 'fixture.held',
          version: '1',
          description: 'harmless held job',
          inputSchema: { type: 'object' },
          async start() {
            jobReady.release();
            return { reference: { fixture: 'owned' } };
          },
          async *observe(): AsyncIterable<JobEvent> {
            await jobRelease.promise;
            yield {
              type: 'terminal',
              result: { outcome: 'succeeded', content: 'owned finished' },
              supervision: 'ended',
            };
          },
          async cancel() {
            jobRelease.release();
            return { status: 'stopped' };
          },
          async dispose() {},
        },
      ],
    };
    const configuration = (): RunConfiguration => ({
      model: parent,
      modelId: 'root',
      snapshot: { captured: 'original' },
      extensions: mode === 'background' ? [held] : [],
      afterTurn: policy,
      dispose: async () => {
        disposals++;
      },
    });
    // Fault injection is on the test Store boundary only. All creation/settlement
    // facts and the needs_review marker are produced by the actual Core and SQLite.
    const faultStore = new Proxy(store, {
      get(target, key) {
        if (key === 'applyJobReport')
          return async () => {
            throw new AgentError('report_recovery_required');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Store;
    let artifacts = createArtifactStore({ profile, store });
    let runtime = createRuntime({
      store: faultStore,
      ...(mode === 'foreign_creator' ? {} : { artifacts }),
      permissions: permission,
      extensions: [task],
      modelId: 'root',
      ...(mode === 'static'
        ? { model: parent, afterTurn: policy }
        : { resolveRunConfiguration: async () => configuration() }),
      childConfigurations: [
        { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: `file://${directory}`,
        name: 'w',
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: mode === 'foreign_creator' ? 'creator' : 'owner',
        title: 'root',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'work',
        sessionId: 'root',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate' },
      });
      if (mode === 'foreign_creator') {
        await runtime.waitForCommand('work');
        const view = await store.getView('root');
        expect(view.runs).toHaveLength(1);
        expect(view.runs[0]!).toMatchObject({ status: 'failed', reason: 'permission_denied' });
        expect(view.executions).toEqual([]);
        expect(requests).toEqual([]);
        expect(
          (
            await store.listPendingJobReports({
              expectedStoreId: storeId,
              sessionId: 'root',
              limit: 10,
            })
          ).commands,
        ).toEqual([]);
        await artifacts.close();
        await runtime.close();
        store = await openSqliteStore(profile);
        artifacts = createArtifactStore({ profile, store });
        runtime = createRuntime({
          store,
          artifacts,
          permissions: permission,
          resolveRunConfiguration: async () => {
            ordinaryResolves++;
            return configuration();
          },
          resolveRecoveryRunConfiguration: async () => {
            recoveryResolves++;
            return configuration();
          },
        });
        const cursor = (await store.getMetadata()).lastChangeCursor;
        await rejects(
          runtime.resumeJobReport({
            expectedStoreId: storeId,
            commandId: 'resume',
            sessionId: 'root',
            subjectId: 'owner',
            reportCommandId: 'absent-report',
          }),
          'report_recovery_unavailable',
        );
        expect(recoveryResolves).toBe(0);
        expect(recoveryPolicies).toBe(0);
        expect(ordinaryResolves).toBe(0);
        expect(requests).toEqual([]);
        expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
        return;
      }
      await childReady.promise;
      await runtime.waitForCommand('work');
      childRelease.release();
      let reportId = '';
      await until(async () => {
        const page = await store.listPendingJobReports({
          expectedStoreId: storeId,
          sessionId: 'root',
          limit: 10,
        });
        reportId = page.commands[0]?.id ?? reportId;
        if (!reportId) {
          const commands = (await store.getView('root')).executions;
          const carrier = commands.find((e) => e.kind === 'job' && e.childSessionId);
          if (carrier) {
            const { semanticDigest } = await import('../../../src/json');
            reportId = `report-${await semanticDigest([storeId, carrier.id, carrier.resultRevision])}`;
          }
        }
        return !!reportId && (await store.getCommand(reportId))?.status === 'needs_review';
      });
      expect((await store.getCommand(reportId))!.receipt).toMatchObject({
        reason: 'report_recovery_required',
      });
      expect(requests).toHaveLength(2);
      const parentRun = (await store.getView('root')).runs.find(
        (r) => r.originCommandId === 'work',
      )!;
      const originalConfiguration = structuredClone(parentRun.configuration);
      const originalExecutions = await store.listExecutions('root');
      await runtime.close();
      store = await openSqliteStore(profile);
      const coldCursor = (await store.getMetadata()).lastChangeCursor;
      artifacts = createArtifactStore({ profile, store });
      runtime = createRuntime({
        store,
        artifacts,
        permissions: permission,
        extensions: [task],
        modelId: 'root',
        ...(mode === 'static'
          ? { model: parent, afterTurn: policy }
          : {
              resolveRunConfiguration: async () => {
                ordinaryResolves++;
                throw Error('ordinary resolver must not restore');
              },
              ...(mode === 'missing'
                ? {}
                : {
                    resolveRecoveryRunConfiguration: async (input) => {
                      recoveryResolves++;
                      expect(canonicalJson(input.run.configuration)).toBe(
                        canonicalJson(originalConfiguration),
                      );
                      expect(input.command.id).toBe('work');
                      expect(Object.isFrozen(input.run)).toBe(true);
                      if (mode === 'preparation_shutdown') {
                        preparationReady.release();
                        await new Promise<void>((resolve) =>
                          input.signal.addEventListener('abort', () => resolve(), { once: true }),
                        );
                      }
                      const restored: RunConfiguration = {
                        ...configuration(),
                        afterTurn: {
                          async authorize() {
                            recoveryPolicies++;
                            return { allowed: true, revision: 'original-policy' };
                          },
                        },
                      };
                      if (mode === 'cleanup_failure')
                        return {
                          ...restored,
                          snapshot: { captured: 'different' },
                          dispose: async () => {
                            await restored.dispose?.();
                            throw Error('owned cleanup fault');
                          },
                        };
                      return mode === 'version'
                        ? { ...restored, snapshot: { captured: 'different' } }
                        : mode === 'deny'
                          ? {
                              ...restored,
                              afterTurn: {
                                async authorize() {
                                  return { allowed: false, revision: 'original-policy' };
                                },
                              },
                            }
                          : restored;
                    },
                  }),
            }),
        childConfigurations: [
          { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
        ],
      });
      await runtime.getView('root');
      await runtime.getCommand(reportId);
      await runtime.getSelectedContext({ expectedStoreId: storeId, sessionId: 'root' });
      expect(requests).toHaveLength(2);
      expect(recoveryResolves).toBe(0);
      expect(ordinaryResolves).toBe(0);
      expect((await store.getMetadata()).lastChangeCursor).toBe(coldCursor);
      if (mode === 'cancel')
        await runtime.cancelCommand({
          expectedStoreId: storeId,
          commandId: 'cancel-report',
          sessionId: 'root',
          subjectId: 'owner',
          targetCommandId: reportId,
        });
      if (mode === 'rewind') {
        const session = (await store.getSession('root'))!;
        await runtime.selectContext({
          expectedStoreId: storeId,
          subjectId: 'owner',
          commandId: 'rewind-report',
          sessionId: 'root',
          expectedContextSelectionId: session.contextSelectionId,
          boundary: null,
        });
      }
      if (mode === 'human_before')
        await store.acceptCommand({
          expectedStoreId: storeId,
          commandId: 'human-priority',
          sessionId: 'root',
          subjectId: 'owner',
          request: { kind: 'run.start', content: 'new human input' },
        });
      const intent = {
        expectedStoreId: storeId,
        commandId: 'resume',
        subjectId: 'owner',
        sessionId: 'root',
        reportCommandId: reportId,
      };
      if (mode === 'preparation_shutdown') {
        const pending = runtime.resumeJobReport(intent).catch((e) => e);
        await preparationReady.promise;
        expect(runtime.getLifecycleState().busy).toBe(true);
        await runtime.close();
        expect(((await pending) as { code?: string }).code).toBe('runtime_draining');
        expect(requests).toHaveLength(2);
        expect(disposals).toBe(2);
        return;
      }
      if (mode === 'version' || mode === 'missing' || mode === 'cleanup_failure') {
        await rejects(
          runtime.resumeJobReport(intent),
          mode !== 'missing'
            ? 'report_configuration_mismatch'
            : 'report_recovery_binding_unavailable',
        );
        expect(requests).toHaveLength(2);
      } else {
        const originalIntent = structuredClone(intent);
        const pending = runtime.resumeJobReport(intent);
        intent.reportCommandId = 'changed-by-caller';
        const receipt = await pending;
        intent.reportCommandId = originalIntent.reportCommandId;
        expect(receipt.kind).toBe('job.report.resume');
        if (mode === 'success' || mode === 'static' || mode === 'background') {
          expect(receipt.receipt).toMatchObject({
            reportCommandId: reportId,
            outcome: 'report_resumed',
          });
          await reportReady.promise;
          expect(
            (await runtime.getView('root')).runs.some(
              (r) => r.originCommandId === reportId && r.isActive,
            ),
          ).toBe(true);
          const resolves = recoveryResolves;
          expect(await runtime.resumeJobReport(intent)).toEqual(receipt);
          expect(recoveryResolves).toBe(resolves);
          expect(requests).toHaveLength(3);
          await rejects(
            runtime.resumeJobReport({ ...intent, subjectId: 'other' }),
            'report_recovery_unavailable',
          );
          reportRelease.release();
          await runtime.waitForCommand(reportId);
          if (mode === 'background') {
            expect(requests).toHaveLength(4);
            expect(disposals).toBe(1);
            expect(runtime.getLifecycleState().busy).toBe(true);
            expect(
              (await runtime.getView('root')).executions.find(
                (e) => e.definitionId === 'fixture.held',
              )!.status,
            ).toBe('running');
            jobRelease.release();
          }
          expect(
            requests[2]!.messages.some((m) => m.sourceIds?.some((id) => id.startsWith('result-'))),
          ).toBe(true);
          expect((await runtime.getRun(parentRun.id))!.status).toBe('completed');
          expect((await runtime.getRun(parentRun.id))!.configuration).toEqual(
            originalConfiguration,
          );
          expect((await runtime.getView('root')).runs).toHaveLength(2);
          const carrier = originalExecutions.find((e) => e.kind === 'job' && e.childSessionId)!;
          expect((await runtime.getExecution(carrier.id))!.status).toBe('succeeded');
        } else {
          expect(receipt.receipt).toMatchObject({ outcome: 'report_suppressed', runId: null });
          expect(requests).toHaveLength(2);
        }
      }
      if (mode === 'human_before') {
        expect((await runtime.getCommand('human-priority'))!.status).toBe('accepted');
        expect(requests).toHaveLength(2);
      }
      expect(ordinaryResolves).toBe(0);
      if (mode !== 'static') await until(async () => disposals === (mode === 'missing' ? 1 : 2));
      expect(disposals).toBe(mode === 'static' ? 0 : mode === 'missing' ? 1 : 2);
      if (mode === 'cleanup_failure') {
        await until(async () => runtime.getLifecycleState().reasons.includes('cleanup'));
        expect(runtime.getLifecycleState().busy).toBe(true);
        expect(runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
        await rejects(runtime.close(), 'shutdown_cleanup_unconfirmed');
        expect(runtime.getLifecycleState().state).toBe('drain_failed');
        expect((await store.getMetadata()).storeId).toBe(storeId);
        expect((await store.getCommand(reportId))!.status).toBe('needs_review');
        let maintenance: ReturnType<typeof acquireProfileMaintenanceAccess> | undefined;
        let lockError: unknown;
        try {
          maintenance = acquireProfileMaintenanceAccess(profile);
        } catch (error) {
          lockError = error;
        } finally {
          maintenance?.lock.release();
        }
        expect(lockError).toBeDefined();
        expect(disposals).toBe(2);
      }
    } finally {
      childRelease.release();
      reportRelease.release();
      jobRelease.release();
      if (mode === 'cleanup_failure') {
        await rejects(runtime.close(), 'shutdown_cleanup_unconfirmed');
        await artifacts.close();
        await store.close();
      } else await runtime.close();
      if (mode === 'human_before') {
        const reopened = await openSqliteStore(profile);
        try {
          expect((await reopened.getCommand('human-priority'))!.status).toBe('accepted');
          expect(await reopened.acquireSessionOwner('root', 'explicit-new-reader')).not.toBeNull();
          expect(requests).toHaveLength(2);
        } finally {
          await reopened.close();
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
}
