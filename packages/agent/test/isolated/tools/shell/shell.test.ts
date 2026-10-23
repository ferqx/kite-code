import { expect, test } from 'bun:test';
import type { JobDefinition, Json, ToolContext } from '@kite-ai/agent/extensions';
import { createShellExtension } from '@kite-ai/agent/shell';

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
    .execute({ shellId: 'work', commandId: 'exact-stop' }, context);
  expect(calls).toEqual([{ commandId: 'exact-stop' }]);
  expect(result.details).toMatchObject({
    cancelRequested: true,
    ref,
    execution: { status: 'outcome_unknown' },
  });
  expect(result.content).not.toContain('stopped');
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
