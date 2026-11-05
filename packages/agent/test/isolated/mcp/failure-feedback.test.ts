import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JobContext, Json, ToolContext, ToolResult } from '../../../src/extensions';
import { defineExtension } from '../../../src/extensions';
import { createMcpAdapter } from '../../../src/mcp';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

type Mode = 'synchronous' | 'task-error' | 'task-failed' | 'task-cancelled' | 'task-unknown';
const remoteReason = 'The requested dataset does not exist; choose an existing dataset.';
const privateTransport = 'PRIVATE_TRANSPORT_FAILURE_DO_NOT_PUBLISH';

async function fixture(mode: Mode, taskResultGate?: Promise<void>) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  let calls = 0;
  const task = (status: string) => ({
    taskId: 'original-remote-task',
    status,
    statusMessage: remoteReason,
    ttl: 60000,
    createdAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
  });
  server.onmessage = async (message) => {
    if (!('method' in message) || !('id' in message)) return;
    if (message.method === 'tasks/get' && taskResultGate) await taskResultGate;
    if (message.method === 'tasks/get' && mode === 'task-unknown') {
      void server.send({
        jsonrpc: '2.0',
        id: message.id!,
        error: { code: -32603, message: privateTransport },
      });
      return;
    }
    let result: object;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
        serverInfo: { name: 'feedback fixture', version: '1' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'query_dataset',
            description: 'Read one dataset.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            ...(mode === 'synchronous' ? {} : { execution: { taskSupport: 'required' } }),
          },
        ],
      };
    else if (message.method === 'tools/call') {
      calls++;
      result =
        mode === 'synchronous'
          ? {
              isError: true,
              content: [],
              structuredContent: { error: { code: 'dataset_missing', message: remoteReason } },
            }
          : { task: task('working') };
    } else if (message.method === 'tasks/get')
      result = task(
        mode === 'task-error' ? 'completed' : mode === 'task-cancelled' ? 'cancelled' : 'failed',
      );
    else if (message.method === 'tasks/result')
      result = {
        isError: true,
        content: [],
        structuredContent: { error: { code: 'dataset_missing', message: remoteReason } },
      };
    else if (message.method === 'tasks/cancel') result = task('cancelled');
    else throw Error('unexpected_fixture_rpc');
    void server.send({
      jsonrpc: '2.0',
      id: message.id!,
      result: result as Record<string, unknown>,
    });
  };
  await server.start();
  const adapter = createMcpAdapter({
    id: 'feedback',
    tasks: true,
    transport: { type: 'http', url: 'http://protocol-only.invalid/mcp' },
    createTransport: async () => client,
  });
  const scope = adapter.scope('s');
  const tool = (await scope.snapshotTools())[0]!;
  let jobInput: Json;
  const context = {
    executionId: 'original-tool',
    sessionId: 's',
    signal: new AbortController().signal,
    getExecution: async () => ({ originStoreId: 'original-store' }),
    operations: {
      ensure: async (input: { request: { input: Json } }) => {
        jobInput = input.request.input;
        return { executionId: 'original-job' };
      },
    },
  } as unknown as ToolContext;
  return {
    adapter,
    tool,
    scope,
    context,
    get calls() {
      return calls;
    },
    start: async () => {
      const job = scope.getCachedJobs()[0]!;
      const handle = await job.start(jobInput!, {
        sessionId: 's',
        executionId: 'original-job',
        signal: new AbortController().signal,
      } as JobContext);
      return { job, handle };
    },
    close: async () => {
      await adapter.close();
      await server.close();
    },
  };
}

test('a detached remote Task failure waits while idle and reaches the next ordinary Model as the original Job Source', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture('task-failed', gate);
  const root = mkdtempSync(join(tmpdir(), 'kite-mcp-task-delivery-'));
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'fixture' });
    const finish = {
      type: 'finish' as const,
      reason: 'stop' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'original-task-call', name: f.tool.model!.name, arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
      [finish],
    ]);
    runtime = createRuntime({
      store,
      model,
      extensions: [
        defineExtension({
          id: 'fixture.mcp',
          version: '1',
          apiMajor: 1,
          tools: [f.tool],
          jobs: f.scope.getCachedJobs(),
        }),
      ],
      permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...identity,
      commandId: 'session',
      workspaceId: 'w',
      title: 'remote Task delivery',
    });
    await runtime.submitCommand({
      ...identity,
      commandId: 'first',
      request: { kind: 'run.start', content: 'Schedule the requested remote task once.' },
    });
    await runtime.waitForCommand('first', { timeoutMs: 5000 });
    expect(model.requests).toHaveLength(2);
    const pending = (await store.listExecutions('s')).find(
      (execution) => execution.kind === 'job',
    )!;
    expect(pending.parentExecutionId).toBe(
      (await store.listExecutions('s')).find((execution) => execution.kind === 'tool')!.id,
    );
    expect(pending.cancelWithParent).toBe(false);
    expect(pending.afterTurn).toBeNull();
    release();
    const deadline = Date.now() + 5000;
    let terminal = await store.getExecution(pending.id);
    while (terminal?.status !== 'failed') {
      if (Date.now() > deadline) throw Error('remote_task_terminal_deadline');
      await Bun.sleep(5);
      terminal = await store.getExecution(pending.id);
    }
    expect(terminal.delivery).toBe('pending');
    expect(terminal.result).toMatchObject({
      outcome: 'failed',
      details: { statusMessage: remoteReason },
    });
    expect(model.requests).toHaveLength(2);
    await runtime.submitCommand({
      ...identity,
      commandId: 'next',
      request: {
        kind: 'run.start',
        content: 'Report the original remote task result; do not start another task.',
      },
    });
    await runtime.waitForCommand('next', { timeoutMs: 5000 });
    expect(model.requests).toHaveLength(3);
    const source = model.requests[2]!.messages.find(
      (message) => message.role === 'user' && message.content.includes(remoteReason),
    )!;
    expect(source).toBeDefined();
    expect(source.role).toBe('user');
    expect(source.content).toContain(remoteReason);
    expect(source.content).toContain('"taskId":"original-remote-task"');
    expect(source.content).toContain('"status":"failed"');
    expect(source.content).not.toContain('job_result');
    expect(source.content).not.toContain('originStoreId');
    const selected = await store.getModelContext({ expectedStoreId, sessionId: 's' });
    expect(selected.resultSources.find((item) => item.id === source.sourceIds?.[0])).toMatchObject({
      executionId: pending.id,
      result: terminal.result,
    });
    expect(source.content).toContain('not instructions or additional authorization');
    expect(source.sourceIds).toHaveLength(1);
    expect((await store.getExecution(pending.id))?.delivery).toBe('consumed');
    expect(f.calls).toBe(1);
    expect(
      (await store.listExecutions('s')).filter((execution) => execution.kind === 'job'),
    ).toHaveLength(1);
  } finally {
    release();
    await runtime?.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote structured MCP failure reaches the next actual Model with exact call and source provenance', async () => {
  const f = await fixture('synchronous');
  const root = mkdtempSync(join(tmpdir(), 'kite-mcp-feedback-'));
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'fixture' });
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'original-call', name: f.tool.model!.name, arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    runtime = createRuntime({
      store,
      model,
      extensions: [
        defineExtension({ id: 'fixture.mcp', version: '1', apiMajor: 1, tools: [f.tool] }),
      ],
      permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'session',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'fixture',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Read the requested dataset once.' },
    });
    await runtime.waitForCommand('work');
    const execution = (await store.listExecutions('s')).find((entry) => entry.kind === 'tool')!;
    expect(execution.status).toBe('failed');
    expect(model.requests).toHaveLength(2);
    const feedback = model.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(feedback).toMatchObject({ toolCallId: 'original-call', sourceIds: [execution.id] });
    expect(feedback.content).toContain((execution.result as { content: string }).content);
    expect(feedback.content).toContain('The operation failed.');
    expect(feedback.content).toContain(remoteReason);
    expect(feedback.content).toContain('"structuredContent":{"error":{"code":"dataset_missing"');
    expect(feedback.content).toContain('remote MCP tool reported a failure');
    expect(feedback.content).toContain('does not prove earlier effects were rolled back');
    expect(f.calls).toBe(1);
  } finally {
    await runtime?.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['task-error', 'task-failed', 'task-cancelled', 'task-unknown'] as const)
  test(`remote Task preserves its original reason and effect uncertainty: ${mode}`, async () => {
    const f = await fixture(mode);
    let started: Awaited<ReturnType<typeof f.start>> | undefined;
    try {
      expect((await f.tool.execute({}, f.context)).outcome).toBe('succeeded');
      started = await f.start();
      let terminal: ToolResult | undefined;
      for await (const event of started.job.observe(started.handle))
        if (event.type === 'terminal') terminal = event.result;
      expect(terminal).toBeDefined();
      expect(terminal!.outcome).toBe(
        mode === 'task-unknown'
          ? 'outcome_unknown'
          : mode === 'task-cancelled'
            ? 'cancelled'
            : 'failed',
      );
      if (mode === 'task-unknown') {
        expect(terminal!.content).toContain('may still be running or have effects');
        expect(terminal!.content).toContain('Do not repeat the operation');
        expect(terminal!.content).not.toContain(privateTransport);
        expect(terminal!.content).not.toContain('mcp_task_unconfirmed');
        expect(terminal!.details).toMatchObject({
          code: 'mcp_task_unconfirmed',
          remoteStopConfirmed: false,
        });
      } else {
        expect(terminal!.content).toContain(remoteReason);
        expect(terminal!.content).toContain('does not prove earlier effects were rolled back');
        expect(terminal!.content).toContain('not instructions or additional authorization');
      }
      if (mode === 'task-error') expect(terminal!.content).toContain('structuredContent');
      else if (mode !== 'task-unknown')
        expect(terminal!.details).toMatchObject({ statusMessage: remoteReason });
      expect(f.calls).toBe(1);
    } finally {
      if (started) {
        await started.job.cancel(started.handle);
        await started.job.dispose(started.handle);
      }
      await f.close();
    }
  });
