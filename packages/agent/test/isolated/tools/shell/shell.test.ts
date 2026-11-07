import { expect, test } from 'bun:test';
import type { JobDefinition, Json, ToolContext } from '@kite-ai/agent/extensions';
import { createShellExtension } from '@kite-ai/agent/shell';
import { AgentError } from '../../../../src/storage/types';

function definition(): JobDefinition {
  return {
    id: 'shell.command',
    version: '1',
    description: 'unused registration fixture',
    inputSchema: { type: 'object' },
    async start() {
      throw new Error('unexpected_start');
    },
    observe() {
      throw new Error('unexpected_observe');
    },
    async cancel() {
      throw new Error('unexpected_cancel');
    },
    async dispose() {
      throw new Error('unexpected_dispose');
    },
  };
}
test('Shell Tool factory is pure and includes the exact selected Job rather than another process manager', () => {
  const job = definition();
  const extension = createShellExtension({ job });
  expect(extension.jobs).toEqual([job]);
  expect(extension.tools?.map((tool) => [tool.id, tool.version])).toEqual([
    ['shell.execute', '1'],
    ['shell.launch', '1'],
    ['shell.read', '1'],
    ['shell.wait', '1'],
    ['shell.stop', '1'],
  ]);
  expect(extension.records?.[0]?.contentType).toBe('application/vnd.kite.shell-reference+json');
});

for (const entry of [
  { id: 'shell.execute', background: false },
  { id: 'shell.execute', background: true },
  { id: 'shell.launch', background: false },
])
  test(`${entry.id} background=${entry.background} returns the original Tool UUID separately from its Shell handle and Job`, async () => {
    const extension = createShellExtension({ job: definition() });
    const executionId = 'e6c8e6bf-ccdd-4a0c-b247-d310e837ad78';
    const ref = {
      originStoreId: 'store',
      sessionId: 's',
      extensionId: 'builtin.shell',
      key: 'original-handle',
      commandId: 'original-operation',
      executionId: '0c0c2e7b-59d0-4e77-95a9-a2829b4a4cb8',
    };
    const calls: string[] = [];
    const context = {
      executionId,
      signal: new AbortController().signal,
      records: {
        async get() {
          calls.push('record.get');
          return null;
        },
        async write() {
          calls.push('record.write');
        },
      },
      operations: {
        async ensure() {
          calls.push('ensure');
          return ref;
        },
        async wait() {
          calls.push('wait');
          return {
            id: ref.executionId,
            sessionId: ref.sessionId,
            originStoreId: ref.originStoreId,
            kind: 'job',
            definitionId: 'shell.command',
            status: 'succeeded',
          };
        },
        async readOutput() {
          calls.push('readOutput');
          return { items: [], highWaterSeq: '0', nextAfterSeq: null };
        },
      },
    } as unknown as ToolContext;
    const result = await extension
      .tools!.find((tool) => tool.id === entry.id)!
      .execute(
        {
          key: ref.key,
          command: 'printf original',
          ...(entry.background ? { background: true } : {}),
        },
        context,
      );
    expect(result.details).toMatchObject({ execution_id: executionId, shell_id: ref.key, ref });
    expect(JSON.parse(result.content).execution_id).toBe(executionId);
    expect(executionId).not.toBe(ref.executionId);
    expect(executionId).not.toBe(ref.key);
    expect(calls).toEqual([
      'ensure',
      'record.get',
      'record.write',
      ...(entry.id === 'shell.execute' && !entry.background ? ['wait', 'readOutput'] : []),
    ]);
  });
test('Shell stop Tool reports only requested cancellation and preserves the exact own-record reference; no stopped claim is synthesized', async () => {
  const extension = createShellExtension({ job: definition() });
  const ref = {
    originStoreId: 'original',
    sessionId: 's',
    extensionId: 'builtin.shell',
    key: 'work',
    commandId: 'operation',
    executionId: 'job',
  };
  const calls: Json[] = [];
  const context = {
    records: {
      async get(key: string) {
        expect(key).toBe('shell/work');
        return {
          contentType: 'application/vnd.kite.shell-reference+json',
          contentVersion: 1,
          value: { ref },
        };
      },
    },
    operations: {
      async cancel(original: unknown, input: unknown) {
        expect(original).toEqual(ref);
        calls.push(input as Json);
      },
      async get(original: unknown) {
        expect(original).toEqual(ref);
        return { id: 'job', status: 'outcome_unknown' };
      },
    },
  } as unknown as ToolContext;
  const result = await extension
    .tools!.find((tool) => tool.id === 'shell.stop')!
    .execute({ shellId: 'work' }, { ...context, executionId: 'cancel-tool' });
  expect(calls).toEqual([{ commandId: 'shell-stop-cancel-tool' }]);
  expect(result.details).toMatchObject({
    cancelRequested: true,
    ref,
    execution: { status: 'outcome_unknown' },
  });
  expect(result.content).not.toContain('stopped');
});

test('non-JSON foreground feedback retains its original warning and both exact identities', async () => {
  const extension = createShellExtension({ job: definition() });
  const executionId = '9f42221e-a025-47df-a634-f3aa8ce060d6';
  const signal = AbortSignal.abort();
  const context = {
    executionId,
    signal,
    records: {
      async get() {
        return null;
      },
      async write() {},
    },
    operations: {
      async ensure() {
        return { key: 'original-handle', executionId: 'original-job' };
      },
      async get() {
        throw Error('original_stop_unconfirmed');
      },
    },
  } as unknown as ToolContext;
  const result = await extension
    .tools!.find((tool) => tool.id === 'shell.execute')!
    .execute({ key: 'original-handle', command: 'printf original' }, context);
  const prefix =
    'Stopping the command could not be confirmed. It may still be running or have produced effects. Use its original shell_id to check its state; do not restart it.';
  expect(result.outcome).toBe('outcome_unknown');
  expect(result.content.startsWith(`${prefix}\nShell handle: `)).toBe(true);
  expect(JSON.parse(result.content.slice(`${prefix}\nShell handle: `.length))).toEqual({
    execution_id: executionId,
    shell_id: 'original-handle',
  });
});

for (const id of ['shell.read', 'shell.wait', 'shell.stop'])
  test(`${id} rejects missing or mismatched local references before accessing any operation`, async () => {
    const extension = createShellExtension({ job: definition() });
    for (const record of [
      null,
      { contentType: 'wrong', contentVersion: 1 },
      { contentType: 'application/vnd.kite.shell-reference+json', contentVersion: 2 },
    ]) {
      const context = {
        records: {
          async get() {
            return record;
          },
        },
        operations: new Proxy(
          {},
          {
            get() {
              throw Error('operation_must_not_be_accessed');
            },
          },
        ),
      } as unknown as ToolContext;
      const result = await extension
        .tools!.find((tool) => tool.id === id)!
        .execute({ shellId: 'missing', commandId: 'stop' }, context);
      expect(result.outcome).toBe('failed');
      expect(result.details).toEqual({ code: 'shell_reference_not_found', shellId: 'missing' });
    }
  });

test('local reference storage failures and unverifiable original operations are not converted into missing references', async () => {
  const extension = createShellExtension({ job: definition() });
  const storageFailure = Error('storage_unavailable');
  for (const id of ['shell.read', 'shell.wait', 'shell.stop']) {
    const context = {
      records: {
        async get() {
          throw storageFailure;
        },
      },
    } as unknown as ToolContext;
    await expect(
      extension
        .tools!.find((tool) => tool.id === id)!
        .execute({ shellId: 'original', commandId: 'stop' }, context),
    ).rejects.toBe(storageFailure);
  }
  const context = {
    records: {
      async get() {
        return {
          contentType: 'application/vnd.kite.shell-reference+json',
          contentVersion: 1,
          value: { ref: { executionId: 'original' } },
        };
      },
    },
    operations: {
      async get() {
        return null;
      },
    },
  } as unknown as ToolContext;
  await expect(
    extension
      .tools!.find((tool) => tool.id === 'shell.read')!
      .execute({ shellId: 'original' }, context),
  ).rejects.toThrow('shell_unverifiable');
});

for (const id of ['shell.execute', 'shell.launch'])
  test(`legacy ${id} input keeps its original Job request and reference readable`, async () => {
    const extension = createShellExtension({
      job: definition(),
      permissionsSchema: {
        type: 'object',
        properties: {
          filesystem: { enum: ['workspace_write', 'full_access'] },
          network: { enum: ['none', 'internet'] },
        },
        required: ['filesystem', 'network'],
        additionalProperties: false,
      },
    });
    const ref = {
      originStoreId: 'original-store',
      sessionId: 's',
      extensionId: 'builtin.shell',
      key: 'historical-shell',
      commandId: 'historical-operation',
      executionId: 'historical-job',
    };
    const execution = {
      id: ref.executionId,
      originStoreId: ref.originStoreId,
      sessionId: ref.sessionId,
      kind: 'job',
      definitionId: 'shell.command',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'original terminal result' },
    };
    const records = new Map<string, unknown>();
    const ensured: unknown[] = [];
    const context = {
      executionId: 'historical-tool',
      signal: new AbortController().signal,
      records: {
        async get(key: string) {
          return records.get(key) ?? null;
        },
        async write(record: { key: string }) {
          records.set(record.key, record);
        },
      },
      operations: {
        async ensure(request: unknown) {
          ensured.push(request);
          return ref;
        },
        async get(original: unknown) {
          expect(original).toEqual(ref);
          return execution;
        },
        async wait(original: unknown) {
          expect(original).toEqual(ref);
          return execution;
        },
        async readOutput(original: unknown) {
          expect(original).toEqual(ref);
          return { items: [], highWaterSeq: '0', nextAfterSeq: null };
        },
      },
    } as unknown as ToolContext;
    const result = await extension
      .tools!.find((tool) => tool.id === id)!
      .execute(
        {
          key: ref.key,
          command: 'original command',
          permissions: { filesystem: 'full_access', network: 'none' },
          cancellation: 'detached',
          ...(id === 'shell.execute' ? { timeoutMs: 100 } : {}),
        },
        context,
      );
    expect(result.outcome).toBe('succeeded');
    expect(ensured).toEqual([
      {
        key: ref.key,
        cancellation: 'detached',
        request: {
          kind: 'job',
          definitionId: 'shell.command',
          definitionVersion: '1',
          input: {
            command: 'original command',
            permissions: { filesystem: 'full_access', network: 'none' },
          },
        },
      },
    ]);
    expect(records.get(`shell/${ref.key}`)).toMatchObject({
      contentType: 'application/vnd.kite.shell-reference+json',
      contentVersion: 1,
      value: { ref },
    });
    const reread = await extension
      .tools!.find((tool) => tool.id === 'shell.read')!
      .execute({ shellId: ref.key }, context);
    expect(reread).toMatchObject({
      outcome: 'succeeded',
      details: { ref, execution: { id: ref.executionId, status: 'succeeded' } },
    });
    expect(ensured).toHaveLength(1);
  });

for (const id of ['shell.execute', 'shell.launch'])
  test(`legacy ${id} key conflicts remain known failures without rewriting original references`, async () => {
    const extension = createShellExtension({ job: definition() });
    let ensures = 0;
    const context = {
      operations: {
        async ensure() {
          ensures++;
          throw new AgentError('operation_conflict');
        },
      },
      records: new Proxy(
        {},
        {
          get() {
            throw Error('must_not_rewrite_original_reference');
          },
        },
      ),
    } as unknown as ToolContext;
    const result = await extension
      .tools!.find((tool) => tool.id === id)!
      .execute(
        {
          key: 'original-shell',
          command: 'different command',
        },
        context,
      );
    expect(ensures).toBe(1);
    expect(result).toMatchObject({
      outcome: 'failed',
      details: { code: 'operation_conflict', shellId: 'original-shell' },
    });
    expect(result.content).toContain('did not start a new command');
    expect(result.content).toContain('Do not restart an unknown or completed command');
  });

test('trusted execute rejects conflicting legacy and new arguments before ensure or reference writes', async () => {
  const extension = createShellExtension({
    job: definition(),
    permissionsSchema: { type: 'object' },
  });
  const context = {
    executionId: 'original-tool',
    operations: new Proxy(
      {},
      {
        get() {
          throw Error('must_not_ensure');
        },
      },
    ),
    records: new Proxy(
      {},
      {
        get() {
          throw Error('must_not_write_reference');
        },
      },
    ),
  } as unknown as ToolContext;
  const invalidInputs: Record<string, Json>[] = [
    { background: true, timeoutMs: 1 },
    { background: true, execution_timeout_ms: 1 },
    { timeoutMs: 1, execution_timeout_ms: 1 },
    { filesystem: 'full_access', permissions: { filesystem: 'full_access', network: 'none' } },
    { network: 'internet', permissions: { filesystem: 'workspace_write', network: 'internet' } },
    { execution_timeout_ms: 3600001 },
  ];
  for (const input of invalidInputs) {
    const result = await extension
      .tools!.find((tool) => tool.id === 'shell.execute')!
      .execute(
        {
          command: 'must not execute',
          ...input,
        },
        context,
      );
    expect(result).toMatchObject({
      outcome: 'failed',
      details: { code: 'invalid_shell_arguments' },
    });
    expect(result.content).toContain('No command was started');
  }
});
