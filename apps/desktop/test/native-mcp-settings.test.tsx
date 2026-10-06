import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeMcpFacts,
  NativeMcpRequest,
  NativeMcpSubmission,
  NativeSelection,
} from '../src/native-bridge';
import { NativeMcpSettings } from '../src/native-mcp-settings';

const facts: NativeMcpFacts = {
  kind: 'settings.mcp',
  observationId: 1,
  storeId: 'store',
  sessionId: 'session',
  workspaceId: 'workspace',
  canWrite: true,
  errors: [],
  servers: [
    {
      id: 'server',
      configDigest: 'digest',
      transport: 'http',
      source: { kind: 'programmatic', id: 'program', revision: '1' },
      admitted: true,
      selected: true,
      available: true,
      reason: null,
    },
  ],
  sources: [],
  nextAfterId: 'source-cursor',
  snapshots: [],
  nextAfterKey: 'snapshot-cursor',
};
const original: NativeMcpSubmission = {
  kind: 'settings.mcp.submission',
  commandId: 'original',
  storeId: 'old-store',
  sessionId: 'old-session',
  workspaceId: 'workspace',
  actionId: 'mcp.connect',
  serverId: 'server',
  name: null,
  phase: 'outcome_unknown',
  association: 'unavailable',
  bodySha256: 'digest',
  requestSha256: 'digest',
};
async function fixture(
  run: (
    host: HTMLElement,
    root: ReturnType<typeof createRoot>,
    calls: NativeMcpRequest[],
    bridge: NativeBridge,
  ) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host),
    calls: NativeMcpRequest[] = [];
  const bridge = {
    request: async (request: NativeMcpRequest) => {
      calls.push(request);
      if (request.method === 'settings.mcp.read') return facts;
      if (request.method === 'settings.mcp.sources')
        return { kind: 'settings.mcp.sources', observationId: 1, sources: [], nextAfterId: null };
      if (request.method === 'settings.mcp.submit')
        return {
          ...original,
          storeId: 'store',
          sessionId: 'session',
          association: 'current',
          phase: 'pending',
        };
      return undefined;
    },
  } as unknown as NativeBridge;
  try {
    await run(host, root, calls, bridge);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((value) => value.textContent === label)!;
test('MCP finite DOM scope selection needs confirmation, pagination is explicit and originals are never auto queried', async () =>
  fixture(async (host, root, calls, bridge) => {
    await act(async () =>
      root.render(<NativeMcpSettings bridge={bridge} generation={1} submissions={[original]} />),
    );
    expect(calls.map((value) => value.method)).toEqual(['settings.mcp.read']);
    expect(host.textContent).toContain('Outcome unknown; not completed');
    expect(button(host, 'Check original original').disabled).toBe(true);
    await act(async () => button(host, 'Select workspace server: disable').click());
    expect(calls.filter((value) => value.method === 'settings.mcp.submit')).toHaveLength(0);
    await act(async () => button(host, 'Confirm exact MCP operation').click());
    expect(calls.find((value) => value.method === 'settings.mcp.submit')).toEqual({
      method: 'settings.mcp.submit',
      generation: 1,
      observationId: 1,
      operation: { kind: 'select', serverId: 'server', scope: 'workspace', enabled: false },
    });
    await act(async () => button(host, 'Next sources page').click());
    expect(calls.at(-1)).toEqual({
      method: 'settings.mcp.sources',
      generation: 1,
      observationId: 1,
      afterId: 'source-cursor',
    });
    expect(calls.some((value) => value.method === 'settings.mcp.lookup')).toBe(false);
  }));
test('empty/error directory preserves originals and cleanup closes readers without runtime cancellation', async () =>
  fixture(async (host, root, calls, bridge) => {
    const broken = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') throw Error('mcp_source_unavailable');
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(<NativeMcpSettings bridge={broken} generation={1} submissions={[original]} />),
    );
    expect(host.textContent).toContain('original');
    expect(host.textContent).toContain('mcp_source_unavailable');
    await act(async () =>
      root.render(<NativeMcpSettings bridge={bridge} generation={2} submissions={[original]} />),
    );
    expect(
      calls.some((value) => value.method === 'settings.mcp.close' && value.generation === 1),
    ).toBe(true);
    expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
  }));
test('Main original projection replaces local pending without invalidating a same-Session view refresh', async () =>
  fixture(async (host, root, calls, bridge) => {
    const selection = {
      storeId: 'store',
      session: { id: 'session' },
      viewSelection: 1,
      viewGeneration: 1,
    } as NativeSelection;
    await act(async () =>
      root.render(
        <NativeMcpSettings bridge={bridge} generation={1} selection={selection} submissions={[]} />,
      ),
    );
    await act(async () => button(host, 'Select workspace server: disable').click());
    await act(async () => button(host, 'Confirm exact MCP operation').click());
    expect(host.textContent).toContain('pending');
    const completed = {
      ...original,
      storeId: 'store',
      sessionId: 'session',
      association: 'current' as const,
      phase: 'completed' as const,
    };
    await act(async () =>
      root.render(
        <NativeMcpSettings
          bridge={bridge}
          generation={1}
          selection={{ ...selection, viewGeneration: 2 }}
          submissions={[completed]}
        />,
      ),
    );
    expect(host.textContent).toContain('completed');
    expect(host.textContent).not.toContain('pending');
    expect(button(host, 'Select workspace server: disable').disabled).toBe(false);
    expect(calls.filter((value) => value.method === 'settings.mcp.read')).toHaveLength(1);
    expect(calls.some((value) => value.method === 'settings.mcp.close')).toBe(false);
  }));
test('late old selection directory cannot replace the new view', async () =>
  fixture(async (host, root, _calls, bridge) => {
    let resolve!: (value: NativeMcpFacts) => void;
    const late = {
      request: (request: NativeMcpRequest) =>
        request.method === 'settings.mcp.read'
          ? new Promise<NativeMcpFacts>((done) => {
              resolve = done;
            })
          : Promise.resolve(undefined),
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(<NativeMcpSettings bridge={late} generation={1} submissions={[]} />),
    );
    await act(async () =>
      root.render(<NativeMcpSettings bridge={bridge} generation={2} submissions={[]} />),
    );
    await act(async () =>
      resolve({ ...facts, servers: [{ ...facts.servers[0]!, id: 'late-server' }] }),
    );
    expect(host.textContent).not.toContain('late-server');
    expect(host.textContent).toContain('server');
  }));

test('full immutable descriptor verifies ordered bytes and SHA while read closure never cancels execution', async () =>
  fixture(async (host, root, calls, _bridge) => {
    const body = JSON.stringify({
        name: 'original tool',
        description: 'full original descriptor',
        inputSchema: { type: 'object' },
      }),
      bytes = new TextEncoder().encode(body),
      digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    const origin = {
      originStoreId: 'store',
      sessionId: 'session',
      serverId: 'server',
      configDigest: 'digest',
      connectionExecutionId: 'connection',
      publisherExecutionId: 'publisher',
      generation: 1,
    };
    const snapshot = {
      recordKey: 'record',
      sourceRecordKey: 'record',
      origin,
      availability: 'available',
      reason: null,
      toolCount: 1,
      index: null,
    };
    const entry = {
      index: 0,
      definitionId: 'original.tool',
      definitionVersion: '1',
      label: 'original tool',
      labelComplete: true,
      descriptorHash: digest,
      descriptorBytes: String(bytes.length),
      manifest: {
        id: 'descriptor',
        scope: { kind: 'execution', id: 'publisher' },
        mediaType: 'application/octet-stream',
        size: String(bytes.length),
        hash: digest,
      },
    };
    const bridge = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') return { ...facts, snapshots: [snapshot] };
        if (request.method === 'settings.mcp.tools')
          return {
            kind: 'settings.mcp.tools',
            observationId: 1,
            page: {
              version: 1,
              recordKey: 'record',
              binding: { ...origin, indexDigest: 'digest' },
              availability: 'available',
              reason: null,
              toolCount: 1,
              startIndex: 0,
              entries: [entry],
              nextIndex: null,
              complete: true,
              live: true,
              currentGeneration: 1,
            },
          };
        if (request.method === 'settings.mcp.descriptor')
          return {
            kind: 'settings.mcp.descriptor',
            readId: request.readId,
            bodySha256: digest,
            bodyBytes: bytes.length,
          };
        if (request.method === 'settings.mcp.descriptor.read') {
          const end = Math.min(bytes.length, request.offset + 32);
          return {
            kind: 'settings.mcp.descriptor.chunk',
            readId: request.readId,
            offset: request.offset,
            nextOffset: end,
            eof: end === bytes.length,
            data: btoa(String.fromCharCode(...bytes.subarray(request.offset, end))),
          };
        }
        return undefined;
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(<NativeMcpSettings bridge={bridge} generation={1} submissions={[]} />),
    );
    await act(async () => button(host, 'Open tools record').click());
    await act(async () => {
      button(host, 'Read full descriptor 0').click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('[data-mcp-descriptor="verified"]')?.textContent).toBe(body);
    const chunks = calls.filter((value) => value.method === 'settings.mcp.descriptor.read');
    expect(chunks.length).toBeGreaterThan(1);
    expect(calls.some((value) => value.method === 'settings.mcp.descriptor.close')).toBe(true);
    expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
    await act(async () => button(host, 'Close tool reader').click());
    expect(host.querySelector('[data-mcp-descriptor="verified"]')).toBeNull();
  }));

test('Remove reads exact fallback preview before confirmation and failure cannot mutate', async () =>
  fixture(async (host, root, calls, _bridge) => {
    const sha = 'a'.repeat(64),
      source = {
        id: `mcp-${sha}`,
        name: 'project-server',
        source: { kind: 'workspace', pathDigest: sha, rootIdentity: sha },
        rawEntryDigest: sha,
        transportDigest: sha,
        transport: 'http',
        enabled: true,
        admitted: true,
        reason: null,
        configDigest: sha,
      };
    const target = {
        serverId: source.id,
        name: source.name,
        source: source.source,
        rawEntryDigest: sha,
        transport: 'http',
        enabled: true,
        reason: null,
      },
      fallback = { ...target, name: 'user-fallback', source: { ...source.source, kind: 'user' } };
    let fail = true;
    const bridge = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') return { ...facts, sources: [source] };
        if (request.method === 'settings.mcp.removePreview') {
          if (fail) throw Error('mcp_removal_preview_unavailable');
          return {
            kind: 'settings.mcp.removePreview',
            observationId: 1,
            serverId: source.id,
            scope: 'workspace',
            preview: { target, fallback },
          };
        }
        if (request.method === 'settings.mcp.submit')
          return {
            ...original,
            storeId: 'store',
            sessionId: 'session',
            association: 'current',
            phase: 'completed',
          };
        return undefined;
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(<NativeMcpSettings bridge={bridge} generation={1} submissions={[original]} />),
    );
    expect(host.textContent).toContain('Select a current Session');
    await act(async () => button(host, `Remove exact workspace source ${source.id}`).click());
    expect(host.textContent).toContain('mcp_removal_preview_unavailable');
    expect(button(host, 'Confirm exact MCP operation')).toBeUndefined();
    expect(calls.some((value) => value.method === 'settings.mcp.submit')).toBe(false);
    fail = false;
    await act(async () => button(host, `Remove exact workspace source ${source.id}`).click());
    expect(host.textContent).toContain('Declaration to remove');
    expect(host.textContent).toContain('user-fallback');
    expect(host.textContent).toContain('Fallback after removal');
    expect(calls.some((value) => value.method === 'settings.mcp.submit')).toBe(false);
    await act(async () => button(host, 'Close operation review').click());
    expect(button(host, 'Confirm exact MCP operation')).toBeUndefined();
    expect(calls.some((value) => value.method === 'settings.mcp.submit')).toBe(false);
    await act(async () => button(host, `Remove exact workspace source ${source.id}`).click());
    await act(async () => button(host, 'Confirm exact MCP operation').click());
    expect(calls.filter((value) => value.method === 'settings.mcp.submit')).toEqual([
      {
        method: 'settings.mcp.submit',
        generation: 1,
        observationId: 1,
        operation: { kind: 'remove', serverId: source.id, scope: 'workspace' },
      },
    ]);
  }));
