import { expect, test } from 'bun:test';
import {
  type AgentClient,
  canonicalMcpCommandRequest,
  canonicalModelBody,
  type UserMcpOperationResult,
  type UserMcpSettingsRequest,
  type UserMcpSettingsView,
} from '@kite-ai/client';
import { mcpSha, parseNativeMcpRecord } from '../../electron/mcp-journal';
import { NativeUserMcpSettings } from '../../electron/user-mcp-settings';
import { memoryPrivateData } from '../private-data.fixture';

const digest = 'a'.repeat(64),
  serverId = `mcp-${digest}`;
const view: UserMcpSettingsView = {
  scope: 'user',
  storeId: 'store',
  readSet: digest,
  errors: [],
  sources: [
    {
      id: serverId,
      name: 'owned-user',
      transport: 'http',
      address: 'https://example.com/mcp',
      enabled: true,
      configured: true,
      diagnostics: [],
      authentication: { policy: 'none', status: 'none', loginAllowed: false },
      connection: { state: 'ready', generation: 1, toolCount: 1 },
    },
  ],
};
const result = (
  request: UserMcpSettingsRequest,
  state: UserMcpOperationResult['state'] = 'applied',
): UserMcpOperationResult => ({
  scope: 'user',
  ...request,
  state,
  receipt: {
    code: null,
    cancelled: false,
    configuration: 'unchanged',
    authentication: null,
    connection: null,
    revocation: null,
  },
});
function fixture() {
  const calls: { method: string; args: unknown[] }[] = [],
    data = memoryPrivateData();
  let current: { generation: number; storeId: string } | undefined = {
    generation: 1,
    storeId: 'store',
  };
  const operations = new Map<string, UserMcpSettingsRequest>();
  const methods = {
    serverInfo: { storeId: 'store', subjectId: 'owner' },
    getUserMcpSettings: async (...args: unknown[]) => {
      calls.push({ method: 'read', args });
      return structuredClone(view);
    },
    updateUserMcpSettings: async (request: UserMcpSettingsRequest) => {
      calls.push({ method: 'post', args: [request] });
      operations.set(request.commandId, request);
      return result(request);
    },
    getUserMcpOperation: async (commandId: string, ...args: unknown[]) => {
      calls.push({ method: 'get', args: [commandId, ...args] });
      return result(operations.get(commandId)!);
    },
    cancelUserMcpOperation: async (commandId: string, ...args: unknown[]) => {
      calls.push({ method: 'cancel', args: [commandId, ...args] });
      return {
        ...result(operations.get(commandId)!, 'failed'),
        receipt: { ...result(operations.get(commandId)!).receipt, cancelled: true },
      };
    },
    listUserMcpTools: async (...args: unknown[]) => {
      calls.push({ method: 'tools', args });
      return {
        scope: 'user',
        storeId: 'store',
        serverId,
        generation: 1,
        entries: [],
        complete: true,
        nextAfterIndex: null,
      };
    },
  };
  const client = new Proxy(methods, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      throw Error(`unexpected_session_method_${String(key)}`);
    },
  }) as unknown as AgentClient;
  const manager = () =>
    new NativeUserMcpSettings(
      client,
      () => current,
      () => {},
      data,
    );
  return {
    data,
    methods,
    operations,
    calls,
    client,
    manager,
    setCurrent: (value: typeof current) => {
      current = value;
    },
  };
}
test('global Main reads, adds, enables, removes and lists tools without acquiring any Session', async () => {
  const f = fixture(),
    manager = f.manager();
  let facts = await manager.read();
  expect(facts.sources.map((s) => s.name)).toEqual(['owned-user']);
  expect(facts).not.toHaveProperty('sessionId');
  expect(facts).not.toHaveProperty('workspaceId');
  for (const operation of [
    {
      kind: 'add' as const,
      name: 'new-user',
      entry: { type: 'http' as const, url: 'https://example.com/new' },
    },
    { kind: 'enabled' as const, serverId, enabled: false },
    { kind: 'remove' as const, serverId },
  ]) {
    expect((await manager.submit(facts.observationId, operation)).phase).toBe('completed');
    facts = await manager.read();
  }
  await manager.tools(facts.observationId, serverId, 1);
  expect(f.calls.filter((c) => c.method === 'post')).toHaveLength(3);
  expect(f.data.mcps()).toHaveLength(0);
  expect(f.data.userMcps()).toHaveLength(3);
  for (const row of f.data.userMcps()) {
    expect(row.version).toBe(2);
    expect(row.scope).toBe('user');
    expect(row).not.toHaveProperty('sessionId');
    expect(row.request.operation).not.toHaveProperty('scope');
  }
});
test('one hot ID owns one POST; reopening and lookup of a lost reply never repeat it', async () => {
  const f = fixture();
  let resolvePost!: (result: UserMcpOperationResult) => void;
  f.methods.updateUserMcpSettings = async (request) => {
    f.calls.push({ method: 'post', args: [request] });
    f.operations.set(request.commandId, request);
    return new Promise((resolve) => {
      resolvePost = resolve;
    });
  };
  const manager = f.manager(),
    facts = await manager.read(),
    operation = { kind: 'connect' as const, serverId };
  const first = manager.submit(facts.observationId, operation),
    duplicate = manager.submit(facts.observationId, operation);
  expect(first === duplicate).toBe(true);
  expect(f.calls.filter((c) => c.method === 'post')).toHaveLength(1);
  const original = f.data.userMcps()[0]!;
  resolvePost({ ...result(original.request), commandId: 'forged-original' });
  expect((await first).phase).toBe('outcome_unknown');
  const cold = f.manager();
  expect(cold.submissions[0]!.phase).toBe('outcome_unknown');
  expect(f.calls.filter((c) => c.method === 'get')).toHaveLength(0);
  await cold.read();
  expect(f.calls.filter((c) => c.method === 'get')).toHaveLength(0);
  expect((await cold.lookup(original.request.commandId)).phase).toBe('completed');
  expect(f.calls.filter((c) => c.method === 'post')).toHaveLength(1);
  expect(f.calls.find((c) => c.method === 'get')?.args[0]).toBe(original.request.commandId);
});
test('global reads survive Session selection; Store or generation change rejects stale observations', async () => {
  const f = fixture(),
    manager = f.manager(),
    facts = await manager.read();
  // Session changes do not change the global callback identity.
  f.setCurrent({ generation: 1, storeId: 'store' });
  expect(
    (await manager.submit(facts.observationId, { kind: 'enabled', serverId, enabled: false }))
      .phase,
  ).toBe('completed');
  const next = await manager.read();
  f.setCurrent({ generation: 2, storeId: 'store' });
  expect(() => manager.submit(next.observationId, { kind: 'remove', serverId })).toThrow(
    'mcp_observation_changed',
  );
  expect(f.calls.filter((c) => c.method === 'post')).toHaveLength(1);
});
test('closing a global reader isolates a delayed original GET and does not cancel its operation', async () => {
  const f = fixture();
  f.methods.updateUserMcpSettings = async (request) => {
    f.calls.push({ method: 'post', args: [request] });
    f.operations.set(request.commandId, request);
    throw Error('reply_lost');
  };
  const manager = f.manager(),
    facts = await manager.read();
  const unknown = await manager.submit(facts.observationId, { kind: 'connect', serverId });
  let resolveGet!: (result: UserMcpOperationResult) => void;
  f.methods.getUserMcpOperation = async (commandId, ...args) => {
    f.calls.push({ method: 'get', args: [commandId, ...args] });
    return new Promise((resolve) => {
      resolveGet = resolve;
    });
  };
  const lookup = manager.lookup(unknown.commandId);
  manager.release();
  resolveGet(result(f.operations.get(unknown.commandId)!));
  await expect(lookup).rejects.toThrow();
  expect(manager.submissions[0]!.phase).toBe('outcome_unknown');
  expect(f.data.userMcps()[0]!.phase).toBe('outcome_unknown');
  expect(f.calls.filter((c) => c.method === 'cancel')).toHaveLength(0);
});
test('cancel uses the persisted global ID and a foreign Store never queries or resubmits it', async () => {
  const f = fixture();
  f.methods.updateUserMcpSettings = async (request) => {
    f.operations.set(request.commandId, request);
    throw Error('reply_lost');
  };
  const manager = f.manager(),
    facts = await manager.read();
  const unknown = await manager.submit(facts.observationId, { kind: 'connect', serverId });
  expect((await manager.cancel(unknown.commandId)).phase).toBe('cancelled');
  expect(f.calls.filter((c) => c.method === 'cancel')[0]?.args[0]).toBe(unknown.commandId);
  f.setCurrent({ generation: 2, storeId: 'other' });
  f.methods.serverInfo.storeId = 'other';
  expect((await manager.lookup(unknown.commandId)).association).toBe('unavailable');
  expect(f.calls.filter((c) => c.method === 'get')).toHaveLength(0);
});
test('closed global operation grammar rejects renderer project authority, secrets and unsafe URLs before persistence', async () => {
  const f = fixture(),
    manager = f.manager(),
    facts = await manager.read();
  const invalid = [
    { kind: 'remove', serverId, scope: 'workspace' },
    {
      kind: 'add',
      name: 'secret',
      entry: { type: 'http', url: 'https://example.com/?token=secret' },
    },
    { kind: 'bind', serverId, expiresAt: 12, secret: 'raw' },
  ];
  for (const operation of invalid)
    expect(() => manager.submit(facts.observationId, operation as never)).toThrow();
  expect(f.data.userMcps()).toHaveLength(0);
  expect(f.calls.filter((c) => c.method === 'post')).toHaveLength(0);
});
test('legacy user unknown blocks edits until explicit original lookup; old project configuration stays private', async () => {
  const f = fixture();
  const request = {
    expectedStoreId: 'store',
    commandId: 'old-user',
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.add',
    definitionVersion: '1',
    input: {
      scope: 'user',
      name: 'legacy',
      entry: { type: 'http', url: 'https://example.com/mcp' },
      expectedReadSet: {
        scopeDigest: digest,
        user: {
          identity: { kind: 'user', pathDigest: digest, rootIdentity: digest },
          etag: digest,
          error: null,
        },
        workspace: null,
        approvalEtag: null,
        bindingEtag: null,
        variablesDigest: digest,
      },
    },
  };
  const row = parseNativeMcpRecord({
    version: 1,
    sessionId: 'old-session',
    workspaceId: 'old-workspace',
    workspaceIdentity: digest,
    subjectId: 'owner',
    request,
    targetRequest: null,
    bodySha256: mcpSha(canonicalModelBody(request)),
    requestSha256: mcpSha(canonicalMcpCommandRequest(request as never)),
    phase: 'submitting',
  });
  f.data.beginMcp(row);
  f.data.finishMcp(row.request.commandId, 'outcome_unknown');
  const projectRequest = {
    ...request,
    commandId: 'old-project',
    input: {
      ...request.input,
      scope: 'workspace',
      expectedReadSet: {
        ...request.input.expectedReadSet,
        workspace: {
          ...request.input.expectedReadSet.user,
          identity: { ...request.input.expectedReadSet.user.identity, kind: 'workspace' },
        },
      },
    },
  };
  const project = parseNativeMcpRecord({
    ...row,
    request: projectRequest,
    bodySha256: mcpSha(canonicalModelBody(projectRequest)),
    requestSha256: mcpSha(canonicalMcpCommandRequest(projectRequest as never)),
  });
  f.data.beginMcp(project);
  f.data.finishMcp(project.request.commandId, 'outcome_unknown');
  Object.assign(f.methods, {
    getCommand: async (id: string) => {
      f.calls.push({ method: 'legacy-get', args: [id] });
      return {
        id,
        originStoreId: 'store',
        sessionId: 'old-session',
        subjectId: 'owner',
        kind: 'extension.invoke',
        requestDigest: row.requestSha256,
        status: 'rejected',
      };
    },
  });
  const manager = f.manager(),
    facts = await manager.read();
  expect(manager.submissions).toHaveLength(1);
  expect(manager.submissions[0]!.legacyUser).toBe(true);
  expect(f.calls.some((c) => c.method === 'legacy-get')).toBe(false);
  expect(() => manager.submit(facts.observationId, { kind: 'remove', serverId })).toThrow(
    'mcp_operation_pending',
  );
  expect((await manager.lookup('old-user')).phase).toBe('failed');
  expect((await manager.submit(facts.observationId, { kind: 'remove', serverId })).phase).toBe(
    'completed',
  );
  expect(f.data.mcps().find((r) => r.request.commandId === 'old-project')!.phase).toBe(
    'outcome_unknown',
  );
});

test('confirmed global terminal records stay confirmed after restart and do not block new edits', async () => {
  const f = fixture(),
    first = f.manager(),
    facts = await first.read();
  const confirmed = await first.submit(facts.observationId, {
    kind: 'enabled',
    serverId,
    enabled: false,
  });
  const cold = f.manager();
  expect(cold.submissions[0]!.phase).toBe('completed');
  expect(f.calls.filter((call) => call.method === 'get')).toHaveLength(0);
  const current = await cold.read();
  expect((await cold.submit(current.observationId, { kind: 'remove', serverId })).phase).toBe(
    'completed',
  );
  expect((await cold.lookup(confirmed.commandId)).phase).toBe('completed');
  expect(f.calls.filter((call) => call.method === 'post')).toHaveLength(2);
});

test('an observed unavailable global owner can disconnect despite read errors and an unresolved earlier operation', async () => {
  const f = fixture();
  f.methods.updateUserMcpSettings = async (request) => {
    f.calls.push({ method: 'post', args: [request] });
    f.operations.set(request.commandId, request);
    if (request.operation.kind !== 'disconnect') throw Error('reply_lost');
    return result(request);
  };
  const manager = f.manager(),
    initial = await manager.read();
  const original = await manager.submit(initial.observationId, { kind: 'connect', serverId });
  expect(original.phase).toBe('outcome_unknown');
  const unavailable = {
    ...structuredClone(view),
    readSet: 'b'.repeat(64),
    errors: ['mcp_source_unavailable'],
    sources: [
      {
        ...structuredClone(view.sources[0]!),
        configured: false,
        enabled: false,
        diagnostics: ['mcp_source_entry_missing'],
        connection: { state: 'failed' as const, generation: null, toolCount: null },
      },
    ],
  };
  f.methods.getUserMcpSettings = async (...args) => {
    f.calls.push({ method: 'read', args });
    return unavailable;
  };
  const facts = await manager.read();
  expect(facts.canWrite).toBe(false);
  const invalid = [
    { kind: 'add', name: 'another', entry: { type: 'http', url: 'https://example.com/new' } },
    { kind: 'enabled', serverId, enabled: true },
    { kind: 'remove', serverId },
    { kind: 'authStatus', serverId },
    { kind: 'login', serverId },
    { kind: 'authRefresh', serverId },
    { kind: 'clear', serverId },
    { kind: 'revoke', serverId },
    { kind: 'bind', serverId, expiresAt: 1234 },
    { kind: 'connect', serverId },
    { kind: 'reconnect', serverId },
    { kind: 'refresh', serverId },
    { kind: 'disconnect', serverId: `mcp-${'c'.repeat(64)}` },
  ];
  for (const operation of invalid)
    expect(() => manager.submit(facts.observationId, operation as never)).toThrow(
      'mcp_source_unavailable',
    );
  expect(f.calls.filter((call) => call.method === 'post')).toHaveLength(1);
  const stopped = await manager.submit(facts.observationId, { kind: 'disconnect', serverId });
  expect(stopped.phase).toBe('completed');
  expect(stopped.commandId).not.toBe(original.commandId);
  const saved = f.data.userMcps().find((row) => row.request.commandId === stopped.commandId)!;
  expect(saved.request.expectedReadSet).toBe(unavailable.readSet!);
  expect(saved.request.operation).toEqual({ kind: 'disconnect', serverId });
  expect(manager.submissions.find((row) => row.commandId === original.commandId)!.phase).toBe(
    'outcome_unknown',
  );
  expect(f.calls.filter((call) => call.method === 'get')).toHaveLength(0);
});

test('an unresolved exact owner stop cannot be resubmitted after refresh and stale cleanup observations cannot dispatch', async () => {
  const f = fixture();
  const unavailable = {
    ...structuredClone(view),
    errors: ['mcp_source_unavailable'],
    sources: [
      {
        ...structuredClone(view.sources[0]!),
        configured: false,
        enabled: false,
        connection: { state: 'failed' as const, generation: null, toolCount: null },
      },
    ],
  };
  f.methods.getUserMcpSettings = async (...args) => {
    f.calls.push({ method: 'read', args });
    return unavailable;
  };
  f.methods.updateUserMcpSettings = async (request) => {
    f.calls.push({ method: 'post', args: [request] });
    f.operations.set(request.commandId, request);
    throw Error('reply_lost');
  };
  const manager = f.manager(),
    initial = await manager.read();
  const first = await manager.submit(initial.observationId, { kind: 'disconnect', serverId });
  expect(first.phase).toBe('outcome_unknown');
  const refreshed = await manager.read();
  expect(() => manager.submit(refreshed.observationId, { kind: 'disconnect', serverId })).toThrow(
    'mcp_operation_pending',
  );
  f.setCurrent({ generation: 2, storeId: 'store' });
  expect(() => manager.submit(refreshed.observationId, { kind: 'disconnect', serverId })).toThrow(
    'mcp_observation_changed',
  );
  expect(f.calls.filter((call) => call.method === 'post')).toHaveLength(1);
});

test('a held owner with a configured source can still stop when user binding metadata is unreadable', async () => {
  const f = fixture();
  const unreadable = { ...structuredClone(view), errors: ['mcp_source_binding_invalid'] };
  f.methods.getUserMcpSettings = async (...args) => {
    f.calls.push({ method: 'read', args });
    return unreadable;
  };
  const manager = f.manager(),
    facts = await manager.read();
  expect(facts.canWrite).toBe(false);
  expect(facts.sources[0]!.configured).toBe(true);
  expect(() =>
    manager.submit(facts.observationId, { kind: 'enabled', serverId, enabled: false }),
  ).toThrow('mcp_source_unavailable');
  expect(() => manager.submit(facts.observationId, { kind: 'authStatus', serverId })).toThrow(
    'mcp_source_unavailable',
  );
  const stopped = await manager.submit(facts.observationId, { kind: 'disconnect', serverId });
  expect(stopped.phase).toBe('completed');
  expect(f.calls.filter((call) => call.method === 'post')).toHaveLength(1);
});

test('an unavailable owner cleanup cannot transfer an old observation to another authenticated subject', async () => {
  const f = fixture();
  f.methods.getUserMcpSettings = async () => ({
    ...structuredClone(view),
    errors: ['mcp_source_binding_invalid'],
  });
  const manager = f.manager(),
    facts = await manager.read();
  f.methods.serverInfo.subjectId = 'another-owner';
  expect(() => manager.submit(facts.observationId, { kind: 'disconnect', serverId })).toThrow(
    'mcp_observation_changed',
  );
  expect(f.calls.filter((call) => call.method === 'post')).toHaveLength(0);
  expect(f.data.userMcps()).toHaveLength(0);
});
