import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { type ChildAgentConfiguration, createRuntime, type RuntimeOptions } from '../../../src';
import type { Extension, OperationRef, Permissions, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
const allow: Permissions = {
  async authorize() {
    return { allowed: true, revision: 'full' };
  },
};
const tool = (id: string, execute: ToolDefinition['execute'], version = '1'): ToolDefinition => ({
  id,
  version,
  description: `exact ${id} ${version}`,
  inputSchema: { type: 'object', additionalProperties: false },
  execute,
});
const module = (tools: ToolDefinition[], version = '1'): Extension => ({
  id: 'extra',
  version,
  apiMajor: 1,
  tools,
  records: [
    { contentType: 'fixture.child', contentVersion: 1, schema: { type: 'object' } },
    { contentType: 'fixture.v2', contentVersion: 1, schema: { type: 'object' } },
  ],
});
async function fixture(
  child: ChildAgentConfiguration,
  extra: Extension,
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-binding-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const refs: OperationRef[] = [];
  const parent = createFixedModel([
    call('fixture.delegate'),
    [finish],
    call('fixture.delegate'),
    [finish],
  ]);
  const delegate = tool('fixture.delegate', async (_input, context) => {
    let ref: OperationRef;
    try {
      ref = await context.operations.ensure({
        key: `child-${context.executionId}`,
        request: { kind: 'agent', configurationId: 'child', input: { content: 'bounded child' } },
      });
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'child_tool_scope_exceeds_parent')
        throw error;
      return { outcome: 'failed', content: error.code };
    }
    const same = await context.operations.ensure({
      key: `child-${context.executionId}`,
      request: { kind: 'agent', configurationId: 'child', input: { content: 'bounded child' } },
    });
    expect(same).toEqual(ref);
    refs.push(ref);
    const result = await context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 });
    return { outcome: 'succeeded', content: JSON.stringify(result.result) };
  });
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: allow,
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [delegate] }],
    resolveRunConfiguration: async () => ({
      model: parent,
      modelId: 'parent',
      extensions: [extra],
      snapshot: { selected: extra.version },
    }),
    childConfigurations: [child],
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: `file://${root}` });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 's',
  });
  return {
    root,
    store,
    runtime,
    refs,
    expectedStoreId,
    parent,
    submit: () =>
      runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate' },
      }),
    done: () => runtime.waitForCommand('work', { timeoutMs: 7000 }),
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function configuration(
  model: ModelAdapter,
  extra: Extension,
  additions: Partial<ChildAgentConfiguration> = {},
): ChildAgentConfiguration {
  return {
    id: 'child',
    version: '1',
    model,
    modelId: 'child',
    extensions: [extra],
    toolIds: extra.tools!.map((t) => t.id),
    snapshot: { child: true },
    ...additions,
  };
}

test('trusted child resolver reads only sealed parent extensions and retained readers close after capture', async () => {
  const child = createFixedModel([[finish]]);
  const extra = module([]);
  let reads = 0,
    retained: (() => Promise<unknown>) | undefined;
  const f = await fixture(configuration(child, extra), extra, {
    async initializeRunRequirements(input) {
      const context = await input.forExtension('extra');
      await context.records.create({
        key: `run/${input.run.id}/original`,
        contentType: 'fixture.child',
        contentVersion: 1,
        value: { tail: 'EXACT_PARENT_FACT' },
      });
      return [];
    },
    async resolveChildRunConfiguration(input) {
      expect(input.parentRun).not.toBeNull();
      expect(() => input.records.forExtension('foreign')).toThrow(
        'child_configuration_read_scope_denied',
      );
      const records = input.records.forExtension('extra');
      const key = `run/${input.parentRun!.id}/original`;
      const record = await records.get(key);
      reads++;
      expect(record?.value).toEqual({ tail: 'EXACT_PARENT_FACT' });
      expect(record?.originStoreId).toBe(input.parentExecution.originStoreId);
      expect(Object.isFrozen(record)).toBe(true);
      retained = () => records.get(key);
      return {
        model: child,
        modelId: 'child',
        extensions: [extra],
        toolIds: [],
        snapshot: { captured: record!.value },
      };
    },
  });
  try {
    await f.submit();
    await f.done();
    expect(reads).toBe(1);
    expect(child.requests).toHaveLength(1);
    expect(f.refs).toHaveLength(1);
    let code = '';
    try {
      await retained!();
    } catch (error) {
      code = (error as AgentError).code;
    }
    expect(code).toBe('child_configuration_read_scope_denied');
    const model = (await f.store.listExecutions(f.refs[0]!.childSessionId!)).find(
      (item) => item.kind === 'model',
    )!;
    const run = (await f.store.getRun(model.runId!))!;
    expect(run.configuration).toMatchObject({
      snapshot: { captured: { tail: 'EXACT_PARENT_FACT' } },
    });
  } finally {
    await f.close();
  }
}, 10000);

test('trusted child configuration rejects a record changed during resolver capture without starting the child', async () => {
  const child = createFixedModel([[finish]]);
  const extra = module([]);
  let change!: () => Promise<unknown>;
  let disposed = 0;
  const f = await fixture(configuration(child, extra), extra, {
    async initializeRunRequirements(input) {
      const context = await input.forExtension('extra');
      const key = `run/${input.run.id}/original`;
      const record = await context.records.create({
        key,
        contentType: 'fixture.child',
        contentVersion: 1,
        value: { state: 'original' },
      });
      expect(record.revision).toBe('1');
      change = async () => {
        // Fault injection between the trusted read and admission; no forged business proof.
        const db = new Database(join(f.root, 'data', 'new', 'core.db'));
        try {
          db.run(
            "UPDATE extension_record SET revision=revision+1,json=? WHERE extension_id='extra' AND key=?",
            [JSON.stringify({ state: 'changed' }), key],
          );
        } finally {
          db.close();
        }
      };
      return [];
    },
    async resolveChildRunConfiguration(input) {
      const record = await input.records
        .forExtension('extra')
        .get(`run/${input.parentRun!.id}/original`);
      expect(record?.value).toEqual({ state: 'original' });
      await change();
      return {
        model: child,
        modelId: 'child',
        extensions: [extra],
        toolIds: [],
        snapshot: { captured: record!.value },
        dispose: async () => {
          disposed++;
        },
      };
    },
  });
  try {
    await f.submit();
    await f.done();
    expect(child.requests).toHaveLength(0);
    expect(disposed).toBe(1);
    expect(f.refs).toHaveLength(0);
    const execution = (await f.store.listExecutions('s')).find((item) => item.kind === 'tool')!;
    expect(execution.result).toMatchObject({
      outcome: 'outcome_unknown',
      content: 'context_refresh_required',
    });
  } finally {
    await f.close();
  }
}, 10000);

async function rejectsCode(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as AgentError)?.code).toBe(code);
}

for (const boundary of [
  'carrier_transaction',
  'permission_wait',
  'activation_transaction',
] as const) {
  test(`trusted child record CAS rejects drift at ${boundary} before child Model`, async () => {
    const child = createFixedModel([[finish]]);
    const extra = module([]);
    let originalKey = '',
      disposed = 0,
      changed = false,
      rejected = false;
    let captured: Parameters<typeof f.store.ensureOperation>[0] | undefined;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continuePermission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = (changedValue: boolean) => {
      const db = new Database(join(f.root, 'data', 'new', 'core.db'));
      try {
        // Explicit corruption/race injection in this disposable database only.
        db.run(
          "UPDATE extension_record SET revision=?,json=? WHERE extension_id='extra' AND key=?",
          [
            changedValue ? 2 : 1,
            JSON.stringify({ state: changedValue ? 'later' : 'original' }),
            originalKey,
          ],
        );
        changed ||= changedValue;
      } finally {
        db.close();
      }
    };
    const f = await fixture(configuration(child, extra), extra, {
      permissions: {
        async authorize(request) {
          if (
            boundary === 'permission_wait' &&
            request.definitionId === 'agent/child' &&
            !changed
          ) {
            entered();
            await continuePermission;
          }
          return { allowed: true, revision: 'full' };
        },
      },
      async initializeRunRequirements(input) {
        originalKey = `run/${input.run.id}/original`;
        const context = await input.forExtension('extra');
        await context.records.create({
          key: originalKey,
          contentType: 'fixture.child',
          contentVersion: 1,
          value: { state: 'original' },
        });
        return [];
      },
      async resolveChildRunConfiguration(input) {
        const record = await input.records.forExtension('extra').get(originalKey);
        return {
          model: child,
          modelId: 'child',
          extensions: [extra],
          toolIds: [],
          snapshot: { captured: record!.value },
          dispose: async () => {
            disposed++;
          },
        };
      },
    });
    const ensure = f.store.ensureOperation.bind(f.store);
    const activate = f.store.activateChildRun.bind(f.store);
    f.store.ensureOperation = async (input) => {
      captured = input;
      if (boundary !== 'carrier_transaction' || changed) return ensure(input);
      write(true);
      try {
        return await ensure(input);
      } catch (error) {
        rejected = (error as AgentError).code === 'context_refresh_required';
        throw error;
      } finally {
        write(false);
      }
    };
    if (boundary === 'activation_transaction')
      f.store.activateChildRun = async (input) => {
        if (changed) return activate(input);
        write(true);
        try {
          await rejectsCode(activate(input), 'context_refresh_required');
          rejected = true;
          expect(child.requests).toHaveLength(0);
        } finally {
          write(false);
        }
        // After the deliberately injected fault is restored, the original owned child completes normally.
        return activate(input);
      };
    try {
      await f.submit();
      if (boundary === 'permission_wait') {
        await Promise.race([
          waiting,
          Bun.sleep(5000).then(() => {
            throw new Error('permission wait not entered');
          }),
        ]);
        write(true);
        try {
          const cursor = (await f.store.getMetadata()).lastChangeCursor;
          await rejectsCode(
            ensure({ ...captured!, operationKey: 'drifted-after-permission-wait' }),
            'context_refresh_required',
          );
          rejected = true;
          expect(child.requests).toHaveLength(0);
          expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
        } finally {
          write(false);
          release();
        }
      }
      await f.done();
      expect(changed).toBe(true);
      expect(rejected).toBe(true);
      expect(disposed).toBe(1);
      const executions = await f.store.listExecutions('s');
      if (boundary === 'carrier_transaction') {
        expect(child.requests).toHaveLength(0);
        expect(executions.filter((item) => item.kind === 'job')).toHaveLength(0);
        expect(f.refs).toHaveLength(0);
      } else {
        expect(child.requests).toHaveLength(1);
        const carrier = executions.find((item) => item.kind === 'job')!;
        expect(carrier.childConfiguration?.recordReads).toHaveLength(1);
        expect(carrier.status).toBe('succeeded');
      }
    } finally {
      release();
      await f.close();
    }
  }, 10000);
}

test('trusted Run record observer fixes manifest and Session, preserves origin and performs no writes', async () => {
  const child = createFixedModel([[finish]]);
  const extra = module([]);
  let runId = '',
    key = '';
  const f = await fixture(configuration(child, extra), extra, {
    async initializeRunRequirements(input) {
      runId = input.run.id;
      key = `run/${runId}/original`;
      const context = await input.forExtension('extra');
      await context.records.create({
        key,
        contentType: 'fixture.child',
        contentVersion: 1,
        value: { exact: true },
      });
      return [];
    },
  });
  try {
    await f.submit();
    await f.done();
    const input = { sessionId: 's', runId, extensionId: 'extra', key };
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const record = await f.runtime.readRunExtensionRecord(input);
    expect(record?.value).toEqual({ exact: true });
    expect(Object.isFrozen(record)).toBe(true);
    expect(await f.runtime.readRunExtensionRecord({ ...input, key: 'missing' })).toBeNull();
    for (const override of [
      { sessionId: 'foreign' },
      { runId: 'missing' },
      { extensionId: 'foreign' },
    ]) {
      let error: unknown;
      try {
        await f.runtime.readRunExtensionRecord({ ...input, ...override });
      } catch (caught) {
        error = caught;
      }
      expect((error as AgentError)?.code).toBe('run_extension_read_scope_denied');
    }
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('trusted child missing record observation is sealed and rejects a later presence before carrier creation', async () => {
  const child = createFixedModel([[finish]]);
  const extra = module([]);
  let key = '',
    injected = false;
  const f = await fixture(configuration(child, extra), extra, {
    async resolveChildRunConfiguration(input) {
      key = `run/${input.parentRun!.id}/missing`;
      expect(await input.records.forExtension('extra').get(key)).toBeNull();
      return {
        model: child,
        modelId: 'child',
        extensions: [extra],
        toolIds: [],
        snapshot: { missing: true },
      };
    },
  });
  const ensure = f.store.ensureOperation.bind(f.store);
  f.store.ensureOperation = async (input) => {
    expect(input.childConfiguration?.recordReads?.[0]?.revision).toBeNull();
    const db = new Database(join(f.root, 'data', 'new', 'core.db'));
    try {
      // Deliberate race injection only, not business authority fabrication.
      db.run(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('extra','session','s',?,1,'fixture.child',1,?,'{}')",
        [key, f.expectedStoreId],
      );
      injected = true;
    } finally {
      db.close();
    }
    return ensure(input);
  };
  try {
    await f.submit();
    await f.done();
    expect(injected).toBe(true);
    expect(child.requests).toHaveLength(0);
    expect(f.refs).toHaveLength(0);
    expect((await f.store.listExecutions('s')).filter((item) => item.kind === 'job')).toHaveLength(
      0,
    );
  } finally {
    await f.close();
  }
}, 10000);
