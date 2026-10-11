import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { defineExtension } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

test('parallel Tools retain actual reverse completion and original Model call-result order through cold history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-parallel-tools-'));
  const ledger = join(root, 'effects');
  let release!: () => void;
  let slowEntered = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'slow-first', name: 'fixture.parallel.slow', arguments: '{}' },
      { type: 'tool_call', id: 'fast-second', name: 'fixture.parallel.fast', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Both original results complete' }, finish],
  ]);
  const store = await openSqliteStore({ dataRoot: root, profile: 'parallel' });
  const runtime = createRuntime({
    store,
    model,
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-parallel' }) },
    extensions: [
      defineExtension({
        id: 'fixture.parallel',
        version: '1',
        apiMajor: 1,
        tools: ['slow', 'fast'].map((name) => ({
          id: `fixture.parallel.${name}`,
          version: '1',
          description: name,
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, context) {
            if (name === 'slow') {
              slowEntered++;
              await held;
              context.signal.throwIfAborted();
            }
            const content = `${name} original 😀\r\n`;
            appendFileSync(ledger, `${name}\n`);
            return { outcome: 'succeeded' as const, content };
          },
        })),
      }),
    ],
  });
  let closed = false;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const storeId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'create',
      workspaceId: 'w',
      title: 'parallel',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'work',
      request: { kind: 'run.start', content: 'Two ordinary tools' },
    });
    const deadline = Date.now() + 1000;
    for (;;) {
      const tools = (await store.listExecutions('s')).filter((row) => row.kind === 'tool');
      const fast = tools.find((row) => row.callId === 'fast-second');
      if (fast?.status === 'succeeded') {
        expect(slowEntered).toBe(1);
        expect(tools.find((row) => row.callId === 'slow-first')?.status).toBe('dispatching');
        expect(readFileSync(ledger, 'utf8')).toBe('fast\n');
        break;
      }
      if (Date.now() > deadline) throw Error('parallel_fast_cannot_complete_while_slow_held');
      await Bun.sleep(5);
    }
    release();
    const command = await runtime.waitForCommand('work', { timeoutMs: 2000 });
    expect(command.status).toBe('applied');
    const runId = (command.receipt as { runId: string }).runId;
    expect(await store.getRun(runId)).toMatchObject({ status: 'completed' });
    expect(readFileSync(ledger, 'utf8')).toBe('fast\nslow\n');
    const executions = await store.listExecutions('s');
    const tools = executions.filter((row) => row.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.every((row) => row.status === 'succeeded')).toBe(true);
    const messages = await store.listMessages('s');
    const historicalResults = messages.filter((row) => row.role === 'tool');
    expect(historicalResults.map((row) => row.toolCallId)).toEqual(['fast-second', 'slow-first']);
    expect(model.requests).toHaveLength(2);
    const modelResults = model.requests[1]!.messages.filter((row) => row.role === 'tool');
    expect(modelResults.map((row) => row.toolCallId)).toEqual(['slow-first', 'fast-second']);
    for (const [index, id] of ['slow-first', 'fast-second'].entries()) {
      const execution = tools.find((row) => row.callId === id)!;
      expect(modelResults[index]?.content).toBe(`${index === 0 ? 'slow' : 'fast'} original 😀\r\n`);
      expect(modelResults[index]?.sourceIds).toEqual([execution.id]);
    }
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.close();
    closed = true;
    reader = await openSqliteStore({ dataRoot: root, profile: 'parallel', mode: 'readonly' });
    expect((await reader.getMetadata()).storeId).toBe(storeId);
    expect(await reader.listMessages('s')).toEqual(messages);
    expect(await reader.listExecutions('s')).toEqual(executions);
    expect(await reader.getCommand('work')).toEqual(command);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(model.requests).toHaveLength(2);
    expect(readFileSync(ledger, 'utf8')).toBe('fast\nslow\n');
  } finally {
    release();
    if (!closed) await runtime.close();
    await reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a later parallel Tool terminal SQLite rejection survives the earlier unknown outcome after held cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-parallel-storage-'));
  const ledger = join(root, 'effects');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted = false,
    disposed = 0;
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'unknown-first', name: 'fixture.storage.unknown', arguments: '{}' },
      { type: 'tool_call', id: 'storage-second', name: 'fixture.storage.late', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const extension = defineExtension({
    id: 'fixture.storage',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.storage.unknown',
        version: '1',
        description: 'Honest first outcome',
        inputSchema: { type: 'object' },
        async execute() {
          await entered;
          appendFileSync(ledger, 'first unknown 😀\n');
          return { outcome: 'outcome_unknown', content: 'Original first effect is unknown' };
        },
      },
      {
        id: 'fixture.storage.late',
        version: '1',
        description: 'Later terminal persistence',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          enter();
          if (!context.signal.aborted)
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          aborted = true;
          await cleanup;
          appendFileSync(ledger, 'late cleanup complete 😀\n');
          return { outcome: 'succeeded', content: 'Actual late result cannot be persisted' };
        },
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: root, profile: 'storage' });
  const db = new Database(join(root, 'storage/core.db'));
  db.exec(
    "CREATE TRIGGER reject_late_terminal BEFORE UPDATE OF state ON execution WHEN NEW.call_id='storage-second' AND NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'late Tool terminal denied'); END",
  );
  const runtime = createRuntime({
    store,
    model,
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned-storage' }) },
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      extensions: [extension],
      snapshot: null,
      dispose: async () => {
        disposed++;
      },
    }),
  });
  let closed = false;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const storeId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId: storeId, subjectId: 'owner', sessionId: 's' };
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'late storage failure',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Independent late persistence failure' },
    });
    const deadline = Date.now() + 1200;
    while (!aborted) {
      if (Date.now() > deadline) throw Error('late_storage_abort_deadline');
      await Bun.sleep(5);
    }
    const activeCommand = (await store.getCommand('work'))!;
    const runId = (activeCommand.receipt as { runId: string }).runId;
    expect((await store.getRun(runId))?.isActive).toBe(true);
    expect(disposed).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(readFileSync(ledger, 'utf8')).toBe('first unknown 😀\n');
    release();
    const command = await runtime.waitForCommand('work', { timeoutMs: 2000 });
    const run = await store.getRun(runId);
    expect(run).toMatchObject({
      status: 'failed',
      isActive: false,
      reason: 'SQLITE_CONSTRAINT_TRIGGER',
    });
    const executions = await store.listExecutions('s');
    expect(executions.find((row) => row.callId === 'unknown-first')).toMatchObject({
      status: 'outcome_unknown',
      result: { content: 'Original first effect is unknown' },
    });
    expect(executions.find((row) => row.callId === 'storage-second')).toMatchObject({
      status: 'dispatching',
      result: null,
    });
    expect(model.requests).toHaveLength(1);
    const effects = readFileSync(ledger, 'utf8');
    expect(effects).toBe('first unknown 😀\nlate cleanup complete 😀\n');
    const messages = await store.listMessages('s');
    expect(messages.filter((row) => row.role === 'tool').map((row) => row.toolCallId)).toEqual([
      'unknown-first',
    ]);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    db.exec('DROP TRIGGER reject_late_terminal');
    await runtime.close();
    closed = true;
    expect(disposed).toBe(1);
    db.close();
    reader = await openSqliteStore({ dataRoot: root, profile: 'storage', mode: 'readonly' });
    expect(await reader.listExecutions('s')).toEqual(executions);
    expect(await reader.listMessages('s')).toEqual(messages);
    expect(await reader.getCommand('work')).toEqual(command);
    expect(await reader.getRun(runId)).toEqual(run);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(model.requests).toHaveLength(1);
    expect(readFileSync(ledger, 'utf8')).toBe(effects);
  } finally {
    release();
    if (!closed) await runtime.close();
    db.close();
    await reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('denying a parallel sibling waits for attempted Tool cleanup before releasing its Run binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-parallel-denial-'));
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false,
    aborted = false,
    deniedCalls = 0,
    disposed = 0;
  const effects: string[] = [];
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'attempted', name: 'fixture.denial.attempted', arguments: '{}' },
      { type: 'tool_call', id: 'denied', name: 'fixture.denial.ask', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const extension = defineExtension({
    id: 'fixture.denial',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.denial.attempted',
        version: '1',
        description: 'Attempted sibling with held cleanup',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          entered = true;
          effects.push('attempted');
          if (!context.signal.aborted)
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          aborted = true;
          await cleanup;
          effects.push('cleanup completed');
          return {
            outcome: 'outcome_unknown',
            content: 'Attempted external effect remains unknown',
          };
        },
      },
      {
        id: 'fixture.denial.ask',
        version: '1',
        description: 'Independently denied sibling',
        inputSchema: { type: 'object' },
        async execute() {
          deniedCalls++;
          return { outcome: 'succeeded', content: 'Must never execute' };
        },
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: root, profile: 'denial' });
  const runtime = createRuntime({
    store,
    model,
    permissions: {
      authorize: async (request) =>
        request.definitionId === 'fixture.denial.ask'
          ? {
              allowed: false,
              revision: 'owned-denial',
              approval: { request: { title: 'Independent Tool approval' } },
            }
          : { allowed: true, revision: 'owned-denial' },
    },
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      extensions: [extension],
      snapshot: null,
      dispose: async () => {
        disposed++;
      },
    }),
  });
  let closed = false;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 1200;
    for (;;) {
      const fact = await read();
      if (fact !== undefined) return fact;
      if (Date.now() > deadline) throw Error('parallel_denial_fact_deadline');
      await Bun.sleep(5);
    }
  }
  try {
    const storeId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId: storeId, subjectId: 'owner', sessionId: 's' };
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'parallel denial',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Parallel independent permissions' },
    });
    const interaction = await until(async () =>
      entered
        ? (
            await runtime.listInteractions({
              expectedStoreId: storeId,
              sessionId: 's',
              state: 'pending',
            })
          ).interactions[0]
        : undefined,
    );
    expect(disposed).toBe(0);
    await runtime.answerInteraction({
      ...base,
      commandId: 'deny',
      presentationSessionId: 's',
      interactionId: interaction.id,
      expectedRevision: interaction.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await until(async () => (aborted ? true : undefined));
    expect((await store.getRun(interaction.runId!))?.isActive).toBe(true);
    expect(disposed).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(deniedCalls).toBe(0);
    expect(effects).toEqual(['attempted']);
    release();
    const command = await runtime.waitForCommand('work', { timeoutMs: 2000 });
    const run = await store.getRun(interaction.runId!);
    expect(run).toMatchObject({ status: 'cancelled', isActive: false });
    expect(command.cancelRequestedAt).not.toBeNull();
    const executions = await store.listExecutions('s');
    expect(executions.find((row) => row.callId === 'denied')).toMatchObject({
      status: 'failed',
      result: { content: 'approval_denied', details: { adapterAttempted: false } },
    });
    expect(executions.find((row) => row.callId === 'attempted')).toMatchObject({
      status: 'outcome_unknown',
      result: { content: 'Attempted external effect remains unknown' },
    });
    await until(async () => (disposed === 1 ? true : undefined));
    expect(disposed).toBe(1);
    expect(deniedCalls).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(effects).toEqual(['attempted', 'cleanup completed']);
    const messages = await store.listMessages('s');
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.close();
    closed = true;
    reader = await openSqliteStore({ dataRoot: root, profile: 'denial', mode: 'readonly' });
    expect(await reader.listExecutions('s')).toEqual(executions);
    expect(await reader.listMessages('s')).toEqual(messages);
    expect(await reader.getRun(interaction.runId!)).toEqual(run);
    expect(await reader.getCommand('work')).toEqual(command);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(disposed).toBe(1);
    expect(deniedCalls).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(effects).toEqual(['attempted', 'cleanup completed']);
  } finally {
    release();
    if (!closed) await runtime.close();
    await reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
