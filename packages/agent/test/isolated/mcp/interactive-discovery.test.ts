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
      names: new Map([[remote.id, 'actual remote name']]),
      assertFresh: async () => {
        fresh++;
      },
    },
  ]);
  const result = await tool.execute({ query: 'recoverable echo' }, context());
  expect(result.outcome).toBe('succeeded');
  expect(JSON.parse(result.content).items).toEqual([
    {
      serverId: 'actual-server',
      serverName: 'recoverable',
      remoteName: 'actual remote name',
      modelName: remote.model!.name,
      definitionId: remote.id,
      definitionVersion: remote.version,
      description: remote.description,
      inputSchema: remote.inputSchema,
    },
  ]);
  expect(fresh).toBe(1);
  expect(calls).toBe(0);
  expect(hostReadOnlyTool('builtin.mcp.discovery', 'mcp.tools.search')).toBe(true);
  expect(hostReadOnlyTool('external', 'mcp.tools.search')).toBe(false);
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
  const result = await tool.execute({ query: 'echo' }, context());
  expect(result.outcome).toBe('failed');
  expect(JSON.parse(result.content)).toMatchObject({
    complete: false,
    items: [{ serverId: 'fresh', definitionId: remote.id }],
    unavailableSources: [{ serverId: 'unavailable' }],
  });
  expect(result.content).not.toContain('PRIVATE_CATALOGUE_FAULT');
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
  const result = await tool.execute({ query: 'echo' }, context());
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
