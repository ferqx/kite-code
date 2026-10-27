import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { JobDefinition, ToolDefinition } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSessionLogs } from '@kite-ai/agent/storage';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { TuiController, type TuiPort } from '@kite-ai/ui/tui';
import { openCallerJournal } from '../../host/caller-journal';
import { createTuiCallerPort } from '../../host/caller-port';
import { createTuiDisplayReader, readTuiPendingInputs } from '../../host/tui-display';

function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > deadline) throw Error('finishing_input_observation_timeout');
    await Bun.sleep(5);
  }
}

test('real cancelling Run accepts TUI successor; late receipt preserves B draft and original Command never resends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-tui-finishing-'));
  const profile = selectProfile({ dataRoot: root, profile: 'finishing' });
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const started = gate(),
    stopEntered = gate(),
    stopReleased = gate(),
    receiptEntered = gate(),
    receiptReleased = gate();
  const handle = { reference: { original: true } };
  let disposed = 0,
    followPosts = 0,
    physicalFollowPosts = 0;
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'original-call', name: 'hold', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'successor completed' }, finish],
  ]);
  const job: JobDefinition = {
    id: 'hold.job',
    version: '1',
    description: 'controlled original stop',
    inputSchema: { type: 'object' },
    async start() {
      started.release();
      return handle;
    },
    async *observe() {
      await stopReleased.promise;
      yield {
        type: 'terminal',
        result: { outcome: 'cancelled', content: 'original stopped' },
        supervision: 'ended',
      } as const;
    },
    async cancel(original) {
      expect(original === handle).toBe(true);
      stopEntered.release();
      await stopReleased.promise;
      return { status: 'stopped' };
    },
    async dispose(original) {
      expect(original === handle).toBe(true);
      disposed++;
    },
  };
  const tool: ToolDefinition = {
    id: 'hold',
    version: '1',
    description: 'wait on original controlled Job',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      const operation = await context.operations.ensure({
        key: 'original',
        request: { kind: 'job', definitionId: job.id, definitionVersion: '1', input: {} },
      });
      try {
        await context.operations.wait(operation, { signal: context.signal, timeoutMs: 5000 });
      } catch (error) {
        await stopReleased.promise;
        throw error;
      }
      return { outcome: 'succeeded', content: 'original wait finished' };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [{ id: 'controlled', version: '1', apiMajor: 1, tools: [tool], jobs: [job] }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-fixture' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    instanceId: 'finishing-input',
    buildId: 'fixed',
    sessionLogs: (input, options) => readSessionLogs(store, input, options),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'commands', 'inputs', 'history'],
    },
  });
  const actualFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      if (
        String(args[0]).startsWith(service.endpoint) &&
        args[1]?.method === 'POST' &&
        typeof args[1].body === 'string'
      ) {
        if (JSON.parse(args[1].body).kind === 'input.follow_up') physicalFollowPosts++;
      }
      return actualFetch(...args);
    },
    { preconnect: actualFetch.preconnect },
  );
  await client.connect();
  const access = acquireProfileAccess(profile);
  const journal = openCallerJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  const callers = createTuiCallerPort({ client, storeId, journal });
  const readDisplay = createTuiDisplayReader(client, storeId);
  let controller: TuiController | undefined;
  let originalFailure: unknown;
  let failed = false;
  const cleanupFailures: unknown[] = [];
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'real',
    });
    for (const id of ['a', 'b'])
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        title: id,
      });
    let sequence = 0;
    const port: TuiPort = {
      storeId,
      nextCommandId: () => `tui-${++sequence}`,
      listSessions: (signal) => client.listSessions({ signal }),
      async readSession(id, signal) {
        const view = await client.getView(id, { signal });
        const messages = await client.listMessages(id, { signal, limit: 200 });
        const active = view.runs.find((run) => run.isActive);
        return {
          storeId,
          view,
          messages,
          interactions: [],
          ...(active ? { activeCommand: await client.getCommand(active.originCommandId) } : {}),
        };
      },
      callers: {
        ...callers,
        async submit(intent) {
          const result = await callers.submit(intent);
          if (intent.request.kind === 'input.follow_up') {
            followPosts++;
            receiptEntered.release();
            await receiptReleased.promise;
          }
          return result;
        },
      },
      submit: async (id, request) =>
        request.kind === 'run.start'
          ? client.startRun(id, request)
          : request.kind === 'input.steer'
            ? client.steer(id, request)
            : client.followUp(id, request),
      answer: (id, interaction, request) => client.answerInteraction(id, interaction, request),
      cancel: (id, request) => client.cancelCommand(id, request),
      getCommand: (commandId) => client.getCommand(commandId),
    };
    controller = new TuiController(port);
    await controller.select('a');
    controller.setDraft('original');
    await controller.send();
    await Promise.race([
      started.promise,
      Bun.sleep(5000).then(() => {
        throw Error('original_job_not_started');
      }),
    ]);
    const originalRun = (await client.getView('a')).runs.find((run) => run.isActive)!;
    await client.cancelRun('a', {
      kind: 'run.cancel',
      expectedStoreId: storeId,
      commandId: 'cancel-original',
      runId: originalRun.id,
    });
    await stopEntered.promise;
    await controller.select('a');
    expect(controller.state.snapshot?.view.runs.find((run) => run.isActive)?.status).toBe(
      'cancelling',
    );
    expect((await client.getRun(originalRun.id)).status).toBe('cancelling');
    const directory = await client.listSessionDirectory({ storeId, workspaceId: 'w' });
    expect(directory.items.find((item) => item.session.id === 'a')?.activity?.run?.status).toBe(
      'cancelling',
    );
    const background = await client.listBackgroundExecutions({
      storeId,
      workspaceId: 'w',
      rootSessionId: 'a',
    });
    const parent = background.items.find((item) => item.run?.id === originalRun.id);
    expect(parent?.run?.status).toBe('cancelling');
    const displayView = await client.getView('a');
    const display = await readDisplay(
      displayView,
      await client.listMessages('a'),
      new AbortController().signal,
    );
    expect(display.runtimeModel?.source).toBe('model_input');
    expect(display.runtimeModel?.runId).toBe(originalRun.id);
    expect(display.usage?.inputTokens).toBe(1);
    const firstModel = displayView.executions.find((execution) => execution.kind === 'model')!;
    if (display.executionTimings[firstModel.id]?.availability !== 'recorded_dispatch') {
      const logs = await client.listSessionLogs('a', {
        afterCursor: '0',
        upperCursor: displayView.snapshotCursor,
        limit: 200,
      });
      console.error(
        'timing source',
        JSON.stringify({
          model: {
            id: firstModel.id,
            status: firstModel.status,
            definitionId: firstModel.definitionId,
            definitionVersion: firstModel.definitionVersion,
            runId: firstModel.runId,
          },
          floor: logs.replayFloor,
          upper: logs.upperCursor,
          complete: logs.complete,
          events: logs.entries
            .filter((entry) => entry.objectId === firstModel.id)
            .map(({ type, recordedStatus, occurredAt, details, modelExecutionId }) => ({
              type,
              recordedStatus,
              occurredAt,
              details,
              modelExecutionId,
            })),
        }),
      );
    }
    expect(display.executionTimings[firstModel.id]?.availability).toBe('recorded_dispatch');
    const body = 'New task: 完整中🙂e\u0301\r\nnext line\r\n';
    controller.setDraft(body);
    const sending = controller.send();
    await Promise.race([
      receiptEntered.promise,
      sending.then(() => {
        expect(physicalFollowPosts).toBe(1);
      }),
    ]);
    expect(followPosts).toBe(1);
    expect(model.requests.length).toBe(1);
    const saved = journal.list().find((row) => row.intent.request.kind === 'input.follow_up')!;
    expect(saved.intent.request.kind).toBe('input.follow_up');
    if (saved.intent.request.kind !== 'input.follow_up') throw Error('successor_kind_mismatch');
    expect(saved.intent.request.content === body).toBe(true);
    expect(saved.intent.request.afterRunId).toBe(originalRun.id);
    const pending = await client.getCommand(saved.intent.request.commandId);
    expect(pending.status).toBe('accepted');
    expect(pending.receipt).toEqual({ commandId: pending.id });
    const stored = await store.getCommand(pending.id);
    expect(stored!.kind).toBe('input.follow_up');
    expect(stored!.request).toMatchObject({
      kind: saved.intent.request.kind,
      content: body,
      afterRunId: originalRun.id,
      contextSelectionId: saved.intent.request.contextSelectionId,
    });
    expect((await store.listAcceptedCommands('a')).map((command) => command.id)).toEqual([
      pending.id,
    ]);
    const queued = await readTuiPendingInputs(client, storeId, 'a', new AbortController().signal);
    expect(queued.map((input) => input.request.content)).toEqual([body]);
    expect(queued.map((input) => input.id)).toEqual([pending.id]);
    await controller.select('b');
    controller.setDraft('B original draft');
    receiptReleased.release();
    await sending;
    expect(controller.state.sessionId).toBe('b');
    expect(controller.state.draft).toBe('B original draft');
    stopReleased.release();
    await until(async () =>
      (await client.getView('a')).runs.some(
        (run) => run.id !== originalRun.id && run.status === 'completed',
      ),
    );
    const finalView = await client.getView('a');
    expect(await readTuiPendingInputs(client, storeId, 'a', new AbortController().signal)).toEqual(
      [],
    );
    const applied = await client.getCommand(saved.intent.request.commandId);
    const appliedReceipt = applied.receipt as {
      outcome: 'input_applied';
      runId: string;
      contextSelectionId: string;
      messageId: string;
      supersededExecutionIds: string[];
    };
    expect(applied.status).toBe('applied');
    expect(appliedReceipt).toEqual({
      outcome: 'input_applied',
      runId: appliedReceipt.runId,
      contextSelectionId: saved.intent.request.contextSelectionId,
      messageId: expect.any(String),
      supersededExecutionIds: [],
    });
    const successor = await client.getRun(appliedReceipt.runId);
    expect(successor.originCommandId).toBe(applied.id);
    expect(successor.rootWorkCommandId).toBe(applied.id);
    expect(finalView.runs.find((run) => run.id === originalRun.id)?.status).toBe('cancelled');
    expect(model.requests.length).toBe(2);
    expect(model.requests[1]!.messages.some((message) => message.content === body)).toBe(true);
    const postsBeforeLookup = physicalFollowPosts;
    expect(postsBeforeLookup).toBe(1);
    const settled = await callers.lookup(saved.intent, new AbortController().signal);
    const repeated = await callers.submit(
      await callers.prepare(saved.intent.scope, saved.intent.request),
    );
    expect(settled.phase).toBe('applied');
    expect(repeated.phase).toBe('applied');
    expect(physicalFollowPosts).toBe(postsBeforeLookup);
    expect(followPosts).toBe(1);
    expect(model.requests.length).toBe(2);
    expect(disposed).toBe(1);
  } catch (error) {
    originalFailure = error;
    failed = true;
  } finally {
    receiptReleased.release();
    stopReleased.release();
    globalThis.fetch = actualFetch;
    const cleanup = async (close: () => void | Promise<void>) => {
      try {
        await close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    await cleanup(() => controller?.dispose());
    await cleanup(() => journal.close());
    await cleanup(() => access.lock.release());
    await cleanup(() => client.disposeNetwork());
    await cleanup(() => service.close());
    await cleanup(() => runtime.close());
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      failed ? [originalFailure, ...cleanupFailures] : cleanupFailures,
      `finishing_input_cleanup_failed:${root}`,
      { cause: originalFailure },
    );
  if (failed) throw originalFailure;
  rmSync(root, { recursive: true, force: true });
}, 20000);
