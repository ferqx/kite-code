import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Execution, McpToolsSnapshot, SessionView } from '@kite-ai/client';
import type { TuiPort } from '@kite-ai/ui/tui';
import { createTuiToolLabelsReader } from '../../host/tui-tool-labels';

const digest = 'a'.repeat(64),
  serverId = 'original-server';
const tool = (name: string): Execution => ({
  id: 'execution',
  originStoreId: 'store',
  sessionId: 'session',
  runId: 'run',
  kind: 'tool',
  definitionId: `mcp.${serverId}.${createHash('sha256').update(JSON.stringify(name)).digest('hex').slice(0, 32)}`,
  definitionVersion: 'b'.repeat(64),
  status: 'succeeded',
  result: null,
  resultRevision: '1',
  cancelRequestedAt: null,
});
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
  runs: [],
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
function fixture(name: string, complete: boolean) {
  const execution = tool(name);
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
      return { version: 1 as const, sessionId, items: [original], nextAfterKey: null };
    },
    async readToolsPage() {
      return {
        version: 1 as const,
        recordKey: original.recordKey,
        binding: { ...original.origin, indexDigest: original.index!.hash },
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
            manifest: original.index!,
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
test('exact saved MCP metadata names the formal proxy; matching current config supplies server label without Tool RPC', async () => {
  const f = fixture('search_documents', true),
    reader = createTuiToolLabelsReader(f.port, 'store'),
    signal = new AbortController().signal;
  expect(await reader.read(view(f.execution), signal, f.facts)).toEqual([
    {
      executionId: 'execution',
      originStoreId: 'store',
      sessionId: 'session',
      definitionId: f.execution.definitionId,
      definitionVersion: f.execution.definitionVersion,
      label: 'Friendly server · search_documents',
    },
  ]);
  expect(f.descriptorReads).toBe(0);
  await reader.read(view(f.execution), signal, f.facts);
  expect(f.snapshotReads).toBe(1);
  const historical = {
    ...f.facts,
    items: f.facts.items.map((item) => ({ ...item, configDigest: 'e'.repeat(64) })),
  };
  expect((await reader.read(view(f.execution), signal, historical))[0]?.label).toBe(
    'MCP · search_documents',
  );
  await reader.read({ ...view(f.execution), executions: [] }, signal, f.facts);
  await reader.read(view(f.execution), signal, f.facts);
  expect(f.snapshotReads).toBe(2);
});
test('an incomplete label reads the original complete descriptor; missing exact version or foreign origin stays unnamed', async () => {
  const name = '完整真实工具名称🙂'.repeat(20),
    f = fixture(name, false),
    reader = createTuiToolLabelsReader(f.port, 'store'),
    signal = new AbortController().signal;
  expect((await reader.read(view(f.execution), signal, f.facts))[0]?.label).toBe(
    `Friendly server · ${name}`,
  );
  expect(f.descriptorReads).toBe(1);
  reader.clear();
  expect(
    await reader.read(view({ ...f.execution, definitionVersion: 'f'.repeat(64) }), signal, f.facts),
  ).toEqual([]);
  const before = f.snapshotReads;
  expect(
    await reader.read(view({ ...f.execution, originStoreId: 'foreign' }), signal, f.facts),
  ).toEqual([]);
  expect(f.snapshotReads).toBe(before);
});
