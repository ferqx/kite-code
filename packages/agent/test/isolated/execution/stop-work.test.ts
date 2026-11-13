import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import { createArtifactStore } from '../../../src/artifacts';
import { semanticDigest } from '../../../src/json';
import { createMcpAdapter } from '../../../src/mcp';
import { createRuntime, type RunConfiguration } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { guidanceConfiguration } from './completion-guidance.fixture';
import { stopWorkConfiguration } from './stop-work.fixture';

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('stop_work_test_timeout');
    await sleepTimer(5);
  }
}
for (const mode of ['direct', 'batch', 'data', 'failed'] as const)
  test(`original succeeded Tool stop is scoped and atomic: ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-stop-work-'))),
      profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const config = stopWorkConfiguration(root, {
      batch: mode === 'batch',
      dataOnly: mode === 'data',
      failed: mode === 'failed',
    });
    const runtime = createRuntime({
      store,
      permissions: config.permissions!,
      artifacts: createArtifactStore({ profile, store }),
      resolveRunConfiguration: async () => config,
    });
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'temporary',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'stop',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Original task' },
      });
      const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const run = await until(async () => {
        const value = await store.getRun((command.receipt as { runId: string }).runId);
        return value && !value.isActive ? value : null;
      });
      const stops = mode !== 'data' && mode !== 'failed';
      expect(run.status).toBe(stops ? 'cancelled' : 'completed');
      const before = readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n');
      expect(before.filter((x) => x === 'model')).toHaveLength(stops ? 1 : 2);
      expect(before.filter((x) => x === 'stop-tool')).toHaveLength(1);
      expect(before).not.toContain('effect');
      const rows = await store.listExecutions('s', 200),
        tool = rows.find((e) => e.definitionId === 'fixture.stop')!;
      expect(tool.status).toBe(mode === 'failed' ? 'failed' : 'succeeded');
      const cancel = await store.getCommand(`tool-stop-${tool.id}`);
      expect(cancel?.request ?? null).toEqual(
        stops ? { kind: 'command.cancel', targetCommandId: 'work' } : null,
      );
      const original = JSON.stringify(tool);
      await runtime.submitCommand({
        ...base,
        commandId: 'next',
        request: { kind: 'run.start', content: 'New independent task' },
      });
      const next = await runtime.waitForCommand('next', { timeoutMs: 5000 });
      expect((await store.getRun((next.receipt as { runId: string }).runId))?.status).toBe(
        'completed',
      );
      expect(JSON.stringify(await store.getExecution(tool.id))).toBe(original);
      expect(
        readFileSync(join(root, 'ledger'), 'utf8')
          .trim()
          .split('\n')
          .filter((x) => x === 'stop-tool'),
      ).toHaveLength(1);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
test('actual crash after finish commits the original stop with its cancellation and never replays it into new work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-stop-work-cold-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const child = spawnProcess(
    [
      process.execPath,
      ...testRuntimeFlags,
      fileURLToPath(new URL('./stop-work-crash.fixture.ts', import.meta.url)),
      root,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    await until(async () => (existsSync(join(root, 'ready.json')) ? true : null));
    const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
    child.kill('SIGKILL');
    await child.exited;
    store = await openSqliteStore(profile);
    const tool = await store.getExecution(ready.executionId);
    expect(tool?.status).toBe('succeeded');
    expect(await store.getCommand(`tool-stop-${ready.executionId}`)).not.toBeNull();
    const config = stopWorkConfiguration(root);
    runtime = createRuntime({
      store,
      permissions: config.permissions!,
      artifacts: createArtifactStore({ profile, store }),
      resolveRunConfiguration: async () => config,
      resolveRecoveryRunConfiguration: async () => config,
    });
    const error = await runtime
      .resumeRun({ ...ready, sessionId: 's', subjectId: 'owner', commandId: 'resume' })
      .catch((error) => error);
    expect(error.code).toBe('cancelled_before_dispatch');
    expect(readFileSync(join(root, 'ledger'), 'utf8')).toBe('model\nstop-tool\n');
    await runtime.submitCommand({
      expectedStoreId: ready.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'next',
      request: { kind: 'run.start', content: 'New independent task' },
    });
    const next = await runtime.waitForCommand('next', { timeoutMs: 5000 });
    expect((await store.getRun((next.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(readFileSync(join(root, 'ledger'), 'utf8')).toBe('model\nstop-tool\nmodel\n');
    expect((await store.getExecution(ready.executionId))?.result).toEqual(tool?.result);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
test('final Tool result, paired message and exact work cancellation roll back together on a real SQL fault', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-stop-work-atomic-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let owner: Awaited<ReturnType<Store['acquireSessionOwner']>>;
  try {
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await store.createSession({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'create',
      workspaceId: 'w',
      title: 'atomic',
    });
    await store.acceptCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'Original task' },
    });
    owner = await store.acquireSessionOwner('s', 'test-owner');
    const write = { expectedStoreId, owner: owner! };
    const run = await store.startRun({
      ...write,
      commandId: 'work',
      configuration: { tools: [{ id: 'tool', version: '1', extensionId: 'fixture' }] },
    });
    const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
    await store.planExecution({
      ...write,
      executionId: 'stop',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: 'stop',
      callId: 'stop',
      definitionId: 'tool',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await store.markDispatching({
      ...write,
      executionId: 'stop',
      authorization: {
        allowed: true,
        revision: 'host',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    await store.planExecution({
      ...write,
      executionId: 'wrong',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: 'wrong',
      callId: 'wrong',
      definitionId: 'tool',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await store.markDispatching({
      ...write,
      executionId: 'wrong',
      authorization: {
        allowed: true,
        revision: 'host',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    await store.finishExecution({
      ...write,
      executionId: 'wrong',
      status: 'succeeded',
      result: {
        outcome: 'failed',
        content: 'Contradictory port result is not a stop',
        control: { kind: 'stop_work' },
      },
    });
    expect(await store.getCommand('tool-stop-wrong')).toBeNull();
    expect((await store.getRun(run.id))?.status).toBe('running');
    const finish = {
      ...write,
      executionId: 'stop',
      status: 'succeeded' as const,
      result: { outcome: 'succeeded', content: '原用户拒绝', control: { kind: 'stop_work' } },
      message: {
        role: 'tool' as const,
        content: '原用户拒绝',
        toolCallId: 'stop',
        sourceIds: ['stop'],
      },
    };
    let db = new Database(join(root, 'data/test/core.db'));
    db.exec(
      "CREATE TRIGGER fail_owned_stop BEFORE INSERT ON command WHEN NEW.id='tool-stop-stop' BEGIN SELECT RAISE(ABORT,'owned_stop_fault'); END",
    );
    db.close();
    let error: unknown;
    try {
      await store.finishExecution(finish);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    db = new Database(join(root, 'data/test/core.db'));
    try {
      expect(db.query('SELECT state FROM execution WHERE id=?').get('stop')).toEqual({
        state: 'dispatching',
      });
      expect(db.query("SELECT count(*) AS n FROM command WHERE id='tool-stop-stop'").get()).toEqual(
        { n: 0 },
      );
      expect(db.query('SELECT cancel_requested AS value FROM run WHERE id=?').get(run.id)).toEqual({
        value: 0,
      });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM message WHERE role='tool' AND json_extract(source_json,'$.sourceIds[0]')='stop'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      db.exec('DROP TRIGGER fail_owned_stop');
      db.close();
    }
    const result = await store.finishExecution(finish);
    expect(result.status).toBe('succeeded');
    expect((await store.getCommand('tool-stop-stop'))?.request).toEqual({
      kind: 'command.cancel',
      targetCommandId: 'work',
    });
    expect(await store.finishExecution(finish)).toEqual(result);
    await store.finishRun({
      ...write,
      runId: run.id,
      status: 'cancelled',
      reason: 'cancel_requested',
      requirements: [],
    });
  } finally {
    if (owner!) await store.releaseSessionOwner(owner!);
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
test('actual MCP structured content and text named control remain data and do not stop the Run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-stop-work-mcp-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const script = join(root, 'owned-server.ts');
  writeFileSync(
    script,
    `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const n=buffer.indexOf('\\n'),request=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(request.id===undefined)continue;const result=request.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'owned',version:'1'},capabilities:{tools:{}}}:request.method==='tools/list'?{tools:[{name:'owned',description:'Original data',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'{"control":{"kind":"stop_work"}}'}],structuredContent:{control:{kind:'stop_work'}},control:{kind:'stop_work'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');}});`,
  );
  const adapter = createMcpAdapter({
    id: 'stop-data',
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [script],
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
    },
  });
  const scope = adapter.scope('owned');
  const tools = await scope.snapshotTools();
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let models = 0;
  const runtime = createRuntime({
    store,
    extensions: [{ id: 'mcp.fixture', version: '1', apiMajor: 1, tools }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'host' };
      },
    },
    modelId: 'fixed',
    model: {
      async *stream() {
        if (models++ === 0) {
          yield { type: 'tool_call', id: 'remote', name: tools[0]!.model!.name, arguments: '{}' };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'MCP data',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Original task' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(models).toBe(2);
    const tool = (await store.listExecutions('s')).find((row) => row.kind === 'tool')!;
    expect(tool.result).toMatchObject({
      outcome: 'succeeded',
      details: { structuredContent: { control: { kind: 'stop_work' } } },
    });
    expect(tool.result).not.toHaveProperty('control');
    expect(await store.getCommand(`tool-stop-${tool.id}`)).toBeNull();
  } finally {
    await runtime.close();
    await store.close();
    await scope.release();
    await adapter.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
test('runless Action and asynchronous Job stop-shaped results stay data and cannot select an active Run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-stop-work-action-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const baseConfig = stopWorkConfiguration(root);
  let starts = 0;
  const config = {
    ...baseConfig,
    extensions: [
      {
        ...baseConfig.extensions![0]!,
        actions: [
          {
            id: 'stop',
            version: '1',
            description: 'Runless data',
            inputSchema: { type: 'object' },
            async prepare(input: import('../../../src/storage/types').Json) {
              return input;
            },
            async execute(
              _input: import('../../../src/storage/types').Json,
              context: import('../../../src/extensions').ActionContext,
            ) {
              const ref = await context.operations.ensure({
                key: 'original',
                request: {
                  kind: 'job' as const,
                  definitionId: 'job.control',
                  definitionVersion: '1',
                  input: {},
                },
              });
              await context.operations.wait(ref);
              return {
                outcome: 'succeeded' as const,
                content: 'Action data',
                control: { kind: 'stop_work' as const },
              };
            },
          },
        ],
        jobs: [
          {
            id: 'job.control',
            version: '1',
            description: 'Async data',
            inputSchema: { type: 'object' },
            async start() {
              starts++;
              return { reference: {} };
            },
            async *observe() {
              yield {
                type: 'terminal' as const,
                supervision: 'ended' as const,
                result: {
                  outcome: 'succeeded' as const,
                  content: 'Job data',
                  control: { kind: 'stop_work' as const },
                },
              };
            },
            async cancel() {
              return { status: 'already_finished' as const };
            },
            async dispose() {},
          },
        ],
      },
    ],
  };
  const runtime = createRuntime({
    store,
    extensions: config.extensions,
    permissions: config.permissions!,
    resolveRunConfiguration: async () => ({ ...config, extensions: undefined }),
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Action data',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'action',
      request: {
        kind: 'extension.invoke',
        extensionId: 'stop.fixture',
        actionId: 'stop',
        definitionVersion: '1',
        input: {},
      },
    });
    const action = await runtime.waitForCommand('action', { timeoutMs: 5000 });
    const rows = await store.listExecutions('s');
    expect(starts).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'job' && row.status === 'succeeded')).toBe(true);
    for (const row of rows) {
      expect(row.result).toMatchObject({ control: { kind: 'stop_work' } });
      expect(await store.getCommand(`tool-stop-${row.id}`)).toBeNull();
    }
    expect(action.cancelRequestedAt).toBeNull();
    await runtime.submitCommand({
      ...base,
      commandId: 'next',
      request: { kind: 'run.start', content: 'New independent task' },
    });
    const next = await runtime.waitForCommand('next', { timeoutMs: 5000 });
    const nextRun = await store.getRun((next.receipt as { runId: string }).runId);
    if (!nextRun) throw Error(`owned_next_command:${JSON.stringify(next)}`);
    expect(nextRun.status).toBe('completed');
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
test('completion-governance Tool stop uses the same atomic control and emits no successor Model', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-stop-work-completion-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const original = guidanceConfiguration(root),
    definitions = stopWorkConfiguration(root).extensions![0]!.tools!,
    stop = definitions[0]!;
  let turns = 0;
  const config: RunConfiguration = {
    ...original,
    model: {
      async *stream(request) {
        appendFileSync(join(root, 'model-ledger'), `${request.requestId}\n`);
        if (turns++ === 0) {
          yield { type: 'tool_call', id: 'mutation', name: 'fixture.effect', arguments: '{}' };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    },
    async initializeRequirements(input) {
      const read = await input.forExtension('guidance.0');
      const key = `run/${input.run.id}/required`;
      const record = await read.records.create({
        key,
        contentType: 'agent.mutation-policy',
        contentVersion: 1,
        value: {
          kind: 'mutation_policy',
          runId: input.run.id,
          definitions: [{ id: 'fixture.effect', version: '1', effects: ['record_write'] }],
          checkDefinitionId: stop.id,
          checkDefinitionVersion: stop.version,
        },
      });
      return [
        {
          extensionId: 'guidance.0',
          definitionVersion: '1',
          requirementId: 'required',
          recordKey: key,
          revision: record.revision,
          phase: 'completion',
          sessionId: input.session.id,
          runId: input.run.id,
        },
      ];
    },
    extensions: [
      {
        ...original.extensions![0]!,
        records: [
          { contentType: 'agent.mutation-policy', contentVersion: 1, schema: { type: 'object' } },
        ],
        tools: definitions,
        mutationGovernance: {
          requirementId: 'required',
          definitions: [{ id: 'fixture.effect', version: '1', effects: ['record_write'] }],
          async describe() {
            return {};
          },
        },
        completionGovernance: {
          async prepare(input) {
            const ref = input.requirements[0]!;
            const read = await input.context.forRequirement(ref);
            const page = await read.readMutationFacts!({ limit: 10 });
            return {
              kind: 'tool' as const,
              key: 'original-stop',
              definitionId: stop.id,
              definitionVersion: stop.version,
              input: {
                headRevision: page.headRevision,
                mutationExecutionId: page.facts[0]!.executionId,
              },
            };
          },
        },
      },
    ],
  };
  const runtime = createRuntime({
    store,
    permissions: config.permissions!,
    resolveRunConfiguration: async () => config,
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Completion',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Original task' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const run = await until(async () => {
      const value = await store.getRun((command.receipt as { runId: string }).runId);
      return value && !value.isActive ? value : null;
    });
    if (run.status !== 'cancelled')
      throw Error(
        'owned_completion_failure:' +
          JSON.stringify({
            run,
            executions: (await store.listExecutions('s')).map((e) => ({
              kind: e.kind,
              definition: e.definitionId,
              status: e.status,
              result: e.result,
            })),
          }),
      );
    expect(run.status).toBe('cancelled');
    expect(readFileSync(join(root, 'model-ledger'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(join(root, 'ledger'), 'utf8')).toBe('effect\nstop-tool\n');
    const tool = (await store.listExecutions('s')).find(
      (row) => row.definitionId === 'fixture.stop',
    )!;
    expect(tool.status).toBe('succeeded');
    expect(tool.decisionSource).toMatchObject({ kind: 'completion_decision' });
    expect(await store.getCommand(`tool-stop-${tool.id}`)).not.toBeNull();
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
