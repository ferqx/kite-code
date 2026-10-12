import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentError, ConfigurationPreparationCleanupError, createRuntime } from '@kite-ai/agent';
import type { Json, ToolContext, ToolResult } from '@kite-ai/agent/extensions';
import { createWorkspaceFiles } from '@kite-ai/agent/files';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { acquireProfileAccess } from '../../../src/platform/profile';

async function fixture(failCleanup: boolean, childFailure = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-preparation-cleanup-')));
  writeFileSync(join(root, 'retained.txt'), 'original directory owner content');
  const profile = { dataRoot: join(root, 'data'), profile: 'temporary' };
  const files = createWorkspaceFiles({ root });
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel(
    childFailure
      ? [
          [
            { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
            { ...finish, reason: 'tool_calls' },
          ],
          [finish],
        ]
      : [],
  );
  const childModel = createFixedModel([[finish]]);
  const cleanupError = new Error('original host disposer refuses before closing actual Files');
  let disposals = 0;
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: { authorize: async () => ({ allowed: true, revision: '1' }) },
    ...(childFailure
      ? {
          extensions: [
            {
              id: 'fixture',
              version: '1',
              apiMajor: 1,
              tools: [
                {
                  id: 'fixture.delegate',
                  version: '1',
                  description: 'Request one trusted child through the ordinary Tool context',
                  inputSchema: { type: 'object' },
                  async execute(_input: Json, context: ToolContext): Promise<ToolResult> {
                    await context.operations.ensure({
                      key: 'child',
                      request: {
                        kind: 'agent',
                        configurationId: 'child',
                        input: { content: 'must never dispatch child' },
                      },
                    });
                    return {
                      outcome: 'succeeded',
                      content: 'unexpected child preparation success',
                    };
                  },
                },
              ],
            },
          ],
          childConfigurations: [
            { id: 'child', version: '1', model: childModel, modelId: 'child', snapshot: {} },
          ],
          async resolveChildRunConfiguration() {
            const originalError = new AgentError('child_preparation_failed');
            const resources = {
              files,
              async dispose() {
                disposals++;
                // A real opened directory remains owned: do not fake an OS close failure.
                throw cleanupError;
              },
            };
            try {
              await resources.dispose();
            } catch (error) {
              throw new ConfigurationPreparationCleanupError({
                originalError,
                cleanupError: error,
                resources,
              });
            }
            throw originalError;
          },
        }
      : {}),
    async resolveRunConfiguration() {
      return {
        model,
        modelId: 'fixed',
        snapshot: {},
        // The same original validation failure occurs before startRun in both cases.
        toolIds: childFailure ? ['fixture.delegate'] : ['unregistered.tool'],
        async dispose() {
          if (childFailure) return;
          disposals++;
          if (failCleanup) throw cleanupError;
          await files.close();
        },
      };
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'real temporary workspace',
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      subjectId: 'owner',
      title: 'preparation cleanup',
    });
  } catch (error) {
    await files.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    profile,
    files,
    store,
    model,
    childModel,
    runtime,
    expectedStoreId,
    cleanupError,
    disposals: () => disposals,
    async rejectPreparation() {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'invalid-configuration',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'must never dispatch' },
      });
      return runtime.waitForCommand('invalid-configuration');
    },
    async teardown() {
      // Fixture custody, after all assertions: this cannot make Runtime shutdown successful.
      // Also seal Runtime admission if an assertion failed before its shutdown assertion.
      await runtime.close().catch(() => {});
      const cleanup = await Promise.allSettled([files.close(), store.close()]);
      const errors = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, 'Fixture owner cleanup failed.');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('failed returned configuration cleanup retains its actual Files and Store through cached failed shutdown and denies maintenance', async () => {
  const f = await fixture(true);
  try {
    const command = await f.rejectPreparation();
    expect(command.status).toBe('rejected');
    expect(command.receipt).toMatchObject({ reason: 'configuration_cleanup_unconfirmed' });
    expect(f.model.requests).toHaveLength(0);
    expect((await f.runtime.getView('s')).runs).toHaveLength(0);
    expect(await f.store.listExecutions('s', 100)).toHaveLength(0);
    expect(f.disposals()).toBe(1);
    expect((await f.files.read('retained.txt')).content).toBe('original directory owner content');
    expect(f.runtime.getLifecycleState().reasons).toContain('cleanup');
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    const closing = f.runtime.close();
    const error = await closing.catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
    expect(f.runtime.close()).toBe(closing);
    expect(await f.runtime.close().catch((value: unknown) => value)).toBe(error);
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.disposals()).toBe(1);
    expect((await f.store.getMetadata()).storeId).toBe(f.expectedStoreId);
    expect((await f.files.read('retained.txt')).content).toBe('original directory owner content');
    expect(() => acquireProfileAccess(f.profile, 'exclusive')).toThrow('Lock is busy.');

    const originalError = new AgentError('tool_unavailable');
    const resources = { files: f.files };
    const marker = new ConfigurationPreparationCleanupError({
      originalError,
      cleanupError: f.cleanupError,
      resources,
    });
    expect(marker).toBeInstanceOf(AgentError);
    expect(marker.code).toBe('configuration_cleanup_unconfirmed');
    expect(marker.cause.originalError).toBe(originalError);
    expect(marker.cause.cleanupError).toBe(f.cleanupError);
    expect(marker.cause.resources).toBe(resources);
    expect(Object.isFrozen(marker.cause)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(marker, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(marker)).not.toContain(f.cleanupError.message);
    expect(JSON.stringify(marker)).not.toContain('resources');
  } finally {
    await f.teardown();
  }
});

test('successful original cleanup of the same invalid configuration has normal rejection, permits shutdown and releases maintenance authority', async () => {
  const f = await fixture(false);
  try {
    const command = await f.rejectPreparation();
    expect(command.status).toBe('rejected');
    expect(command.receipt).toMatchObject({ reason: 'tool_unavailable' });
    expect(f.model.requests).toHaveLength(0);
    expect((await f.runtime.getView('s')).runs).toHaveLength(0);
    expect(await f.store.listExecutions('s', 100)).toHaveLength(0);
    expect(f.disposals()).toBe(1);
    await expect(f.files.read('retained.txt')).rejects.toMatchObject({ code: 'file_closed' });
    expect(f.runtime.getLifecycleState().reasons).not.toContain('cleanup');
    await f.runtime.close();
    expect(f.runtime.getLifecycleState()).toEqual({ state: 'closed', busy: false, reasons: [] });
    expect(f.disposals()).toBe(1);
    const maintenance = acquireProfileAccess(f.profile, 'exclusive');
    try {
      expect(maintenance.lock.mode).toBe('exclusive');
    } finally {
      maintenance.lock.release();
    }
  } finally {
    await f.teardown();
  }
});

test('child pre-return cleanup unknown stops the ordinary parent Tool and retains actual resources without child dispatch or next Model', async () => {
  const f = await fixture(true, true);
  try {
    await f.rejectPreparation();
    expect(f.model.requests).toHaveLength(1);
    expect(f.childModel.requests).toHaveLength(0);
    const executions = await f.store.listExecutions('s', 100);
    expect(executions.filter((execution) => execution.kind === 'model')).toHaveLength(1);
    expect(executions.filter((execution) => execution.kind === 'job')).toHaveLength(0);
    const tools = executions.filter((execution) => execution.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      status: 'outcome_unknown',
      result: { outcome: 'outcome_unknown', content: 'configuration_cleanup_unconfirmed' },
    });
    expect(await f.store.listSessions()).toHaveLength(1);
    const runs = (await f.runtime.getView('s')).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.isActive).toBe(false);
    expect(f.disposals()).toBe(1);
    expect((await f.files.read('retained.txt')).content).toBe('original directory owner content');
    expect(f.runtime.getLifecycleState().reasons).toContain('cleanup');
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    const closing = f.runtime.close();
    const error = await closing.catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
    expect(f.runtime.close()).toBe(closing);
    expect(await f.runtime.close().catch((value: unknown) => value)).toBe(error);
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.disposals()).toBe(1);
    expect((await f.store.getMetadata()).storeId).toBe(f.expectedStoreId);
    expect((await f.files.read('retained.txt')).content).toBe('original directory owner content');
    expect(() => acquireProfileAccess(f.profile, 'exclusive')).toThrow('Lock is busy.');
  } finally {
    await f.teardown();
  }
});
