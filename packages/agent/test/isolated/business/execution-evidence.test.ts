import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createArtifactStore } from '../../../src/artifacts';
import {
  createExecutionEvidenceExtension,
  type ExecutionEvidencePage,
  type ExecutionEvidenceReadRequest,
  type ExecutionEvidenceRecord,
} from '../../../src/business/execution-evidence';
import type { ToolContext } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage/types';

const context = {
  sessionId: 'session',
  runId: 'run',
  executionId: 'reader',
  signal: new AbortController().signal,
} as ToolContext;
function record(
  id: string,
  options: Partial<ExecutionEvidenceRecord['execution']> = {},
): ExecutionEvidenceRecord {
  return {
    taskRunId: 'run',
    execution: {
      id,
      sessionId: 'session',
      runId: 'run',
      kind: 'tool',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: `Original public result ${id}` },
      resultRevision: '1',
      definitionId: 'files.edit',
      definitionVersion: '2',
      attempt: 1,
      inputDigest: `original-input-${id}`,
      originStoreId: 'original-store',
      ...options,
    },
    paths: [{ path: `src/${id}.ts`, source: 'files_input' }],
  };
}
function tool(read: (request: ExecutionEvidenceReadRequest) => Promise<ExecutionEvidencePage>) {
  return createExecutionEvidenceExtension({ read }).tools![0]!;
}

test('execution evidence uses scoped true pages, exact receipt detail and recorded targets only', async () => {
  const unknownShell = {
    ...record('shell', {
      kind: 'job',
      runId: null,
      definitionId: 'shell.command',
      status: 'outcome_unknown',
      result: { outcome: 'outcome_unknown', content: 'Stop unconfirmed' },
    }),
    paths: [],
    shellId: 'original-shell-key',
  };
  const records = [record('a'), unknownShell, record('c')];
  const requests: ExecutionEvidenceReadRequest[] = [];
  const reader = tool(async (request) => {
    requests.push(request);
    if (request.executionId)
      return {
        items: records.filter((item) => item.execution.id === request.executionId),
        nextCursor: null,
      };
    const offset = request.cursor === 'page-2' ? 2 : 0;
    return {
      items: records.slice(offset, offset + request.limit),
      nextCursor: offset + request.limit < records.length ? 'page-2' : null,
    };
  });
  const first = JSON.parse((await reader.execute({ limit: 2 }, context)).content);
  expect(first.items.map((item: { execution_id: string }) => item.execution_id)).toEqual([
    'a',
    'shell',
  ]);
  expect(first.items[0].receipt).toMatchObject({
    execution_id: 'a',
    input_digest: 'original-input-a',
  });
  expect(first.items[0]).not.toHaveProperty('result');
  expect(first.items[1]).toMatchObject({
    status: 'outcome_unknown',
    shell_id: 'original-shell-key',
    paths: [],
  });
  expect(first.complete).toBe(false);
  expect(first.next_cursor).toBe('page-2');
  const second = JSON.parse(
    (await reader.execute({ cursor: first.next_cursor, limit: 2 }, context)).content,
  );
  expect(second.items.map((item: { execution_id: string }) => item.execution_id)).toEqual(['c']);
  expect(second.complete).toBe(true);
  const detail = JSON.parse((await reader.execute({ executionId: 'shell' }, context)).content);
  expect(detail.items[0].result).toEqual({
    outcome: 'outcome_unknown',
    content: 'Stop unconfirmed',
  });
  expect(detail.meaning).toContain('Unknown outcomes remain unknown');
  expect(detail.meaning).toContain('no complete per-file change capture');
  expect(
    requests.every(
      (request) =>
        request.sessionId === 'session' &&
        request.runId === 'run' &&
        request.callerExecutionId === 'reader',
    ),
  ).toBe(true);
});

for (const mode of [
  'foreign-session',
  'foreign-run',
  'private-model',
  'wrong-detail',
  'repeated-cursor',
] as const)
  test(`execution evidence fails closed for ${mode} without returning the original body`, async () => {
    const secret = record(mode === 'wrong-detail' ? 'other' : 'wanted', {
      ...(mode === 'foreign-session' ? { sessionId: 'foreign' } : {}),
      ...(mode === 'foreign-run' ? { runId: 'foreign' } : {}),
      ...(mode === 'private-model' ? { kind: 'model' } : {}),
      result: { content: 'PRIVATE_BODY_MUST_NOT_ESCAPE' },
    });
    const reader = tool(async () => ({
      items: [secret],
      nextCursor: mode === 'repeated-cursor' ? 'same' : null,
    }));
    const result = await reader.execute(
      mode === 'repeated-cursor' ? { cursor: 'same' } : { executionId: 'wanted' },
      context,
    );
    expect(result.outcome).toBe('failed');
    expect(result.details).toEqual({ code: 'execution_evidence_scope_denied' });
    expect(result.content).not.toContain('PRIVATE_BODY_MUST_NOT_ESCAPE');
  });

test('arguments cannot select a foreign Session and absent or unknown scope never restarts work', async () => {
  let reads = 0;
  const reader = tool(async () => {
    reads++;
    return { items: [], nextCursor: null };
  });
  expect((await reader.execute({ sessionId: 'foreign' }, context)).outcome).toBe('failed');
  expect((await reader.execute({}, { ...context, runId: null })).outcome).toBe('failed');
  expect(reads).toBe(0);
  const missing = await reader.execute({ executionId: 'lost' }, context);
  expect(missing.outcome).toBe('failed');
  expect(missing.content).toContain('do not rerun');
});

test('scoped cursor rejection explains recovery without exposing private backend errors', async () => {
  const reader = tool(async () => {
    throw new AgentError('execution_evidence_cursor_invalid');
  });
  const result = await reader.execute({ cursor: 'foreign-cursor' }, context);
  expect(result.outcome).toBe('failed');
  expect(result.content).toContain('Start a new evidence list without cursor');
  expect(result.content).toContain('do not rerun');
});

test('detail projects only original public evidence, without raw inputs or arbitrary checkpoint metadata', async () => {
  const original = {
    ...record('a'),
    checkpoint: { id: 'checkpoint', state: 'confirmed', privateBody: 'PRIVATE_CHECKPOINT' },
    privateDiff: 'INITIAL_USER_DIRTY',
  };
  Object.assign(original.execution, {
    input: { secret: 'PRIVATE_INPUT' },
    decisionSource: { content: 'PRIVATE_MODEL' },
  });
  const body = (
    await tool(async () => ({ items: [original], nextCursor: null })).execute(
      { executionId: 'a' },
      context,
    )
  ).content;
  expect(JSON.parse(body).items[0].result).toEqual(original.execution.result);
  expect(JSON.parse(body).items[0].checkpoint).toEqual({ id: 'checkpoint', state: 'confirmed' });
  for (const secret of [
    'PRIVATE_INPUT',
    'PRIVATE_MODEL',
    'PRIVATE_CHECKPOINT',
    'INITIAL_USER_DIRTY',
  ])
    expect(body).not.toContain(secret);
});

test('two actual compressions can omit original evidence and the Runtime still reads it without claiming pre-existing dirty files or repeating an unknown effect', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-execution-evidence-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  writeFileSync(join(root, 'user-dirty.txt'), 'pre-existing user content');
  let calls = 0,
    modelCalls = 0,
    summaries = 0,
    evidenceReads = 0;
  const requests: ModelRequest[] = [];
  const evidence = createExecutionEvidenceExtension({
    async read(request) {
      evidenceReads++;
      const all = (await store.listExecutions(request.sessionId)).filter(
        (execution) =>
          execution.runId === request.runId && execution.definitionId === 'fixture.edit',
      );
      return {
        items: all
          .filter((execution) => !request.executionId || execution.id === request.executionId)
          .map((execution) => ({
            taskRunId: request.runId,
            execution,
            paths: [{ path: 'agent.txt', source: 'files_input' }],
          })),
        nextCursor: null,
      };
    },
  });
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model: ModelAdapter = {
    async *stream(request) {
      if (request.messages.some((message) => message.content === 'SUMMARIZE_EVIDENCE_FIXTURE')) {
        yield {
          type: 'text_delta',
          text: `Checkpoint ${summaries}: original paths and receipts deliberately omitted.`,
        };
        yield finish;
        return;
      }
      requests.push(request);
      const index = modelCalls++;
      if (index < 4) {
        const lastList =
          index === 3
            ? JSON.parse(
                request.messages.filter((message) => message.role === 'tool').at(-1)!.content,
              )
            : null;
        yield {
          type: 'tool_call',
          id: `call-${index}`,
          name: index === 0 ? 'fixture.edit' : 'read_execution_evidence',
          arguments:
            index === 3 ? JSON.stringify({ execution_id: lastList.items[0].execution_id }) : '{}',
        };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield {
          type: 'text_delta',
          text: 'Evidence read; original unknown effect was not repeated.',
        };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    compressor: {
      id: 'fixture.evidence',
      version: '1',
      async shouldCompress() {
        return calls === 1 && summaries < 2 && (summaries === 0 || evidenceReads === 1);
      },
      async prepare() {
        summaries++;
        return { instructions: 'SUMMARIZE_EVIDENCE_FIXTURE', snapshot: { summaries } };
      },
    },
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
    extensions: [
      evidence,
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.edit',
            version: '1',
            description: 'Actual unknown file publication',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            async execute() {
              calls++;
              writeFileSync(join(root, 'agent.txt'), 'one actual effect');
              return {
                outcome: 'outcome_unknown',
                content: 'Publication occurred; original receipt is unconfirmed.',
              };
            },
          },
        ],
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'workspace',
      title: 'Evidence',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: {
        kind: 'run.start',
        content: 'Inspect the original operation evidence; preserve user changes.',
      },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const result = JSON.parse(
      requests[3]!.messages.filter((message) => message.role === 'tool').at(-1)!.content,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      status: 'outcome_unknown',
      paths: [{ path: 'agent.txt', source: 'files_input' }],
    });
    expect(JSON.stringify(result.items)).not.toContain('user-dirty.txt');
    expect(summaries).toBe(2);
    expect(evidenceReads).toBe(3);
    expect(requests[2]!.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(
      requests[2]!.messages.some((message) =>
        message.content.includes('original paths and receipts deliberately omitted'),
      ),
    ).toBe(true);
    const detail = JSON.parse(
      requests[4]!.messages.filter((message) => message.role === 'tool').at(-1)!.content,
    );
    expect(detail.items[0].result).toContain('Outcome unknown.');
    expect(detail.items[0].result).toContain(
      'Publication occurred; original receipt is unconfirmed.',
    );
    expect(detail.items[0].result).toContain('do not repeat');
    for (const field of ['origin_store_id', 'task_run_id', 'input_digest'])
      expect(JSON.stringify(detail)).not.toContain(field);
    const original = (await store.listExecutions('session')).find(
      (entry) => entry.definitionId === 'fixture.edit',
    )!;
    expect(original.result).toMatchObject({
      outcome: 'outcome_unknown',
      content: 'Publication occurred; original receipt is unconfirmed.',
    });
    expect(readFileSync(join(root, 'user-dirty.txt'), 'utf8')).toBe('pre-existing user content');
    expect(readFileSync(join(root, 'agent.txt'), 'utf8')).toBe('one actual effect');
    expect(calls).toBe(1);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
