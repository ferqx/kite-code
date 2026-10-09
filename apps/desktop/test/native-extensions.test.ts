import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  AgentClient,
  Command,
  Execution,
  ExtensionCatalogue,
  ExtensionCommandRequest,
  PublicView,
} from '@kite-ai/client';
import {
  callerTextDigest,
  canonicalNativeCallerRequest,
  NativeCallerJournal,
} from '../electron/caller-journal';
import { NativeExtensions } from '../electron/extensions';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { NativeExtensionScope } from '../src/extensions-bridge';
import { memoryPrivateData } from './private-data.fixture';

function fixture() {
  let scope: NativeExtensionScope | undefined = {
    generation: 1,
    viewSelection: 1,
    historyEpoch: 1,
    storeId: 'store',
    sessionId: 'session',
    workspaceId: 'workspace',
    contextSelectionId: 'context',
  };
  let posts = 0,
    gets = 0,
    commands = 0,
    drop = false;
  const catalogue: ExtensionCatalogue[] = [
    {
      extensionId: 'fixture.example',
      version: '1',
      actions: [
        { id: 'analyze', version: '1', description: 'Analyze', inputSchema: { type: 'object' } },
        { id: 'mark', version: '2', description: 'Mark', inputSchema: { type: 'object' } },
      ],
      queries: [
        { id: 'results', version: '1', description: 'Read', inputSchema: { type: 'object' } },
      ],
    },
  ];
  let views: PublicView[] = [
    {
      extensionId: 'fixture.example',
      contentType: 'example.findings',
      contentVersion: 1,
      summary: 'Findings',
      payload: { body: '完整雪🙂'.repeat(20000) },
      artifactRefs: [],
      actions: [
        {
          actionId: 'mark',
          definitionVersion: '2',
          label: 'Mark original',
          input: { key: 'original', revision: '3' },
        },
      ],
    },
  ];
  let original: Command | undefined;
  const execution: Execution = {
    id: 'execution',
    originStoreId: 'store',
    sessionId: 'session',
    runId: null,
    parentExecutionId: null,
    kind: 'job',
    definitionId: 'fixture.example/analyze',
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
    result: { content: 'complete', details: { extra: 'large'.repeat(50000) } },
    cancelRequestedAt: null,
  };
  const data = memoryPrivateData();
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'local-user' },
    async listExtensions() {
      gets++;
      return structuredClone(catalogue);
    },
    async queryExtension() {
      gets++;
      return structuredClone(views);
    },
    async getView(id: string) {
      gets++;
      return {
        storeId: 'store',
        session: {
          id,
          workspaceId: 'workspace',
          parentSessionId: null,
          rootSessionId: id,
          deletedAt: null,
          contextSelectionId: 'context',
        },
        runs: [],
        executions: [],
        messages: [],
      };
    },
    async getCommand() {
      gets++;
      return structuredClone(original);
    },
    async getExecution() {
      gets++;
      return structuredClone(execution);
    },
    async invokeExtension(sessionId: string, request: ExtensionCommandRequest) {
      posts++;
      commands++;
      execution.definitionId = `${request.extensionId}/${request.actionId}`;
      execution.definitionVersion = request.definitionVersion;
      original = {
        id: request.commandId,
        kind: 'extension.invoke',
        originStoreId: request.expectedStoreId,
        sessionId,
        subjectId: 'local-user',
        requestDigest: callerTextDigest(canonicalNativeCallerRequest(request)),
        status: 'applied',
        cancelRequestedAt: null,
        receipt: {
          executionId: 'execution',
          status: 'succeeded',
          preparingNextAttempt: false,
          finalizationDigest: 'f'.repeat(64),
        },
      } as Command;
      if (drop) throw Error('reply_lost');
      return structuredClone(original);
    },
  } as unknown as AgentClient;
  const journal = new NativeCallerJournal(client, data);
  const extensions = new NativeExtensions(client, () => scope, journal);
  const open = () =>
    extensions.open({
      method: 'extensions.open' as const,
      generation: 1,
      readId: 'catalogue',
      viewSelection: 1,
      historyEpoch: 1,
    });
  function consume(readId: string) {
    const buffers: Buffer[] = [];
    let offset = 0;
    while (true) {
      const chunk = extensions.read({
        method: 'extensions.read' as const,
        generation: 1,
        readId,
        offset,
        limit: 65536,
      });
      buffers.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    return Buffer.concat(buffers);
  }
  const invoke = (observationId: number, commandId = 'command') => ({
    method: 'extensions.invoke' as const,
    generation: 1,
    observationId,
    commandId,
    extensionId: 'fixture.example',
    actionId: 'analyze',
    definitionVersion: '1',
    input: { key: 'original' },
  });
  return {
    client,
    data,
    journal,
    extensions,
    open,
    consume,
    invoke,
    catalogue,
    get scope() {
      return scope;
    },
    set scope(value) {
      scope = value;
    },
    get posts() {
      return posts;
    },
    get gets() {
      return gets;
    },
    get commands() {
      return commands;
    },
    set drop(value: boolean) {
      drop = value;
    },
    get original() {
      return original!;
    },
    get execution() {
      return execution;
    },
    set views(value: PublicView[]) {
      views = value;
    },
  };
}

test('Native public extension reads complete immutable bodies, persists one action and cold checks only its original receipt', async () => {
  const f = fixture();
  f.catalogue[0]!.actions[0]!.description = '目录雪🙂'.repeat(20000);
  const head = await f.open();
  await expect(f.extensions.invoke(f.invoke(head.observationId))).rejects.toThrow(
    'extensions_observation_unavailable',
  );
  expect(f.posts).toBe(0);
  const body = f.consume(head.readId);
  expect(body.length).toBe(head.bodyBytes);
  expect(createHash('sha256').update(body).digest('hex')).toBe(head.sha256);
  expect(JSON.parse(body.toString())).toEqual(f.catalogue);
  f.extensions.close(head.readId);
  const result = await f.extensions.invoke(f.invoke(head.observationId));
  expect(result.outcome).toBe('succeeded');
  expect(result.execution).toEqual({ id: 'execution', status: 'succeeded', resultRevision: '1' });
  expect(JSON.stringify(result)).not.toContain('large');
  expect(f.posts).toBe(1);
  expect(f.data.callers()[0]!.intent.request.kind).toBe('extension.invoke');
  await f.extensions.lookup('command');
  await f.extensions.invoke(f.invoke(head.observationId));
  expect(f.posts).toBe(1);
  const cold = new NativeCallerJournal(f.client, f.data);
  await cold.submit('command');
  expect(f.posts).toBe(1);
  f.original.requestDigest = '0'.repeat(64);
  expect((await f.extensions.lookup('command')).outcome).toBe('unknown');
  expect(f.posts).toBe(1);
  const before = f.gets;
  f.client.serverInfo!.storeId = 'restored';
  expect((await f.extensions.lookup('command')).outcome).toBe('unknown');
  expect(f.gets).toBe(before);
  expect(f.posts).toBe(1);
});

test('Native result actions bind exact observed indices, version and complete input; refresh revokes old authority', async () => {
  const f = fixture(),
    head = await f.open();
  f.consume(head.readId);
  const result = await f.extensions.query({
    method: 'extensions.query' as const,
    generation: 1,
    readId: 'views',
    observationId: head.observationId,
    extensionId: 'fixture.example',
    queryId: 'results',
    input: {},
  });
  const bytes = f.consume(result.readId);
  expect(bytes.length).toBeGreaterThan(65536);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256);
  f.extensions.close(result.readId);
  const action = {
    ...f.invoke(result.observationId),
    actionId: 'mark',
    definitionVersion: '2',
    viewIndex: 0,
    actionIndex: 0,
    input: { key: 'original', revision: '3' },
  };
  await expect(
    f.extensions.invoke({ ...action, input: { key: 'original', revision: '4' } }),
  ).rejects.toThrow();
  await expect(f.extensions.invoke({ ...action, viewIndex: 1 })).rejects.toThrow();
  expect(f.posts).toBe(0);
  expect((await f.extensions.invoke(action)).outcome).toBe('succeeded');
  expect(f.posts).toBe(1);
  await f.open();
  await expect(f.extensions.invoke({ ...action, commandId: 'other' })).rejects.toThrow();
  expect(f.posts).toBe(1);
});

test('Native action scope changing after durable prepare revokes first POST permission and preserves its original unknown intent', async () => {
  const f = fixture();
  const extensions = new NativeExtensions(f.client, () => f.scope, {
    prepare: async (sessionId, request) => {
      const row = await f.journal.prepare(sessionId, request);
      f.scope = { ...f.scope!, viewSelection: 2 };
      return row;
    },
    submit: (id) => f.journal.submit(id),
    lookup: (id) => f.journal.lookup(id),
    records: () => f.journal.records(),
    releaseFirst: (id) => f.journal.releaseFirst(id),
  });
  const head = await extensions.open({
    method: 'extensions.open' as const,
    generation: 1,
    readId: 'catalogue',
    viewSelection: 1,
    historyEpoch: 1,
  });
  extensions.read({
    method: 'extensions.read' as const,
    generation: 1,
    readId: 'catalogue',
    offset: 0,
    limit: 65536,
  });
  await expect(extensions.invoke(f.invoke(head.observationId))).rejects.toThrow();
  expect(f.posts).toBe(0);
  expect(f.data.callers()).toHaveLength(1);
  await expect(f.journal.submit('command')).rejects.toThrow();
  expect(f.posts).toBe(0);
  expect(f.data.callers()[0]!.phase).toBe('unknown');
});

test('Native lost action reply checks the exact saved command without redoing; unknown and next-attempt outcomes stay unresolved', async () => {
  const f = fixture(),
    head = await f.open();
  f.consume(head.readId);
  f.drop = true;
  expect((await f.extensions.invoke(f.invoke(head.observationId))).outcome).toBe('unknown');
  expect(f.posts).toBe(1);
  expect((await f.extensions.lookup('command')).outcome).toBe('succeeded');
  f.execution.status = 'outcome_unknown';
  f.original.receipt = {
    executionId: 'execution',
    status: 'outcome_unknown',
    preparingNextAttempt: false,
    finalizationDigest: 'a'.repeat(64),
  };
  expect((await f.extensions.lookup('command')).outcome).toBe('unknown');
  await expect(f.journal.clear('command')).rejects.toThrow('caller_clear_unconfirmed');
  expect(f.data.callers()).toHaveLength(1);
  f.execution.status = 'failed';
  f.original.receipt = {
    executionId: 'execution',
    status: 'failed',
    preparingNextAttempt: true,
    finalizationDigest: 'a'.repeat(64),
  };
  expect((await f.extensions.lookup('command')).outcome).toBe('unknown');
  f.extensions.release();
  expect((await f.extensions.lookup('command')).outcome).toBe('unknown');
  expect(f.posts).toBe(1);
  await expect(f.journal.clear('command')).rejects.toThrow('caller_clear_unconfirmed');
  expect(f.data.callers()).toHaveLength(1);
  f.original.receipt = {
    executionId: 'execution',
    status: 'failed',
    preparingNextAttempt: false,
    finalizationDigest: 'a'.repeat(64),
  };
  await f.journal.clear('command');
  expect(f.data.callers()).toHaveLength(0);
  expect(f.posts).toBe(1);
});

test('closing a Native body aborts only its GET and rejects delayed data; query provenance and body capacity fail closed', async () => {
  const f = fixture();
  let release!: (value: ExtensionCatalogue[]) => void, signal: AbortSignal | undefined;
  f.client.listExtensions = async (options) => {
    signal = options?.signal;
    return await new Promise<ExtensionCatalogue[]>((resolve) => {
      release = resolve;
    });
  };
  const opening = f.open();
  f.extensions.close('catalogue');
  expect(signal?.aborted).toBe(true);
  release(f.catalogue);
  await expect(opening).rejects.toThrow();
  expect(f.posts).toBe(0);
  f.client.listExtensions = async () => structuredClone(f.catalogue);
  const head = await f.open();
  f.consume(head.readId);
  const query = {
    method: 'extensions.query' as const,
    generation: 1,
    readId: 'views',
    observationId: head.observationId,
    extensionId: 'fixture.example',
    queryId: 'results',
    input: {},
  };
  const original = await f.extensions.query(query);
  f.consume(original.readId);
  await expect(f.extensions.query({ ...query, readId: 'third' })).rejects.toThrow(
    'extensions_read_capacity_exceeded',
  );
  // A rejected allocation does not revoke the complete prior observation.
  const result = await f.extensions.invoke({
    ...f.invoke(original.observationId),
    actionId: 'mark',
    definitionVersion: '2',
    viewIndex: 0,
    actionIndex: 0,
    input: { key: 'original', revision: '3' },
  });
  expect(result.outcome).toBe('succeeded');
  f.extensions.close('views');
  f.views = [
    {
      extensionId: 'another.extension',
      contentType: 'unknown',
      contentVersion: 1,
      summary: 'foreign',
      payload: null,
      artifactRefs: [],
      actions: [],
    },
  ];
  await expect(f.extensions.query(query)).rejects.toThrow('extensions_result_scope_mismatch');
  expect(f.posts).toBe(1);
});

test('Native extension IPC admits only its seven closed methods, exact scalars and coordinates, and the public small GET input boundary', () => {
  const open = {
    method: 'extensions.open' as const,
    generation: 1,
    readId: 'read',
    viewSelection: 1,
    historyEpoch: 0,
  };
  const query = {
    method: 'extensions.query' as const,
    generation: 1,
    readId: 'query',
    observationId: 1,
    extensionId: 'independent.extension',
    queryId: 'results',
    input: {},
  };
  const read = {
    method: 'extensions.read' as const,
    generation: 1,
    readId: 'read',
    offset: 0,
    limit: 65536,
  };
  const invoke = {
    method: 'extensions.invoke' as const,
    generation: 1,
    observationId: 1,
    commandId: 'command',
    extensionId: 'independent.extension',
    actionId: 'analyze',
    definitionVersion: '2026.10+preview',
    input: { body: '雪🙂' },
  };
  const requests = [
    open,
    query,
    read,
    { method: 'extensions.close' as const, generation: 1, readId: 'read' },
    { method: 'extensions.release' as const, generation: 1 },
    invoke,
    { method: 'extensions.lookup' as const, generation: 1, commandId: 'command' },
  ];
  for (const request of requests) {
    expect(decodeNativeRequest(request)).toEqual(request);
    expect(() => decodeNativeRequest({ ...request, authority: 'renderer-supplied' })).toThrow(
      'invalid_native_request',
    );
    expect(() => decodeNativeRequest({ ...request, generation: '1' })).toThrow(
      'invalid_native_request',
    );
  }
  const invalid: unknown[] = [
    { ...open, readId: '../profile' },
    { ...open, viewSelection: -1 },
    { ...open, historyEpoch: 0.5 },
    { ...open, historyEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...query, observationId: '1' },
    { ...query, queryId: '../unsafe' },
    { ...query, input: undefined },
    { ...query, input: Number.NaN },
    { ...read, offset: -1 },
    { ...read, offset: 0.5 },
    { ...read, offset: Number.MAX_SAFE_INTEGER + 1 },
    { ...read, limit: 0 },
    { ...read, limit: 65537 },
    { ...read, limit: '65536' },
    { ...invoke, commandId: '../command' },
    { ...invoke, extensionId: '../extension' },
    { ...invoke, definitionVersion: 1 },
    { ...invoke, input: undefined },
    { ...invoke, viewIndex: 0 },
    { ...invoke, actionIndex: 0 },
    { ...invoke, viewIndex: -1, actionIndex: 0 },
    { ...invoke, viewIndex: 0, actionIndex: 0.5 },
    { ...invoke, viewIndex: '0', actionIndex: 0 },
    { method: 'extensions.lookup' as const, generation: 1, commandId: 7 },
    { method: 'extensions.close' as const, generation: 1, readId: null },
  ];
  for (const request of invalid)
    expect(() => decodeNativeRequest(request)).toThrow('invalid_native_request');
  expect(decodeNativeRequest({ ...invoke, viewIndex: 0, actionIndex: 0 })).toEqual({
    ...invoke,
    viewIndex: 0,
    actionIndex: 0,
  });
  const atLimit = 'a'.repeat(8186);
  expect(encodeURIComponent(JSON.stringify(atLimit)).length).toBe(8192);
  expect(decodeNativeRequest({ ...query, input: atLimit })).toEqual({ ...query, input: atLimit });
  expect(() => decodeNativeRequest({ ...query, input: `${atLimit}a` })).toThrow(
    'invalid_native_request',
  );
  expect(() => decodeNativeRequest({ ...query, input: '雪'.repeat(910) })).toThrow(
    'invalid_native_request',
  );
  expect(() =>
    decodeNativeRequest({
      method: 'caller.prepare',
      generation: 1,
      sessionId: 'session',
      intent: {
        kind: 'extension.invoke',
        commandId: 'command',
        expectedStoreId: 'store',
        extensionId: 'independent.extension',
        actionId: 'analyze',
        definitionVersion: '1',
        input: {},
      },
    }),
  ).toThrow('invalid_native_request');
  expect(
    decodeNativeRequest({ method: 'caller.submit', generation: 1, commandId: 'command' }),
  ).toEqual({ method: 'caller.submit', generation: 1, commandId: 'command' });
  expect(() =>
    decodeNativeRequest({
      method: 'caller.submit',
      generation: 1,
      commandId: 'command',
      intent: invoke,
    }),
  ).toThrow('invalid_native_request');
  // The shared canonical helper also understands four Auth actions; that is not a generic Native caller permission.
  const readSet = {
    scopeDigest: 'a'.repeat(64),
    user: {
      identity: { kind: 'user', pathDigest: 'b'.repeat(64), rootIdentity: 'c'.repeat(64) },
      etag: null,
      error: null,
    },
    workspace: null,
    approvalEtag: null,
    bindingEtag: null,
    variablesDigest: 'd'.repeat(64),
  };
  expect(() =>
    decodeNativeRequest({
      method: 'caller.prepare',
      generation: 1,
      sessionId: 'session',
      intent: {
        kind: 'extension.invoke',
        commandId: 'auth-command',
        expectedStoreId: 'store',
        extensionId: 'builtin.mcp.sources',
        actionId: 'mcp.auth.login',
        definitionVersion: '1',
        input: { serverId: 'server', expectedReadSet: readSet },
      },
    }),
  ).toThrow('invalid_native_request');
});
