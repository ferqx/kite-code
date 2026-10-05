import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import {
  defineExtension,
  type JobEvent,
  type Json,
  type OperationRef,
} from '../../../src/extensions';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('job_freshness_barrier_timeout')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const launch = (id: string, keys: string[], rule: string): ModelEvent[] => [
  {
    type: 'tool_call',
    id,
    name: 'fixture.launch',
    arguments: JSON.stringify({ keys, path: 'output.txt', rule }),
  },
  { ...finish, reason: 'tool_calls' },
];

test('a queued Job keeps its original model decision when the parent refreshes for its next request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-job-freshness-'));
  const instruction = join(root, 'AGENTS.md');
  const ledger = join(root, 'external-ledger');
  writeFileSync(instruction, 'old rule');
  const started = barrier();
  const endFirst = barrier();
  const queuedPermission = barrier();
  const refs = new Map<string, OperationRef>();
  const effects: Json[] = [];
  const model = createFixedModel([
    launch('old-call', ['first', 'queued'], 'old rule'),
    [finish],
    launch('fresh-call', ['fresh'], 'new rule'),
    [finish],
  ]);
  const extension = defineExtension({
    id: 'fixture.queued-sources',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'Launch controlled Jobs from this decision',
        inputSchema: {
          type: 'object',
          properties: {
            keys: { type: 'array', items: { type: 'string' } },
            path: { type: 'string' },
            rule: { type: 'string' },
          },
          required: ['keys', 'path', 'rule'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const value = input as { keys: string[]; path: string; rule: string };
          for (const key of value.keys) {
            refs.set(
              key,
              await context.operations.ensure({
                key,
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.effect',
                  definitionVersion: '1',
                  input: { key, path: value.path, rule: value.rule },
                },
              }),
            );
            if (key === 'first') await bounded(started.waiting);
          }
          if (value.keys.includes('queued')) {
            await bounded(queuedPermission.waiting);
            // Change after both decisions exist but before the queued Job owns a process slot.
            writeFileSync(instruction, 'new rule');
          }
          return { outcome: 'succeeded', content: 'references admitted' };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.effect',
        version: '1',
        description: 'Harmless externally recorded effect',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            path: { type: 'string' },
            rule: { type: 'string' },
          },
          required: ['key', 'path', 'rule'],
          additionalProperties: false,
        },
        resources: { slot: 'process' },
        async start(input) {
          effects.push(structuredClone(input));
          appendFileSync(ledger, `${JSON.stringify(input)}\n`);
          if ((input as { key: string }).key === 'first') started.release();
          return { reference: input };
        },
        async *observe(handle): AsyncIterable<JobEvent> {
          if ((handle.reference as { key: string }).key === 'first') await endFirst.waiting;
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'recorded' },
          };
        },
        async cancel() {
          endFirst.release();
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const runtime = createRuntime({
    store,
    model,
    extensions: [extension],
    processConcurrency: 1,
    sources: createProjectSources({
      async workspaceRoot() {
        return root;
      },
      targetPaths: () => ['output.txt'],
    }),
    permissions: {
      async authorize(request) {
        if (
          request.definitionId === 'fixture.effect' &&
          (request.input as { key: string }).key === 'queued'
        )
          queuedPermission.release();
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'test',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'test',
      subjectId: 'owner',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'old-work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'launch old decisions' },
    });
    await bounded(runtime.waitForCommand('old-work'));
    expect(model.requests).toHaveLength(2);
    expect(
      model.requests[1]!.messages.filter((message) => message.role === 'system').map(
        (message) => message.content,
      ),
    ).toEqual(['new rule']);
    expect(effects).toEqual([{ key: 'first', path: 'output.txt', rule: 'old rule' }]);
    const queuedId = refs.get('queued')!.executionId!;
    const queuedDecision = (await store.getExecution(queuedId))!.decisionSource;
    expect(JSON.stringify(queuedDecision)).toContain('old rule');
    const originalModel = await store.getExecution(model.requests[0]!.requestId);
    endFirst.release();
    await bounded(runtime.waitForCommand(refs.get('queued')!.commandId));
    expect(await store.getExecution(queuedId)).toMatchObject({
      status: 'failed',
      result: { content: 'context_refresh_required', details: { adapterAttempted: false } },
      decisionSource: queuedDecision,
    });
    expect(await store.getExecution(model.requests[0]!.requestId)).toEqual(originalModel);
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'fresh-work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'launch with current instructions' },
    });
    await bounded(runtime.waitForCommand('fresh-work'));
    await bounded(runtime.waitForCommand(refs.get('fresh')!.commandId));
    expect(effects).toEqual([
      { key: 'first', path: 'output.txt', rule: 'old rule' },
      { key: 'fresh', path: 'output.txt', rule: 'new rule' },
    ]);
    expect(model.requests).toHaveLength(4);
    expect(await store.getExecution(refs.get('fresh')!.executionId!)).toMatchObject({
      status: 'succeeded',
    });
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    endFirst.release();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
