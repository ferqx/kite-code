import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type {
  Extension,
  JobDefinition,
  OperationRef,
  ToolContext,
  ToolDefinition,
} from '../../../src/extensions';
import type { OutputOperations } from '../../../src/extensions/output';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const sequence = (name: string): ModelEvent[][] => [
  [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  ],
  [finish],
];
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
async function rejected(read: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await read;
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string })?.code).toBe(code);
}

test('Host output pages bind original Store/namespace/Session/ref, freeze upper cursor, and cold reads never restart the original Job', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-operation-output-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  let starts = 0,
    cancels = 0;
  let original!: OperationRef;
  let operations!: OutputOperations;
  let readContext!: ToolContext;
  const bodies = ['first α\n', 'second β\n', 'third γ\n'];
  const job: JobDefinition = {
    id: 'fixture.output',
    version: '1',
    description: 'Harmless exact output fixture',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      return { reference: { id: 'actual-handle' } };
    },
    async *observe() {
      for (const content of bodies) yield { type: 'output', stream: 'stdout', content };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: 'succeeded', content: 'done' },
      };
    },
    async cancel() {
      cancels++;
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const launch: ToolDefinition = {
    id: 'fixture.launch',
    version: '1',
    description: 'Launch one ordinary Job',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      original = await context.operations.ensure({
        key: 'output',
        request: { kind: 'job', definitionId: job.id, definitionVersion: '1', input: {} },
      });
      await context.operations.wait(original, { signal: context.signal, timeoutMs: 4000 });
      await context.records.write({
        key: 'ref',
        expectedRevision: null,
        contentType: 'application/json',
        contentVersion: 1,
        value: original as unknown as import('../../../src/extensions').Json,
      });
      operations = context.operations as OutputOperations;
      readContext = context;
      return { outcome: 'succeeded', content: 'created' };
    },
  };
  const ext: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [launch],
    jobs: [job],
    records: [{ contentType: 'application/json', contentVersion: 1, schema: { type: 'object' } }],
  };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let runtime = createRuntime({
    store,
    model: createFixedModel(sequence(launch.id)),
    modelId: 'fixed',
    extensions: [ext],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${directory}`,
      name: 'private',
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      commandId: 'create',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 's',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'run',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'output' },
    });
    await runtime.waitForCommand('run', { timeoutMs: 5000 });
    const before = (await store.getMetadata()).lastChangeCursor;
    const page = await operations.readOutput(original, { limit: 1 });
    expect(page.highWaterSeq).toBe('3');
    expect(page.items.map((item) => item.content)).toEqual([bodies[0]!]);
    const second = await operations.readOutput(original, {
      afterSeq: page.items[0]!.throughSeq,
      upperSeq: page.highWaterSeq,
      limit: 1,
    });
    const third = await operations.readOutput(original, {
      afterSeq: second.items[0]!.throughSeq,
      upperSeq: page.highWaterSeq,
      limit: 1,
    });
    expect(
      hash([...page.items, ...second.items, ...third.items].map((item) => item.content).join('')),
    ).toBe(hash(bodies.join('')));
    expect((await operations.readOutput(original, { afterSeq: '3', upperSeq: '3' })).items).toEqual(
      [],
    );
    await rejected(
      operations.readOutput({ ...original, originStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await rejected(operations.readOutput({ ...original, sessionId: 'other' }), 'permission_denied');
    await rejected(
      operations.readOutput({ ...original, extensionId: 'other' }),
      'permission_denied',
    );
    await rejected(
      operations.readOutput({ ...original, commandId: 'other' }),
      'operation_not_found',
    );
    await rejected(
      operations.readOutput({ ...original, executionId: 'other' }),
      'operation_not_found',
    );
    await rejected(operations.readOutput(original, { upperSeq: '4' }), 'cursor_ahead');
    await rejected(operations.readOutput(original, { limit: 201 }), 'invalid_output_page');
    await rejected(
      operations.readOutput(original, { signal: AbortSignal.abort() } as never),
      'invalid_output_page',
    );
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    expect(starts).toBe(1);
    expect(cancels).toBe(0);
    expect(readContext.signal.aborted).toBe(false);
    await runtime.close();
    store = await openSqliteStore(profile);
    const cold: ToolDefinition = {
      id: 'fixture.read',
      version: '1',
      description: 'Read old actual output without ensure',
      inputSchema: { type: 'object' },
      async execute(_input, context) {
        const stored = await context.records.get('ref');
        const ref = stored!.value as unknown as OperationRef;
        const result = await (context.operations as OutputOperations).readOutput(ref, {
          upperSeq: '3',
          limit: 3,
        });
        expect(result.items.map((item) => item.content)).toEqual(bodies);
        expect((await context.operations.get(ref))?.status).toBe('succeeded');
        return { outcome: 'succeeded', content: 'read only old body' };
      },
    };
    const model = createFixedModel(sequence(cold.id));
    runtime = createRuntime({
      store,
      model,
      modelId: 'cold-read',
      extensions: [{ ...ext, tools: [cold] }],
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'cold-read',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'explicit read' },
    });
    await runtime.waitForCommand('cold-read', { timeoutMs: 5000 });
    expect(model.requests).toHaveLength(2);
    expect(starts).toBe(1);
    expect(cancels).toBe(0);
    expect((await store.getExecution(original.executionId!))?.resultRevision).toBe('1');
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
