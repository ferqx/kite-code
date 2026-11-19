import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { ExtensionRecord, ToolContext, ToolDefinition } from '../../../src/extensions';
import { createModelToolSurface, modelToolCall } from '../../../src/model-tools';
import { builtinCapability } from '../../../src/permissions/capabilities';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage/types';
import { createWebSearchExtension, type SearchPort } from '../../../src/tools/web-search';

const artifact = { id: 'evidence', size: '2', mediaType: 'application/json' };
const empty: SearchPort = {
  async search({ query }) {
    return { kind: 'results', query, items: [], truncated: false };
  },
};
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function records() {
  const db = new Map<string, ExtensionRecord>();
  return {
    async get(key: string) {
      return db.get(key) ?? null;
    },
    async write(input: Parameters<ToolContext['records']['write']>[0]) {
      const old = db.get(input.key);
      if ((old?.revision ?? null) !== input.expectedRevision)
        throw new AgentError('record_revision_conflict');
      const saved = {
        ...input,
        sessionId: 'session',
        extensionId: 'builtin.web-search',
        originStoreId: null,
        revision: String(Number(old?.revision ?? 0) + 1),
      };
      db.set(input.key, saved);
      return saved;
    },
    async list() {
      return [...db.values()];
    },
  };
}
function context(
  id: string,
  durable = records(),
  signal = new AbortController().signal,
): ToolContext {
  return {
    runId: 'run',
    sessionId: 'session',
    executionId: id,
    records: durable,
    signal,
    artifacts: { publish: async () => artifact },
  } as unknown as ToolContext;
}
function create(
  port: SearchPort,
  overrides: Partial<Parameters<typeof createWebSearchExtension>[0]> = {},
) {
  return createWebSearchExtension({
    provider: 'fixture',
    port,
    publishEvidence: async () => artifact,
    ...overrides,
  }).tools![0]!;
}

test('SQLite budgets six charged attempts across one Run, and closes and reopens with the same execution identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-search-tool-'));
  try {
    const profile = { dataRoot: root, profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const artifacts = createArtifactStore({ profile, store });
    const model = createFixedModel([
      [
        ...Array.from({ length: 7 }, (_, i) => ({
          type: 'tool_call' as const,
          id: `c${i}`,
          name: 'web_search',
          arguments: JSON.stringify({ query: `query ${i}` }),
        })),
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
      [
        { type: 'tool_call', id: 'denied', name: 'web_search', arguments: '{"query":"deny"}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    let denyTool = false;
    const sent: string[] = [];
    const extension = createWebSearchExtension({
      provider: 'fixture',
      port: {
        async search({ query }, { executionId, signal }) {
          signal.throwIfAborted();
          sent.push(executionId);
          return {
            kind: 'results',
            query,
            items: [],
            truncated: false,
            usage: { providerRequests: 1 },
          };
        },
      },
      publishEvidence: (block, c) =>
        runtime.publishWebSearchEvidence(
          {
            expectedStoreId,
            sessionId: c.sessionId,
            executionId: c.executionId,
            subjectId: 'owner',
            signal: c.signal,
          },
          block,
        ),
    });
    const runtime = createRuntime({
      store,
      artifacts,
      model,
      modelId: 'fixed',
      extensions: [extension],
      permissions: {
        authorize: async (request) => ({
          allowed: !denyTool || request.kind !== 'tool',
          revision: denyTool ? 'deny-search' : 'allow',
        }),
      },
    });
    let runId: string | undefined;
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'workspace',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'new',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'search',
      });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Search seven times' },
      });
      const work = await runtime.waitForCommand('work', { timeoutMs: 20000 });
      expect(work.status).toBe('applied');
      runId = (work.receipt as { runId: string }).runId;
      expect(sent).toHaveLength(6);
      const executions = (await store.listExecutions('s', 100)).filter((e) => e.kind === 'tool');
      expect(executions).toHaveLength(7);
      expect(
        executions
          .filter((e) => e.status === 'succeeded')
          .map((e) => e.id)
          .sort(),
      ).toEqual([...sent].sort());
      expect(executions.find((e) => e.status === 'failed')?.result).toMatchObject({
        content: 'web_search_budget_exhausted',
      });
      expect(model.requests).toHaveLength(2);
      for (const executionId of sent) {
        const evidence = await runtime.readWebSearchEvidence({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          executionId,
        });
        expect(evidence.blocks).toMatchObject([
          { status: 'completed', usage: { providerRequests: 1 }, sources: [] },
        ]);
      }
      denyTool = true;
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'independent',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'New task: a denied search' },
      });
      const denied = await runtime.waitForCommand('independent', { timeoutMs: 8000 });
      const deniedId = (denied.receipt as { runId: string }).runId;
      expect(deniedId).not.toBe(runId);
      const deniedTool = (await store.listExecutions('s', 100)).find(
        (e) => e.runId === deniedId && e.kind === 'tool',
      );
      expect(deniedTool?.status).toBe('failed');
      expect(sent).toHaveLength(6);
      expect(
        await store.getExtensionRecord({
          sessionId: 's',
          extensionId: 'builtin.web-search',
          key: `budget/${deniedId}`,
        }),
      ).toBeNull();
    } finally {
      await runtime.close();
    }
    const reopened = await openSqliteStore(profile);
    try {
      const budget = await reopened.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.web-search',
        key: `budget/${runId}`,
      });
      expect([...(budget?.value as string[])].sort()).toEqual([...sent].sort());
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('concurrent reservations recheck Store revisions, and an uncertain original execution cannot dispatch twice', async () => {
  let sends = 0;
  const port: SearchPort = {
    async search(input, c) {
      sends++;
      return empty.search(input, c);
    },
  };
  const durable = records();
  const tool = create(port);
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, (_, i) => tool.execute({ query: 'q' }, context(String(i), durable))),
  );
  expect(sends).toBe(6);
  expect(outcomes.filter((r) => r.outcome === 'succeeded')).toHaveLength(6);
  const retried = await create(port).execute({ query: 'q' }, context('0', durable));
  expect(retried).toMatchObject({
    outcome: 'outcome_unknown',
    content: 'web_search_already_reserved',
  });
  expect(sends).toBe(6);
});

test('forwards original cancellation; closed input and disabled child budget dispatch zero requests', async () => {
  let sends = 0;
  const c = new AbortController();
  const started = Promise.withResolvers<void>();
  const port: SearchPort = {
    async search(_input, options) {
      sends++;
      started.resolve();
      expect(options.executionId).toBe('running');
      expect(options.signal).toBe(c.signal);
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('private adapter diagnostic'), {
                code: 'search_cancelled',
                retrySafety: 'unknown',
                usage: { providerRequests: 1 },
              }),
            ),
          {
            once: true,
          },
        ),
      );
    },
  };
  expect(
    (await create(port, { maxRequests: 0 }).execute({ query: 'q' }, context('child'))).content,
  ).toBe('web_search_budget_exhausted');
  expect(
    (await create(port).execute({ query: 'q', provider: 'override' }, context('bad'))).content,
  ).toBe('web_search_input_invalid');
  expect(sends).toBe(0);
  const evidence: unknown[] = [];
  const pending = create(port, {
    publishEvidence: async (block) => {
      evidence.push(block);
      return artifact;
    },
  }).execute({ query: 'q' }, context('running', records(), c.signal));
  await started.promise;
  c.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled');
  expect(evidence).toMatchObject([
    {
      status: 'outcome_unknown',
      errorCode: 'web_search_cancelled',
      usage: { providerRequests: 1 },
    },
  ]);
  expect(sends).toBe(1);
});

test('bounded UTF-8 preview, distinct source/citation evidence, and stable secret-free failures', async () => {
  let saved: unknown;
  const source = {
    url: 'https://example.org/article',
    title: 'Article',
    snippet: '😀'.repeat(9000),
  };
  const tool = create(
    {
      async search({ query }) {
        return {
          kind: 'answer',
          query,
          searchPerformed: true,
          truncated: false,
          text: '😀'.repeat(9000),
          sources: [source, { ...source, url: 'https://user:pass@example.org' }],
          citations: [{ url: source.url, startIndex: 0, endIndex: 2 }],
        };
      },
    },
    {
      publishEvidence: async (block) => {
        saved = block;
        return artifact;
      },
    },
  );
  const result = await tool.execute({ query: 'original' }, context('big'));
  expect(result.outcome).toBe('succeeded');
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(16 * 1024);
  expect(result.content).toContain('untrusted data');
  expect(result.content).not.toContain('user:pass');
  expect(result.artifactRefs).toHaveLength(2);
  expect(result.modelContent).toBeUndefined();
  expect(saved).toMatchObject({
    truncated: true,
    sources: [source],
    citations: [{ url: source.url }],
  });
  const failure = await create({
    async search() {
      throw new Error('Bearer secret-value');
    },
  }).execute({ query: 'q' }, context('bad-response'));
  expect(JSON.stringify(failure)).not.toContain('secret');
});

test('only the registered search Tool has external network effects', () => {
  const cap = (ext: string, ver: string, kind: 'tool' | 'job') =>
    builtinCapability(ext, 'web.search', kind, 'builtin.planning', ver);
  expect(cap('builtin.web-search', '1', 'tool')).toEqual({
    effects: ['network', 'external'],
    safeRead: false,
  });
  for (const c of [
    cap('custom', '1', 'tool'),
    cap('builtin.web-search', '2', 'tool'),
    cap('builtin.web-search', '1', 'job'),
  ])
    expect(c).toEqual({ effects: ['unknown'], safeRead: false });
});

test('settings Search Test is a separate exact external/network action', () => {
  const cap = (kind: 'tool' | 'action' | 'job', version: string, ext = 'builtin.web-search-test') =>
    builtinCapability(ext, 'web_search.test', kind, 'builtin.planning', version);
  expect(cap('action', '1')).toEqual({ effects: ['network', 'external'], safeRead: false });
  for (const c of [
    cap('tool', '1'),
    cap('job', '1'),
    cap('action', '2'),
    cap('action', '1', 'custom'),
  ])
    expect(c).toEqual({ effects: ['unknown'], safeRead: false });
});

test('uses a single normalized query and reports known preflight versus uncertain charged failures', async () => {
  const evidence: unknown[] = [];
  const options = {
    publishEvidence: async (block: unknown) => {
      evidence.push(block);
      return artifact;
    },
  };
  const normalized = create(
    {
      async search(input, scope) {
        expect(input).toEqual({ query: 'source only' });
        return empty.search(input, scope);
      },
    },
    options,
  );
  expect((await normalized.execute({ query: '  source only  ' }, context('ok'))).outcome).toBe(
    'succeeded',
  );
  for (const [code, retrySafety, outcome] of [
    ['search_query_too_long', 'safe', 'failed'],
    ['search_timeout', 'unknown', 'outcome_unknown'],
  ] as const) {
    const port: SearchPort = {
      async search() {
        throw Object.assign(new Error('PRIVATE remote response'), {
          code,
          retrySafety,
          ...(outcome === 'outcome_unknown' ? { usage: { providerRequests: 1 } } : {}),
        });
      },
    };
    const failed = await create(port, options).execute({ query: 'q' }, context(code));
    expect(failed).toMatchObject({ outcome, content: code });
    expect(evidence.at(-1)).toMatchObject({
      status: outcome,
      errorCode: `web_${code}`,
      ...(outcome === 'outcome_unknown' ? { usage: { providerRequests: 1 } } : {}),
    });
    expect(JSON.stringify([failed, evidence])).not.toContain('PRIVATE');
  }
});

test('user and MCP search names round-trip in any order under both search routes', () => {
  const builtin = create(empty);
  const fn: ToolDefinition = { ...builtin, id: 'web_search', model: undefined };
  const mcp = { ...builtin, id: 'mcp.fixture.search' };
  const occupied = { ...builtin, id: 'web_search_1', model: undefined };
  for (const native of [true, false]) {
    const selected = native ? [fn, mcp, occupied] : [fn, mcp, occupied, builtin];
    for (const definitions of [selected, [...selected].reverse()]) {
      const request: ModelRequest = {
        modelId: 'm',
        requestId: 'r',
        messages: [],
        tools: definitions.map((d) => ({
          id: d.id,
          definitionVersion: d.version,
          inputSchema: d.inputSchema,
          description: d.description,
        })),
      };
      const surface = createModelToolSurface(
        request,
        new Map(definitions.map((d) => [d.id, d])),
        native,
      );
      expect(new Set(surface.tools.map((t) => t.id)).size).toBe(selected.length);
      expect(surface.tools.map((t) => t.id).includes('web_search')).toBe(!native);
      for (const [i, d] of definitions.entries()) {
        const alias = surface.tools[i]!.id;
        const decoded = surface.decode({ id: 'call', name: alias, arguments: '{"query":"q"}' });
        expect(decoded.name).toBe(d.id);
        expect(modelToolCall(decoded).name).toBe(alias);
      }
    }
  }
});

test('history from an earlier ordinary catalogue is re-encoded when a native route reserves the literal', () => {
  const original = create(empty);
  const user: ToolDefinition = { ...original, id: 'web_search', model: undefined };
  const occupied: ToolDefinition = { ...original, id: 'web_search_1', model: undefined };
  function surface(defs: ToolDefinition[], history: ModelRequest['messages'], native: boolean) {
    return createModelToolSurface(
      {
        modelId: 'fixed',
        requestId: 'r',
        messages: history,
        tools: defs.map((t) => ({
          id: t.id,
          definitionVersion: t.version,
          inputSchema: t.inputSchema,
          description: t.description,
        })),
      },
      new Map(defs.map((t) => [t.id, t])),
      native,
    );
  }
  const past = surface([user], [], false).decode({
    id: 'user-call',
    name: 'web_search',
    arguments: '{"query":"old"}',
  });
  const active = surface(
    [user, occupied],
    [{ role: 'assistant', content: '', toolCalls: [past] }],
    true,
  );
  expect(active.request.messages[0]!.toolCalls?.[0]?.name).toBe('web_search_2');
  const saved = active.decode({ id: 'again', name: 'web_search_2', arguments: '{"query":"new"}' });
  const later = surface(
    [occupied, user],
    [{ role: 'assistant', content: '', toolCalls: [past, saved] }],
    true,
  );
  expect(later.tools.map((t) => t.id)).toEqual(['web_search_1', 'web_search_2']);
  expect(later.request.messages[0]!.toolCalls).toEqual([
    { id: 'user-call', name: 'web_search_2', arguments: '{"query":"old"}' },
    { id: 'again', name: 'web_search_2', arguments: '{"query":"new"}' },
  ]);
  expect(later.decode({ id: 'x', name: 'web_search', arguments: '{}' }).model?.error).toBe(
    'tool_not_available',
  );
  expect(() => surface([original], [], true)).toThrow('conflicting_search_routes');
});
