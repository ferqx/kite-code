import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { QueryResponse } from '../src/generated/api';
import {
  createClient,
  decodeMcpToolsPage,
  decodeMcpToolsSnapshots,
  readMcpToolDescriptor,
} from '../src/index';

const jsonMime = 'application/json; charset=utf-8';
const chunkMime = 'application/octet-stream';
const currentStoreId = 'current-store';
const origin = {
  originStoreId: 'original-store',
  sessionId: 'original-session',
  serverId: 'local-peer',
  configDigest: 'a'.repeat(64),
  connectionExecutionId: 'connection-execution',
  publisherExecutionId: 'publisher-execution',
  generation: 3,
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const bytes = (value: unknown) => new TextEncoder().encode(canonical(value));
type Stored = { content: Uint8Array; mediaType: string };
function fixture() {
  const artifacts = new Map<string, Stored>();
  const internal = (id: string, content: Uint8Array, mediaType: string) => {
    artifacts.set(id, { content, mediaType });
    return { id, size: String(content.byteLength), hash: sha(content) };
  };
  // Place a four-byte scalar across the first exact 64 KiB chunk boundary.
  const base = { name: 'unicode-tool', description: '', inputSchema: { type: 'object' } };
  const descriptor = ListToolsResultSchema.parse({
    tools: [
      {
        ...base,
        description: '',
        title: '完整工具',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: '原始输入' } },
        },
        outputSchema: { type: 'object', properties: { tail: { const: 'OUTPUT-TAIL' } } },
        annotations: { title: '远端数据', readOnlyHint: true, destructiveHint: false },
        execution: { taskSupport: 'optional' },
        icons: [
          { src: 'https://example.invalid/icon.png', mimeType: 'image/png', sizes: ['32x32'] },
        ],
        _meta: { original: '保留\r\n元数据' },
      },
    ],
  }).tools[0]!;
  const prefix = canonical(descriptor).indexOf('"description":"') + '"description":"'.length;
  const prefixBytes = new TextEncoder().encode(canonical(descriptor).slice(0, prefix)).byteLength;
  descriptor.description = `${'x'.repeat(65535 - prefixBytes)}😀${'界'.repeat(350000)}ORIGINAL-TAIL`;
  const content = bytes(descriptor);
  const chunks = [];
  for (let start = 0; start < content.length; start += 65536) {
    chunks.push(internal(`chunk-${chunks.length}`, content.slice(start, start + 65536), chunkMime));
  }
  const manifest = {
    kind: 'mcp_tool_descriptor',
    version: 1,
    origin,
    toolIndex: 33,
    definitionId: 'mcp.local-peer.unicode',
    definitionVersion: 'b'.repeat(64),
    descriptorHash: sha(content),
    descriptorBytes: String(content.length),
    chunks,
  };
  const manifestRef = internal('manifest', bytes(manifest), jsonMime);
  const entry = {
    index: 33,
    definitionId: manifest.definitionId,
    definitionVersion: manifest.definitionVersion,
    label: descriptor.name,
    labelComplete: true,
    descriptorHash: manifest.descriptorHash,
    descriptorBytes: manifest.descriptorBytes,
    manifest: {
      ...manifestRef,
      scope: { kind: 'execution' as const, id: origin.publisherExecutionId },
      mediaType: jsonMime as typeof jsonMime,
    },
  };
  const binding = { ...origin, indexDigest: 'c'.repeat(64) };
  return { artifacts, internal, descriptor, content, manifest, entry, binding };
}

type WireMode =
  | 'valid'
  | 'hash'
  | 'size'
  | 'mime'
  | 'missing'
  | 'late'
  | 'body'
  | 'truncate'
  | 'store'
  | 'id';
async function wire(data = fixture()) {
  let mode: WireMode = 'valid';
  const requests: { method: string; id: string; storeId: string | null; scopeId: string | null }[] =
    [];
  const profile = { dataRoot: '/owned-fixture', name: 'mcp-tools', accessKey: 'fixture-key' };
  let releaseLate: (() => void) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/server')
        return Response.json({
          instanceId: 'fixture',
          buildId: 'fixture',
          apiMajor: 1,
          profile,
          dataAvailability: 'available',
          storeId: currentStoreId,
          capabilities: [],
        });
      const id = url.pathname.split('/').at(-1)!;
      requests.push({
        method: request.method,
        id,
        storeId: url.searchParams.get('storeId'),
        scopeId: url.searchParams.get('scopeId'),
      });
      const artifact = data.artifacts.get(id);
      if (!artifact || mode === 'missing')
        return Response.json(
          { code: 'artifact_not_found', message: 'Owned missing artifact' },
          { status: 404 },
        );
      if (mode === 'late')
        await new Promise<void>((resolve) => {
          releaseLate = resolve;
        });
      // Split the actual response too; successful readers must observe real EOF.
      const sent = artifact.content.slice(0, mode === 'truncate' ? -1 : undefined);
      if (mode === 'body') sent[0] = sent[0]! ^ 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sent.slice(0, 17));
          controller.enqueue(sent.slice(17));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': mode === 'mime' ? 'text/plain' : artifact.mediaType,
          'content-disposition': `attachment; filename="${id}"`,
          'cache-control': 'no-store',
          'x-artifact-id': mode === 'id' ? 'foreign-ref' : id,
          'x-artifact-store-id': mode === 'store' ? 'foreign-store' : origin.originStoreId,
          'x-artifact-hash': mode === 'hash' ? '0'.repeat(64) : sha(artifact.content),
          'x-artifact-size': String(artifact.content.length + (mode === 'size' ? 1 : 0)),
        },
      });
    },
  });
  const client = createClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: 'owned-fixture-token',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  try {
    await client.connect();
  } catch (error) {
    client.disposeNetwork();
    server.stop(true);
    throw error;
  }
  const before = client.lastAppliedCursor;
  return {
    ...data,
    client,
    requests,
    before,
    setMode(next: WireMode) {
      mode = next;
    },
    releaseLate() {
      releaseLate?.();
    },
    async read(ref: typeof data.entry.manifest, signal?: AbortSignal) {
      return client.readArtifact(
        origin.sessionId,
        {
          expectedStoreId: currentStoreId,
          refId: ref.id,
          scope: ref.scope,
        },
        {
          signal,
          expectedReference: {
            storeId: origin.originStoreId,
            size: ref.size,
            mediaType: ref.mediaType,
            hash: ref.hash,
          },
        },
      );
    },
    close() {
      releaseLate?.();
      client.disposeNetwork();
      server.stop(true);
    },
  };
}

test('owned public Artifact wire retains original Store identity and proves actual full EOF without advancing cursor', async () => {
  const owned = await wire();
  try {
    const result = await owned.read(owned.entry.manifest);
    expect(result.content).toEqual(bytes(owned.manifest));
    expect(result.reference.storeId).toBe(origin.originStoreId);
    expect(owned.content.length).toBeGreaterThan(1024 * 1024);
    expect(owned.client.lastAppliedCursor).toEqual(owned.before);
    expect(owned.requests).toEqual([
      {
        method: 'GET',
        id: 'manifest',
        storeId: currentStoreId,
        scopeId: origin.publisherExecutionId,
      },
    ]);
  } finally {
    owned.close();
  }
}, 10000);

for (const mode of [
  'hash',
  'size',
  'mime',
  'missing',
  'body',
  'truncate',
  'store',
  'id',
] as const) {
  test(`owned Artifact HTTP ${mode} fault rejects registered manifest bytes`, async () => {
    const owned = await wire();
    try {
      owned.setMode(mode);
      const expectedCode =
        mode === 'body'
          ? 'artifact_content_mismatch'
          : mode === 'truncate' || mode === 'id'
            ? 'invalid_response'
            : 'artifact_metadata_mismatch';
      if (mode === 'missing') await expect(owned.read(owned.entry.manifest)).rejects.toBeDefined();
      else
        await expect(owned.read(owned.entry.manifest)).rejects.toMatchObject({
          code: expectedCode,
        });
      expect(owned.client.lastAppliedCursor).toEqual(owned.before);
      expect(owned.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally {
      owned.close();
    }
  }, 10000);
}

async function until(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= end) throw Error('owned_http_observation_timeout');
    await Bun.sleep(5);
  }
}

test('public Artifact abort refuses late valid response and never issues a business POST', async () => {
  const owned = await wire();
  const controller = new AbortController();
  try {
    owned.setMode('late');
    const pending = owned.read(owned.entry.manifest, controller.signal);
    // Observe actual HTTP before abort, rather than substitute a callback proof.
    await until(() => owned.requests.length === 1);
    controller.abort(Error('owned_reader_cancelled'));
    owned.releaseLate();
    await expect(pending).rejects.toBeDefined();
    expect(owned.client.lastAppliedCursor).toEqual(owned.before);
    expect(owned.requests.map((request) => request.method)).toEqual(['GET']);
  } finally {
    controller.abort();
    owned.close();
  }
}, 10000);

function descriptorRead(owned: Awaited<ReturnType<typeof wire>>, signal?: AbortSignal) {
  return readMcpToolDescriptor({
    currentStoreId,
    sessionId: origin.sessionId,
    binding: owned.binding,
    entry: owned.entry,
    signal,
    readArtifact: (sessionId, input, options) =>
      owned.client.readArtifact(sessionId, input, options),
  });
}
function alterManifest(
  data: ReturnType<typeof fixture>,
  edit: (value: Record<string, unknown>) => void,
) {
  const manifest = structuredClone(data.manifest);
  // Explicit hostile immutable document; HTTP registers its true SHA and size.
  edit(manifest as unknown as Record<string, unknown>);
  const ref = data.internal('manifest', bytes(manifest), jsonMime);
  Object.assign(data.entry.manifest, ref);
}
function replaceBody(data: ReturnType<typeof fixture>, content: Uint8Array) {
  const chunks = [data.internal('replacement-chunk', content, chunkMime)];
  const hash = sha(content),
    size = String(content.length);
  data.entry.descriptorHash = hash;
  data.entry.descriptorBytes = size;
  alterManifest(data, (manifest) =>
    Object.assign(manifest, { chunks, descriptorHash: hash, descriptorBytes: size }),
  );
}

test('descriptor reader proves the complete original SDK Tool across Unicode chunk boundaries with one manifest GET', async () => {
  const owned = await wire();
  try {
    expect(Array.from(owned.content.slice(65535, 65539))).toEqual([240, 159, 152, 128]);
    const result = await descriptorRead(owned);
    expect(result).toEqual(owned.descriptor);
    expect(result.description?.endsWith('ORIGINAL-TAIL')).toBe(true);
    expect(result.outputSchema).toEqual(owned.descriptor.outputSchema);
    expect(result._meta).toEqual({ original: '保留\r\n元数据' });
    expect(owned.requests.map((request) => request.id)).toEqual([
      'manifest',
      ...owned.manifest.chunks.map((chunk) => chunk.id),
    ]);
    expect(owned.requests.filter((request) => request.id === 'manifest')).toHaveLength(1);
    console.info(
      'owned MCP descriptor proof',
      JSON.stringify({
        origin,
        currentStoreId,
        descriptorBytes: owned.entry.descriptorBytes,
        descriptorHash: owned.entry.descriptorHash,
        manifestHash: owned.entry.manifest.hash,
        manifestReads: 1,
        chunks: owned.manifest.chunks.length,
        unicodeStartByte: 65535,
        tail: 'ORIGINAL-TAIL',
        businessPOST: owned.requests.filter((request) => request.method === 'POST').length,
      }),
    );
    expect(
      owned.requests.every(
        (request) =>
          request.method === 'GET' &&
          request.storeId === currentStoreId &&
          request.scopeId === origin.publisherExecutionId,
      ),
    ).toBe(true);
    expect(owned.client.lastAppliedCursor).toEqual(owned.before);
  } finally {
    owned.close();
  }
}, 10000);

const manifestFaults: [string, (manifest: Record<string, unknown>) => void][] = [
  [
    'foreign origin',
    (m) => {
      m.origin = { ...origin, originStoreId: 'foreign' };
    },
  ],
  [
    'foreign session',
    (m) => {
      m.origin = { ...origin, sessionId: 'foreign-session' };
    },
  ],
  [
    'wrong publisher',
    (m) => {
      m.origin = { ...origin, publisherExecutionId: 'foreign-publisher' };
    },
  ],
  [
    'generation drift',
    (m) => {
      m.origin = { ...origin, generation: 4 };
    },
  ],
  [
    'definition swap',
    (m) => {
      m.definitionId = 'other-definition';
    },
  ],
  [
    'definition version drift',
    (m) => {
      m.definitionVersion = 'd'.repeat(64);
    },
  ],
  [
    'tool index drift',
    (m) => {
      m.toolIndex = 34;
    },
  ],
  [
    'descriptor digest drift',
    (m) => {
      m.descriptorHash = 'd'.repeat(64);
    },
  ],
  [
    'unexpected field',
    (m) => {
      m.extra = true;
    },
  ],
  [
    'future version',
    (m) => {
      m.version = 2;
    },
  ],
  [
    'repeat ref',
    (m) => {
      const c = m.chunks as unknown[];
      c[1] = c[0];
    },
  ],
  [
    'skip chunk',
    (m) => {
      (m.chunks as unknown[]).splice(1, 1);
    },
  ],
  [
    'oversized ref',
    (m) => {
      (m.chunks as { size: string }[])[0]!.size = '65537';
    },
  ],
  [
    'unsafe decimal',
    (m) => {
      (m.chunks as { size: string }[])[0]!.size = '9223372036854775808';
    },
  ],
  [
    'too many chunks',
    (m) => {
      m.chunks = Array.from({ length: 2049 }, (_, i) => ({
        id: `bad-${i}`,
        size: '65536',
        hash: 'e'.repeat(64),
      }));
    },
  ],
];
for (const [label, edit] of manifestFaults) {
  test(`original manifest ${label} refuses before any descriptor chunk request`, async () => {
    const data = fixture();
    alterManifest(data, edit);
    const owned = await wire(data);
    try {
      await expect(descriptorRead(owned)).rejects.toMatchObject({
        code: 'mcp_tools_metadata_invalid',
      });
      expect(owned.requests.map((request) => request.id)).toEqual(['manifest']);
      expect(owned.client.lastAppliedCursor).toEqual(owned.before);
    } finally {
      owned.close();
    }
  }, 10000);
}

for (const fault of [
  'swap',
  'missing',
  'fatal UTF-8',
  'invalid schema',
  'invalid manifest UTF-8',
] as const) {
  test(`actual descriptor ${fault} never yields prefix metadata`, async () => {
    const data = fixture();
    if (fault === 'swap')
      alterManifest(data, (m) => {
        const c = m.chunks as unknown[];
        [c[0], c[1]] = [c[1], c[0]];
      });
    if (fault === 'missing') data.artifacts.delete(data.manifest.chunks[1]!.id);
    if (fault === 'fatal UTF-8')
      replaceBody(data, Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
    if (fault === 'invalid schema')
      replaceBody(data, bytes({ name: data.descriptor.name, inputSchema: { type: 'array' } }));
    if (fault === 'invalid manifest UTF-8')
      Object.assign(
        data.entry.manifest,
        data.internal('manifest', Uint8Array.from([255]), jsonMime),
      );
    const owned = await wire(data);
    try {
      await expect(descriptorRead(owned)).rejects.toBeDefined();
      expect(owned.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(owned.client.lastAppliedCursor).toEqual(owned.before);
    } finally {
      owned.close();
    }
  }, 10000);
}

function display(contentType: string, payload: unknown): QueryResponse {
  // Decoder adversarial inputs deliberately cross the generated DTO type boundary.
  return [
    {
      extensionId: 'builtin.mcp',
      contentType,
      contentVersion: 1,
      summary: 'Original saved metadata',
      payload,
      actions: [],
      artifactRefs: [],
    },
  ] as unknown as QueryResponse;
}
function page(data = fixture()) {
  return {
    version: 1 as const,
    recordKey: `tools/${'a'.repeat(64)}`,
    binding: data.binding,
    availability: 'available' as const,
    reason: null,
    toolCount: 34,
    startIndex: 33,
    entries: [data.entry],
    nextIndex: null,
    complete: true,
    live: false,
    currentGeneration: null,
  };
}
function snapshots(data = fixture()) {
  return {
    version: 1 as const,
    sessionId: origin.sessionId,
    items: [
      {
        recordKey: `tools/${'a'.repeat(64)}`,
        sourceRecordKey: 'connection/local-peer/original-key',
        origin,
        availability: 'available' as const,
        reason: null,
        toolCount: 34,
        index: { ...data.entry.manifest, id: 'index-root' },
      },
    ],
    nextAfterKey: null,
  };
}

test('closed saved Query decoders preserve original identity and explicit unavailable facts', () => {
  const p = page(),
    s = snapshots();
  expect(decodeMcpToolsPage(display('builtin.mcp.tools', p))).toEqual(p);
  expect(decodeMcpToolsSnapshots(display('builtin.mcp.tools.snapshots', s))).toEqual(s);
  const filtered = { ...s, items: [], nextAfterKey: `tools/${'b'.repeat(64)}` };
  expect(decodeMcpToolsSnapshots(display('builtin.mcp.tools.snapshots', filtered))).toEqual(
    filtered,
  );
  const progressing = { ...s, nextAfterKey: `tools/${'b'.repeat(64)}` };
  expect(decodeMcpToolsSnapshots(display('builtin.mcp.tools.snapshots', progressing))).toEqual(
    progressing,
  );
  const unavailable = {
    ...p,
    availability: 'unavailable' as const,
    reason: 'mcp_tools_unavailable',
    entries: [],
    complete: false,
  };
  expect(decodeMcpToolsPage(display('builtin.mcp.tools', unavailable))).toEqual(unavailable);
  expect(() =>
    decodeMcpToolsPage(display('builtin.mcp.tools', { ...unavailable, complete: true })),
  ).toThrow();
  expect(() =>
    decodeMcpToolsSnapshots(display('builtin.mcp.tools.snapshots', { ...s, version: 2 })),
  ).toThrow();
  expect(() => decodeMcpToolsPage(display('builtin.mcp.tools', { ...p, extra: true }))).toThrow();
  expect(() =>
    decodeMcpToolsPage(display('builtin.mcp.tools', { ...p, nextIndex: 33, complete: false })),
  ).toThrow();
  expect(() =>
    decodeMcpToolsPage(
      display('builtin.mcp.tools', {
        ...p,
        binding: { ...p.binding, generation: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ),
  ).toThrow();
  expect(() =>
    decodeMcpToolsSnapshots(
      display('builtin.mcp.tools.snapshots', { ...s, nextAfterKey: `tools/${'0'.repeat(64)}` }),
    ),
  ).toThrow();
  const wrongSession = structuredClone(s);
  wrongSession.items[0]!.origin.sessionId = 'foreign';
  expect(() =>
    decodeMcpToolsSnapshots(display('builtin.mcp.tools.snapshots', wrongSession)),
  ).toThrow();
}, 10000);

for (const label of ['\ud800x', '\udc00', 'x\ud800']) {
  test('closed tool name preview refuses any broken surrogate', () => {
    const p = page();
    p.entries[0]!.label = label;
    expect(() => decodeMcpToolsPage(display('builtin.mcp.tools', p))).toThrow();
  }, 10000);
}

test('Query encoded UTF-8 budget applies to complete envelope and privileged refs/actions remain empty', () => {
  const p = page();
  const response = display('builtin.mcp.tools', p);
  expect(() =>
    decodeMcpToolsPage([{ ...response[0]!, summary: '界'.repeat(12000) }] as QueryResponse),
  ).toThrow();
  expect(() =>
    decodeMcpToolsPage([{ ...response[0]!, actions: [{}] }] as unknown as QueryResponse),
  ).toThrow();
  expect(() =>
    decodeMcpToolsPage([
      { ...response[0]!, artifactRefs: [p.entries[0]!.manifest] },
    ] as QueryResponse),
  ).toThrow();
}, 10000);

for (const fault of ['foreign session', 'foreign publisher', 'oversized descriptor'] as const) {
  test(`public entry ${fault} refuses before HTTP`, async () => {
    const data = fixture();
    if (fault === 'foreign session') data.binding.sessionId = 'foreign';
    if (fault === 'foreign publisher') data.entry.manifest.scope.id = 'foreign';
    if (fault === 'oversized descriptor') data.entry.descriptorBytes = '134217729';
    const owned = await wire(data);
    try {
      await expect(descriptorRead(owned)).rejects.toMatchObject({
        code: 'mcp_tools_metadata_invalid',
      });
      expect(owned.requests).toHaveLength(0);
    } finally {
      owned.close();
    }
  }, 10000);
}

test('descriptor reader cancellation during actual manifest HTTP refuses late metadata and leaves cursor/business untouched', async () => {
  const owned = await wire();
  const controller = new AbortController();
  try {
    owned.setMode('late');
    const pending = descriptorRead(owned, controller.signal);
    await until(() => owned.requests.length === 1);
    controller.abort(Error('owned_descriptor_cancelled'));
    owned.releaseLate();
    await expect(pending).rejects.toBeDefined();
    expect(owned.requests.map((request) => request.id)).toEqual(['manifest']);
    expect(owned.client.lastAppliedCursor).toEqual(owned.before);
  } finally {
    controller.abort();
    owned.close();
  }
}, 10000);
