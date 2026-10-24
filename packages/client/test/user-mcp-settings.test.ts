import { expect, test } from 'bun:test';
import {
  createClient,
  type ServerInfo,
  type UserMcpOperationResult,
  type UserMcpSettingsRequest,
  type UserMcpSettingsView,
  type UserMcpToolsPage,
} from '../src';

const digest = 'a'.repeat(64),
  serverId = `mcp-${digest}`;
const info: ServerInfo = {
  instanceId: 'fixture',
  buildId: 'fixture',
  apiMajor: 1,
  profile: { dataRoot: '/owned', name: 'user-mcp', accessKey: 'fixture-key' },
  dataAvailability: 'available',
  storeId: 'owned-store',
  capabilities: ['user_mcp_settings'],
};
const request = (commandId = 'original-command'): UserMcpSettingsRequest => ({
  storeId: info.storeId!,
  commandId,
  expectedReadSet: digest,
  operation: { kind: 'enabled', serverId, enabled: false },
});
const result = (input = request()): UserMcpOperationResult => ({
  ...structuredClone(input),
  scope: 'user',
  state: 'applied',
  receipt: {
    code: null,
    cancelled: false,
    configuration: 'published',
    authentication: null,
    connection: null,
    revocation: null,
  },
});
const view = (): UserMcpSettingsView => ({
  scope: 'user',
  storeId: info.storeId!,
  readSet: digest,
  errors: [],
  sources: [
    {
      id: serverId,
      name: 'Owned server',
      transport: 'http',
      address: 'https://example.test/mcp',
      enabled: true,
      configured: true,
      diagnostics: [],
      authentication: { policy: 'none', status: 'none', loginAllowed: false },
      connection: { state: 'ready', generation: 7, toolCount: 257 },
    },
  ],
});
const tools: UserMcpToolsPage['entries'] = Array.from({ length: 257 }, (_, index) => ({
  index,
  definitionId: `mcp.owned.tool-${index}`,
  definitionVersion: digest,
  descriptor: {
    name: `tool-${index}`,
    inputSchema: { type: 'object', properties: { token: { type: 'string' } } },
    description: `完整工具 ${index}\nUnicode🙂`,
  },
}));
type Kind = 'settings' | 'update' | 'lookup' | 'cancel' | 'tools';
type Call = { method: string; url: URL; body?: UserMcpSettingsRequest | { storeId: string } };
async function fixture(
  run: (f: {
    client: ReturnType<typeof createClient>;
    calls: Call[];
    set: (
      transform: (kind: Kind, value: unknown, call: Call) => unknown | Promise<unknown>,
    ) => void;
  }) => Promise<void>,
  supports = true,
) {
  const calls: Call[] = [],
    operations = new Map<string, UserMcpOperationResult>();
  let transform = (_kind: Kind, value: unknown, _call: Call): unknown | Promise<unknown> => value;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/server')
      return Response.json({ ...info, capabilities: supports ? info.capabilities : [] });
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    };
    calls.push(call);
    let kind: Kind, value: unknown;
    if (url.pathname === '/v1/config/user/mcp/tools') {
      kind = 'tools';
      const afterIndex = url.searchParams.has('afterIndex')
        ? Number(url.searchParams.get('afterIndex'))
        : -1;
      const entries = tools.slice(afterIndex + 1, afterIndex + 129);
      const complete = afterIndex + entries.length === tools.length - 1;
      value = {
        scope: 'user',
        storeId: info.storeId!,
        serverId,
        generation: 7,
        entries,
        complete,
        nextAfterIndex: complete ? null : entries.at(-1)!.index,
      } satisfies UserMcpToolsPage;
    } else if (url.pathname === '/v1/config/user/mcp') {
      if (call.method === 'POST') {
        kind = 'update';
        const operation = result(call.body as UserMcpSettingsRequest);
        operations.set(operation.commandId, operation);
        value = operation;
      } else {
        kind = 'settings';
        value = view();
      }
    } else {
      const match = /^\/v1\/config\/user\/mcp\/operations\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      expect(match).not.toBeNull();
      const id = decodeURIComponent(match![1]!);
      const operation = structuredClone(operations.get(id) ?? result(request(id)));
      kind = match![2] ? 'cancel' : 'lookup';
      if (kind === 'cancel') {
        operation.state = 'failed';
        operation.receipt.cancelled = true;
        operation.receipt.code = 'cancelled';
        operations.set(id, operation);
      }
      value = operation;
    }
    const transformed = await transform(kind, value, call);
    return transformed instanceof Response ? transformed : Response.json(transformed);
  }) as typeof fetch;
  const client = createClient({
    endpoint: 'http://owned.local',
    token: 'fixture-token',
    expected: {
      apiMajor: 1,
      profile: info.profile,
      instanceId: info.instanceId,
      buildId: info.buildId,
      requiredCapabilities: [],
    },
  });
  try {
    await client.connect();
    await run({
      client,
      calls,
      set(next) {
        transform = next;
      },
    });
  } finally {
    client.disposeNetwork();
    globalThis.fetch = originalFetch;
  }
}

const methods = (client: ReturnType<typeof createClient>, storeId = info.storeId!) => [
  () => client.getUserMcpSettings({ storeId }),
  () => client.updateUserMcpSettings({ ...request(), storeId }),
  () => client.getUserMcpOperation('original-command', { storeId }),
  () => client.cancelUserMcpOperation('original-command', { storeId }),
  () => client.listUserMcpTools({ storeId, serverId, generation: 7 }),
];

test('all five global MCP methods require the admitted capability and exact Store before business requests', async () => {
  await fixture(async ({ client, calls }) => {
    for (const method of methods(client))
      await expect(method()).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(calls).toHaveLength(0);
  }, false);
  await fixture(async ({ client, calls }) => {
    for (const method of methods(client, 'other-store'))
      await expect(method()).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    expect(calls).toHaveLength(0);
    await expect(
      client.getUserMcpSettings({ storeId: info.storeId!, sessionId: 'session' } as Parameters<
        typeof client.getUserMcpSettings
      >[0]),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
});

test('user MCP public responses reject project, Session and secret fields at their closed boundaries', async () =>
  fixture(async ({ client, calls, set }) => {
    const row = view().sources[0]!;
    for (const invalid of [
      { ...view(), scope: 'project' },
      { ...view(), sessionId: 'private-session' },
      { ...view(), workspaceId: 'project' },
      { ...view(), secret: 'private' },
      { ...view(), sources: [{ ...row, source: { kind: 'workspace' } }] },
      {
        ...view(),
        sources: [{ ...row, authentication: { ...row.authentication, token: 'private' } }],
      },
    ]) {
      set((kind, value) => (kind === 'settings' ? invalid : value));
      await expect(client.getUserMcpSettings({ storeId: info.storeId! })).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
    set((kind, value) => (kind === 'settings' ? { ...view(), sources: [row, row] } : value));
    await expect(client.getUserMcpSettings({ storeId: info.storeId! })).rejects.toMatchObject({
      code: 'configuration_scope_mismatch',
    });
    for (const invalid of [
      { ...result(), sessionId: 'session' },
      { ...result(), scope: 'project' },
      { ...result(), receipt: { ...result().receipt, credential: 'private' } },
    ]) {
      set((kind, value) => (kind === 'lookup' ? invalid : value));
      await expect(
        client.getUserMcpOperation('original-command', { storeId: info.storeId! }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    }
    set((_kind, value) => value);
    expect(await client.getUserMcpSettings({ storeId: info.storeId! })).toEqual(view());
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(client.lastAppliedCursor).toBeUndefined();
  }));

test('MCP update snapshots the original operation and mismatched or malformed POST outcomes remain unknown without retry', async () =>
  fixture(async ({ client, calls, set }) => {
    const input = request();
    const updating = client.updateUserMcpSettings(input);
    input.storeId = 'caller-mutated';
    if (input.operation.kind === 'enabled') input.operation.enabled = true;
    expect(await updating).toEqual(result());
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual(request());
    for (const invalid of [
      { ...result(), storeId: 'other-store' },
      { ...result(), commandId: 'other-command' },
      { ...result(), expectedReadSet: 'b'.repeat(64) },
      { ...result(), operation: { kind: 'remove', serverId } },
      { ...result(), receipt: { ...result().receipt, secret: 'private' } },
      {},
    ]) {
      set((kind, value) => (kind === 'update' ? invalid : value));
      const before = calls.filter((call) => call.method === 'POST').length;
      await expect(client.updateUserMcpSettings(request())).rejects.toMatchObject({
        code: 'network_outcome_unknown',
      });
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(before + 1);
    }
    set((kind, value) =>
      kind === 'update'
        ? Response.json(
            {
              code: 'mcp_read_set_changed',
              message: 'Changed user source',
              scope: 'user',
              requestId: 'fixture',
              retryable: false,
            },
            { status: 409 },
          )
        : value,
    );
    await expect(client.updateUserMcpSettings(request())).rejects.toMatchObject({
      code: 'mcp_read_set_changed',
      status: 409,
    });
  }));

test('lost MCP update and cancellation replies only recover the original operation ID and never resubmit the mutation', async () =>
  fixture(async ({ client, calls, set }) => {
    set((kind, value) => {
      if (kind === 'update' || kind === 'cancel') throw new TypeError('owned transport closed');
      return value;
    });
    await expect(client.updateUserMcpSettings(request('lost-original'))).rejects.toMatchObject({
      code: 'network_outcome_unknown',
    });
    for (let i = 0; i < 2; i++)
      expect(
        (await client.getUserMcpOperation('lost-original', { storeId: info.storeId! })).commandId,
      ).toBe('lost-original');
    await expect(
      client.cancelUserMcpOperation('lost-original', { storeId: info.storeId! }),
    ).rejects.toMatchObject({ code: 'network_outcome_unknown' });
    const observed = await client.getUserMcpOperation('lost-original', { storeId: info.storeId! });
    expect(observed.receipt.cancelled).toBe(true);
    expect(
      calls
        .filter((call) => call.method === 'POST')
        .map((call) => ({ path: call.url.pathname, body: call.body })),
    ).toEqual([
      { path: '/v1/config/user/mcp', body: request('lost-original') },
      {
        path: '/v1/config/user/mcp/operations/lost-original/cancel',
        body: { storeId: info.storeId! },
      },
    ]);
    expect(
      calls
        .filter((call) => call.url.pathname.includes('/operations/'))
        .every((call) => call.url.pathname.includes('/lost-original')),
    ).toBe(true);
    expect(client.lastAppliedCursor).toBeUndefined();
  }));

test('MCP user tools page exclusively after its index, preserves complete descriptors and rejects stale identity or cursors', async () =>
  fixture(async ({ client, calls, set }) => {
    const first = await client.listUserMcpTools({
      storeId: info.storeId!,
      serverId,
      generation: 7,
    });
    const entries = [...first.entries];
    let page = first;
    while (!page.complete) {
      page = await client.listUserMcpTools({
        storeId: info.storeId!,
        serverId,
        generation: 7,
        afterIndex: page.nextAfterIndex!,
      });
      entries.push(...page.entries);
    }
    expect(entries).toEqual(tools);
    const reads = calls.filter((call) => call.url.pathname.endsWith('/tools'));
    expect(reads).toHaveLength(3);
    expect(reads.map((call) => call.url.searchParams.get('afterIndex'))).toEqual([
      null,
      '127',
      '255',
    ]);
    expect(
      reads.every(
        (call) =>
          !call.url.searchParams.has('sessionId') && !call.url.searchParams.has('workspaceId'),
      ),
    ).toBe(true);
    for (const change of [
      (value: UserMcpToolsPage) => ({ ...value, generation: 8 }),
      (value: UserMcpToolsPage) => ({ ...value, storeId: 'other-store' }),
      (value: UserMcpToolsPage) => ({ ...value, serverId: `mcp-${'b'.repeat(64)}` }),
      (value: UserMcpToolsPage) => ({ ...value, sessionId: 'session' }),
      (value: UserMcpToolsPage) => ({ ...value, secret: 'private' }),
      (value: UserMcpToolsPage) => ({ ...value, entries: [{ ...value.entries[0]!, index: 127 }] }),
      (value: UserMcpToolsPage) => ({ ...value, nextAfterIndex: 129 }),
      (value: UserMcpToolsPage) => ({ ...value, complete: true }),
      (value: UserMcpToolsPage) => ({
        ...value,
        entries: [{ ...value.entries[0]!, credential: 'private' }],
      }),
    ]) {
      set((kind, value) => (kind === 'tools' ? change(value as UserMcpToolsPage) : value));
      const before = calls.length;
      await expect(
        client.listUserMcpTools({
          storeId: info.storeId!,
          serverId,
          generation: 7,
          afterIndex: 127,
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
      expect(calls).toHaveLength(before + 1);
    }
  }));
