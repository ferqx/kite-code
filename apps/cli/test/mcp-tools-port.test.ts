import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentClient, McpToolsEntry, McpToolsSnapshot, QueryResponse } from '@kite-ai/client';
import { createTuiMcpPort } from '../host/tui-mcp';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fixture() {
  const origin = {
    originStoreId: 'original-store',
    sessionId: 'a',
    serverId: 'owned-tools',
    configDigest: 'c'.repeat(64),
    connectionExecutionId: 'connection-original',
    publisherExecutionId: 'publisher-original',
    generation: 1,
  };
  const metadata = {
    name: '完整😀'.repeat(50),
    description: 'original description',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: `${'α😀终'.repeat(120000)}FULL_SCHEMA_TAIL` },
      },
    },
    outputSchema: { type: 'object' },
    _meta: { original: true },
  };
  const body = bytes(metadata),
    blobs = new Map<string, Uint8Array>();
  const chunks: { id: string; size: string; hash: string }[] = [];
  for (let start = 0; start < body.length; start += 65536) {
    const id = `chunk-${chunks.length}`,
      content = body.slice(start, start + 65536);
    blobs.set(id, content);
    chunks.push({ id, size: String(content.length), hash: hash(content) });
  }
  const manifest = bytes({
    kind: 'mcp_tool_descriptor',
    version: 1,
    origin,
    toolIndex: 0,
    definitionId: 'tool-original',
    definitionVersion: '1',
    descriptorHash: hash(body),
    descriptorBytes: String(body.length),
    chunks,
  });
  blobs.set('manifest-original', manifest);
  const snapshot: McpToolsSnapshot = {
    recordKey: `tools/${'1'.repeat(64)}`,
    sourceRecordKey: 'connection/owned-tools/original',
    origin,
    availability: 'available',
    reason: null,
    toolCount: 1,
    index: {
      id: 'index-original',
      scope: { kind: 'execution', id: origin.publisherExecutionId },
      size: '100',
      hash: 'f'.repeat(64),
      mediaType: 'application/json; charset=utf-8',
    },
  };
  const entry: McpToolsEntry = {
    index: 0,
    definitionId: 'tool-original',
    definitionVersion: '1',
    label: metadata.name.slice(0, 120),
    labelComplete: false,
    descriptorHash: hash(body),
    descriptorBytes: String(body.length),
    manifest: {
      id: 'manifest-original',
      scope: { kind: 'execution', id: origin.publisherExecutionId },
      size: String(manifest.length),
      hash: hash(manifest),
      mediaType: 'application/json; charset=utf-8',
    },
  };
  // A complete code point is required even for the explicitly limited name preview.
  const label = entry.label;
  if (/[\ud800-\udbff]$/.test(label)) (entry as { label: string }).label = label.slice(0, -1);
  const page = {
    version: 1,
    recordKey: snapshot.recordKey,
    binding: { ...origin, indexDigest: snapshot.index!.hash },
    availability: 'available',
    reason: null,
    toolCount: 1,
    startIndex: 0,
    entries: [entry],
    nextIndex: null,
    complete: true,
    live: false,
    currentGeneration: null,
  };
  const queryCalls: { session: string; namespace: string; id: string; input: unknown }[] = [];
  const artifactCalls: Parameters<AgentClient['readArtifact']>[] = [];
  const client = {
    serverInfo: { storeId: 'current-store', subjectId: 'local-user' },
    async queryExtension(session: string, namespace: string, id: string, input: unknown) {
      queryCalls.push({ session, namespace, id, input });
      return [
        {
          extensionId: 'builtin.mcp',
          contentType:
            id === 'mcp.tools.snapshots' ? 'builtin.mcp.tools.snapshots' : 'builtin.mcp.tools',
          contentVersion: 1,
          summary: 'Original immutable metadata',
          actions: [],
          artifactRefs: [],
          payload:
            id === 'mcp.tools.snapshots'
              ? { version: 1, sessionId: 'a', items: [snapshot], nextAfterKey: null }
              : page,
        },
      ] as unknown as QueryResponse;
    },
    readArtifact: (async (...args: Parameters<AgentClient['readArtifact']>) => {
      artifactCalls.push(args);
      const ref = args[2]!.expectedReference!;
      const content = blobs.get(args[1].refId)!;
      return {
        content,
        reference: {
          id: args[1].refId,
          storeId: ref.storeId!,
          scope: args[1].scope,
          size: ref.size,
          mediaType: ref.mediaType,
          hash: ref.hash!,
        },
      };
    }) as AgentClient['readArtifact'],
  };
  const port = createTuiMcpPort(client as unknown as AgentClient, 'current-store');
  return { port, client, snapshot, page, entry, metadata, blobs, queryCalls, artifactCalls };
}

test('Host uses exact original Query bindings and public complete Artifact reader for Unicode schema beyond one MiB', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const snapshots = await f.port.readToolsSnapshots!('a', signal);
  const page = await f.port.readToolsPage!('a', snapshots.items[0]!, signal);
  const complete = await f.port.readToolDescriptor!('a', page.binding, page.entries[0]!, signal);
  expect(complete).toEqual(f.metadata);
  expect(f.artifactCalls.length).toBeGreaterThan(17);
  expect(
    f.artifactCalls.every(
      ([session, input, options]) =>
        session === 'a' &&
        input.expectedStoreId === 'current-store' &&
        input.scope.id === 'publisher-original' &&
        options?.expectedReference?.storeId === 'original-store' &&
        options.signal === signal,
    ),
  ).toBe(true);
  expect(f.queryCalls.map((call) => [call.namespace, call.id])).toEqual([
    ['builtin.mcp', 'mcp.tools.snapshots'],
    ['builtin.mcp', 'mcp.tools'],
  ]);
  expect(f.queryCalls[1]!.input).toEqual({
    recordKey: f.snapshot.recordKey,
    generation: 1,
    indexDigest: f.snapshot.index!.hash,
    afterIndex: 0,
    limit: 32,
  });
});

test('Host rejects swapped generation and changed current Store, and reader rejects corrupt final chunk without complete metadata', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  f.page.binding.generation = 2;
  await expect(f.port.readToolsPage!('a', f.snapshot, signal)).rejects.toThrow(
    'mcp_tools_scope_mismatch',
  );
  const last = [...f.blobs.keys()].filter((key) => key.startsWith('chunk-')).at(-1)!;
  f.blobs.set(last, new Uint8Array(f.blobs.get(last)!.length));
  await expect(
    f.port.readToolDescriptor!(
      'a',
      { ...f.snapshot.origin, indexDigest: f.snapshot.index!.hash },
      f.entry,
      signal,
    ),
  ).rejects.toThrow();
  f.client.serverInfo.storeId = 'wrong-store';
  const before = f.queryCalls.length;
  await expect(f.port.readToolsSnapshots!('a', signal)).rejects.toThrow('mcp_tools_scope_mismatch');
  expect(f.queryCalls).toHaveLength(before);
});

test('Host propagates reader abort and never publishes a late descriptor', async () => {
  const f = fixture(),
    abort = new AbortController();
  const original = f.client.readArtifact;
  f.client.readArtifact = (async (...args: Parameters<AgentClient['readArtifact']>) => {
    const value = await original(...args);
    abort.abort(Error('owned_reader_cancel'));
    return value;
  }) as AgentClient['readArtifact'];
  await expect(
    f.port.readToolDescriptor!('a', f.page.binding, f.entry, abort.signal),
  ).rejects.toThrow('owned_reader_cancel');
  expect(f.artifactCalls).toHaveLength(1);
  expect(f.queryCalls).toHaveLength(0);
});

test('Host rejects a nonadvancing cursor across legal empty pages but permits strict forward progress', async () => {
  const f = fixture(),
    after = `tools/${'a'.repeat(64)}`;
  let next = after;
  f.client.queryExtension = async () =>
    [
      {
        extensionId: 'builtin.mcp',
        contentType: 'builtin.mcp.tools.snapshots',
        contentVersion: 1,
        summary: 'Filtered original page',
        actions: [],
        artifactRefs: [],
        payload: { version: 1, sessionId: 'a', items: [], nextAfterKey: next },
      },
    ] as unknown as QueryResponse;
  await expect(
    f.port.readToolsSnapshots!('a', new AbortController().signal, { afterKey: after }),
  ).rejects.toThrow('mcp_tools_cursor_stale');
  next = `tools/${'b'.repeat(64)}`;
  expect(
    (await f.port.readToolsSnapshots!('a', new AbortController().signal, { afterKey: after }))
      .nextAfterKey,
  ).toBe(next);
});
