import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { readExecutionToolOwner } from '../../../src/execution/definition-owner';
import type { Json, PublicExecution, ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import {
  mcpModelInput,
  mcpModelInputHint,
  mcpModelReference,
  mcpReferenceResult,
} from '../../../src/mcp/model-reference';
import { modelCursor, readModelCursor } from '../../../src/model-cursor';
import {
  modelExecutionId,
  readModelExecutionId,
  readModelIdentifier,
} from '../../../src/model-identifier';
import {
  modelReference,
  parseModelReference,
  readModelReference,
} from '../../../src/model-reference';
import { openSqliteStore } from '../../../src/sqlite';
import type { ExecutionRecord } from '../../../src/storage/types';

test('cursor round-trips the largest supported Agent filter within the public limit and rejects changed scopes', () => {
  const scope = {
    kind: 'agents',
    sessionId: 's',
    agentIds: Array.from({ length: 200 }, () => crypto.randomUUID()),
  };
  const position = { afterSeq: '1', upperSeq: '200' };
  const cursor = modelCursor(scope, position);
  expect(cursor.length).toBeLessThanOrEqual(4096);
  expect(readModelCursor(cursor, scope)).toEqual(position);
  for (const foreign of [
    { ...scope, sessionId: 'foreign' },
    { ...scope, agentIds: scope.agentIds.slice(1) },
  ])
    expect(() => readModelCursor(cursor, foreign)).toThrow('invalid_cursor');
  for (const invalid of [`${cursor}=`, cursor.slice(0, -1), '%%'])
    expect(() => readModelCursor(invalid, scope)).toThrow('invalid_cursor');
  expect(() => modelCursor(scope, 'x'.repeat(4096))).toThrow('invalid_cursor');
});

test('compact execution and MCP locators decode exact original receipts without encoded mutable bindings', async () => {
  const id = '1172d244-0afd-48cc-b3bd-7c4906dd5e91';
  const short = modelExecutionId(id);
  expect(short.length).toBeLessThan(30);
  expect(readModelExecutionId(short)).toBe(id);
  for (const value of ['u%%', 'uabc', 's', `${short.slice(2)}=`])
    expect(() => readModelIdentifier(value)).toThrow('tool_reference_invalid');
  const serverId = `mcp-${'a'.repeat(64)}`;
  const result = mcpReferenceResult(
    {
      outcome: 'succeeded',
      content: '',
      details: {
        binding: {
          serverId,
          connectionKey: 'original',
          configDigest: 'b'.repeat(64),
          generation: 2,
        },
        descriptors: [{ descriptor: { uri: 'fixture://exact' }, descriptorDigest: 'c'.repeat(64) }],
      },
    },
    'resources',
    id,
  );
  const ref = (result.details as { descriptors: { resource_ref: string }[] }).descriptors[0]!
    .resource_ref;
  expect(ref.length).toBeLessThan(35);
  const request = {
    kind: 'tool' as const,
    definitionId: 'mcp.resources.read',
    definitionVersion: '1',
    sessionId: 's',
    input: { resourceRef: ref },
  };
  const scope = {
    readExecution: async () => ({
      sessionId: 's',
      status: 'succeeded',
      result: result as unknown as Json,
    }),
  };
  expect(await mcpModelInputHint(request, scope)).toEqual({ serverId });
  await expect(mcpModelInputHint({ ...request, sessionId: 'foreign' }, scope)).rejects.toThrow(
    'tool_reference_scope_denied',
  );
  expect(
    await mcpModelInputHint(
      {
        ...request,
        definitionId: 'external.business',
        input: { resourceRef: 'ordinary business data' },
      },
      {
        readExecution: async () => {
          throw Error('Foreign business fields must not read MCP receipts');
        },
      },
    ),
  ).toEqual({ resourceRef: 'ordinary business data' });
  const original = {
    id,
    kind: 'tool',
    definitionId: 'mcp.resources.list',
    definitionVersion: '1',
    extensionId: 'builtin.mcp',
    sessionId: 's',
    runId: 'prior',
    originStoreId: 'store',
    status: 'succeeded',
    resultRevision: '1',
    authorization: { dispatched: true },
    result,
  } as unknown as PublicExecution;
  const context = {
    executionId: 'current',
    sessionId: 's',
    runId: 'now',
    signal: new AbortController().signal,
    getExecution: async (value: string) =>
      value === id
        ? original
        : value === 'current'
          ? { ...original, id: 'current', runId: 'now' }
          : null,
  } as unknown as ToolContext;
  expect(await mcpModelInput({ resourceRef: ref }, 'resource', context)).toEqual({
    serverId,
    connectionKey: 'original',
    configDigest: 'b'.repeat(64),
    generation: 2,
    catalogueExecutionId: id,
    descriptorDigest: 'c'.repeat(64),
    uri: 'fixture://exact',
  });
  await expect(mcpModelInput({ promptRef: ref }, 'prompt', context)).rejects.toThrow(
    'tool_reference_invalid',
  );
  await expect(
    mcpModelInput({ resourceRef: mcpModelReference('resource', id, 1) }, 'resource', context),
  ).rejects.toThrow('tool_reference_unavailable');
  for (const malformed of [ref.slice(0, -1), `${ref}=`, 'mr_%%'])
    await expect(mcpModelInput({ resourceRef: malformed }, 'resource', context)).rejects.toThrow(
      'tool_reference_',
    );
});

test('dynamic tools use the original Model binding and reject foreign or unconfirmed Model provenance', async () => {
  const execution = {
    id: 'tool',
    kind: 'tool',
    definitionId: 'mcp.resources.list',
    definitionVersion: '1',
    runId: 'run',
    stepId: 'step',
    sessionId: 's',
    originStoreId: 'store',
    rootWorkCommandId: 'work',
    rootWorkSeq: '2',
    decisionSource: { modelExecutionId: 'model' },
  } as unknown as ExecutionRecord;
  const original = {
    ...execution,
    id: 'model',
    kind: 'model',
    status: 'succeeded',
    decisionSource: {
      toolBindings: [{ id: 'mcp.resources.list', version: '1', extensionId: 'builtin.mcp' }],
    },
  } as unknown as ExecutionRecord;
  let model = original;
  const host = {
    getExecution: async () => model,
    getRun: async () => {
      throw Error('Current catalogue is not an original step binding');
    },
  };
  expect(await readExecutionToolOwner(host, execution)).toBe('builtin.mcp');
  for (const change of [
    { sessionId: 'foreign' },
    { originStoreId: 'foreign' },
    { runId: 'foreign' },
    { stepId: 'other' },
    { rootWorkCommandId: 'other' },
    { status: 'outcome_unknown' },
  ]) {
    model = { ...original, ...change } as ExecutionRecord;
    expect(await readExecutionToolOwner(host, execution)).toBeUndefined();
  }
  model = {
    ...original,
    decisionSource: {
      toolBindings: [{ id: 'mcp.resources.list', version: '2', extensionId: 'builtin.mcp' }],
    },
  };
  expect(await readExecutionToolOwner(host, execution)).toBeUndefined();
});

test('references locate exact successful dispatched receipts and reject changed authority or revision', async () => {
  const source = {
    id: 'original',
    kind: 'tool',
    sessionId: 's',
    runId: 'previous',
    originStoreId: 'store',
    extensionId: 'owner',
    definitionId: 'read',
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
    authorization: { dispatched: true },
    result: { outcome: 'succeeded', content: 'original' },
  } as unknown as PublicExecution;
  const current = { ...source, id: 'current', runId: 'current-run' };
  let original = source;
  const context = {
    executionId: current.id,
    runId: current.runId,
    sessionId: 's',
    signal: new AbortController().signal,
    getExecution: async (id: string) =>
      id === current.id ? current : id === source.id ? original : null,
  } as unknown as ToolContext;
  const ref = modelReference('file', source.id);
  expect(parseModelReference(ref, 'file')).toEqual({ executionId: source.id, resultRevision: '1' });
  expect(
    (await readModelReference(ref, 'file', context, 'owner', { read: ['1'] })).result.content,
  ).toBe('original');
  for (const change of [
    { sessionId: 'child' },
    { originStoreId: 'other' },
    { runId: null },
    { extensionId: 'other' },
    { definitionVersion: '2' },
    { status: 'failed' },
    { status: 'outcome_unknown' },
    { authorization: { dispatched: false } },
    { resultRevision: '2' },
    { result: { outcome: 'failed', content: '' } },
  ]) {
    original = { ...source, ...change } as PublicExecution;
    await expect(
      readModelReference(ref, 'file', context, 'owner', { read: ['1'] }),
    ).rejects.toThrow('tool_reference_');
  }
  original = source;
  for (const invalid of [
    '',
    'file.%%',
    `${ref}=`,
    modelReference('plan', source.id),
    'file.WyIiLCIxIl0',
    'file.WyJ4IiwiMCJd',
  ])
    expect(() => parseModelReference(invalid, 'file')).toThrow('tool_reference_invalid');
  await expect(
    readModelReference(modelReference('file', 'missing'), 'file', context),
  ).rejects.toThrow('tool_reference_scope_denied');
});

test('real Files use complete baselines and Artifact references without implicit overwrite or replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-reference-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    files = createWorkspaceFiles({ root });
  const artifacts = createArtifactStore({ profile, store });
  let step = 0;
  const succeeded = async (callId: string) => {
    const row = (await store.listExecutions('s')).find((e) => e.callId === callId)!;
    expect(row.status).toBe('succeeded');
    const content = (row.result as { content: string }).content;
    return { row, value: content.startsWith('{') ? JSON.parse(content) : content };
  };
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const call = (id: string, name: string, input: Json): ModelEvent[] => [
    { type: 'tool_call', id, name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
  const model: ModelAdapter = {
    async *stream() {
      let events: ModelEvent[];
      switch (step++) {
        case 0:
          events = call('create', 'write_file', { path: 'a', content: 'one\ntwo\n' });
          break;
        case 1:
          events = call('read', 'read_file', { path: 'a', max_lines: 1 });
          break;
        case 2:
          events = call('edit', 'edit_file', {
            path: 'a',
            base_ref: (await succeeded('read')).value.base_ref,
            old_text: 'two',
            new_text: 'three',
          });
          break;
        case 3:
          events = call('stale', 'edit_file', {
            path: 'a',
            base_ref: (await succeeded('read')).value.base_ref,
            old_text: 'one',
            new_text: 'WRONG',
          });
          break;
        case 4:
          events = call('overwrite', 'write_file', { path: 'a', content: 'WRONG' });
          break;
        case 5:
          events = call('old-contract', 'write_file', { path: 'a', base: null, content: 'WRONG' });
          break;
        case 6:
          events = call('artifact', 'fixture_publish', {});
          break;
        case 7:
          events = call('copy', 'write_file', {
            path: 'b',
            content_ref: modelReference('artifact', (await succeeded('artifact')).row.id, 0),
          });
          break;
        case 8:
          events = call('wrong-target', 'write_file', {
            path: 'b',
            base_ref: (await succeeded('edit')).value.base_ref,
            content: 'WRONG',
          });
          break;
        case 9:
          events = [finish];
          break;
        case 10:
          events = call('next-run', 'edit_file', {
            path: 'a',
            base_ref: (await succeeded('edit')).value.base_ref,
            old_text: 'three',
            new_text: 'four',
          });
          break;
        default:
          events = [finish];
      }
      for (const event of events) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    permissions: { authorize: async () => ({ allowed: true, revision: 'exact' }) },
    extensions: [
      { id: 'builtin.files', version: '1', apiMajor: 1, tools: createFileTools(files) },
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.publish',
            version: '1',
            model: { name: 'fixture_publish' },
            description: 'Publish immutable text',
            inputSchema: { type: 'object' },
            async execute(_, context) {
              const ref = await context.artifacts!.publish({
                key: 'body',
                content: Buffer.from('full immutable body'),
                mediaType: 'text/plain',
              });
              return { outcome: 'succeeded', content: 'published', artifactRefs: [ref] };
            },
          },
        ],
      },
    ],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await runtime.createSession({
      ...scope,
      commandId: 'create-session',
      workspaceId: 'w',
      title: 'refs',
    });
    for (const commandId of ['first', 'second']) {
      await runtime.submitCommand({
        ...scope,
        commandId,
        request: { kind: 'run.start', content: 'edit accurately' },
      });
      expect((await runtime.waitForCommand(commandId, { timeoutMs: 10000 })).status).toBe(
        'applied',
      );
    }
    const rows = await store.listExecutions('s');
    expect(rows.find((e) => e.callId === 'next-run')).toMatchObject({ status: 'succeeded' });
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('one\nfour\n');
    expect(readFileSync(join(root, 'b'), 'utf8')).toBe('full immutable body');
    for (const id of ['stale', 'overwrite', 'old-contract', 'wrong-target'])
      expect(rows.find((e) => e.callId === id)?.status).toBe('failed');
    expect(rows.filter((e) => e.kind === 'tool' && e.status === 'succeeded')).toHaveLength(6);
    expect((await succeeded('read')).value.baseline.size).toBe(8);
    expect((await succeeded('read')).row).toHaveProperty('resultRevision', '1');
  } finally {
    await runtime.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});
