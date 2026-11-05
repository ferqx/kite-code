import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AgentError,
  ConfigurationPreparationCleanupError,
  createRuntime,
  type RunConfiguration,
} from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createChildConfiguration } from '../../src/child-configuration';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const privateCause = 'PRIVATE_CHILD_CONFIGURATION_CLOSE_FAILED';
const modes = [
  'validation-failed',
  'validation-clean',
  'normal',
  'cancel-failed',
  'cancel-clean',
] as const;

for (const mode of modes)
  test(`actual child configuration producer retains cleanup ownership: ${mode}`, async () => {
    const root = temporaryDirectory('kite-child-configuration-cleanup-');
    const store = await openSqliteStore({ dataRoot: join(root, 'state'), profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const parent = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'spawn-once',
          name: 'spawn_agent',
          arguments: '{"prompt":"Inspect once without modifications."}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const cancellation = mode.startsWith('cancel-');
    const cleanupFails = mode.endsWith('-failed');
    const closeFailure = new Error(privateCause);
    let disposals = 0;
    let childCalls = 0;
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resource: ReturnType<typeof Bun.serve> | undefined;
    let configuration: RunConfiguration | undefined;
    let preparationFailure: unknown;
    let originalSignal: AbortSignal | undefined;
    let resourceAliveDuringChild = false;
    const child: ModelAdapter = {
      async *stream() {
        childCalls++;
        expect(disposals).toBe(0);
        resourceAliveDuringChild = (await fetch(resource!.url)).ok;
        yield finish;
      },
    };
    const configured = createChildConfiguration({
      roles: [{ id: 'worker', version: '1', modelId: 'child', toolPolicy: 'parent' }],
      async resolve(input) {
        originalSignal = input.signal;
        resource = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: () => new Response('owned configuration preparation resource'),
        });
        configuration = {
          model: child,
          modelId: mode.startsWith('validation-') ? 'mismatched-child' : 'child',
          toolIds: [],
          snapshot: {},
          async dispose() {
            disposals++;
            if (cleanupFails) throw closeFailure;
            resource!.stop(true);
          },
        };
        entered();
        if (cancellation) await proceed;
        return configuration;
      },
    });
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      extensions: [
        createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned test child' }],
        }),
      ],
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      ...configured,
      async resolveChildRunConfiguration(input) {
        try {
          return await configured.resolveChildRunConfiguration!(input);
        } catch (error) {
          preparationFailure = error;
          throw error;
        }
      },
    });
    const request = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...request,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Child cleanup',
      });
      await runtime.submitCommand({
        ...request,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Delegate exactly once and report the original result.',
        },
      });
      if (cancellation) {
        await preparing;
        await runtime.cancelCommand({
          ...request,
          commandId: 'cancel-work',
          targetCommandId: 'work',
        });
        expect(originalSignal!.aborted).toBe(true);
        release();
      }
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const rows = await store.listExecutions('s');
      const spawn = rows.find((row) => row.definitionId === 'task.spawn')!;
      const receipt = JSON.parse((spawn.result as { content: string }).content);
      const carriers = rows.filter((row) => row.childSessionId);
      expect(parent.requests[0]!.tools.some((tool) => tool.id === 'spawn_agent')).toBe(true);
      expect(JSON.stringify(parent.requests)).not.toContain(privateCause);
      expect(JSON.stringify(spawn.result)).not.toContain(privateCause);
      if (mode === 'normal') {
        expect(receipt.accepted).toBe(true);
        expect(carriers).toHaveLength(1);
        await runtime.waitForCommand(`child-start-${carriers[0]!.id}`, { timeoutMs: 5000 });
        expect(childCalls).toBe(1);
        expect(resourceAliveDuringChild).toBe(true);
        expect(preparationFailure).toBeUndefined();
      } else {
        expect(carriers).toHaveLength(0);
        expect(childCalls).toBe(0);
        expect(disposals).toBe(1);
        if (cleanupFails) {
          expect(preparationFailure).toBeInstanceOf(ConfigurationPreparationCleanupError);
          const error = preparationFailure as ConfigurationPreparationCleanupError;
          expect(error.cause.cleanupError).toBe(closeFailure);
          expect(error.cause.resources).toBe(configuration!);
          if (cancellation) expect(error.cause.originalError).toBe(originalSignal!.reason);
          else
            expect(error.cause.originalError).toMatchObject({
              code: 'child_model_binding_mismatch',
            });
          expect(receipt).toMatchObject({
            accepted: null,
            error: { code: 'receipt_unverifiable' },
          });
        } else {
          expect(preparationFailure).toBeInstanceOf(AgentError);
          expect(preparationFailure).not.toBeInstanceOf(ConfigurationPreparationCleanupError);
          if (cancellation) expect(preparationFailure).toBe(originalSignal!.reason);
          else {
            expect(preparationFailure).toMatchObject({ code: 'child_model_binding_mismatch' });
            expect(receipt).toMatchObject({
              accepted: false,
              error: { code: 'preparation_failed' },
            });
            const feedback = parent.requests
              .at(-1)!
              .messages.find((message) => message.toolCallId === 'spawn-once')!;
            expect(feedback.content).toContain('not accepted');
            expect(feedback.content).toContain('configuration could not be prepared');
          }
        }
        if (!cancellation) {
          const feedback = parent.requests
            .at(-1)!
            .messages.find((message) => message.toolCallId === 'spawn-once')!;
          expect(feedback.sourceIds).toEqual([spawn.id]);
          expect(feedback.content).toContain((spawn.result as { content: string }).content);
          if (cleanupFails)
            expect(feedback.content).toContain('Acceptance of this Agent request is unknown');
        }
      }
      if (cancellation) {
        const work = (await store.getCommand('work'))!;
        const run = await store.getRun((work.receipt as { runId: string }).runId);
        expect(run!.status).toBe('cancelled');
        expect(parent.requests).toHaveLength(1);
        expect(receipt.accepted).toBeNull();
      }
      if (cleanupFails) {
        await expect(runtime.close()).rejects.toMatchObject({
          code: 'shutdown_cleanup_unconfirmed',
        });
        expect(runtime.getLifecycleState()).toMatchObject({ state: 'drain_failed' });
        expect((await fetch(resource!.url)).ok).toBe(true);
        expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
        await expect(runtime.close()).rejects.toMatchObject({
          code: 'shutdown_cleanup_unconfirmed',
        });
      } else {
        await runtime.close();
        expect(runtime.getLifecycleState()).toMatchObject({ state: 'closed' });
        await expect(fetch(resource!.url)).rejects.toThrow();
      }
      expect(disposals).toBe(1);
    } finally {
      release();
      await runtime.close().catch(() => {});
      // This explicit test teardown does not make the Runtime's rejected close successful.
      resource?.stop(true);
      await store.close();
      removeTemporaryDirectory(root);
    }
  }, 10000);
