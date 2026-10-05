import { expect, test } from 'bun:test';
import type { AgentClient, Command, QueryResponse } from '@kite-ai/client';
import type {
  TuiCallerIntent,
  TuiCallerPort,
  TuiMcpAuthFact,
  TuiMcpSourceApprovalPort,
  TuiMcpSourceSnapshot,
} from '@kite-ai/ui/tui';
import { callerDigest, callerRequestDigest, parseCallerIntent } from '../../host/caller-intents';
import { mcpSha } from '../../host/mcp-selection-intents';
import {
  createTuiMcpAuthPort,
  decodeMcpAuthFact,
  decodeMcpAuthStatus,
} from '../../host/tui-mcp-auth';

const serverId = `mcp-${'a'.repeat(64)}`;
const snapshot: TuiMcpSourceSnapshot = {
  storeId: 'store',
  sessionId: 'session',
  workspaceId: 'workspace',
  workspaceIdentity: 'physical',
  registryRevision: 'a'.repeat(64),
  errors: [],
  readSet: {
    scopeDigest: '1'.repeat(64),
    variablesDigest: '2'.repeat(64),
    user: {
      identity: { kind: 'user', pathDigest: '3'.repeat(64), rootIdentity: '4'.repeat(64) },
      etag: null,
      error: null,
    },
    workspace: null,
    approvalEtag: null,
    bindingEtag: null,
  },
  items: [
    {
      id: serverId,
      name: 'owned',
      source: { kind: 'user', pathDigest: '3'.repeat(64), rootIdentity: '4'.repeat(64) },
      rawEntryDigest: '5'.repeat(64),
      transportDigest: '6'.repeat(64),
      transport: 'http',
      enabled: true,
      admitted: true,
      reason: null,
      configDigest: '7'.repeat(64),
    },
  ],
};
function original(id = 'auth'): TuiCallerIntent {
  const request = {
    expectedStoreId: 'store',
    commandId: id,
    kind: 'extension.invoke' as const,
    extensionId: 'builtin.mcp.sources' as const,
    actionId: 'mcp.auth.login' as const,
    definitionVersion: '1' as const,
    input: JSON.parse(JSON.stringify({ serverId, expectedReadSet: snapshot.readSet })),
  };
  return parseCallerIntent({
    scope: { storeId: 'store', sessionId: 'session', workspaceId: 'workspace' },
    subjectId: 'subject',
    bodyDigest: callerDigest(request),
    requestDigest: callerRequestDigest(request),
    target: { kind: 'session', id: 'session' },
    request,
  });
}
function display(type: string, payload: unknown): QueryResponse {
  return JSON.parse(
    JSON.stringify([
      {
        extensionId: 'builtin.mcp.sources' as const,
        contentType: type,
        contentVersion: 1,
        summary: 'Safe fact',
        payload,
        actions: [],
        artifactRefs: [],
      },
    ]),
  );
}
function fixture() {
  const intent = original();
  const inputDigest = mcpSha(
    intent.request.kind === 'extension.invoke' ? intent.request.input : {},
  );
  const command: Command = {
    id: 'auth',
    originStoreId: 'store',
    sessionId: 'session',
    kind: 'extension.invoke',
    subjectId: 'subject',
    requestDigest: intent.requestDigest,
    status: 'applied',
    cancelRequestedAt: null,
    receipt: {
      executionId: 'execution',
      status: 'succeeded',
      preparingNextAttempt: false,
      finalizationDigest: 'b'.repeat(64),
    },
  };
  const fact: TuiMcpAuthFact = {
    storeId: 'store',
    sessionId: 'session',
    command: {
      id: 'auth',
      originStoreId: 'store',
      sessionId: 'session',
      subjectId: 'subject',
      requestDigest: intent.requestDigest,
      status: 'applied',
      executionId: 'execution',
    },
    execution: {
      id: 'execution',
      originStoreId: 'store',
      sessionId: 'session',
      originCommandId: 'auth',
      parentExecutionId: null,
      kind: 'job',
      definitionId: 'builtin.mcp.sources/mcp.auth.login',
      definitionVersion: '1' as const,
      inputDigest,
      status: 'succeeded',
    },
    binding: {
      version: 1,
      executionId: 'execution',
      originCommandId: 'auth',
      originalStoreId: 'store',
      sessionId: 'session',
      workspaceId: 'workspace',
      actionId: 'mcp.auth.login' as const,
      serverId,
      inputDigest,
    },
    phase: 'completed',
    authStatus: 'authenticated',
    effectAttempted: true,
    reason: 'mcp_oauth_authenticated',
  };
  const counters = { query: 0, source: 0, prepare: 0, post: 0, callerGet: 0 };
  let current = snapshot,
    rows = [{ intent, phase: 'unknown' as const }];
  const callers: TuiCallerPort = {
    list: async () => rows,
    prepare: async (_scope, request) => {
      counters.prepare++;
      return original(request.commandId);
    },
    submit: async (i) => {
      counters.post++;
      return { intent: i, phase: 'applied', command };
    },
    lookup: async (i) => {
      counters.callerGet++;
      return { intent: i, phase: 'applied', command };
    },
    clear: async () => {
      throw Error('unexpected_clear');
    },
  };
  const sources: TuiMcpSourceApprovalPort = {
    read: async () => {
      counters.source++;
      return current;
    },
    list: async () => [],
    submit: async () => {
      throw Error('unexpected_submit');
    },
    lookup: async () => {
      throw Error('unexpected_lookup');
    },
  };
  const client: Pick<AgentClient, 'serverInfo' | 'queryExtension'> = {
    serverInfo: { storeId: 'store', subjectId: 'subject' } as AgentClient['serverInfo'],
    queryExtension: async (_session, _extension, query, input) => {
      counters.query++;
      expect(_session).toBe('session');
      expect(_extension).toBe('builtin.mcp.sources');
      if (query === 'mcp.auth.result') {
        expect(input).toEqual({ commandId: 'auth' });
        return display('builtin.mcp.auth.result', fact);
      }
      return display('builtin.mcp.auth.status', {
        serverId,
        workspaceId: 'workspace',
        loginAllowed: true,
        policy: 'oauth',
        status: 'available',
        credentialPresent: true,
      });
    },
  };
  const port = createTuiMcpAuthPort({ client, storeId: 'store', callers, sources });
  return {
    port,
    intent,
    fact,
    command,
    client,
    counters,
    sourceDrift() {
      current = { ...snapshot, workspaceIdentity: 'changed' };
    },
    noHistory() {
      rows = [];
    },
  };
}

test('finite status is source-fresh; cold unresolved original blocks prepare and duplicate submission is GET-only', async () => {
  const f = fixture();
  expect(await f.port.read(snapshot, serverId, new AbortController().signal)).toMatchObject({
    credentialPresent: true,
    status: 'available',
  });
  await expect(f.port.prepare(original('new').request, snapshot)).rejects.toThrow(
    'mcp_auth_original_unverified',
  );
  expect(f.counters.prepare).toBe(0);
  await f.port.submit(f.intent);
  expect(f.counters.post).toBe(0);
  expect(f.counters.callerGet).toBe(1);
  f.noHistory();
  f.sourceDrift();
  await expect(f.port.prepare(original('new').request, snapshot)).rejects.toThrow(
    'mcp_auth_source_changed',
  );
  expect(f.counters.prepare).toBe(0);
});

test('history uses exact public Command and finite result only, independent of removed Source/physical Workspace; terminal proof permits new explicit intent', async () => {
  const f = fixture();
  f.sourceDrift();
  const result = await f.port.lookup(f.intent, new AbortController().signal);
  expect(result.phase).toBe('completed');
  expect(result.fact?.authStatus).toBe('authenticated');
  expect(f.counters).toEqual({ query: 1, source: 0, prepare: 0, post: 0, callerGet: 1 });
});

test('wrong Store/subject/body refuses all HTTP; closed decoder rejects raw material and enum coercion', async () => {
  for (const change of ['store', 'subject', 'body'] as const) {
    const f = fixture();
    const i: TuiCallerIntent =
      change === 'store'
        ? { ...f.intent, scope: { ...f.intent.scope, storeId: 'foreign' } }
        : change === 'subject'
          ? { ...f.intent, subjectId: 'foreign' }
          : { ...f.intent, bodyDigest: 'f'.repeat(64) };
    expect(
      (
        await f.port
          .lookup(i, new AbortController().signal)
          .catch(() => ({ phase: 'outcome_unknown' }))
      ).phase,
    ).toBe('outcome_unknown');
    expect(f.counters.query).toBe(0);
    expect(f.counters.callerGet).toBe(0);
  }
  const f = fixture();
  expect(() =>
    decodeMcpAuthFact(display('builtin.mcp.auth.result', { ...f.fact, token: 'private' })),
  ).toThrow('mcp_auth_fact_invalid');
  expect(() =>
    decodeMcpAuthStatus(
      display('builtin.mcp.auth.status', {
        serverId,
        workspaceId: 'workspace',
        loginAllowed: true,
        policy: ['oauth'],
        status: 'available',
        credentialPresent: true,
      }),
    ),
  ).toThrow('mcp_auth_fact_invalid');
});

test('phase downgrade, wrong input/binding/subject/receipt and applied without terminal fact never authenticate or release unknown conflict', async () => {
  for (const change of [
    'phase',
    'input',
    'binding',
    'subject',
    'receipt',
    'effect',
    'reason',
  ] as const) {
    const f = fixture();
    if (change === 'phase') f.fact.phase = 'failed';
    else if (change === 'input') f.fact.execution!.inputDigest = 'e'.repeat(64);
    else if (change === 'binding') f.fact.binding!.workspaceId = 'other';
    else if (change === 'subject') f.fact.command!.subjectId = 'foreign';
    else if (change === 'receipt')
      f.command.receipt = {
        executionId: 'execution',
        status: 'running',
        preparingNextAttempt: false,
        finalizationDigest: 'b'.repeat(64),
      };
    else if (change === 'effect') f.fact.effectAttempted = false;
    else f.fact.reason = 'mcp_oauth_credentials_cleared';
    expect((await f.port.lookup(f.intent, new AbortController().signal)).phase).toBe(
      'outcome_unknown',
    );
    await expect(f.port.prepare(original('new').request, snapshot)).rejects.toThrow(
      'mcp_auth_original_unverified',
    );
    expect(f.counters.post).toBe(0);
  }
});

test('only verified terminal original allows a new durable prepare; each prepared identity consumes first POST once', async () => {
  const f = fixture();
  expect((await f.port.lookup(f.intent, new AbortController().signal)).phase).toBe('completed');
  const prepared = await f.port.prepare(original('next').request, snapshot);
  expect(f.counters.prepare).toBe(1);
  await f.port.submit(prepared);
  await f.port.submit(prepared);
  expect(f.counters.post).toBe(1);
  expect(f.counters.callerGet).toBe(2);
});
