import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Execution, McpToolsSnapshot, SessionView } from '@kite-ai/client';
import type { TuiPort } from '@kite-ai/ui/tui';
import { createTuiToolLabelsReader } from '../../host/tui-tool-labels';

const digest = 'a'.repeat(64),
  serverId = `mcp-${'a'.repeat(64)}`;
const tool = (name: string, id = serverId): Execution => ({
  id: 'execution',
  originStoreId: 'store',
  sessionId: 'session',
  runId: 'run',
  kind: 'tool',
  definitionId: `mcp.${id}.${createHash('sha256').update(JSON.stringify(name)).digest('hex').slice(0, 32)}`,
  definitionVersion: 'b'.repeat(64),
  status: 'succeeded',
  result: null,
  resultRevision: '1',
  cancelRequestedAt: null,
});
type FrozenSource = {
  version: number;
  scope: { storeId: string; sessionId: string; workspaceId: string };
  selection: { present: boolean; serverIds: string[] };
  servers: { id: string; name: string; configDigest: string }[];
  inheritance?: {
    version: number;
    parentExecutionId: string;
    parentSessionId: string;
    rootSessionId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
  };
};
const frozenSource = (current: SessionView) =>
  (current.runs[0]!.configuration as { snapshot: { mcp: { sources: FrozenSource } } }).snapshot.mcp
    .sources;
const view = (execution: Execution): SessionView => ({
  storeId: 'store',
  snapshotCursor: '1',
  session: {
    id: 'session',
    workspaceId: 'w',
    rootSessionId: 'session',
    parentSessionId: null,
    title: 'original',
    controlRevision: '1',
    contextSelectionId: 'selection',
    nextSeq: '1',
    deletedAt: null,
  },
  runs: [
    {
      id: 'run',
      sessionId: 'session',
      originStoreId: 'store',
      originCommandId: 'command',
      status: 'completed',
      isActive: false,
      createdAt: 1,
      finishedAt: 2,
      reason: null,
      configuration: {
        snapshot: {
          mcp: {
            sources: {
              version: 1,
              scope: { storeId: 'store', sessionId: 'session', workspaceId: 'w' },
              selection: { present: true, serverIds: [serverId] },
              servers: [{ id: serverId, name: 'Frozen server', configDigest: digest }],
            },
          },
        },
      },
    },
  ],
  executions: [execution],
  messages: [],
});
const original: McpToolsSnapshot = {
  recordKey: 'tools/original',
  sourceRecordKey: 'connection/original',
  origin: {
    originStoreId: 'store',
    sessionId: 'session',
    serverId,
    configDigest: digest,
    connectionExecutionId: 'connection',
    publisherExecutionId: 'publisher',
    generation: 1,
  },
  availability: 'available',
  reason: null,
  toolCount: 1,
  index: {
    id: 'index',
    hash: 'c'.repeat(64),
    size: '100',
    scope: { kind: 'execution', id: 'publisher' },
    mediaType: 'application/json; charset=utf-8',
  },
};
function fixture(name: string, complete: boolean, selectedServerId = serverId) {
  const execution = tool(name, selectedServerId);
  const metadata = { ...original, origin: { ...original.origin, serverId: selectedServerId } };
  let snapshotReads = 0,
    descriptorReads = 0;
  const facts: Awaited<ReturnType<NonNullable<TuiPort['mcp']>['read']>> = {
    storeId: 'store',
    sessionId: 'session',
    workspaceId: 'w',
    workspaceIdentity: 'identity',
    workspacePath: '/original',
    registryRevision: '1',
    readSet: {
      userEtag: 'u',
      workspaceEtag: null,
      explicitDigest: digest,
      registryDigest: digest,
      registryRevision: '1',
      scopeDigest: digest,
    },
    labels: { [serverId]: 'Friendly server' },
    items: [
      {
        id: serverId,
        configDigest: digest,
        transport: 'stdio',
        source: { kind: 'programmatic', id: 'source', revision: '1' },
        admitted: true,
        selected: true,
        available: true,
        reason: null,
      },
    ],
  };
  const port = {
    async read() {
      return facts;
    },
    async readToolsSnapshots(sessionId: string) {
      snapshotReads++;
      return { version: 1 as const, sessionId, items: [metadata], nextAfterKey: null };
    },
    async readToolsPage() {
      return {
        version: 1 as const,
        recordKey: metadata.recordKey,
        binding: { ...metadata.origin, indexDigest: metadata.index!.hash },
        availability: 'available' as const,
        reason: null,
        toolCount: 1,
        startIndex: 0,
        entries: [
          {
            index: 0,
            definitionId: execution.definitionId,
            definitionVersion: execution.definitionVersion,
            label: complete ? name : name.slice(0, 10),
            labelComplete: complete,
            descriptorHash: 'd'.repeat(64),
            descriptorBytes: '100',
            manifest: metadata.index!,
          },
        ],
        nextIndex: null,
        complete: true,
        live: false,
        currentGeneration: 2,
      };
    },
    async readToolDescriptor() {
      descriptorReads++;
      return { name, inputSchema: { type: 'object' } };
    },
  };
  return {
    execution,
    port,
    facts,
    get snapshotReads() {
      return snapshotReads;
    },
    get descriptorReads() {
      return descriptorReads;
    },
  };
}
test('exact saved MCP metadata and frozen Run source name the proxy without current-directory or Tool RPC', async () => {
  const f = fixture('search_documents', true),
    reader = createTuiToolLabelsReader(f.port, 'store'),
    signal = new AbortController().signal;
  expect(await reader.read(view(f.execution), signal)).toEqual([
    {
      executionId: 'execution',
      originStoreId: 'store',
      sessionId: 'session',
      runId: 'run',
      definitionId: f.execution.definitionId,
      definitionVersion: f.execution.definitionVersion,
      label: 'Frozen server · search_documents',
    },
  ]);
  expect(f.descriptorReads).toBe(0);
  await reader.read(view(f.execution), signal);
  expect(f.snapshotReads).toBe(1);
  f.facts.labels = { [serverId]: 'Renamed today' };
  f.facts.items = [];
  f.port.read = async () => {
    throw Error('current_directory_must_not_be_read');
  };
  expect((await reader.read(view(f.execution), signal))[0]?.label).toBe(
    'Frozen server · search_documents',
  );
  await reader.read({ ...view(f.execution), executions: [] }, signal);
  await reader.read(view(f.execution), signal);
  expect(f.snapshotReads).toBe(2);
});
test('an incomplete label reads the original complete descriptor; missing exact version or foreign origin stays unnamed', async () => {
  const name = '完整真实工具名称🙂'.repeat(20),
    f = fixture(name, false),
    reader = createTuiToolLabelsReader(f.port, 'store'),
    signal = new AbortController().signal;
  expect((await reader.read(view(f.execution), signal))[0]?.label).toBe(`Frozen server · ${name}`);
  expect(f.descriptorReads).toBe(1);
  reader.clear();
  expect(
    await reader.read(view({ ...f.execution, definitionVersion: 'f'.repeat(64) }), signal),
  ).toEqual([]);
  const before = f.snapshotReads;
  expect(await reader.read(view({ ...f.execution, originStoreId: 'foreign' }), signal)).toEqual([]);
  expect(f.snapshotReads).toBe(before);
});

test('missing, foreign, duplicate and mismatched frozen source evidence never borrows today’s label', async () => {
  const f = fixture('search_documents', true),
    signal = new AbortController().signal;
  const read = async (value: SessionView) =>
    (await createTuiToolLabelsReader(f.port, 'store').read(value, signal))[0]?.label;
  expect(await read({ ...view(f.execution), runs: [] })).toBe('MCP · search_documents');
  const originalView = view(f.execution);
  const mutate = (change: (source: FrozenSource, run: SessionView['runs'][number]) => void) => {
    const changed = structuredClone(originalView);
    change(frozenSource(changed), changed.runs[0]!);
    return changed;
  };
  for (const change of [
    (source: FrozenSource) => {
      source.version = 2;
    },
    (source: FrozenSource) => {
      source.scope.storeId = 'foreign';
    },
    (source: FrozenSource) => {
      source.scope.sessionId = 'foreign';
    },
    (source: FrozenSource) => {
      source.scope.workspaceId = 'foreign';
    },
    (source: FrozenSource) => {
      source.selection.serverIds = [];
    },
    (source: FrozenSource) => {
      source.selection.serverIds.push(serverId);
    },
    (source: FrozenSource) => {
      source.servers[0]!.configDigest = 'e'.repeat(64);
    },
    (source: FrozenSource) => {
      source.servers.push({ ...source.servers[0]! });
    },
    (_source: FrozenSource, run: SessionView['runs'][number]) => {
      run.id = 'another-run';
    },
    (_source: FrozenSource, run: SessionView['runs'][number]) => {
      run.originStoreId = 'foreign';
    },
    (_source: FrozenSource, run: SessionView['runs'][number]) => {
      run.sessionId = 'foreign';
    },
  ])
    expect(await read(mutate(change))).toBe('MCP · search_documents');
  const duplicate = structuredClone(originalView);
  duplicate.runs.push({ ...duplicate.runs[0]! });
  expect(await read(duplicate)).toBe('MCP · search_documents');
  expect(await read(structuredClone(originalView))).toBe('Frozen server · search_documents');
});

test('descriptor proof rejects wrong name hash and mismatched metadata binding', async () => {
  const f = fixture('search_documents', true),
    signal = new AbortController().signal;
  const readPage = f.port.readToolsPage;
  f.port.readToolsPage = async () => {
    const page = await readPage();
    page.entries[0]!.label = 'other tool';
    return page;
  };
  await expect(
    createTuiToolLabelsReader(f.port, 'store').read(view(f.execution), signal),
  ).rejects.toThrow('tui_tool_label_name_identity_mismatch');
  f.port.readToolsPage = async () => {
    const page = await readPage();
    page.binding.configDigest = 'e'.repeat(64);
    return page;
  };
  await expect(
    createTuiToolLabelsReader(f.port, 'store').read(view(f.execution), signal),
  ).rejects.toThrow('tui_tool_label_page_scope_mismatch');
});

test('independent child label reads retain exact frozen role-wrapper inheritance without superseding parent reads', async () => {
  const f = fixture('search_documents', true),
    signal = new AbortController().signal;
  const current = view(f.execution);
  current.session.parentSessionId = 'parent';
  current.session.rootSessionId = 'parent';
  const run = current.runs[0]!,
    source = frozenSource(current);
  source.scope.sessionId = 'parent';
  source.inheritance = {
    version: 1,
    parentExecutionId: 'carrier',
    parentSessionId: 'parent',
    rootSessionId: 'parent',
    rootWorkCommandId: 'work',
    rootWorkSeq: '1',
  };
  run.carrierExecutionId = 'carrier';
  run.rootWorkCommandId = 'work';
  run.rootWorkSeq = '1';
  run.configuration = {
    snapshot: {
      roleId: 'worker',
      roleVersion: '1',
      roleModelId: null,
      roleToolIds: null,
      configuration: { mcp: { sources: source } },
    },
  };
  const reader = createTuiToolLabelsReader(f.port, 'store');
  const results = await Promise.all([
    reader.read(view(f.execution), signal),
    reader.readChild(current, signal),
  ]);
  expect(results.map((labels) => labels[0]?.label)).toEqual([
    'Frozen server · search_documents',
    'Frozen server · search_documents',
  ]);
  const invalid = structuredClone(current);
  (
    invalid.runs[0]!.configuration as {
      snapshot: { configuration: { mcp: { sources: FrozenSource } } };
    }
  ).snapshot.configuration.mcp.sources.inheritance!.parentExecutionId = 'other';
  expect((await reader.readChild(invalid, signal))[0]?.label).toBe('MCP · search_documents');
  const ambiguous = structuredClone(current);
  (
    ambiguous.runs[0]!.configuration as { snapshot: { mcp?: { sources: FrozenSource } } }
  ).snapshot.mcp = { sources: source };
  expect((await reader.readChild(ambiguous, signal))[0]?.label).toBe('MCP · search_documents');
  const grandchild = structuredClone(current);
  grandchild.session.parentSessionId = 'different-parent';
  expect((await reader.readChild(grandchild, signal))[0]?.label).toBe('MCP · search_documents');
});

test('static programmatic server names require one exact frozen selection and never expose generated source IDs', async () => {
  const f = fixture('search_documents', true, 'static-docs'),
    signal = new AbortController().signal;
  const current = view(f.execution);
  current.runs[0]!.configuration = {
    snapshot: { mcp: { servers: [{ id: 'static-docs', configDigest: digest }] } },
  };
  const read = async (value: SessionView) =>
    (await createTuiToolLabelsReader(f.port, 'store').read(value, signal))[0]?.label;
  expect(await read(current)).toBe('static-docs · search_documents');
  expect(await read(structuredClone(current))).toBe('static-docs · search_documents');
  for (const servers of [
    [],
    [{ id: 'static-docs', configDigest: 'e'.repeat(64) }],
    [
      { id: 'static-docs', configDigest: digest },
      { id: 'static-docs', configDigest: digest },
    ],
  ]) {
    const invalid = structuredClone(current);
    invalid.runs[0]!.configuration = { snapshot: { mcp: { servers } } };
    expect(await read(invalid)).toBe('MCP · search_documents');
  }
  const dynamic = fixture('search_documents', true),
    generated = view(dynamic.execution);
  generated.runs[0]!.configuration = {
    snapshot: { mcp: { servers: [{ id: serverId, configDigest: digest }] } },
  };
  expect(
    (await createTuiToolLabelsReader(dynamic.port, 'store').read(generated, signal))[0]?.label,
  ).toBe('MCP · search_documents');
});
