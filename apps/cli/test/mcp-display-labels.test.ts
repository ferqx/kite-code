import { expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QueryResponse } from '@kite-ai/client';
import {
  decodeTuiMcpLabels,
  type TuiMcpConnectionIntent,
  type TuiMcpSourceSnapshot,
} from '@kite-ai/ui/tui';
import type { McpConnectionRecord } from '../host/mcp-connection-intents';
import type { McpConnectionJournal } from '../host/mcp-connection-journal';
import { mcpCanonical, mcpSha } from '../host/mcp-selection-intents';
import type { McpSourceApprovalJournal } from '../host/mcp-source-approval-journal';
import { createTuiMcpPort } from '../host/tui-mcp';

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'kite-mcp-labels-'));
  const root = realpathSync(temporary),
    stat = lstatSync(root),
    precise = lstatSync(root, { bigint: true });
  const workspaceIdentity = mcpCanonical({
    root,
    dev: String(precise.dev),
    ino: String(precise.ino),
  });
  const name = 'ActualMcpName',
    id = `mcp-${mcpSha({ name })}`;
  const identity = {
    kind: 'workspace' as const,
    pathDigest: 'd'.repeat(64),
    rootIdentity: mcpSha({ path: root, dev: stat.dev, ino: stat.ino }),
  };
  const sourceItem = {
    id,
    name,
    source: identity,
    rawEntryDigest: 'b'.repeat(64),
    transportDigest: 'a'.repeat(64),
    transport: 'http' as const,
    enabled: true,
    admitted: true,
    reason: null,
    configDigest: 'c'.repeat(64),
  };
  const sourceSet = {
    scopeDigest: 'f'.repeat(64),
    user: {
      identity: { kind: 'user' as const, pathDigest: 'e'.repeat(64), rootIdentity: 'a'.repeat(64) },
      etag: 'b'.repeat(64),
      error: null,
    },
    workspace: { identity, etag: 'c'.repeat(64), error: null },
    approvalEtag: 'd'.repeat(64),
    bindingEtag: 'e'.repeat(64),
    variablesDigest: 'f'.repeat(64),
  };
  const facts = {
    storeId: 'store',
    sessionId: 'a',
    workspaceId: 'workspace',
    workspaceIdentity,
    workspacePath: root,
    registryRevision: 'combined-registry',
    readSet: {
      userEtag: 'a'.repeat(64),
      workspaceEtag: 'b'.repeat(64),
      explicitDigest: 'c'.repeat(64),
      registryDigest: 'd'.repeat(64),
      registryRevision: 'combined-registry',
      scopeDigest: 'e'.repeat(64),
    },
    items: [
      {
        id,
        configDigest: sourceItem.configDigest,
        transport: sourceItem.transport,
        source: {
          kind: identity.kind,
          id: identity.pathDigest,
          revision: sourceItem.rawEntryDigest,
        },
        admitted: true,
        selected: true,
        available: true,
        reason: null,
      },
    ],
  };
  const sourceSnapshot: TuiMcpSourceSnapshot = {
    storeId: 'store',
    sessionId: 'a',
    workspaceId: 'workspace',
    workspaceIdentity,
    readSet: sourceSet,
    registryRevision: 'f'.repeat(64),
    items: [sourceItem],
    errors: { user: null, workspace: null, approval: null, binding: null },
  };
  const queries: { extension: string; query: string; input: unknown; signal?: AbortSignal }[] = [];
  let effects = 0,
    failLabels = false;
  let sourceHook: ((signal?: AbortSignal) => Promise<void>) | undefined;
  const forbidden = async (): Promise<never> => {
    effects++;
    throw Error('unexpected_effect');
  };
  const envelope = (extensionId: string, contentType: string, payload: unknown) =>
    [
      {
        extensionId,
        contentType,
        contentVersion: 1,
        summary: 'Read-only metadata',
        payload,
        actions: [],
        artifactRefs: [],
      },
    ] as QueryResponse;
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'subject' },
    queryExtension: async (
      _session: string,
      extension: string,
      query: string,
      input: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      queries.push({ extension, query, input, signal: options?.signal });
      if (query === 'mcp.servers')
        return envelope('builtin.mcp.management', 'builtin.mcp.servers', facts);
      if (extension === 'builtin.mcp' && query === 'mcp.catalogue')
        return envelope('builtin.mcp', 'builtin.mcp.catalogue', { items: [], nextAfterKey: null });
      if (query === 'mcp.sources') {
        if (failLabels) throw Error('source_temporarily_unavailable');
        await sourceHook?.(options?.signal);
        return envelope('builtin.mcp.sources', 'builtin.mcp.sources', {
          items: sourceSnapshot.items,
          nextAfterId: null,
          readSet: sourceSet,
          registryRevision: sourceSnapshot.registryRevision,
          errors: sourceSnapshot.errors,
        });
      }
      return forbidden();
    },
    getView: async () => ({
      storeId: 'store',
      session: { id: 'a', workspaceId: 'workspace', deletedAt: null },
    }),
    listAllWorkspaces: async () => [{ id: 'workspace', rootUri: pathToFileURL(root).href }],
    listWorkspaces: forbidden,
    invokeExtension: forbidden,
    getCommand: forbidden,
    getExecution: forbidden,
    getHostMutation: forbidden,
    readArtifact: forbidden,
  } as unknown as Parameters<typeof createTuiMcpPort>[0];
  const journal: McpSourceApprovalJournal = {
    prepare: () => {
      effects++;
      throw Error('unexpected_journal_write');
    },
    record: () => {
      effects++;
      throw Error('unexpected_journal_write');
    },
    list: () => {
      effects++;
      throw Error('unexpected_journal_read');
    },
    close: () => {},
  };
  const port = createTuiMcpPort(client, 'store', undefined, undefined, journal);
  return {
    facts,
    client,
    journal,
    sourceSnapshot,
    name,
    id,
    queries,
    port,
    effects: () => effects,
    failLabels: () => {
      failLabels = true;
    },
    holdLabels: (hook: NonNullable<typeof sourceHook>) => {
      sourceHook = hook;
    },
    close: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

test('first MCP directory reads actual source names and keeps canonical settings unchanged with zero writes, artifacts or journal calls', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  try {
    const before = structuredClone(f.facts);
    const actual = await f.port.read('a', signal);
    expect(actual.labels?.[f.id]).toBe(f.name);
    expect(Object.isFrozen(actual.labels)).toBe(true);
    const { labels: _labels, liveServerIds: _live, ...canonical } = actual;
    expect(actual.liveServerIds).toEqual([]);
    expect(canonical).toEqual(before);
    expect(f.facts).toEqual(before);
    expect(f.queries.map(({ extension, query, input }) => ({ extension, query, input }))).toEqual([
      { extension: 'builtin.mcp.management', query: 'mcp.servers', input: {} },
      { extension: 'builtin.mcp', query: 'mcp.catalogue', input: { limit: 100 } },
      { extension: 'builtin.mcp.sources', query: 'mcp.sources', input: { limit: 25 } },
    ]);
    expect(f.queries.every((request) => request.signal === signal)).toBe(true);
    expect(f.effects()).toBe(0);
  } finally {
    f.close();
  }
});

test('source labels require the same Store, Session, Workspace and exact registered source identity/configuration', () => {
  const f = fixture();
  try {
    for (const key of ['storeId', 'sessionId', 'workspaceId', 'workspaceIdentity'] as const) {
      expect(() => decodeTuiMcpLabels(f.facts, { ...f.sourceSnapshot, [key]: 'foreign' })).toThrow(
        'mcp_labels_scope_mismatch',
      );
    }
    for (const patch of [
      { id: `mcp-${'0'.repeat(64)}` },
      { rawEntryDigest: '0'.repeat(64) },
      { configDigest: '0'.repeat(64) },
      { transport: 'stdio' as const },
      { source: { ...f.sourceSnapshot.items[0]!.source, pathDigest: '0'.repeat(64) } },
      { source: { ...f.sourceSnapshot.items[0]!.source, rootIdentity: '0'.repeat(64) } },
    ]) {
      expect(
        Object.keys(
          decodeTuiMcpLabels(f.facts, {
            ...f.sourceSnapshot,
            items: [{ ...f.sourceSnapshot.items[0]!, ...patch }],
          }),
        ),
      ).toEqual([]);
    }
    expect(() =>
      decodeTuiMcpLabels(f.facts, {
        ...f.sourceSnapshot,
        items: [f.sourceSnapshot.items[0]!, f.sourceSnapshot.items[0]!],
      }),
    ).toThrow('mcp_labels_invalid');
    expect(f.effects()).toBe(0);
  } finally {
    f.close();
  }
});

test('unavailable optional names preserve accurate registry IDs without retrying queries; cancellation aborts the owned name read', async () => {
  const failed = fixture();
  try {
    failed.failLabels();
    expect(await failed.port.read('a', new AbortController().signal)).toEqual({
      ...failed.facts,
      liveServerIds: [],
    });
    expect(failed.queries.map(({ query }) => query)).toEqual([
      'mcp.servers',
      'mcp.catalogue',
      'mcp.sources',
    ]);
    expect(failed.effects()).toBe(0);
  } finally {
    failed.close();
  }
  const held = fixture(),
    read = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  held.holdLabels(
    (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        started();
      }),
  );
  try {
    const work = held.port.read('a', read.signal);
    await entered;
    read.abort(Error('owned_read_cancelled'));
    await expect(work).rejects.toThrow('owned_read_cancelled');
    expect(held.effects()).toBe(0);
  } finally {
    held.close();
  }
});

test('read-only labels are excluded from connection CAS, while a real canonical observation change still prevents the first POST', async () => {
  const f = fixture();
  const records: McpConnectionRecord[] = [],
    posts: unknown[] = [];
  const journal: McpConnectionJournal = {
    list: () => records,
    prepare: (record) => {
      records.push(record);
      return true;
    },
    record: () => {},
    close: () => {},
  };
  f.client.invokeExtension = async (sessionId, request) => {
    posts.push({ sessionId, request: structuredClone(request) });
    throw Error('deliberate_lost_response');
  };
  const port = createTuiMcpPort(f.client, 'store', undefined, journal, f.journal);
  const intent = (commandId: string): TuiMcpConnectionIntent => ({
    sessionId: 'a',
    workspaceId: f.facts.workspaceId,
    workspaceIdentity: f.facts.workspaceIdentity,
    request: {
      expectedStoreId: 'store',
      commandId,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp',
      actionId: 'mcp.connect',
      definitionVersion: '1',
      input: { serverId: f.id, key: 'original-key' },
    },
  });
  try {
    const actual = await port.read('a', new AbortController().signal);
    expect(actual.labels?.[f.id]).toBe(f.name);
    const original = intent('with-labels');
    expect((await port.connection!.submit(original, actual)).phase).toBe('outcome_unknown');
    expect(posts).toEqual([{ sessionId: 'a', request: original.request }]);
    expect(records).toHaveLength(1);
    await port.connection!.submit(intent('changed-config'), {
      ...actual,
      readSet: { ...actual.readSet, userEtag: '0'.repeat(64) },
    });
    expect(posts).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(f.queries.filter(({ query }) => query === 'mcp.servers')).toHaveLength(3);
    expect(f.effects()).toBe(0);
  } finally {
    f.close();
  }
});
