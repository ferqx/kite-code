import { expect, test } from 'bun:test';
import type { ToolContext, ToolDefinition } from '../../../src/extensions';
import { requestMcpProviderAction } from '../../../src/mcp/provider-action';
import { createMcpToolsSearchTool } from '../../../src/mcp/tools-search';
import { hostReadOnlyTool } from '../../../src/permissions/capabilities';

const context = (
  definitionId = 'mcp.tools.search',
  extra: Partial<ToolContext> = {},
): ToolContext =>
  ({
    executionId: 'own',
    sessionId: 'session',
    runId: 'run',
    signal: new AbortController().signal,
    getExecution: async () =>
      ({
        id: 'own',
        originStoreId: 'store',
        sessionId: 'session',
        kind: 'tool',
        definitionId,
        definitionVersion: '1',
      }) as never,
    ...extra,
  }) as ToolContext;
test('search returns exact frozen definitions and complete schemas without invoking remote tools', async () => {
  let calls = 0,
    fresh = 0;
  const remote: ToolDefinition = {
    id: 'actual.remote.id',
    model: { name: 'mcp_actual_echo_01234567' },
    version: 'actual-fingerprint',
    description: 'Echo a message.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    execute: async () => {
      calls++;
      throw Error('must-not-call');
    },
  };
  const tool = createMcpToolsSearchTool('store', 'session', [
    {
      serverId: 'actual-server',
      label: 'recoverable',
      tools: [remote],
      names: new Map([[remote.id, 'Upstream:FetchDocument']]),
      assertFresh: async () => {
        fresh++;
      },
    },
  ]);
  const queries = [
    'recoverable echo',
    remote.model!.name,
    remote.id,
    'Upstream:FetchDocument',
    '  RECOVERABLE \t FETCHDOCUMENT \n ECHO  ',
  ];
  for (const query of queries) {
    const result = await tool.execute({ query }, context());
    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(result.content).items).toEqual([
      {
        serverId: 'actual-server',
        serverName: 'recoverable',
        remoteName: 'Upstream:FetchDocument',
        modelName: remote.model!.name,
        definitionId: remote.id,
        definitionVersion: remote.version,
        description: remote.description,
        inputSchema: remote.inputSchema,
      },
    ]);
    expect(JSON.parse(tool.formatModelResult!({ result })!).items).toEqual([
      {
        server_id: 'actual-server',
        server_name: 'recoverable',
        name: remote.model!.name,
        description: remote.description,
        input_schema: remote.inputSchema,
      },
    ]);
  }
  expect(fresh).toBe(queries.length);
  expect(calls).toBe(0);
  expect(hostReadOnlyTool('builtin.mcp.discovery', 'mcp.tools.search')).toBe(true);
  expect(hostReadOnlyTool('external', 'mcp.tools.search')).toBe(false);
});
test('remote aliases keep same-named sources distinct and return the exact published callable names', async () => {
  let invoked = 0;
  const sources = ['first', 'second'].map((serverId) => {
    const remote: ToolDefinition = {
      id: `actual.${serverId}.definition`,
      version: `fingerprint-${serverId}`,
      model: { name: `mcp_${serverId}_shared_01234567` },
      description: 'Read a record',
      inputSchema: { type: 'object', properties: { [serverId]: { type: 'string' } } },
      execute: async () => {
        invoked++;
        throw Error('must-not-call');
      },
    };
    return {
      serverId,
      label: 'Same display label',
      tools: [remote],
      names: new Map([[remote.id, 'SharedRemoteName']]),
      assertFresh: async () => {},
    };
  });
  const tool = createMcpToolsSearchTool('store', 'session', sources);
  const shared = await tool.execute({ query: 'SharedRemoteName' }, context());
  expect(shared.outcome).toBe('succeeded');
  expect(
    JSON.parse(shared.content).items.map((item: { modelName: string }) => item.modelName),
  ).toEqual(sources.map((source) => source.tools[0]!.model!.name));
  const exact = await tool.execute(
    { query: sources[1]!.tools[0]!.model!.name, limit: 1 },
    context(),
  );
  expect(exact.outcome).toBe('succeeded');
  expect(JSON.parse(exact.content).items).toEqual([JSON.parse(shared.content).items[1]]);
  expect(invoked).toBe(0);
});

test('search matches complete remote aliases before limiting results and preserves optional name fallbacks', async () => {
  const tools: ToolDefinition[] = Array.from({ length: 25 }, (_, index) => ({
    id: `definition-${index}`,
    version: '1',
    ...(index < 24 ? { model: { name: `published_${index}` } } : {}),
    description: 'Read a record',
    inputSchema: { type: 'object' },
    execute: async () => {
      throw Error('must-not-call');
    },
  }));
  const remoteName = `${'LongRemoteName'.repeat(12)}_末尾UniqueSuffix`;
  const source = {
    serverId: 'actual',
    label: 'Source',
    tools,
    names: new Map([
      [tools[23]!.id, remoteName],
      ['not-a-selected-definition', 'UnselectedAlias'],
    ]),
    assertFresh: async () => {},
  };
  const tool = createMcpToolsSearchTool('store', 'session', [source]);
  for (const limit of [undefined, 1, 20]) {
    const result = await tool.execute(
      { query: 'record', ...(limit === undefined ? {} : { limit }) },
      context(),
    );
    expect(result.outcome).toBe('succeeded');
    expect(
      JSON.parse(result.content).items.map((item: { definitionId: string }) => item.definitionId),
    ).toEqual(tools.slice(0, limit ?? 10).map((entry) => entry.id));
  }
  for (const query of [remoteName, '末尾uniquesuffix', tools[23]!.model!.name]) {
    const result = await tool.execute({ query, limit: 1 }, context());
    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(result.content).items).toMatchObject([
      { definitionId: tools[23]!.id, modelName: tools[23]!.model!.name, remoteName },
    ]);
  }
  const fallback = createMcpToolsSearchTool('store', 'session', [{ ...source, names: undefined }]);
  const result = await fallback.execute({ query: tools[24]!.id, limit: 1 }, context());
  expect(result.outcome).toBe('succeeded');
  expect(JSON.parse(result.content).items).toMatchObject([
    { definitionId: tools[24]!.id, modelName: tools[24]!.id },
  ]);
  expect(JSON.parse(result.content).items[0]).not.toHaveProperty('remoteName');
  expect(
    JSON.parse((await tool.execute({ query: 'UnselectedAlias' }, context())).content).items,
  ).toEqual([]);
  expect(
    JSON.parse((await tool.execute({ query: 'record nonexistent' }, context())).content).items,
  ).toEqual([]);
});

test('name searches retain run scope and cancellation checks without exposing stale matches', async () => {
  let fresh = 0;
  const remote: ToolDefinition = {
    id: 'actual.remote',
    model: { name: 'published_only_name' },
    version: '1',
    description: 'Read a record',
    inputSchema: { type: 'object' },
    execute: async () => {
      throw Error('must-not-call');
    },
  };
  const controller = new AbortController();
  const reason = Error('original-cancel-reason');
  const tool = createMcpToolsSearchTool(
    'store',
    'session',
    [
      {
        serverId: 'actual',
        label: 'Source',
        tools: [remote],
        assertFresh: async () => {
          fresh++;
          controller.abort(reason);
          throw Error('private-stale-error');
        },
      },
    ],
    'run',
  );
  const own = { ...(await context().getExecution('own'))!, runId: 'run' };
  const scoped = context('mcp.tools.search', {
    getExecution: async () => own,
    signal: controller.signal,
  });
  const query = { query: remote.model!.name };
  expect(await tool.execute(query, { ...scoped, runId: 'other' })).toEqual({
    outcome: 'failed',
    content: 'mcp_search_scope_unverifiable',
  });
  expect(fresh).toBe(0);
  await expect(tool.execute(query, scoped)).rejects.toBe(reason);
  expect(fresh).toBe(1);
  await expect(tool.execute(query, scoped)).rejects.toBe(reason);
  expect(fresh).toBe(1);
});

test('withdrawn source and foreign scope never promote cached definitions', async () => {
  let fresh = 0;
  const tool = createMcpToolsSearchTool('store', 'session', [
    {
      serverId: 'actual',
      label: 'echo',
      tools: [],
      assertFresh: async () => {
        fresh++;
        throw Error('stale');
      },
    },
  ]);
  const stale = await tool.execute({ query: 'echo' }, context());
  expect(stale.outcome).toBe('failed');
  expect(JSON.parse(stale.content)).toMatchObject({
    items: [],
    complete: false,
    unavailableSources: [{ serverId: 'actual', code: 'mcp_catalogue_unavailable' }],
    error: { code: 'mcp_search_incomplete' },
  });
  expect(stale.content).toContain('not proof that no matching tool exists');
  expect(stale.content).not.toContain('stale');
  const foreign = context();
  foreign.getExecution = async () =>
    ({
      id: 'own',
      originStoreId: 'foreign',
      sessionId: 'session',
      kind: 'tool',
      definitionId: 'mcp.tools.search',
      definitionVersion: '1',
    }) as never;
  expect((await tool.execute({ query: 'echo' }, foreign)).outcome).toBe('failed');
  expect(fresh).toBe(1);
});

test('partial catalogue failure retains fresh matches and explains incomplete search without leaking its exception', async () => {
  const remote: ToolDefinition = {
    id: 'actual.remote',
    version: '1',
    description: 'Echo text',
    inputSchema: { type: 'object' },
    execute: async () => {
      throw Error('must not invoke');
    },
  };
  const tool = createMcpToolsSearchTool('store', 'session', [
    {
      serverId: 'unavailable',
      label: 'Echo',
      tools: [remote],
      assertFresh: async () => {
        throw Error('PRIVATE_CATALOGUE_FAULT');
      },
    },
    { serverId: 'fresh', label: 'Echo', tools: [remote], assertFresh: async () => {} },
  ]);
  for (const query of ['echo', remote.id]) {
    const result = await tool.execute({ query }, context());
    expect(result.outcome).toBe('failed');
    expect(JSON.parse(result.content)).toMatchObject({
      complete: false,
      items: [{ serverId: 'fresh', definitionId: remote.id }],
      unavailableSources: [{ serverId: 'unavailable' }],
    });
    expect(result.content).not.toContain('PRIVATE_CATALOGUE_FAULT');
  }
});

test('oversized matching schemas are explicitly omitted rather than reported as an empty complete search', async () => {
  let invoked = 0;
  const remote: ToolDefinition = {
    id: 'actual.oversized',
    version: '1',
    description: 'Echo text',
    inputSchema: { type: 'object', description: `OVERSIZED_SCHEMA_BODY${'x'.repeat(256 * 1024)}` },
    execute: async () => {
      invoked++;
      throw Error('must not invoke');
    },
  };
  const tool = createMcpToolsSearchTool('store', 'session', [
    { serverId: 'fresh', label: 'Echo', tools: [remote], assertFresh: async () => {} },
  ]);
  for (const query of ['echo', remote.id]) {
    const result = await tool.execute({ query }, context());
    expect(result.outcome).toBe('failed');
    expect(JSON.parse(result.content)).toMatchObject({
      complete: false,
      items: [],
      unavailableSources: [],
      omittedMatches: 1,
      error: { code: 'mcp_search_incomplete' },
    });
    expect(result.content).toContain('descriptors exceed the search response budget');
    expect(result.content).toContain('not proof that no matching tool exists');
    expect(result.content).not.toContain('OVERSIZED_SCHEMA_BODY');
  }
  expect(invoked).toBe(0);
});
test('Later consumes actual provider choice once and retains the original uncertainty without replay or login', async () => {
  let questions = 0,
    logins = 0;
  const ctx = context('actual.proxy', {
    requestInteraction: async (input) => {
      questions++;
      expect(input.kind).toBe('question');
      expect((input.request as { sourceCode: string }).sourceCode).toBe('mcp_oauth_login_required');
      return { action: 'later' };
    },
  });
  const result = await requestMcpProviderAction(
    {
      serverId: 'actual',
      serverName: 'recoverable',
      code: 'mcp_oauth_login_required',
      login: async () => {
        logins++;
        throw Error('must-not-login');
      },
    },
    ctx,
  );
  expect(result.outcome).toBe('outcome_unknown');
  expect(result.content).toContain('provider_auth_required');
  expect(result.details).toMatchObject({
    adapterAttempted: true,
    remoteStopConfirmed: false,
    choice: 'later',
    replayed: false,
  });
  expect(questions).toBe(1);
  expect(logins).toBe(0);
});
test('Run login invokes only the trusted ordinary authentication callback and never retries the failed tool', async () => {
  let logins = 0;
  const ctx = context('actual.proxy', { requestInteraction: async () => ({ action: 'login' }) });
  const result = await requestMcpProviderAction(
    {
      serverId: 'actual',
      serverName: 'recoverable',
      code: 'mcp_oauth_reauth_required',
      login: async (own) => {
        expect(own).toBe(ctx);
        logins++;
        return { commandId: 'original-auth', status: 'failed' };
      },
    },
    ctx,
  );
  expect(result.details).toMatchObject({
    replayed: false,
    authentication: { commandId: 'original-auth', status: 'failed' },
  });
  expect(logins).toBe(1);
  expect(result.outcome).toBe('outcome_unknown');
});

test('only an exact transport HTTP401 negative RPC receipt qualifies a known failure; Later grants no stop proof', async () => {
  const ctx = context('actual.proxy', { requestInteraction: async () => ({ action: 'later' }) });
  const rejection = {
    httpStatus: 401 as const,
    rpcMethod: 'tools/call' as const,
    requestId: 1,
    serverId: 'actual',
    connectionExecutionId: 'connection',
    originalStoreId: 'store',
    sessionId: 'session',
    configDigest: 'digest',
  };
  const input = {
    serverId: 'actual',
    serverName: 'recoverable',
    code: 'mcp_oauth_login_required' as const,
    rejection,
    login: async () => {
      throw Error('must-not-login');
    },
  };
  const known = await requestMcpProviderAction(input, ctx);
  expect(known.outcome).toBe('failed');
  expect(known.details).toMatchObject({
    remoteStopConfirmed: false,
    replayed: false,
    adapterAttempted: true,
    authorizationRejection: rejection,
  });
  const foreign = await requestMcpProviderAction(
    { ...input, rejection: { ...rejection, originalStoreId: 'foreign' } },
    ctx,
  );
  expect(foreign.outcome).toBe('outcome_unknown');
});
