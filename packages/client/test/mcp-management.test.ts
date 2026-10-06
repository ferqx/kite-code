import { describe, expect, test } from 'bun:test';
import {
  canonicalCallerCommandRequest,
  canonicalMcpCommandRequest,
  canonicalModelBody,
  decodeMcpAuthResult,
  decodeMcpAuthStatus,
  decodeMcpConnectionFact,
  decodeMcpManagementSnapshot,
  decodeMcpReconnectionFact,
  decodeMcpSourceMutationResult,
  decodeMcpSourceResult,
  decodeMcpSourcesPage,
  type McpCommandRequest,
  type QueryResponse,
  validateMcpCommandRequest,
} from '../src';

const hash = 'a'.repeat(64),
  serverId = `mcp-${hash}`;
const identity = { kind: 'user', pathDigest: hash, rootIdentity: hash };
const readSet = {
  scopeDigest: hash,
  user: { identity, etag: hash, error: null },
  workspace: null,
  approvalEtag: hash,
  bindingEtag: null,
  variablesDigest: hash,
};
const selection = {
  userEtag: hash,
  workspaceEtag: null,
  explicitDigest: hash,
  registryDigest: hash,
  registryRevision: 'registry-v1',
  scopeDigest: hash,
};
const scope = { storeId: 'store', sessionId: 'session' };
const execution = {
  id: 'action-execution',
  originStoreId: 'store',
  sessionId: 'session',
  originCommandId: 'command',
  parentExecutionId: null,
  kind: 'job',
  definitionId: 'builtin.mcp/mcp.connect',
  definitionVersion: '1',
  status: 'running',
  inputDigest: hash,
};
const command = {
  id: 'command',
  originStoreId: 'store',
  sessionId: 'session',
  subjectId: 'subject',
  kind: 'extension.invoke',
  requestDigest: hash,
  status: 'applied',
  executionId: execution.id,
};
const target = {
  carrierExecutionId: 'old-carrier',
  carrierKey: 'old',
  operationRef: {
    commandId: 'old-command',
    sessionId: 'session',
    originStoreId: 'store',
    extensionId: 'builtin.mcp',
    key: `connection/${serverId}/old`,
    executionId: 'old-connection',
  },
  connectionExecutionId: 'old-connection',
  configDigest: hash,
  currentGeneration: 7,
};
function display(extensionId: string, contentType: string, payload: unknown): QueryResponse {
  return [
    {
      extensionId,
      contentType,
      contentVersion: 1,
      summary: 'MCP fact',
      payload,
      actions: [],
      artifactRefs: [],
    },
  ] as QueryResponse;
}
const fixtures = [
  [
    decodeMcpManagementSnapshot,
    display('builtin.mcp.management', 'builtin.mcp.servers', {
      ...scope,
      workspaceId: 'workspace',
      workspaceIdentity: 'physical identity',
      workspacePath: '/workspace',
      registryRevision: selection.registryRevision,
      readSet: selection,
      items: [
        {
          id: 'static',
          configDigest: hash,
          transport: 'stdio',
          source: { kind: 'programmatic', id: 'host', revision: 'v1' },
          admitted: true,
          selected: true,
          available: true,
          reason: null,
        },
      ],
    }),
  ],
  [
    decodeMcpSourcesPage,
    display('builtin.mcp.sources', 'builtin.mcp.sources', {
      items: [
        {
          id: serverId,
          name: 'example',
          source: identity,
          rawEntryDigest: hash,
          transportDigest: hash,
          transport: 'http',
          enabled: true,
          admitted: true,
          reason: null,
          configDigest: hash,
        },
      ],
      nextAfterId: serverId,
      readSet,
      registryRevision: hash,
      errors: { user: null, workspace: null, approval: null, binding: null },
    }),
  ],
  [
    decodeMcpConnectionFact,
    display('builtin.mcp', 'builtin.mcp.connection', {
      ...scope,
      execution,
      phase: 'pending',
      operationRef: null,
      connection: null,
      ready: null,
      live: false,
      currentGeneration: null,
      created: null,
      reason: null,
    }),
  ],
  [
    decodeMcpReconnectionFact,
    display('builtin.mcp', 'builtin.mcp.reconnection', {
      ...scope,
      execution: { ...execution, definitionId: 'builtin.mcp/mcp.reconnect' },
      phase: 'pending',
      target,
      oldStop: { confirmed: false, execution: null },
      newOperationRef: null,
      newConnection: null,
      ready: null,
      live: false,
      currentGeneration: null,
      reason: null,
    }),
  ],
  [
    decodeMcpSourceResult,
    display('builtin.mcp.sources', 'builtin.mcp.source.result', {
      ...scope,
      command,
      execution: { ...execution, definitionId: 'builtin.mcp.sources/mcp.source.approve' },
      serverId,
      phase: 'pending',
      decision: null,
      proof: null,
      mutation: null,
      recordKey: null,
      reason: null,
    }),
  ],
  [
    decodeMcpSourceMutationResult,
    display('builtin.mcp.sources', 'builtin.mcp.source.mutation.result', {
      ...scope,
      workspaceId: 'workspace',
      operation: 'remove',
      command,
      execution: {
        ...execution,
        runId: null,
        definitionId: 'builtin.mcp.sources/mcp.source.remove',
      },
      phase: 'pending',
      mutation: null,
      receipt: null,
      reason: null,
      credentialCleanup: { status: 'not_attempted', attempted: false },
    }),
  ],
  [
    decodeMcpAuthStatus,
    display('builtin.mcp.sources', 'builtin.mcp.auth.status', {
      serverId,
      workspaceId: 'workspace',
      loginAllowed: true,
      policy: 'oauth',
      status: 'available',
      credentialPresent: false,
    }),
  ],
  [
    decodeMcpAuthResult,
    display('builtin.mcp.sources', 'builtin.mcp.auth.result', {
      ...scope,
      command: { ...command, kind: undefined },
      execution: { ...execution, definitionId: 'builtin.mcp.sources/mcp.auth.login' },
      binding: {
        version: 1,
        executionId: execution.id,
        originCommandId: 'command',
        originalStoreId: 'store',
        sessionId: 'session',
        workspaceId: 'workspace',
        actionId: 'mcp.auth.login',
        serverId,
        inputDigest: hash,
      },
      phase: 'completed',
      authStatus: 'authenticated',
      effectAttempted: true,
      reason: null,
    }),
  ],
] as const;
// Auth's producer intentionally does not publish Command.kind.
delete payload(fixtures[7][1]).command.kind;
type MutablePayload = Record<string, unknown> & {
  command: Record<string, unknown>;
  execution: Record<string, unknown>;
  binding: Record<string, unknown>;
  credentialCleanup: Record<string, unknown>;
  connection: Record<string, unknown>;
  proof: Record<string, unknown>;
  oldStop: { execution: Record<string, unknown> };
};
function payload(r: QueryResponse): MutablePayload {
  return r[0]!.payload as unknown as MutablePayload;
}
function request(extensionId: string, actionId: string, input: unknown): McpCommandRequest {
  return {
    expectedStoreId: 'store',
    commandId: 'new-command',
    kind: 'extension.invoke',
    extensionId,
    actionId,
    definitionVersion: '1',
    input,
  } as McpCommandRequest;
}
const requests = [
  request('builtin.mcp.management', 'mcp.server.select', {
    serverId: 'static',
    enabled: true,
    scope: 'user',
    expectedReadSet: selection,
  }),
  request('builtin.mcp', 'mcp.connect', { serverId, key: 'new' }),
  request('builtin.mcp', 'mcp.catalogue.refresh', {
    serverId,
    connectionKey: 'old',
    connectionExecutionId: 'old-connection',
    configDigest: hash,
    generation: 7,
  }),
  request('builtin.mcp', 'mcp.reconnect', {
    serverId,
    key: 'new',
    target,
    replacement: { kind: 'source', expectedConfigDigest: hash, expectedReadSet: readSet },
  }),
  request('builtin.mcp.sources', 'mcp.source.approve', { serverId, expectedReadSet: readSet }),
  request('builtin.mcp.sources', 'mcp.credential.bind', {
    serverId,
    expectedReadSet: readSet,
    expiresAt: 123456,
  }),
  request('builtin.mcp.sources', 'mcp.source.add', {
    scope: 'user',
    name: 'example',
    entry: { type: 'http', url: 'https://example.test/mcp' },
    expectedReadSet: readSet,
  }),
  request('builtin.mcp.sources', 'mcp.source.remove', {
    scope: 'user',
    serverId,
    expectedRawEntryDigest: hash,
    expectedReadSet: readSet,
  }),
  ...['login', 'refresh', 'clear', 'revoke'].map((a) =>
    request('builtin.mcp.sources', `mcp.auth.${a}`, { serverId, expectedReadSet: readSet }),
  ),
];
describe('closed browser-safe MCP contracts', () => {
  for (const [decode, fixture] of fixtures) {
    test(`${decode.name} preserves real DTO and rejects envelope/secret/type changes`, () => {
      expect(decode(fixture) as unknown).toEqual(fixture[0]!.payload);
      for (const change of [
        (v: QueryResponse) => v.push(v[0]!),
        (v: QueryResponse) => {
          v[0]!.actions.push({} as never);
        },
        (v: QueryResponse) => {
          (v[0] as unknown as Record<string, unknown>).secret = 'hidden';
        },
        (v: QueryResponse) => {
          payload(v).secret = 'hidden';
        },
        (v: QueryResponse) => {
          v[0]!.contentVersion = 2;
        },
        (v: QueryResponse) => {
          v[0]!.summary = '界'.repeat(100000);
        },
      ]) {
        const bad = structuredClone(fixture);
        change(bad);
        expect(() => decode(bad)).toThrow();
      }
    });
  }
  test('all twelve fixed actions preserve original canonical request and clone', () => {
    for (const r of requests) {
      const validated = validateMcpCommandRequest(r);
      expect(validated).toEqual(r);
      expect(validated).not.toBe(r);
      const { expectedStoreId: _store, commandId: _command, ...core } = r;
      expect(canonicalMcpCommandRequest(r)).toBe(canonicalModelBody(core));
      expect(() => validateMcpCommandRequest({ ...r, secret: 'hidden' })).toThrow();
      expect(() =>
        validateMcpCommandRequest({ ...r, input: { ...r.input, secret: 'hidden' } }),
      ).toThrow();
      expect(() => validateMcpCommandRequest({ ...r, definitionVersion: 1 })).toThrow();
      expect(() =>
        validateMcpCommandRequest({ ...r, extensionId: 'arbitrary.extension' }),
      ).toThrow();
    }
    for (const r of requests.slice(-4))
      expect(canonicalMcpCommandRequest(r)).toBe(
        canonicalCallerCommandRequest(r as Parameters<typeof canonicalCallerCommandRequest>[0]),
      );
  });
  test('enum coercion, incorrect source readset, raw secrets and exact reconnect identity are rejected', () => {
    const r = requests[3]!;
    const input = r.input as unknown as Record<string, unknown> & {
      replacement: Record<string, unknown>;
    };
    for (const changed of [
      { ...input, target: { ...target, connectionExecutionId: 'other' } },
      { ...input, key: 'old' },
      {
        ...input,
        target: { ...target, operationRef: { ...target.operationRef, originStoreId: 'other' } },
      },
      { ...input, replacement: { ...input.replacement, expectedReadSet: selection } },
    ])
      expect(() => validateMcpCommandRequest({ ...r, input: changed })).toThrow();
    expect(() =>
      validateMcpCommandRequest({
        ...requests[5],
        input: { ...requests[5]!.input, token: 'secret' },
      }),
    ).toThrow();
    expect(() =>
      validateMcpCommandRequest(
        request('builtin.mcp.sources', 'mcp.source.add', {
          scope: 'user',
          name: 'x',
          entry: { type: 'http', url: 'https://user:secret@example.test/mcp' },
          expectedReadSet: readSet,
        }),
      ),
    ).toThrow();
    const mutation = structuredClone(fixtures[5][1]);
    payload(mutation).credentialCleanup.status = { toString: () => 'completed' };
    expect(() => decodeMcpSourceMutationResult(mutation)).toThrow();
    const auth = structuredClone(fixtures[7][1]);
    payload(auth).authStatus = true;
    expect(() => decodeMcpAuthResult(auth)).toThrow();
  });
  test('historical Source/Auth never rebind Store, Session, Command, execution or binding', () => {
    for (const index of [4, 5, 7]) {
      const [decode, fixture] = fixtures[index]!;
      for (const changed of ['originStoreId', 'sessionId', 'originCommandId']) {
        const bad = structuredClone(fixture);
        payload(bad).execution[changed] = 'foreign';
        expect(() => decode(bad)).toThrow();
      }
    }
    const bad = structuredClone(fixtures[7][1]);
    payload(bad).binding.inputDigest = 'b'.repeat(64);
    expect(() => decodeMcpAuthResult(bad)).toThrow();
  });
  test('source pagination and no-readSet unavailable page remain explicit', () => {
    expect(
      decodeMcpSourcesPage(
        display('builtin.mcp.sources', 'builtin.mcp.sources', {
          items: [],
          nextAfterId: null,
          readSet: null,
          registryRevision: null,
          errors: ['source_unavailable'],
        }),
      ).readSet,
    ).toBeNull();
    const bad = structuredClone(fixtures[1][1]);
    payload(bad).nextAfterId = `mcp-${'b'.repeat(64)}`;
    expect(() => decodeMcpSourcesPage(bad)).toThrow();
  });
});

test('ready connection and reconnection retain original generation, stopped revision and exact job', () => {
  const job = {
    id: 'old-connection',
    originStoreId: 'store',
    sessionId: 'session',
    originCommandId: 'old-command',
    parentExecutionId: 'old-carrier',
    kind: 'job',
    definitionId: 'mcp.source.connection',
    definitionVersion: '1',
    status: 'running',
  };
  const ready = { serverId, configDigest: hash, generation: 7, toolCount: 40 };
  const c = structuredClone(fixtures[2][1]);
  Object.assign(payload(c), {
    phase: 'ready',
    operationRef: target.operationRef,
    connection: job,
    ready,
    live: true,
    currentGeneration: 8,
    created: false,
  });
  expect(decodeMcpConnectionFact(c).ready?.generation).toBe(7);
  const bad = structuredClone(c);
  payload(bad).connection.originCommandId = 'foreign';
  expect(() => decodeMcpConnectionFact(bad)).toThrow();
  const r = structuredClone(fixtures[3][1]);
  Object.assign(payload(r), {
    phase: 'ready',
    oldStop: {
      confirmed: true,
      execution: { ...job, status: 'succeeded', resultRevision: '9007199254740993' },
    },
    newOperationRef: {
      ...target.operationRef,
      commandId: 'command',
      executionId: 'new-connection',
      key: `connection/${serverId}/new`,
    },
    newConnection: {
      ...job,
      id: 'new-connection',
      originCommandId: 'command',
      parentExecutionId: execution.id,
    },
    ready,
    live: false,
    currentGeneration: null,
  });
  expect(decodeMcpReconnectionFact(r).oldStop.execution?.resultRevision).toBe('9007199254740993');
  for (const revision of ['0', '9223372036854775808', 9]) {
    const v = structuredClone(r);
    payload(v).oldStop.execution.resultRevision = revision;
    expect(() => decodeMcpReconnectionFact(v)).toThrow();
  }
  const staticRequest = structuredClone(requests[3]!);
  (staticRequest.input as unknown as Record<string, unknown>).replacement = {
    kind: 'static',
    expectedConfigDigest: hash,
  };
  expect(validateMcpCommandRequest(staticRequest)).toEqual(staticRequest);
});

test('saved source declarations and cleanup remain separate original facts', () => {
  const targetDeclaration = {
    serverId,
    name: 'example',
    source: identity,
    rawEntryDigest: hash,
    transport: 'http',
    enabled: true,
    reason: null,
  };
  const mutation = {
    id: 'mutation',
    originStoreId: 'store',
    subjectId: 'subject',
    kind: 'config.user.write',
    scope: 'user',
    requestDigest: hash,
    state: 'applied',
    etag: hash,
  };
  const remove = structuredClone(fixtures[5][1]);
  Object.assign(payload(remove), {
    phase: 'saved',
    mutation,
    receipt: {
      target: targetDeclaration,
      fallback: null,
      operationId: 'operation',
      kind: 'remove',
      oldEtag: hash,
      newEtag: hash,
    },
    credentialCleanup: { status: 'failed', attempted: true },
  });
  expect(decodeMcpSourceMutationResult(remove).credentialCleanup).toEqual({
    status: 'failed',
    attempted: true,
  });
  const workspaceRemove = structuredClone(remove);
  const workspaceMutation = {
    ...mutation,
    kind: 'config.workspace.write',
    scope: 'workspace-actual',
  };
  Object.assign(payload(workspaceRemove), {
    workspaceId: 'workspace-actual',
    mutation: workspaceMutation,
  });
  expect(decodeMcpSourceMutationResult(workspaceRemove).mutation?.scope).toBe('workspace-actual');
  for (const invalidScope of [
    'workspace',
    'foreign-workspace',
    'user',
    null,
    ['workspace-actual'],
  ]) {
    const badScope = structuredClone(workspaceRemove);
    payload(badScope).mutation = { ...workspaceMutation, scope: invalidScope };
    expect(() => decodeMcpSourceMutationResult(badScope)).toThrow();
  }
  const approve = structuredClone(fixtures[4][1]);
  Object.assign(payload(approve), {
    phase: 'saved',
    decision: 'approved',
    mutation,
    recordKey: hash,
    proof: {
      decisionId: 'interaction@1',
      storeId: 'store',
      sessionId: 'session',
      interactionId: 'interaction',
      acceptedRevision: '1',
      subjectId: 'subject',
      requestDigest: 'b'.repeat(64),
      recordedAt: 1234,
    },
  });
  expect(decodeMcpSourceResult(approve).decision).toBe('approved');
  const bad = structuredClone(approve);
  payload(bad).proof.storeId = 'foreign';
  expect(() => decodeMcpSourceResult(bad)).toThrow();
  const stdio = structuredClone(requests[6]!);
  (stdio.input as unknown as Record<string, unknown>).entry = {
    type: 'stdio',
    command: '/usr/local/bin/example',
  };
  expect(validateMcpCommandRequest(stdio)).toEqual(stdio);
});
