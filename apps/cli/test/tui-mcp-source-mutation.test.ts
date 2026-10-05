import { expect, test } from 'bun:test';
import type { Command, QueryResponse } from '@kite-ai/client';
import type { TuiMcpSourceMutationIntent, TuiMcpSourceSnapshot } from '@kite-ai/ui/tui';
import { mcpSha } from '../host/mcp-selection-intents';
import {
  createMcpSourceMutationRecord,
  type McpSourceMutationRecord,
} from '../host/mcp-source-mutation-intents';
import type { McpSourceMutationJournal } from '../host/mcp-source-mutation-journal';
import {
  createTuiMcpSourceMutationPort,
  decodeMcpSourceMutationFact,
} from '../host/tui-mcp-source-mutation';

const sha = 'a'.repeat(64);
const observed: TuiMcpSourceSnapshot = {
  storeId: 'store',
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'physical',
  registryRevision: 'r',
  items: [],
  errors: [],
  readSet: {
    scopeDigest: sha,
    user: {
      identity: { kind: 'user', pathDigest: sha, rootIdentity: sha },
      etag: sha,
      error: null,
    },
    workspace: null,
    approvalEtag: null,
    bindingEtag: null,
    variablesDigest: sha,
  },
};
const intent: TuiMcpSourceMutationIntent = {
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'physical',
  request: {
    expectedStoreId: 'store',
    commandId: 'original',
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.add',
    definitionVersion: '1',
    input: {
      scope: 'user',
      name: 'owned',
      entry: { type: 'http', url: 'https://example.invalid/mcp' },
      expectedReadSet: observed.readSet!,
    },
  },
};
function fixture() {
  let http = 0,
    post = 0,
    prepare = 0,
    reads = 0;
  const rows: McpSourceMutationRecord[] = [];
  let failPost = false;
  const server = {
      storeId: 'store',
      subjectId: 'subject',
      instanceId: 'instance',
      buildId: 'build',
      apiMajor: 1,
      capabilities: [],
      profile: { dataRoot: '/owned', name: 'owned', accessKey: 'unused-unit-fixture' },
      dataAvailability: 'available' as const,
    },
    record = createMcpSourceMutationRecord(intent, 'subject');
  const command: Command = {
    id: 'original',
    originStoreId: 'store',
    sessionId: 's',
    subjectId: 'subject',
    kind: 'extension.invoke',
    requestDigest: record.requestSha256,
    status: 'accepted',
    receipt: { executionId: 'exec' },
    cancelRequestedAt: null,
  };
  const fact: Record<string, unknown> = {
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    operation: 'add',
    command: {
      id: 'original',
      originStoreId: 'store',
      sessionId: 's',
      subjectId: 'subject',
      kind: 'extension.invoke',
      requestDigest: record.requestSha256,
      status: 'accepted',
      executionId: 'exec',
    },
    execution: null,
    phase: 'pending',
    mutation: null,
    receipt: null,
    reason: null,
  };
  const response = () =>
    [
      {
        extensionId: 'builtin.mcp.sources',
        contentType: 'builtin.mcp.source.mutation.result',
        contentVersion: 1,
        summary: 'original',
        payload: fact,
        actions: [],
        artifactRefs: [],
      },
    ] as QueryResponse;
  const journal: McpSourceMutationJournal = {
    list: () => structuredClone(rows),
    prepare: (r) => {
      prepare++;
      if (rows.some((x) => x.intent.request.commandId === r.intent.request.commandId)) return false;
      rows.push(r);
      return true;
    },
    record: (r, p) => {
      rows.find((x) => x.intent.request.commandId === r.intent.request.commandId)!.phase = p;
    },
    close: () => {},
  };
  const client = {
    serverInfo: server,
    getCommand: async () => {
      http++;
      return command;
    },
    invokeExtension: async () => {
      expect(rows).toHaveLength(1);
      expect(rows[0]!.phase).toBe('submitting');
      post++;
      http++;
      if (failPost) throw Error('socket_response_lost');
      return command;
    },
    queryExtension: async () => {
      http++;
      return response();
    },
  };
  let snapshot = observed;
  const port = createTuiMcpSourceMutationPort(client, 'store', journal, async () => {
    reads++;
    return snapshot;
  });
  return {
    port,
    server,
    journal,
    record,
    command,
    fact,
    response,
    counts: () => ({ http, post, prepare, reads }),
    fail: () => {
      failPost = true;
    },
    drift: () => {
      snapshot = { ...observed, workspaceIdentity: 'replacement' };
    },
  };
}
test('first durable prepare precedes only POST; same original and cold lookup never prepare or POST again', async () => {
  const f = fixture();
  expect((await f.port.submit(intent, observed)).phase).toBe('pending');
  expect(f.counts()).toEqual({ http: 3, post: 1, prepare: 1, reads: 1 });
  expect((await f.port.submit(intent, observed)).phase).toBe('pending');
  expect(f.counts()).toEqual({ http: 5, post: 1, prepare: 1, reads: 1 });
  await f.port.list();
  expect(f.counts().http).toBe(5);
});
test('lost acceptance remains unknown and only original GET follows; foreign subject/Store reject before all HTTP', async () => {
  const f = fixture();
  f.fail();
  expect((await f.port.submit(intent, observed)).phase).toBe('outcome_unknown');
  expect(f.counts().post).toBe(1);
  await f.port.lookup(intent, new AbortController().signal);
  expect(f.counts().post).toBe(1);
  const before = f.counts().http;
  f.server.storeId = 'foreign';
  await expect(f.port.lookup(intent, new AbortController().signal)).rejects.toThrow();
  expect(f.counts().http).toBe(before);
  f.server.storeId = 'store';
  f.server.subjectId = 'other';
  await expect(f.port.lookup(intent, new AbortController().signal)).rejects.toThrow();
  expect(f.counts().http).toBe(before);
});
test('physical/readSet drift is rejected before publication; malformed closed fact and arrays never coerce enums', async () => {
  const f = fixture();
  f.drift();
  await expect(f.port.submit(intent, observed)).rejects.toThrow();
  expect(f.counts().post).toBe(0);
  const result = f.response();
  expect(decodeMcpSourceMutationFact(result).phase).toBe('pending');
  expect(() =>
    decodeMcpSourceMutationFact([{ ...result[0]!, payload: { ...f.fact, extra: true } }]),
  ).toThrow();
  expect(() =>
    decodeMcpSourceMutationFact([{ ...result[0]!, payload: { ...f.fact, operation: ['add'] } }]),
  ).toThrow();
});
test('original request/hash or projected Command mismatch never upgrades unknown to saved', async () => {
  const f = fixture();
  f.journal.prepare(f.record);
  f.command.requestDigest = 'b'.repeat(64);
  expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe('outcome_unknown');
  expect(f.counts().http).toBe(1);
  expect(f.journal.list()[0]!.phase).toBe('submitting');
});

test('terminal phases cannot release unknown by relabeling a running or succeeded Execution', async () => {
  for (const phase of ['failed', 'cancelled'] as const) {
    const f = fixture();
    f.journal.prepare(f.record);
    f.command.status = 'applied';
    f.command.receipt = { executionId: 'exec', status: 'succeeded', finalizationDigest: sha };
    f.fact.command = { ...(f.fact.command as object), status: 'applied' };
    f.fact.execution = {
      id: 'exec',
      originStoreId: 'store',
      sessionId: 's',
      originCommandId: 'original',
      parentExecutionId: null,
      runId: null,
      kind: 'job',
      definitionId: 'builtin.mcp.sources/mcp.source.add',
      definitionVersion: '1',
      inputDigest: mcpSha(intent.request.input),
      status: 'succeeded',
    };
    f.fact.phase = phase;
    f.fact.reason = 'approval_denied';
    expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.journal.list()[0]!.phase).toBe('submitting');
    f.fact.execution = { ...(f.fact.execution as object), status: phase };
    expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.journal.list()[0]!.phase).toBe('submitting');
    f.command.receipt = {
      executionId: 'exec',
      status: phase,
      preparingNextAttempt: true,
      finalizationDigest: sha,
    };
    expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    f.command.receipt = { executionId: 'exec', status: phase, finalizationDigest: sha };
    expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe(phase);
    expect(f.journal.list()[0]!.phase).toBe(phase);
  }
});
test('saved receipt requires original source identity, marker, etags and independent final public Command', async () => {
  const f = fixture();
  f.journal.prepare(f.record);
  const input = intent.request.input;
  if (!('name' in input)) throw Error('test add required');
  f.command.status = 'applied';
  f.command.receipt = { executionId: 'exec', status: 'succeeded', finalizationDigest: sha };
  f.fact.command = { ...(f.fact.command as object), status: 'applied' };
  f.fact.execution = {
    id: 'exec',
    originStoreId: 'store',
    sessionId: 's',
    originCommandId: 'original',
    parentExecutionId: null,
    runId: null,
    kind: 'job',
    definitionId: 'builtin.mcp.sources/mcp.source.add',
    definitionVersion: '1',
    inputDigest: mcpSha(input),
    status: 'succeeded',
  };
  const target = {
    serverId: `mcp-${mcpSha({ name: input.name })}`,
    name: input.name,
    source: input.expectedReadSet.user.identity,
    rawEntryDigest: mcpSha({
      version: 1,
      name: input.name,
      raw: { ...input.entry, _kiteSourceCreation: { version: 1, operationId: 'exec' } },
    }),
    transport: 'http',
    enabled: true,
    reason: null,
  };
  const receipt = {
    target,
    fallback: null,
    operationId: 'exec',
    kind: 'add',
    oldEtag: sha,
    newEtag: 'b'.repeat(64),
  };
  f.fact.receipt = receipt;
  f.fact.mutation = {
    id: 'mcp-entry-exec',
    originStoreId: 'store',
    subjectId: 'subject',
    kind: 'config.user.write',
    scope: 'user',
    requestDigest: mcpSha({
      version: 1,
      executionId: 'exec',
      originCommandId: 'original',
      originalStoreId: 'store',
      sessionId: 's',
      workspaceId: 'w',
      actionId: 'mcp.source.add',
      inputDigest: mcpSha(input),
    }),
    state: 'applied',
    etag: receipt.newEtag,
  };
  f.fact.phase = 'saved';
  for (const invalidReceipt of [
    { ...receipt, oldEtag: 'c'.repeat(64) },
    { ...receipt, newEtag: sha },
    { ...receipt, target: { ...target, source: { ...target.source, pathDigest: 'c'.repeat(64) } } },
    { ...receipt, target: { ...target, rawEntryDigest: sha } },
    { ...receipt, target: { ...target, serverId: `mcp-${sha}` } },
    { ...receipt, fallback: target },
  ]) {
    f.fact.receipt = invalidReceipt;
    expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    expect(f.journal.list()[0]!.phase).toBe('submitting');
  }
  f.fact.receipt = receipt;
  f.command.receipt = { executionId: 'exec', status: 'failed', finalizationDigest: sha };
  expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe('outcome_unknown');
  f.command.receipt = { executionId: 'exec', status: 'succeeded', finalizationDigest: sha };
  expect((await f.port.lookup(intent, new AbortController().signal)).phase).toBe('saved');
  expect(f.journal.list()[0]!.phase).toBe('saved');
});
