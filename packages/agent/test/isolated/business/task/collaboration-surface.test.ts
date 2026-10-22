import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function openFaultDatabase(path: string) {
  const database = new Database(path);
  // Match the live engine's bounded writer policy for isolated SQL fault setup.
  database.run('PRAGMA busy_timeout=1000');
  return database;
}
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];

test('six public tools reuse one child Session, preserve responsibility and observe real completion without consuming it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let lostSpawnResponse = false,
    lostFollowUpResponse = false;
  let originalFollowUpInput: Parameters<typeof store.applyAgentCommand>[0] | undefined;
  const ensureOperation = store.ensureOperation.bind(store);
  store.ensureOperation = async (input) => {
    const receipt = await ensureOperation(input);
    if (input.collaborationCompletion && !lostSpawnResponse) {
      lostSpawnResponse = true;
      throw Error('isolated response lost after durable spawn commit');
    }
    return receipt;
  };
  const applyAgentCommand = store.applyAgentCommand.bind(store);
  store.applyAgentCommand = async (input) => {
    originalFollowUpInput ??= input;
    const receipt = await applyAgentCommand(input);
    if (!lostFollowUpResponse) {
      lostFollowUpResponse = true;
      throw Error('isolated response lost after durable follow-up commit');
    }
    return receipt;
  };
  const originalAssignment = `First precise assignment without a name: ${'complete responsibility source '.repeat(1500)} END_ASSIGNMENT`;
  let stage = 0,
    childCalls = 0,
    childId = '',
    after = '0';
  const expectedNames = [
    'follow_up_agent',
    'interrupt_agent',
    'list_agents',
    'send_agent_message',
    'spawn_agent',
    'wait_agent_events',
  ];
  const parent: ModelAdapter = {
    async *stream(request) {
      expect(request.tools.map((tool) => tool.id).sort()).toEqual(expectedNames);
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const encoded = last?.content.includes('Complete artifact body:\n')
        ? last.content.split('Complete artifact body:\n')[1]!
        : last?.content;
      const body = encoded ? JSON.parse(encoded) : null;
      let events: ModelEvent[];
      switch (stage++) {
        case 0:
          events = call('spawn_agent', { prompt: originalAssignment });
          break;
        case 1:
          expect(body).toMatchObject({ accepted: true, state: 'queued' });
          childId = body.agent_id;
          events = call('wait_agent_events', { wait_ms: 10000 });
          break;
        case 2:
          expect(body.reason).toBe('events');
          expect(body.events).toContainEqual(
            expect.objectContaining({ kind: 'completed', agent_id: childId }),
          );
          after = body.next_seq;
          events = call('list_agents', { limit: 1 });
          break;
        case 3:
          expect(body.items).toHaveLength(1);
          expect(body.next_after_seq).toBeNull();
          expect(body.items[0]).toMatchObject({
            agent_id: childId,
            assignment_source: { content: originalAssignment },
            last_outcome: 'succeeded',
          });
          events = call('follow_up_agent', {
            agent_id: childId,
            content: 'Continue in the same saved Session',
          });
          break;
        case 4:
          expect(body).toMatchObject({
            accepted: true,
            agent_id: childId,
            mode: 'new_turn',
            state: 'queued',
          });
          events = call('wait_agent_events', { after_seq: after, wait_ms: 10000 });
          break;
        case 5:
          expect(body.reason).toBe('events');
          events = call('list_agents', { agent_ids: [childId], limit: 1 });
          break;
        case 6: {
          expect(body.items).toHaveLength(1);
          expect(body.items[0].agent_id).toBe(childId);
          expect(body.items[0].assignment_source.content).toBe(originalAssignment);
          expect(body.items[0].current_work_source.content).toBe(
            'Continue in the same saved Session',
          );
          expect(body.next_after_seq).toBeNull();
          const replayCursor = (await store.getMetadata()).lastChangeCursor;
          const replay = await applyAgentCommand(originalFollowUpInput!);
          expect(replay.receipt).toMatchObject({
            accepted: true,
            agentId: childId,
            mode: 'new_turn',
            state: 'queued',
          });
          expect((await store.getMetadata()).lastChangeCursor).toBe(replayCursor);
          expect(
            (await store.listExecutions('root')).filter(
              (execution) => execution.childSessionId === childId,
            ),
          ).toHaveLength(2);
          events = [finish];
          break;
        }
        default:
          events = [finish];
          break;
      }
      for (const event of events) yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      yield { type: 'text_delta', text: `Real child result ${childCalls}` };
      yield finish;
    },
  };
  const extension = createTaskExtension({
    roles: [{ id: 'worker', configurationId: 'worker', description: 'General trusted child' }],
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    model: parent,
    modelId: 'parent',
    extensions: [extension],
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'temp',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'collaboration',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'coordinate' },
    });
    const result = await runtime.waitForCommand('work', { timeoutMs: 25000 });
    expect((await store.getRun((result.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(childCalls).toBe(2);
    const directoryTools = (await store.listExecutions('root')).filter(
      (execution) => execution.definitionId === 'task.list',
    );
    expect(directoryTools.length).toBeGreaterThan(0);
    expect(
      directoryTools.every(
        (execution) =>
          (execution.result as { modelContent?: { kind: string } }).modelContent?.kind ===
          'artifact',
      ),
    ).toBe(true);
    expect(lostSpawnResponse).toBe(true);
    expect(lostFollowUpResponse).toBe(true);
    // Isolated directory-only sequence placement: this does not claim whole-context large-sequence qualification.
    const database = openFaultDatabase(join(root, 'data', 'test', 'core.db'));
    const commands = database
      .prepare(
        "SELECT id,seq FROM command WHERE session_id='root' AND kind='operation.agent' ORDER BY seq",
      )
      .all() as { id: string; seq: number }[];
    const originalSequence = (
      database.prepare("SELECT next_seq FROM session WHERE id='root'").get() as { next_seq: number }
    ).next_seq;
    for (const [index, command] of commands.entries())
      database.run('UPDATE command SET seq=? WHERE id=?', [
        9007199254740993n + BigInt(index),
        command.id,
      ]);
    database.run("UPDATE session SET next_seq=9007199254741000 WHERE id='root'");
    database.close();
    const page = await store.listStableAgents({
      expectedStoreId: storeId,
      sessionId: 'root',
      extensionId: 'builtin.task',
      subjectId: 'owner',
      limit: 1,
    });
    const restore = openFaultDatabase(join(root, 'data', 'test', 'core.db'));
    for (const command of commands)
      restore.run('UPDATE command SET seq=? WHERE id=?', [command.seq, command.id]);
    restore.run("UPDATE session SET next_seq=? WHERE id='root'", [originalSequence]);
    restore.close();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.agentId).toBe(childId);
    expect(page.nextAfterSeq).toBeNull();
    expect(BigInt(page.upperSeq)).toBeGreaterThan(9007199254740992n);
    expect(BigInt(page.items[0]!.seq)).toBeGreaterThan(9007199254740992n);

    for (const [ids, code] of [
      [[childId, 'inaccessible'], 'agent_unavailable'],
      [[childId, childId], 'invalid_request'],
    ] as const) {
      let failure: unknown;
      try {
        await store.listStableAgents({
          expectedStoreId: storeId,
          sessionId: 'root',
          extensionId: 'builtin.task',
          subjectId: 'owner',
          agentIds: [...ids],
        });
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string })?.code).toBe(code);
    }
    const eventPage1 = await store.listAgentEvents({
      expectedStoreId: storeId,
      sessionId: 'root',
      extensionId: 'builtin.task',
      subjectId: 'owner',
      limit: 1,
    });
    const eventPage2 = await store.listAgentEvents({
      expectedStoreId: storeId,
      sessionId: 'root',
      extensionId: 'builtin.task',
      subjectId: 'owner',
      afterSeq: eventPage1.nextSeq,
      limit: 1,
    });
    const emptyPage = await store.listAgentEvents({
      expectedStoreId: storeId,
      sessionId: 'root',
      extensionId: 'builtin.task',
      subjectId: 'owner',
      afterSeq: eventPage2.nextSeq,
      limit: 1,
    });
    expect(eventPage1.events).toHaveLength(1);
    expect(eventPage2.events).toHaveLength(1);
    expect(BigInt(eventPage2.nextSeq)).toBeGreaterThan(BigInt(eventPage1.nextSeq));
    expect(emptyPage.events).toHaveLength(0);
    expect(emptyPage.nextSeq).toBe(eventPage2.nextSeq);
    expect(eventPage1.nextSeq).toBe(eventPage1.events[0]!.seq);
    const floorDb = openFaultDatabase(join(root, 'data', 'test', 'core.db'));
    floorDb.run('UPDATE storage_meta SET replay_floor=? WHERE singleton=1', [
      BigInt(eventPage1.nextSeq),
    ]);
    let missingEvents: unknown;
    try {
      await store.listAgentEvents({
        expectedStoreId: storeId,
        sessionId: 'root',
        extensionId: 'builtin.task',
        subjectId: 'owner',
        afterSeq: '0',
      });
    } catch (error) {
      missingEvents = error;
    }
    floorDb.run('UPDATE storage_meta SET replay_floor=0 WHERE singleton=1');
    floorDb.close();
    expect((missingEvents as { code?: string })?.code).toBe('cursor_expired');
    expect((missingEvents as Error)?.message).toBe(eventPage1.nextSeq);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await store.listStableAgents({
      expectedStoreId: storeId,
      sessionId: 'root',
      extensionId: 'builtin.task',
      subjectId: 'owner',
      agentIds: [childId],
    });
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('queued guidance pins the original carrier; interrupt prevents late activation without destroying the stable Agent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-queued-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let stage = 0,
    childCalls = 0,
    queuedId = '';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const parent: ModelAdapter = {
    async *stream(request) {
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const body = last ? JSON.parse(last.content) : null;
      let events: ModelEvent[];
      switch (stage++) {
        case 0:
          events = call('spawn_agent', { prompt: 'Hold the first real child slot' });
          break;
        case 1:
          events = call('spawn_agent', { prompt: 'Must remain queued' });
          break;
        case 2:
          queuedId = body.agent_id;
          expect(body).toMatchObject({ state: 'queued', accepted: true });
          events = call('follow_up_agent', {
            agent_id: queuedId,
            content: 'Guidance for this exact queued generation',
          });
          break;
        case 3:
          expect(body).toMatchObject({
            agent_id: queuedId,
            accepted: true,
            mode: 'steer',
            state: 'queued',
          });
          events = call('interrupt_agent', { agent_id: queuedId });
          break;
        case 4:
          expect(body).toMatchObject({
            agent_id: queuedId,
            accepted: true,
            outcome: 'cancel_requested',
          });
          release();
          events = call('wait_agent_events', { wait_ms: 10000 });
          break;
        case 5:
          events = call('list_agents', { agent_ids: [queuedId] });
          break;
        case 6:
          expect(body.items[0]).toMatchObject({
            agent_id: queuedId,
            last_outcome: 'cancelled',
            state: 'idle',
          });
          events = [finish];
          break;
        default:
          events = [finish];
          break;
      }
      for (const event of events) yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      childCalls++;
      await gate;
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 3,
    maxConcurrentSubagents: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'General child' }],
      }),
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'temp',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'queued',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'coordinate' },
    });
    const result = await runtime.waitForCommand('work', { timeoutMs: 25000 });
    expect((await store.getRun((result.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(childCalls).toBe(1);
    const carriers = (await store.listExecutions('root')).filter(
      (execution) => execution.childSessionId === queuedId,
    );
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.status).toBe('cancelled');
    expect((await store.getView(queuedId)).runs).toHaveLength(0);
  } finally {
    release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('later ordinary turn can guide, message and interrupt its existing direct child with current tool authority', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-work-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let a = 0,
    b = 0,
    childCalls = 0,
    agentId = '';
  const results: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const parent: ModelAdapter = {
    async *stream(request) {
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const body = last ? JSON.parse(last.content) : null;
      const isB = request.messages.some(
        (message) => message.role === 'user' && message.content === 'New task: Independent B',
      );
      let events: ModelEvent[];
      if (!isB) {
        if (a++ === 0) events = call('spawn_agent', { prompt: 'Original A assignment' });
        else {
          agentId = body.agent_id;
          events = [finish];
        }
      } else {
        if (body) results.push(body);
        switch (b++) {
          case 0:
            events = call('follow_up_agent', {
              agent_id: agentId,
              content: 'Guide the existing child',
            });
            break;
          case 1:
            events = call('send_agent_message', {
              agent_id: agentId,
              content: 'Context from the current parent turn',
            });
            break;
          case 2:
            events = call('interrupt_agent', { agent_id: agentId });
            break;
          default:
            release();
            events = [finish];
        }
      }
      for (const event of events) yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      if (++childCalls === 1) await gate;
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 3,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'General child' }],
      }),
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'temp',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'work',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'A',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Original A' },
    });
    await runtime.waitForCommand('A', { timeoutMs: 10000 });
    const activeDeadline = Date.now() + 5000;
    while (childCalls !== 1 && Date.now() < activeDeadline) await Bun.sleep(5);
    expect(childCalls).toBe(1);
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'B',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'New task: Independent B' },
    });
    const result = await runtime.waitForCommand('B', { timeoutMs: 25000 });
    expect(results.slice(0, 3)).toHaveLength(3);
    for (const result of results.slice(0, 3)) expect(result).toMatchObject({ accepted: true });
    expect(results[0]).toMatchObject({ state: 'queued', agent_id: agentId });
    expect((await store.getRun((result.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(childCalls).toBe(1);
    const carriers = (await store.listExecutions('root')).filter(
      (execution) => execution.childSessionId === agentId,
    );
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatchObject({ rootWorkCommandId: 'A', status: 'cancelled' });
    expect(
      (
        await store.listAgentMessages({
          expectedStoreId: storeId,
          sessionId: agentId,
          subjectId: 'owner',
        })
      ).items,
    ).toHaveLength(1);
  } finally {
    release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('public schema is exactly six closed prompt tools, with optional registered presets and sustained mailbox waiting', async () => {
  const { createModelToolSurface } = await import('../../../../src/model-tools');
  const surface = (presets?: string[]) => {
    const tools = createTaskExtension({
      roles: [
        { id: 'worker', configurationId: 'worker', description: 'General child' },
        { id: 'read_only', configurationId: 'read_only', description: 'Trusted read-only preset' },
      ],
      ...(presets ? { presets } : {}),
    }).tools!;
    return createModelToolSurface(
      {
        modelId: 'fixed',
        requestId: 'schema',
        messages: [],
        tools: tools.map((tool) => ({
          id: tool.id,
          definitionVersion: tool.version,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
      new Map(tools.map((tool) => [tool.id, tool])),
    );
  };
  const general = surface();
  expect(general.tools.map((tool) => tool.id).sort()).toEqual([
    'follow_up_agent',
    'interrupt_agent',
    'list_agents',
    'send_agent_message',
    'spawn_agent',
    'wait_agent_events',
  ]);
  const spawn = general.tools.find((tool) => tool.id === 'spawn_agent')!;
  expect(spawn.inputSchema.required).toEqual(['prompt']);
  expect(Object.keys(spawn.inputSchema.properties!)).toEqual(['prompt', 'task_name']);
  expect(spawn.inputSchema.additionalProperties).toBe(false);
  const preset = surface(['read_only']);
  expect(
    preset.tools.find((tool) => tool.id === 'spawn_agent')!.inputSchema.properties,
  ).toMatchObject({ preset: { enum: ['read_only'] } });
  for (const name of [
    'run_agent',
    'read_agent',
    'followup_agent',
    'wait_agents',
    'wait_agent_event',
    'cancel_agent_task',
  ])
    expect(general.decode({ id: 'old', name, arguments: '{}' }).model?.error).toBe(
      'tool_not_available',
    );
  expect(
    preset.decode({
      id: 'unknown',
      name: 'spawn_agent',
      arguments: '{"prompt":"read","preset":"invented"}',
    }).model?.error,
  ).toBe('invalid_tool_arguments');
  expect(
    general.decode({
      id: 'identity',
      name: 'spawn_agent',
      arguments: '{"prompt":"read","key":"forged"}',
    }).model?.error,
  ).toBe('invalid_tool_arguments');
  for (const input of [{}, { wait_ms: null }, { wait_ms: 0 }, { wait_ms: 30001 }])
    expect(
      general.decode({ id: 'wait', name: 'wait_agent_events', arguments: JSON.stringify(input) })
        .model?.error,
    ).toBeUndefined();
  expect(
    general.tools.find((tool) => tool.id === 'wait_agent_events')!.inputSchema.properties,
  ).not.toHaveProperty('task_ids');
});

test('mailbox wait wakes for a durable raw human input before business application and preserves its event cursor', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-collaboration-human-wait-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 'parent', subjectId: 'owner' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const parent: ModelAdapter = {
    async *stream() {
      if (calls++ === 0)
        for (const event of call('wait_agent_events', { after_seq: '0', wait_ms: null }))
          yield event;
      else {
        await gate;
        yield { type: 'text_delta', text: 'finished' };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    model: parent,
    modelId: 'parent',
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'trusted' }],
      }),
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    modelConcurrency: 1,
    childConfigurations: [
      { id: 'worker', version: '1', model: parent, modelId: 'parent', toolIds: [], snapshot: {} },
    ],
  });
  const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    const end = Date.now() + 4000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= end) throw Error('human_wait_deadline');
      await Bun.sleep(5);
    }
  };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'wait',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Wait for collaborator events' },
    });
    const waiting = await until(async () =>
      (await store.listExecutions('parent')).find(
        (execution) =>
          execution.definitionId === 'task.events' &&
          ['running', 'dispatching'].includes(execution.status),
      ),
    );
    const run = (await store.getRun(waiting.runId!))!;
    const raw = await store.registerHumanCommand({
      ...identity,
      commandId: 'public-input',
      request: {
        kind: 'input.steer',
        content: 'Consider this input now',
        targetRunId: run.id,
        contextSelectionId: run.contextSelectionId,
      },
    });
    expect(raw.receipt).toMatchObject({ outcome: 'human_input_pending' });
    expect(
      (await store.listPendingInputs({ ...identity, kind: 'input.steer', targetRunId: run.id }))
        .commands,
    ).toHaveLength(0);
    const settled = await until(async () => {
      const execution = await store.getExecution(waiting.id);
      return execution?.status === 'succeeded' ? execution : undefined;
    });
    expect(JSON.parse((settled.result as { content: string }).content)).toEqual({
      reason: 'input',
      events: [],
      next_seq: '0',
    });
    expect((await store.getCommand('public-input'))!.receipt).toMatchObject({
      outcome: 'human_input_pending',
    });
    await runtime.cancelRun({ ...identity, commandId: 'cancel', runId: run.id });
    release();
    await runtime.waitForCommand('work', { timeoutMs: 4000 });
  } finally {
    release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('command error projection distinguishes rejected and unverified receipts without leaking diagnostics to the model', async () => {
  const { AgentError } = await import('../../../../src/storage/types');
  const extension = createTaskExtension({
    roles: [{ id: 'worker', configurationId: 'worker', description: 'trusted' }],
  });
  const spawn = extension.tools!.find((tool) => tool.id === 'task.spawn')!;
  const list = extension.tools!.find((tool) => tool.id === 'task.list')!;
  for (const [error, accepted, code, next] of [
    [
      new AgentError('permission_denied', 'private policy /root/secret'),
      false,
      'permission_denied',
      'resolve_permission',
    ],
    [
      new Error('credential=private-secret; uncertain storage acknowledgement'),
      null,
      'receipt_unverifiable',
      'inspect_original',
    ],
    [new AgentError('cancel_requested'), null, 'receipt_unverifiable', 'inspect_original'],
  ] as const) {
    const context = {
      executionId: 'invocation',
      operations: {
        async ensure() {
          throw error;
        },
      },
    } as unknown as import('../../../../src/extensions').ToolContext;
    const result = await spawn.execute({ prompt: 'bounded child request' }, context);
    const body = JSON.parse(result.content);
    expect(body).toMatchObject({ accepted, error: { code, next_action: next } });
    expect(result.content).not.toContain('private');
    expect(result.content).not.toContain('credential');
  }
  const result = await list.execute({}, {
    operations: {
      async listStableAgents() {
        throw new AgentError('invalid_cursor');
      },
    },
  } as unknown as import('../../../../src/extensions').ToolContext);
  expect(JSON.parse(result.content)).toMatchObject({
    error: { code: 'invalid_cursor', next_action: 'restart_observation' },
  });
  expect(JSON.parse(result.content)).not.toHaveProperty('accepted');
  const events = extension.tools!.find((tool) => tool.id === 'task.events')!;
  const cancelled = await events.execute({}, {
    operations: {
      async waitAgentEvents() {
        throw new AgentError('cancel_requested');
      },
    },
  } as unknown as import('../../../../src/extensions').ToolContext);
  expect(JSON.parse(cancelled.content)).toEqual({
    error: {
      code: 'operation_cancelled',
      message: 'Agent observation was cancelled.',
      next_action: 'none',
    },
  });
  expect(JSON.parse(cancelled.content)).not.toHaveProperty('accepted');
  expect(JSON.parse(cancelled.content)).not.toHaveProperty('diagnostic');
});

test('stable idle child mail queues without activation and is adopted once by the exact same-configuration follow-up', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-idle-mail-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId: storeId, sessionId: 'root', subjectId: 'owner' };
  const assignment = 'Inspect the original synthetic assignment';
  const mailContent = 'Keep this complete idle-only instruction for the next explicit turn';
  const followUp = 'Continue the same assignment using the queued instruction';
  const childRequests: import('@kite-ai/ai').ModelRequest[] = [];
  let stage = 0,
    agentId = '',
    cursor = '0';
  let firstCarrier: Awaited<ReturnType<typeof store.getExecution>> = null;
  let firstRunId: string | null = null;
  let queuedMailId = '';
  const child: ModelAdapter = {
    async *stream(request) {
      childRequests.push(structuredClone(request));
      yield { type: 'text_delta', text: `Verified child turn ${childRequests.length}` };
      yield finish;
    },
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      const last = request.messages.filter((message) => message.role === 'tool').at(-1);
      const body = last ? JSON.parse(last.content) : null;
      let events: ModelEvent[];
      switch (stage++) {
        case 0:
          events = call('spawn_agent', { prompt: assignment });
          break;
        case 1:
          expect(body).toMatchObject({ accepted: true, state: 'queued' });
          agentId = body.agent_id;
          events = call('wait_agent_events', { wait_ms: 10000 });
          break;
        case 2:
          expect(body.events).toContainEqual(
            expect.objectContaining({ agent_id: agentId, kind: 'completed' }),
          );
          cursor = body.next_seq;
          events = call('list_agents', { agent_ids: [agentId], limit: 1 });
          break;
        case 3: {
          expect(body.items).toHaveLength(1);
          expect(body.items[0]).toMatchObject({
            agent_id: agentId,
            state: 'idle',
            last_outcome: 'succeeded',
          });
          const entry = (
            await store.listStableAgents({
              ...identity,
              extensionId: 'builtin.task',
              agentIds: [agentId],
            })
          ).items[0]!;
          firstCarrier = await store.getExecution(entry.ref.executionId!);
          firstRunId = entry.runId;
          expect(firstCarrier?.status).toBe('succeeded');
          expect((await store.getRun(firstRunId!))?.status).toBe('completed');
          expect(childRequests).toHaveLength(1);
          events = call('send_agent_message', { agent_id: agentId, content: mailContent });
          break;
        }
        case 4: {
          // Preserve the actual failed Tool result for the outer red assertion.
          if (body?.accepted !== true) {
            events = [finish];
            break;
          }
          expect(body).toEqual({ accepted: true, delivery: 'queued' });
          const mails = await store.listAgentMessages({
            expectedStoreId: storeId,
            sessionId: agentId,
            subjectId: 'owner',
          });
          expect(mails.items).toHaveLength(1);
          const mail = mails.items[0]!;
          queuedMailId = mail.id;
          expect(mail.state).toBe('accepted');
          expect(mail.targetSessionId).toBe(agentId);
          expect(mail.targetRunId).toBeNull();
          const command = (await store.getCommand(mail.id))!;
          expect(command.request).toMatchObject({
            targetRunId: null,
            carrierExecutionId: firstCarrier!.id,
          });
          expect(childRequests).toHaveLength(1);
          expect((await store.getView(agentId)).runs).toHaveLength(1);
          expect((await store.getExecution(firstCarrier!.id))?.status).toBe('succeeded');
          events = call('follow_up_agent', { agent_id: agentId, content: followUp });
          break;
        }
        case 5:
          expect(body).toMatchObject({ accepted: true, agent_id: agentId, mode: 'new_turn' });
          events = call('wait_agent_events', { after_seq: cursor, wait_ms: 10000 });
          break;
        case 6:
          expect(body.events).toContainEqual(
            expect.objectContaining({ agent_id: agentId, kind: 'completed' }),
          );
          events = call('list_agents', { agent_ids: [agentId], limit: 1 });
          break;
        case 7:
          expect(body.items[0]).toMatchObject({
            agent_id: agentId,
            state: 'idle',
            assignment_source: { content: assignment },
            current_work_source: { content: followUp },
          });
          events = [finish];
          break;
        default:
          throw Error('idle_mail_unexpected_parent_turn');
      }
      for (const event of events) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'Trusted general child' }],
      }),
    ],
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-idle-mail' }) },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'private',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'create',
      workspaceId: 'w',
      title: 'idle mail',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Coordinate the original assignment' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 25000 });
    const executions = await store.listExecutions('root');
    const messageExecution = executions.find(
      (execution) => execution.definitionId === 'task.message',
    );
    expect(messageExecution?.result).toMatchObject({
      outcome: 'succeeded',
      details: { accepted: true, delivery: 'queued' },
    });
    expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(stage).toBe(8);
    expect(childRequests).toHaveLength(2);
    const carriers = executions.filter((execution) => execution.childSessionId === agentId);
    expect(carriers).toHaveLength(2);
    expect(carriers.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(carriers[0]!.id).toBe(firstCarrier!.id);
    expect(carriers[1]!.id).not.toBe(firstCarrier!.id);
    expect(carriers[1]!.childConfiguration).toEqual(firstCarrier!.childConfiguration);
    expect(carriers[1]!.rootWorkCommandId).toBe(firstCarrier!.rootWorkCommandId);
    expect((await store.getExecution(firstCarrier!.id))?.result).toEqual(firstCarrier!.result);
    const childRuns = (await store.getView(agentId)).runs;
    expect(childRuns).toHaveLength(2);
    const successor = childRuns.find((run) => run.id !== firstRunId)!;
    expect(successor.status).toBe('completed');
    const adopted = childRequests[1]!.messages.filter((message) =>
      message.sourceIds?.includes(queuedMailId),
    );
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.content).toContain(mailContent);
    expect(
      childRequests[0]!.messages.some((message) => message.sourceIds?.includes(queuedMailId)),
    ).toBe(false);
    expect(
      (await store.listMessages(agentId)).filter((message) =>
        message.sourceIds?.includes(queuedMailId),
      ),
    ).toHaveLength(1);
    const mails = await store.listAgentMessages({
      expectedStoreId: storeId,
      sessionId: agentId,
      subjectId: 'owner',
    });
    expect(mails.items).toHaveLength(1);
    expect(mails.items[0]).toMatchObject({
      id: queuedMailId,
      state: 'received',
      targetRunId: null,
      receivedRunId: successor.id,
    });
    const childModel = (await store.listExecutions(agentId)).filter(
      (execution) => execution.kind === 'model' && execution.runId === successor.id,
    );
    expect(childModel).toHaveLength(1);
    const saved = await runtime.readModelInput({
      expectedStoreId: storeId,
      sessionId: agentId,
      subjectId: 'owner',
      executionId: childModel[0]!.id,
    });
    expect(
      saved.request.messages.filter((message) => message.sourceIds?.includes(queuedMailId)),
    ).toHaveLength(1);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
