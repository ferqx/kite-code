import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { AgentError, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createFixedModel } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import {
  type AgentClient,
  ClientError,
  type Command,
  canonicalCallerCommandRequest,
  createClient,
  type Run,
} from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { type ScheduledTaskClock, ScheduledTaskRunner } from '../electron/scheduled-task-runner';
import { createScheduledTaskData } from '../electron/scheduled-tasks';
import type { NativeCreation } from '../src/native-bridge';

function fixture(storeId = 'store') {
  const db = new Database(':memory:');
  db.exec('PRAGMA user_version=9');
  const data = createScheduledTaskData(() => db as unknown as DatabaseSync);
  const creations = new Map<string, NativeCreation>();
  const port = {
    ...data,
    begin(input: NativeCreation['input']) {
      const old = creations.get(input.commandId);
      if (old) return { created: false, value: old };
      const value: NativeCreation = { input: structuredClone(input), phase: 'pending' };
      creations.set(input.commandId, value);
      return { created: true, value };
    },
    finish(id: string, phase: NativeCreation['phase']) {
      const value = creations.get(id)!;
      value.phase = phase;
      return value;
    },
  };
  let now = Date.UTC(2026, 9, 15, 8, 59);
  const timers = new Map<unknown, () => void>();
  const clock: ScheduledTaskClock = {
    now: () => now,
    setTimeout(callback) {
      const id = {};
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const task = data.saveScheduledTask(
    {
      id: 'task',
      name: 'Morning',
      prompt: 'Exact prompt 中文🙂',
      workspaceId: 'workspace',
      modelId: 'fixed',
      storeId,
      enabled: true,
      schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
    },
    now,
  );
  return {
    db,
    creations,
    data: port,
    task,
    clock,
    timers,
    advance(ms: number) {
      now += ms;
    },
  };
}
function fakeClient(f: ReturnType<typeof fixture>) {
  const posts: string[] = [],
    commands = new Map<string, Command>(),
    runs = new Map<string, Run>();
  const client = {
    serverInfo: { storeId: 'store' },
    async createSession(input: NativeCreation['input']) {
      expect(
        f.data.scheduledTaskRuns().find((run) => run.createCommandId === input.commandId)!.status,
      ).toBe('creating');
      expect(
        f.data.scheduledTaskRuns().some((run) => run.createCommandId === input.commandId),
      ).toBe(true);
      posts.push('create');
      commands.set(input.commandId, {
        id: input.commandId,
        sessionId: input.sessionId,
        originStoreId: 'store',
        kind: 'session.create',
        status: 'applied',
        receipt: { sessionId: input.sessionId },
        cancelRequestedAt: null,
      });
      return { id: input.sessionId, workspaceId: input.workspaceId, parentSessionId: null };
    },
    async startRun(
      sessionId: string,
      input: { commandId: string; content: string; modelId: string },
    ) {
      expect(
        f.data
          .scheduledTaskRuns()
          .some((run) => run.startCommandId === input.commandId && run.status === 'starting'),
      ).toBe(true);
      expect(input.content).toBe('Exact prompt 中文🙂');
      expect(input.modelId).toBe('fixed');
      posts.push('start');
      const id = `run-${posts.length}`;
      const command: Command = {
        id: input.commandId,
        sessionId,
        originStoreId: 'store',
        kind: 'run.start',
        status: 'applied',
        receipt: { runId: id },
        requestDigest: createHash('sha256')
          .update(
            canonicalCallerCommandRequest({
              kind: 'run.start',
              expectedStoreId: 'store',
              ...input,
            }),
          )
          .digest('hex'),
        cancelRequestedAt: null,
      };
      commands.set(input.commandId, command);
      runs.set(id, {
        id,
        sessionId,
        originCommandId: input.commandId,
        originStoreId: 'store',
        status: 'waiting_interaction',
        isActive: true,
        createdAt: 0,
        finishedAt: null,
        reason: null,
      });
      return command;
    },
    async getCommand(id: string) {
      if (!commands.has(id)) throw Error('not_found');
      return commands.get(id)!;
    },
    async getRun(id: string) {
      return runs.get(id)!;
    },
    async getView(id: string) {
      return {
        storeId: 'store',
        session: { id, workspaceId: 'workspace', parentSessionId: null, deletedAt: null },
        executions: [],
        runs: [...runs.values()].filter((run) => run.sessionId === id),
      };
    },
    async listAllBackgroundExecutions() {
      return [];
    },
  };
  return { client: client as unknown as AgentClient, posts, commands, runs };
}

test('due work snapshots IDs before effects, waits for real Run, avoids overlap, uses fresh sessions and one timer', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    expect(c.posts).toEqual([]);
    expect(f.timers.size).toBe(1);
    f.advance(60000);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(c.posts).toEqual(['create', 'start']);
    expect(runner.list().runs[0]!.status).toBe('waiting');
    await runner.runNow('task');
    expect(c.posts).toHaveLength(2);
    const original = runner.list().runs[0]!;
    Object.assign(c.runs.get(original.serviceRunId!)!, { status: 'completed', isActive: false });
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('completed');
    await runner.runNow('task');
    expect(c.posts).toHaveLength(4);
    expect(new Set(runner.list().runs.map((run) => run.sessionId)).size).toBe(2);
    expect(f.timers.size).toBe(1);
  } finally {
    await runner.stop();
    expect(f.timers.size).toBe(0);
    f.db.close();
  }
});

test('lost start receipt and restart reconcile original IDs with GET only, observing failure honestly', async () => {
  const f = fixture(),
    c = fakeClient(f);
  const start = c.client.startRun.bind(c.client);
  c.client.startRun = async (...args) => {
    await start(...args);
    throw Error('physical_response_lost');
  };
  let runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs[0]!.status).toBe('unknown');
    await runner.stop();
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
    runner.start();
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('waiting');
    expect(c.posts).toHaveLength(2);
    const run = runner.list().runs[0]!;
    Object.assign(c.runs.get(run.serviceRunId!)!, { status: 'failed', isActive: false });
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('failed');
    expect(c.posts).toHaveLength(2);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('crash after claim before POST and foreign store never replay or launch work', async () => {
  const f = fixture(),
    c = fakeClient(f);
  f.data.claimScheduledTask('task', f.clock.now(), { manual: true, storeId: 'store' });
  const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs[0]!.status).toBe('unknown');
    expect(c.posts).toEqual([]);
    (c.client as unknown as { serverInfo: { storeId: string } }).serverInfo.storeId = 'foreign';
    f.advance(86400000);
    await runner.tick();
    expect(c.posts).toEqual([]);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

for (const protocol of ['fixed-model', 'responses'] as const) {
  test(`actual ${protocol} Service and AgentClient create independent scheduled sessions and complete ordinary Runs`, async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const provider =
      protocol === 'responses'
        ? Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            async fetch(incoming) {
              const path = new URL(incoming.url).pathname;
              requests.push({ path, body: (await incoming.json()) as Record<string, unknown> });
              if (path !== '/v1/responses')
                return new Response('unexpected endpoint', { status: 404 });
              const id = `message-${requests.length}`;
              const events = [
                {
                  type: 'response.created',
                  response: {
                    id: `response-${requests.length}`,
                    created_at: 1,
                    model: 'scheduled-mock',
                  },
                },
                {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { type: 'message', id, role: 'assistant', content: [] },
                },
                {
                  type: 'response.output_text.delta',
                  item_id: id,
                  output_index: 0,
                  content_index: 0,
                  delta: 'Scheduled Responses answer',
                },
                {
                  type: 'response.output_item.done',
                  output_index: 0,
                  item: {
                    type: 'message',
                    id,
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: 'Scheduled Responses answer', annotations: [] },
                    ],
                  },
                },
                {
                  type: 'response.completed',
                  response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
                },
              ];
              return new Response(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
                { headers: { 'content-type': 'text/event-stream' } },
              );
            },
          })
        : undefined;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-service-'))),
      dataRoot = join(root, 'data');
    const store = await openSqliteStore({ dataRoot, profile: 'test' }),
      paths = resolveProfile({ dataRoot, profile: 'test' });
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile: { dataRoot, profile: 'test' }, store }),
      modelId: 'fixed',
      model: provider
        ? createSdkModelAdapter({
            models: new Map([
              [
                'fixed',
                createCompatibleModelBinding({
                  baseURL: `http://127.0.0.1:${provider.port}/v1`,
                  modelId: 'scheduled-mock',
                  protocol: 'responses',
                  apiKey: 'local-fixture-only',
                }),
              ],
            ]),
          })
        : createFixedModel([
            [
              { type: 'text_delta', text: 'Scheduled answer' },
              { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
            ],
          ]),
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    const profile = {
      dataRoot: realpathSync(dataRoot),
      name: 'test',
      accessKey: paths.profileAccessKey,
    };
    const readonly = async (): Promise<never> => {
      throw new AgentError('fixture_readonly');
    };
    const service = await startService({
      runtime,
      profile,
      buildId: 'test',
      subjectId: 'owner',
      configurationManagement: {
        async readModels(input) {
          if (input.scope !== 'user' || input.workspaceId !== undefined)
            throw new AgentError('model_settings_user_scope_required');
          return {
            storeId: (await store.getMetadata()).storeId,
            scope: 'user',
            readSet: null,
            defaultModelId: 'fixed',
            models: [
              {
                id: 'fixed',
                enabled: true,
                configured: true,
                provider: 'fixture',
                model: 'fixed',
                diagnostics: [],
              },
            ],
            errors: [],
          };
        },
        read: readonly,
        updateModels: readonly,
        readProviders: readonly,
        discoverProviders: readonly,
        updateProviders: readonly,
        patch: readonly,
        repair: readonly,
        putCredential: readonly,
        revokeCredential: readonly,
        getMutation: readonly,
      },
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions', 'commands'] },
    });
    await client.connect();
    const storeId = client.serverInfo!.storeId!,
      f = fixture(storeId);
    const runner = new ScheduledTaskRunner(client, f.data, { clock: f.clock });
    try {
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'workspace',
        rootUri: pathToFileURL(root).href,
        name: 'Disposable',
      });
      const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = f.task;
      f.data.deleteScheduledTask('task');
      expect(runner.list().tasks).toHaveLength(0);
      const saved = await runner.save({ ...input, id: undefined }, 'create');
      const taskId = saved.tasks[0]!.id;
      expect(runner.list().tasks).toHaveLength(1);
      runner.start();
      await runner.tick();
      await runner.runNow(taskId);
      const deadline = Date.now() + 10000;
      while (
        !['completed', 'failed'].includes(runner.list().runs[0]!.status) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
        await runner.tick();
      }
      const run = runner.list().runs[0]!;
      expect(run.status).toBe('completed');
      expect(run.serviceRunId).toBeDefined();
      const actual = await client.getRun(run.serviceRunId!);
      expect(actual.originCommandId).toBe(run.startCommandId);
      expect(actual.sessionId).toBe(run.sessionId);
      const view = await client.getView(run.sessionId);
      expect(view.session.workspaceId).toBe('workspace');
      expect(view.session.parentSessionId).toBeNull();
      if (provider) {
        expect(requests).toHaveLength(1);
        expect(requests[0]!.path).toBe('/v1/responses');
        expect(requests[0]!.body.model).toBe('scheduled-mock');
        expect(requests[0]!.body.stream).toBe(true);
        expect(requests[0]!.body.store).toBe(false);
        expect(JSON.stringify(requests[0]!.body.input)).toContain('Exact prompt 中文🙂');
        expect(JSON.stringify(view)).toContain('Scheduled Responses answer');
        f.advance(1000);
        await runner.runNow(taskId);
        while (
          runner.list().runs.some((item) => !['completed', 'failed'].includes(item.status)) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(10);
          await runner.tick();
        }
        const history = runner.list().runs;
        expect(history).toHaveLength(2);
        expect(history.every((item) => item.status === 'completed')).toBe(true);
        expect(new Set(history.map((item) => item.sessionId)).size).toBe(2);
        expect(new Set(history.map((item) => item.serviceRunId)).size).toBe(2);
        expect(requests.map((item) => item.path)).toEqual(['/v1/responses', '/v1/responses']);
        expect(JSON.stringify(requests[1]!.body.input)).not.toContain('Scheduled Responses answer');
      }
    } finally {
      await runner.stop();
      client.disposeNetwork();
      await service.close();
      f.db.close();
      provider?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}

test('lost creation response remains unknown after restart and never invents a start', async () => {
  const f = fixture(),
    c = fakeClient(f);
  const create = c.client.createSession.bind(c.client);
  c.client.createSession = async (...args) => {
    await create(...args);
    throw Error('response_lost');
  };
  let runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs[0]!.status).toBe('unknown');
    await runner.stop();
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs[0]!.status).toBe('unknown');
    expect(c.posts).toEqual(['create']);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('shutdown during creation waits for settlement and prevents the subsequent start POST', async () => {
  const f = fixture(),
    c = fakeClient(f);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = c.client.createSession.bind(c.client);
  c.client.createSession = async (...args) => {
    const result = await create(...args);
    await gate;
    return result;
  };
  const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    const work = runner.runNow('task');
    const stop = runner.stop();
    release();
    await Promise.all([work, stop]);
    expect(c.posts).toEqual(['create']);
    expect(runner.list().runs[0]!.status).toBe('unknown');
    expect(f.timers.size).toBe(0);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('wrong original request digest cannot be reported as success', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const run = runner.list().runs[0]!;
    c.commands.get(run.startCommandId)!.requestDigest = 'a'.repeat(64);
    c.runs.get(run.serviceRunId!)!.status = 'completed';
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('unknown');
    expect(c.posts).toHaveLength(2);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('actual scheduled Service Run waits for ordinary approval and completes only after original-session answer', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-approval-'))),
    dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  let effects = 0;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'call', name: 'fixture.effect', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        return request.kind === 'tool'
          ? {
              allowed: false,
              revision: 'policy-1',
              approval: {
                request: { title: 'Approve original scheduled tool', input: request.input },
              },
            }
          : { allowed: true, revision: 'policy-1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Increment fixture count after explicit approval',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'approved' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'test',
    accessKey: resolveProfile({ dataRoot, profile: 'test' }).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'scheduled-approval',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile,
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'commands', 'interactions'],
    },
  });
  await client.connect();
  const storeId = client.serverInfo!.storeId!,
    f = fixture(storeId),
    runner = new ScheduledTaskRunner(client, f.data, { clock: f.clock });
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Disposable',
    });
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const sessionId = runner.list().runs[0]!.sessionId;
    let page = await client.listInteractions(sessionId, { storeId, state: 'pending' });
    const deadline = Date.now() + 10000;
    while (!page.interactions.some((item) => item.kind === 'approval') && Date.now() < deadline) {
      await Bun.sleep(10);
      page = await client.listInteractions(sessionId, { storeId, state: 'pending' });
    }
    const approval = page.interactions.find((item) => item.kind === 'approval')!;
    expect(approval).toBeDefined();
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('waiting');
    expect(effects).toBe(0);
    // Opening the recorded original Session reads its unchanged ordinary interaction.
    const opened = await client.getView(sessionId);
    expect(opened.session.id).toBe(sessionId);
    expect(opened.runs[0]!.status).toBe('waiting_interaction');
    await runner.runNow('task');
    expect(runner.list().runs).toHaveLength(1);
    expect(effects).toBe(0);
    await client.answerInteraction(sessionId, approval.id, {
      expectedStoreId: storeId,
      commandId: 'approve-scheduled',
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    await runtime.waitForCommand(runner.list().runs[0]!.startCommandId, { timeoutMs: 5000 });
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('completed');
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(
      (await client.getInteraction(sessionId, approval.id, { storeId })).acceptedDecisionRevision,
    ).toBe('2');
  } finally {
    await runner.stop();
    client.disposeNetwork();
    await service.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('creation rejection releases its private intent, while start rejection keeps creation completed', async () => {
  for (const phase of ['create', 'start'] as const) {
    const f = fixture(),
      c = fakeClient(f);
    const failure = async (): Promise<never> => {
      throw new ClientError('rejected', 'rejected', 400, {
        code: 'rejected',
        message: 'rejected',
        scope: 'request',
        requestId: 'fixture',
        retryable: false,
      });
    };
    if (phase === 'create') c.client.createSession = failure;
    else c.client.startRun = failure;
    const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
    try {
      runner.start();
      await runner.tick();
      await runner.runNow('task');
      const run = runner.list().runs[0]!;
      expect(run.status).toBe('failed');
      expect(run.settlementVersion).toBe(1);
      expect(f.creations.get(run.createCommandId)!.phase).toBe(
        phase === 'create' ? 'rejected' : 'created',
      );
    } finally {
      await runner.stop();
      f.db.close();
    }
  }
});

test('list returns bounded newest run metadata without persisted prompt snapshots', () => {
  const f = fixture(),
    c = fakeClient(f);
  const source = f.data.claimScheduledTask('task', f.clock.now(), {
    manual: true,
    storeId: 'store',
  })!;
  const runs = Array.from({ length: 300 }, (_, index) => ({
    ...source,
    id: `run${index}`,
    taskId: `task${index % 10}`,
    createdAt: index,
  }));
  f.data.scheduledTaskRuns = () => structuredClone(runs);
  const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    const result = runner.list();
    expect(result.runs).toHaveLength(128);
    expect(result.runs[0]!.createdAt).toBe(299);
    expect(result.runs.every((run) => !('task' in run))).toBe(true);
    for (const id of new Set(result.runs.map((run) => run.taskId)))
      expect(result.runs.filter((run) => run.taskId === id).length).toBeLessThanOrEqual(20);
  } finally {
    f.db.close();
  }
});

test('list bounds actual escaped JSON bytes for maximal control-character run errors', () => {
  const f = fixture(),
    c = fakeClient(f);
  const source = f.data.claimScheduledTask('task', f.clock.now(), {
    manual: true,
    storeId: 'store',
  })!;
  const tasks = Array.from({ length: 128 }, (_, index) => ({
    ...f.task,
    id: `task${index}`,
    prompt: 'x'.repeat(7800),
  }));
  const runs = tasks.map((task, index) => ({
    ...source,
    id: `run${index}`,
    taskId: task.id,
    task,
    createdAt: index,
    status: 'failed' as const,
    error: '\u0000'.repeat(4096),
  }));
  f.data.scheduledTasks = () => structuredClone(tasks);
  f.data.scheduledTaskRuns = () => structuredClone(runs);
  const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    expect(Buffer.byteLength(JSON.stringify(tasks))).toBeLessThanOrEqual(1024 * 1024);
    const unbounded = {
      kind: 'scheduled.tasks',
      tasks,
      runs: runs.map(({ task: _task, ...run }) => run),
    };
    expect(Buffer.byteLength(JSON.stringify(unbounded))).toBeGreaterThan(4 * 1024 * 1024);
    const result = runner.list();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(result.tasks).toHaveLength(128);
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.runs.length).toBeLessThan(128);
    expect(result.runs[0]!.createdAt).toBe(127);
    expect(result.runs[0]!.error).toBe('\u0000'.repeat(4096));
    const next = unbounded.runs[result.runs.length]!;
    expect(
      Buffer.byteLength(JSON.stringify({ ...result, runs: [...result.runs, next] })),
    ).toBeGreaterThan(3 * 1024 * 1024);
  } finally {
    f.db.close();
  }
});

test('an edit deleted during read-only validation cannot become a new enabled task', async () => {
  const f = fixture(),
    c = fakeClient(f);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(c.client, {
    listWorkspaces: async () => {
      await gate;
      return [{ id: 'workspace' }];
    },
    getModelSettings: async () => ({ models: [{ id: 'fixed', enabled: true, configured: true }] }),
  });
  const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = f.task;
  try {
    const saving = runner.save({ ...input, prompt: 'Earlier edit' }, 'update');
    expect(runner.delete(f.task.id).tasks).toHaveLength(0);
    const checked = saving.catch((error: unknown) => error);
    release();
    expect(await checked).toEqual(Error('scheduled_task_not_found'));
    expect(runner.list().tasks).toHaveLength(0);
    await expect(runner.save(input, 'update')).rejects.toThrow('scheduled_task_not_found');
    expect(c.posts).toEqual([]);
  } finally {
    release();
    f.db.close();
  }
});

test('restored foreign running rows stay byte-identical even if Store changes during an original GET', async () => {
  const f = fixture(),
    c = fakeClient(f);
  const original = f.data.claimScheduledTask('task', f.clock.now(), {
    manual: true,
    storeId: 'store',
  })!;
  const before = f.db
    .prepare('SELECT hex(state) AS bytes FROM scheduled_task_runs WHERE id=?')
    .get(original.id);
  c.client.getCommand = async () => {
    (c.client as unknown as { serverInfo: { storeId: string } }).serverInfo.storeId = 'restored';
    throw Error('connection_changed');
  };
  const runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    f.advance(86400000);
    await runner.tick();
    expect(
      f.db
        .prepare('SELECT hex(state) AS bytes FROM scheduled_task_runs WHERE id=?')
        .get(original.id),
    ).toEqual(before);
    expect(c.posts).toEqual([]);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

for (const foreground of ['completed', 'failed', 'cancelled'] as const) {
  test(`terminal ${foreground} Run does not settle unknown child tools or active detached group work`, async () => {
    const f = fixture(),
      c = fakeClient(f),
      runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
    try {
      runner.start();
      await runner.tick();
      await runner.runNow('task');
      const original = runner.list().runs[0]!;
      Object.assign(c.runs.get(original.serviceRunId!)!, { status: foreground, isActive: false });
      let effectStatus = 'outcome_unknown',
        jobStatus = 'failed';
      c.client.listAllBackgroundExecutions = async () =>
        [
          {
            execution: {
              id: 'job',
              rootSessionId: original.sessionId,
              originStoreId: 'store',
              rootWorkCommandId: original.startCommandId,
              status: jobStatus,
            },
            rootSession: { id: original.sessionId },
            session: { workspaceId: 'workspace' },
            childSession: { id: 'child' },
            childRun: { isActive: false },
          },
        ] as never;
      const rootView = c.client.getView.bind(c.client);
      c.client.getView = async (id) =>
        id === 'child'
          ? ({
              storeId: 'store',
              session: {
                id,
                rootSessionId: original.sessionId,
                workspaceId: 'workspace',
                parentSessionId: original.sessionId,
                deletedAt: null,
              },
              runs: [],
              executions: [
                {
                  id: 'effect',
                  sessionId: id,
                  originStoreId: 'store',
                  rootWorkCommandId: original.startCommandId,
                  runId: 'child-run',
                  status: effectStatus,
                },
              ],
            } as never)
          : rootView(id);
      await runner.tick();
      expect(runner.list().runs[0]!.status).toBe('unknown');
      f.advance(60000);
      await runner.tick();
      await runner.runNow('task');
      expect(runner.list().runs).toHaveLength(1);
      expect(c.posts).toHaveLength(2);
      effectStatus = 'succeeded';
      jobStatus = 'running';
      await runner.tick();
      expect(runner.list().runs[0]!.status).toBe('waiting');
      jobStatus = 'succeeded';
      await runner.tick();
      expect(runner.list().runs[0]!.status).toBe(foreground);
    } finally {
      await runner.stop();
      f.db.close();
    }
  });
}

test('failed group reads keep the exact scheduled occurrence unknown and never replay it', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const original = runner.list().runs[0]!;
    Object.assign(c.runs.get(original.serviceRunId!)!, { status: 'completed', isActive: false });
    c.client.listAllBackgroundExecutions = async () => {
      throw Error('unavailable');
    };
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('unknown');
    f.advance(60000);
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs).toHaveLength(1);
    expect(c.posts).toHaveLength(2);
    c.client.listAllBackgroundExecutions = async () => [];
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('completed');
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('actual Runtime unknown tool outcome keeps the failed scheduled Run blocked across due time and restart', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-unknown-'))),
    dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  let effects = 0;
  const step = [
    { type: 'tool_call' as const, id: 'call', name: 'fixture.effect', arguments: '{}' },
    {
      type: 'finish' as const,
      reason: 'tool_calls' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
  const model = createFixedModel([step, step]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless counter with lost acknowledgement',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'outcome_unknown', content: 'Effect needs reconciliation' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'test',
    accessKey: resolveProfile({ dataRoot, profile: 'test' }).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'scheduled-unknown',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions', 'commands'] },
  });
  await client.connect();
  const storeId = client.serverInfo!.storeId!,
    f = fixture(storeId);
  let runner = new ScheduledTaskRunner(client, f.data, { clock: f.clock });
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Disposable',
    });
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const original = runner.list().runs[0]!;
    await runtime.waitForCommand(original.startCommandId, { timeoutMs: 5000 });
    await runner.tick();
    const view = await client.getView(original.sessionId);
    expect(view.runs[0]!.status).toBe('failed');
    expect(view.executions.some((item) => item.status === 'outcome_unknown')).toBe(true);
    expect(runner.list().runs[0]!.status).toBe('unknown');
    expect(runner.list().runs[0]!.finishedAt).toBeUndefined();
    await runner.stop();
    runner = new ScheduledTaskRunner(client, f.data, { clock: f.clock });
    runner.start();
    await runner.tick();
    f.advance(60000);
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs).toHaveLength(1);
    expect(runner.list().runs[0]!.sessionId).toBe(original.sessionId);
    expect(runner.list().runs[0]!.status).toBe('unknown');
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect(() => runner.delete('task')).toThrow('scheduled_task_active');
  } finally {
    await runner.stop();
    client.disposeNetwork();
    await service.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('actual detached child remains a scheduling gate after the original foreground Run completes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-child-'))),
    dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const parent = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const child = createFixedModel([
    [
      { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
  ]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let childSessionId = '',
    childExecutionId = '',
    effects = 0;
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['fixture.effect'],
        snapshot: { fixture: 'scheduled-child' },
        maxConcurrentSubagents: 1,
      },
    ],
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Start an owned harmless child',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'child',
                cancellation: 'detached',
                request: {
                  kind: 'agent',
                  configurationId: 'child',
                  input: { content: 'Perform fixture effect' },
                },
              });
              childSessionId = ref.childSessionId!;
              childExecutionId = ref.executionId!;
              return { outcome: 'succeeded', content: 'Child started' };
            },
          },
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless counter with uncertain result',
            inputSchema: { type: 'object' },
            async execute() {
              entered();
              await gate;
              effects++;
              return { outcome: 'outcome_unknown', content: 'Needs reconciliation' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'test',
    accessKey: resolveProfile({ dataRoot, profile: 'test' }).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'scheduled-child',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions', 'commands'] },
  });
  await client.connect();
  const storeId = client.serverInfo!.storeId!,
    f = fixture(storeId);
  const runner = new ScheduledTaskRunner(client, f.data, { clock: f.clock });
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Disposable',
    });
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const original = runner.list().runs[0]!;
    await runtime.waitForCommand(original.startCommandId, { timeoutMs: 5000 });
    await started;
    expect((await client.getView(original.sessionId)).runs[0]!.status).toBe('completed');
    await runner.tick();
    expect(runner.list().runs[0]!.status).toBe('waiting');
    f.advance(60000);
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs).toHaveLength(1);
    expect(effects).toBe(0);
    release();
    await runtime.waitForCommand(`child-start-${childExecutionId}`, { timeoutMs: 5000 });
    await runner.tick();
    expect(
      (await client.getView(childSessionId)).executions.some(
        (execution) => execution.status === 'outcome_unknown',
      ),
    ).toBe(true);
    expect(runner.list().runs[0]!.status).toBe('unknown');
    f.advance(86400000);
    await runner.tick();
    await runner.runNow('task');
    expect(runner.list().runs).toHaveLength(1);
    expect(effects).toBe(1);
    expect(parent.requests).toHaveLength(2);
    expect(child.requests).toHaveLength(1);
  } finally {
    release();
    await runner.stop();
    client.disposeNetwork();
    await service.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('older unverified failed history cannot hide behind a later completed Run across restart or read failure', async () => {
  const f = fixture(),
    c = fakeClient(f);
  let runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    for (let i = 0; i < 2; i++) {
      await runner.runNow('task');
      const run = f.data.scheduledTaskRuns().find((item) => item.settlementVersion !== 1)!;
      Object.assign(c.runs.get(run.serviceRunId!)!, {
        status: i ? 'completed' : 'failed',
        isActive: false,
      });
      await runner.tick();
      f.advance(1);
    }
    const history = f.data.scheduledTaskRuns().sort((a, b) => a.createdAt - b.createdAt);
    f.db.exec("UPDATE scheduled_task_runs SET state=json_remove(state,'$.settlementVersion')");
    const oldBytes = f.db
      .query('SELECT state FROM scheduled_task_runs WHERE id=?')
      .get(history[0]!.id);
    const originalView = c.client.getView.bind(c.client);
    let unreadable = false;
    c.client.getView = async (id) => {
      if (unreadable) throw Error('unavailable');
      const view = await originalView(id);
      if (id === history[0]!.sessionId)
        view.executions = [
          {
            sessionId: id,
            originStoreId: 'store',
            rootWorkCommandId: history[0]!.startCommandId,
            runId: history[0]!.serviceRunId,
            status: 'outcome_unknown',
          },
        ] as never;
      return view;
    };
    const due = f.data.scheduledTasks()[0]!.nextRunAt;
    f.advance(60000);
    await runner.tick();
    expect(f.data.scheduledTasks()[0]!.nextRunAt).toBe(due);
    expect(
      f.data.scheduledTaskRuns().find((item) => item.id === history[1]!.id)!.settlementVersion,
    ).toBe(1);
    expect(
      f.db.query('SELECT state FROM scheduled_task_runs WHERE id=?').get(history[0]!.id),
    ).toEqual(oldBytes);
    expect(runner.list().runs.find((item) => item.id === history[0]!.id)!.status).toBe('unknown');
    expect(() => runner.delete('task')).toThrow('scheduled_task_active');
    await expect(runner.runNow('task')).rejects.toThrow('scheduled_task_history_unverified');
    await runner.stop();
    unreadable = true;
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
    runner.start();
    await runner.tick();
    await expect(runner.runNow('task')).rejects.toThrow('scheduled_task_history_unverified');
    expect(c.posts).toHaveLength(4);
    expect(f.data.scheduledTasks()[0]!.nextRunAt).toBe(due);
    expect(f.data.scheduledTaskRuns()).toHaveLength(2);
    expect(
      f.db.query('SELECT state FROM scheduled_task_runs WHERE id=?').get(history[0]!.id),
    ).toEqual(oldBytes);
    unreadable = false;
    c.client.getView = originalView;
    await runner.runNow('task');
    expect(c.posts).toHaveLength(6);
    expect(
      f.data.scheduledTaskRuns().find((item) => item.id === history[0]!.id)!.settlementVersion,
    ).toBe(1);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('legacy settlement checks use a global four-record batch without consuming the pending due occurrence', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    for (let i = 0; i < 6; i++) {
      await runner.runNow('task');
      const run = f.data.scheduledTaskRuns().find((item) => item.settlementVersion !== 1)!;
      Object.assign(c.runs.get(run.serviceRunId!)!, { status: 'completed', isActive: false });
      await runner.tick();
      f.advance(1);
    }
    f.db.exec("UPDATE scheduled_task_runs SET state=json_remove(state,'$.settlementVersion')");
    let checks = 0;
    const get = c.client.getCommand.bind(c.client);
    c.client.getCommand = async (id, options) => {
      checks++;
      return get(id, options);
    };
    const due = f.data.scheduledTasks()[0]!.nextRunAt;
    f.advance(60000);
    await runner.tick();
    expect(checks).toBe(4);
    expect(c.posts).toHaveLength(12);
    expect(f.data.scheduledTasks()[0]!.nextRunAt).toBe(due);
    expect(f.data.scheduledTaskRuns().filter((run) => run.settlementVersion === 1)).toHaveLength(4);
    await runner.tick();
    expect(checks).toBe(6);
    expect(c.posts).toHaveLength(14);
    expect(f.data.scheduledTaskRuns().filter((run) => run.settlementVersion === 1)).toHaveLength(6);
    expect(f.data.scheduledTasks()[0]!.nextRunAt).toBeGreaterThan(due!);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('terminal after-turn report and later same-group active Run prevent a premature settlement marker', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const original = f.data.scheduledTaskRuns()[0]!;
    Object.assign(c.runs.get(original.serviceRunId!)!, { status: 'completed', isActive: false });
    const reportId = `report-${createHash('sha256')
      .update(JSON.stringify(['store', 'job', '1']))
      .digest('hex')}`;
    c.commands.set(reportId, {
      id: reportId,
      kind: 'job.report',
      originStoreId: 'store',
      sessionId: original.sessionId,
      status: 'accepted',
    } as Command);
    let delivery = 'pending';
    const order: string[] = [];
    c.client.listAllBackgroundExecutions = async () => {
      order.push('background');
      return [
        {
          execution: {
            id: 'job',
            sessionId: original.sessionId,
            rootSessionId: original.sessionId,
            originStoreId: 'store',
            rootWorkCommandId: original.startCommandId,
            status: 'succeeded',
            delivery,
            resultRevision: '1',
          },
          rootSession: { id: original.sessionId },
          session: { workspaceId: 'workspace' },
        },
      ] as never;
    };
    const view = c.client.getView.bind(c.client);
    c.client.getView = async (id) => {
      order.push('view');
      return view(id);
    };
    await runner.tick();
    expect(order).toEqual(['background', 'view']);
    expect(f.data.scheduledTaskRuns()[0]!.status).toBe('waiting');
    expect(f.data.scheduledTaskRuns()[0]!.settlementVersion).toBeUndefined();
    c.commands.get(reportId)!.status = 'applied';
    c.runs.set('report-run', {
      ...c.runs.get(original.serviceRunId!)!,
      id: 'report-run',
      originCommandId: reportId,
      isActive: true,
    });
    delivery = 'consumed';
    await runner.tick();
    expect(f.data.scheduledTaskRuns()[0]!.status).toBe('waiting');
    expect(f.data.scheduledTaskRuns()[0]!.settlementVersion).toBeUndefined();
    c.runs.get('report-run')!.isActive = false;
    // Ordinary pending results have no report, and must remain non-blocking.
    delivery = 'pending';
    c.commands.delete(reportId);
    const get = c.client.getCommand.bind(c.client);
    c.client.getCommand = async (id) => {
      if (id === reportId) throw new ClientError('command_not_found', 'Not found', 404);
      return get(id);
    };
    await runner.tick();
    expect(f.data.scheduledTaskRuns()[0]!.status).toBe('completed');
    expect(f.data.scheduledTaskRuns()[0]!.settlementVersion).toBe(1);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('actual after-turn report admission and its active Run block scheduling until all report effects settle', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-after-turn-'))),
    dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { release, promise };
  };
  const childGate = gate(),
    applyReady = gate(),
    applyGate = gate(),
    reportStarted = gate(),
    reportStartGate = gate();
  const originalReceive = store.receiveAgentMessages.bind(store);
  store.receiveAgentMessages = async (input) => {
    const result = await originalReceive(input);
    for (const commandId of input.messageIds) {
      const command = await store.getCommand(commandId);
      const receipt = command?.receipt as { mode?: string; runId?: string } | undefined;
      const run = receipt?.runId ? await store.getRun(receipt.runId) : null;
      if (
        command?.kind === 'job.report' &&
        command.status === 'applied' &&
        receipt?.mode === 'idle_new_turn' &&
        run?.isActive &&
        run.originCommandId === command.id
      ) {
        reportStarted.release();
        await reportStartGate.promise;
      }
    }
    return result;
  };
  let calls = 0,
    effects = 0;
  const model = {
    async *stream() {
      calls++;
      if (calls === 1) {
        yield {
          type: 'tool_call' as const,
          id: 'delegate',
          name: 'spawn_agent',
          arguments: JSON.stringify({
            prompt: 'Harmless child',
          }),
        };
        yield { ...finish, reason: 'tool_calls' as const };
      } else if (calls === 3) {
        yield { type: 'tool_call' as const, id: 'effect', name: 'fixture.effect', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' as const };
      } else yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: { dataRoot, profile: 'test' }, store }),
    model,
    modelId: 'fixed',
    modelConcurrency: 2,
    afterTurn: {
      async authorize(input) {
        if (input.phase === 'apply') {
          applyReady.release();
          await applyGate.promise;
        }
        return { allowed: true, revision: 'one' };
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: {
          async *stream() {
            await childGate.promise;
            yield { type: 'text_delta' as const, text: 'Actual child result' };
            yield finish;
          },
        },
        modelId: 'child',
        snapshot: {},
        toolIds: [],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      createTaskExtension({
        roles: [{ id: 'reader', configurationId: 'child', description: 'Harmless' }],
        afterTurn: { enabled: true },
      }),
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless report counter',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded' as const, content: 'Effect settled' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'test',
    accessKey: resolveProfile({ dataRoot, profile: 'test' }).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'review-after-turn',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions', 'commands'] },
  });
  await client.connect();
  const storeId = client.serverInfo!.storeId!;
  const f = fixture(storeId),
    data = f.data;
  const runner = new ScheduledTaskRunner(client, data, { clock: f.clock });
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Disposable',
    });

    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const first = data.scheduledTaskRuns()[0]!;
    await runtime.waitForCommand(first.startCommandId, { timeoutMs: 5000 });
    childGate.release();
    await Promise.race([
      applyReady.promise,
      new Promise((_, r) => setTimeout(() => r(Error('apply not ready')), 5000)),
    ]);
    const carrier = (await store.getView(first.sessionId)).executions.find(
      (x) => x.childSessionId,
    )!;
    assert.equal(carrier.status, 'succeeded');
    assert.equal(carrier.delivery, 'pending');
    const reportId = `report-${createHash('sha256')
      .update(JSON.stringify([storeId, carrier.id, carrier.resultRevision]))
      .digest('hex')}`;
    assert.equal((await client.getCommand(reportId)).status, 'accepted');
    await runner.tick();
    f.advance(60000);
    await runner.tick();
    assert.equal(
      data.scheduledTaskRuns().length,
      1,
      'pending same-group report must block next occurrence',
    );
    assert.equal(
      data.scheduledTaskRuns()[0]!.settlementVersion,
      undefined,
      'no settlement marker before report effects',
    );
    assert.equal(effects, 0);
    applyGate.release();
    await Promise.race([
      reportStarted.promise,
      new Promise((_, r) => setTimeout(() => r(Error('report start not ready')), 5000)),
    ]);
    await runner.tick();
    const mid = await store.getView(first.sessionId);
    assert.equal(mid.runs.filter((r) => r.isActive).length, 1);
    assert.equal(
      mid.executions.some(
        (e) => e.status === 'planned' || e.status === 'dispatching' || e.status === 'running',
      ),
      false,
    );
    assert.equal(
      data.scheduledTaskRuns()[0]!.settlementVersion,
      undefined,
      'active same-group report Run without Model still blocks settlement',
    );
    reportStartGate.release();
    await runtime.waitForCommand(reportId, { timeoutMs: 5000 });
    await runner.tick();
    assert.equal(effects, 1);
    assert.equal(data.scheduledTaskRuns()[0]!.status, 'completed');
    assert.equal(data.scheduledTaskRuns()[0]!.settlementVersion, 1);
    const view = await store.getView(first.sessionId);
    assert.equal(view.runs.filter((x) => x.rootWorkCommandId === first.startCommandId).length, 2);
  } finally {
    childGate.release();
    applyGate.release();
    reportStartGate.release();
    await runner.stop();
    client.disposeNetwork();
    await service.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('stop drains manual legacy verification before private storage closes and never starts another run', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  let release!: () => void;
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const run = f.data.scheduledTaskRuns()[0]!;
    Object.assign(c.runs.get(run.serviceRunId!)!, { status: 'completed', isActive: false });
    await runner.tick();
    f.db.exec("UPDATE scheduled_task_runs SET state=json_remove(state,'$.settlementVersion')");
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const getCommand = c.client.getCommand.bind(c.client);
    c.client.getCommand = async (...args) => {
      entered();
      await gate;
      return getCommand(...args);
    };
    const manual = runner.runNow('task').catch((cause: unknown) => cause);
    await ready;
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);
    release();
    expect(await manual).toMatchObject({ message: 'scheduled_runner_stopped' });
    await stopping;
    expect(stopped).toBe(true);
    expect(c.posts).toEqual(['create', 'start']);
    expect(f.timers.size).toBe(0);
    const settled = JSON.stringify(f.data.scheduledTaskRuns());
    await Bun.sleep(0);
    expect(JSON.stringify(f.data.scheduledTaskRuns())).toBe(settled);
  } finally {
    release?.();
    await runner.stop();
    f.db.close();
  }
});

test('an identical create retry across its due time preserves persisted scheduling bytes and rejects changed identity', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = f.task;
  Object.assign(c.client, {
    listWorkspaces: async () => [{ id: 'workspace' }],
    getModelSettings: async () => ({ models: [{ id: 'fixed', enabled: true, configured: true }] }),
  });
  try {
    const before = f.db.query('SELECT state FROM scheduled_tasks WHERE id=?').get(f.task.id);
    f.advance(60001);
    await runner.save(input, 'create');
    expect(f.data.scheduledTasks()).toEqual([f.task]);
    expect(f.db.query('SELECT state FROM scheduled_tasks WHERE id=?').get(f.task.id)).toEqual(
      before,
    );
    expect(f.data.scheduledTasks()[0]!.nextRunAt).toBeLessThan(f.clock.now());
    expect(c.posts).toEqual([]);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    c.client.getModelSettings = async () => {
      entered();
      await gate;
      return { models: [{ id: 'fixed', enabled: true, configured: true }] } as never;
    };
    const retry = runner.save(input, 'create').catch((cause: unknown) => cause);
    await ready;
    const changed = f.data.saveScheduledTask(
      { ...input, prompt: 'Independently changed' },
      f.clock.now(),
    );
    release();
    expect(await retry).toMatchObject({ message: 'scheduled_task_identity_conflict' });
    expect(f.data.scheduledTasks()).toEqual([changed]);
    expect(c.posts).toEqual([]);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('a retained human_work_deferred Run does not prove scheduled work settled or admit another occurrence', async () => {
  const f = fixture(),
    c = fakeClient(f),
    runner = new ScheduledTaskRunner(c.client, f.data, { clock: f.clock });
  try {
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const first = f.data.scheduledTaskRuns()[0]!;
    Object.assign(c.runs.get(first.serviceRunId!)!, {
      status: 'completed',
      isActive: false,
      reason: 'human_work_deferred',
    });
    await runner.tick();
    f.advance(60000);
    await runner.tick();
    await runner.runNow('task');
    expect(f.data.scheduledTaskRuns()).toHaveLength(1);
    expect(f.data.scheduledTaskRuns()[0]).toMatchObject({
      id: first.id,
      status: 'unknown',
      error: 'human_work_deferred',
    });
    expect(f.data.scheduledTaskRuns()[0]!.settlementVersion).toBeUndefined();
    expect(c.posts).toEqual(['create', 'start']);
  } finally {
    await runner.stop();
    f.db.close();
  }
});

test('a queued human turn cannot settle unfinished scheduled Tool work or admit another occurrence', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-scheduled-queued-human-')));
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  let release!: () => void;
  const originalGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    effects = 0;
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: { dataRoot, profile: 'test' }, store }),
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    model: {
      async *stream() {
        if (calls++ === 0) {
          yield {
            type: 'tool_call' as const,
            id: 'effect',
            name: 'fixture.effect',
            arguments: '{}',
          };
          yield { ...finish, reason: 'tool_calls' as const };
          return;
        }
        yield { type: 'text_delta' as const, text: 'Actual completed response' };
        yield finish;
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless controlled scheduled work',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              await originalGate;
              return { outcome: 'succeeded' as const, content: 'Actual scheduled work settled' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(dataRoot),
    name: 'test',
    accessKey: resolveProfile({ dataRoot, profile: 'test' }).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'scheduled-queued-human',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions', 'commands'] },
  });
  await client.connect();
  const storeId = client.serverInfo!.storeId!;
  const f = fixture(storeId),
    runner = new ScheduledTaskRunner(client, f.data, { clock: f.clock });
  const until = async (read: () => Promise<boolean>) => {
    const end = Date.now() + 6000;
    while (!(await read())) {
      if (Date.now() > end) throw Error('scheduled_tool_timeout');
      await Bun.sleep(5);
    }
  };
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'Disposable',
    });
    runner.start();
    await runner.tick();
    await runner.runNow('task');
    const first = f.data.scheduledTaskRuns()[0]!;
    await until(async () => effects === 1);
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: first.sessionId,
      subjectId: 'owner',
      commandId: 'independent-B',
      request: { kind: 'run.start', content: 'New task: independent B' },
    });
    const active = await store.getView(first.sessionId);
    const original = active.runs.find((run) => run.rootWorkCommandId === first.startCommandId)!;
    expect(original).toMatchObject({
      status: 'running',
      isActive: true,
    });
    expect(active.executions.filter((execution) => execution.kind === 'tool')).toMatchObject([
      {
        definitionId: 'fixture.effect',
        status: 'dispatching',
        authorization: { dispatched: true },
      },
    ]);
    expect((await store.getCommand('independent-B'))?.status).toBe('accepted');
    expect(calls).toBe(1);
    await runner.tick();
    expect(f.data.scheduledTaskRuns()[0]!.status).toBe('running');
    expect(f.data.scheduledTaskRuns()[0]!.settlementVersion).toBeUndefined();
    f.advance(60000);
    await runner.tick();
    expect(f.data.scheduledTaskRuns()).toHaveLength(1);
    await runner.runNow('task');
    expect(f.data.scheduledTaskRuns()[0]!.status).toBe('running');
    expect(f.data.scheduledTaskRuns()[0]!.settlementVersion).toBeUndefined();
    expect(f.data.scheduledTaskRuns()).toHaveLength(1);
    expect((await store.getCommand('independent-B'))?.status).toBe('accepted');
    expect(calls).toBe(1);
    expect(effects).toBe(1);
    await runner.toggle('task', false);
    release();
    await runtime.waitForCommand(first.startCommandId, { timeoutMs: 6000 });
    await runtime.waitForCommand('independent-B', { timeoutMs: 6000 });
    const settled = await store.getView(first.sessionId);
    expect(settled.runs.map((run) => run.originCommandId)).toEqual([
      first.startCommandId,
      'independent-B',
    ]);
    expect(settled.runs.every((run) => run.status === 'completed' && !run.isActive)).toBe(true);
    expect(calls).toBe(3);
    expect(effects).toBe(1);
    await runner.tick();
    expect(f.data.scheduledTaskRuns()).toHaveLength(1);
    expect(f.data.scheduledTaskRuns()[0]).toMatchObject({
      id: first.id,
      status: 'completed',
      settlementVersion: 1,
    });
  } finally {
    release();
    await runner.stop();
    client.disposeNetwork();
    await service.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
