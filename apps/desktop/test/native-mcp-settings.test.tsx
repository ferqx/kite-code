import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createRef } from 'react';
import type {
  NativeBridge,
  NativeMcpFacts,
  NativeMcpRemovalPreview,
  NativeMcpRequest,
  NativeMcpResult,
  NativeMcpSubmission,
  NativeSelection,
} from '../src/native-bridge';

// Load React DOM with browser event support so real input/change events exercise controlled fields.
const bootstrap = new JSDOM('<div></div>');
const priorBootstrap = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeMcpSettings } = await import('../src/native-mcp-settings');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

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
    panelHost: HTMLElement,
  ) => Promise<void>,
) {
  const dom = new JSDOM('<main id="root"></main><div id="panel"></div>');
  // React imports before JSDOM in Bun, so its legacy input hooks need harmless shims.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
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
    panelHost = dom.window.document.getElementById('panel')!,
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
    await run(host, root, calls, bridge, panelHost);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find(
    (value) => value.textContent === label || value.getAttribute('aria-label') === label,
  )!;
test('MCP finite DOM scope selection needs confirmation, pagination is explicit and originals are never auto queried', async () =>
  fixture(async (host, root, calls, bridge, panelHost) => {
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          submissions={[original]}
        />,
      ),
    );
    expect(calls.map((value) => value.method)).toEqual(['settings.mcp.read']);
    expect(host.textContent).toContain('Outcome unknown; not completed');
    expect(button(host, 'Check original original').disabled).toBe(true);
    await act(async () => button(host, '管理连接 server').click());
    await act(async () => button(panelHost, 'Select workspace server: disable').click());
    expect(calls.filter((value) => value.method === 'settings.mcp.submit')).toHaveLength(0);
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
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
  fixture(async (host, root, calls, bridge, panelHost) => {
    const broken = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') throw Error('mcp_source_unavailable');
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={broken}
          generation={1}
          submissions={[original]}
        />,
      ),
    );
    expect(host.textContent).toContain('original');
    expect(host.textContent).toContain('mcp_source_unavailable');
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={2}
          submissions={[original]}
        />,
      ),
    );
    expect(
      calls.some((value) => value.method === 'settings.mcp.close' && value.generation === 1),
    ).toBe(true);
    expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
  }));
test('Main original projection replaces local pending without invalidating a same-Session view refresh', async () =>
  fixture(async (host, root, calls, bridge, panelHost) => {
    const selection = {
      storeId: 'store',
      session: { id: 'session' },
      viewSelection: 1,
      viewGeneration: 1,
    } as NativeSelection;
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selection}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, '管理连接 server').click());
    await act(async () => button(panelHost, 'Select workspace server: disable').click());
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
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
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={{ ...selection, viewGeneration: 2 }}
          submissions={[completed]}
        />,
      ),
    );
    expect(host.textContent).toContain('completed');
    expect(host.textContent).not.toContain('pending');
    await act(async () => button(host, '管理连接 server').click());
    expect(button(panelHost, 'Select workspace server: disable').disabled).toBe(false);
    expect(calls.filter((value) => value.method === 'settings.mcp.read')).toHaveLength(1);
    expect(calls.some((value) => value.method === 'settings.mcp.close')).toBe(false);
  }));
test('late old selection directory cannot replace the new view', async () =>
  fixture(async (host, root, _calls, bridge, panelHost) => {
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
      root.render(
        <NativeMcpSettings panelHost={panelHost} bridge={late} generation={1} submissions={[]} />,
      ),
    );
    await act(async () =>
      root.render(
        <NativeMcpSettings panelHost={panelHost} bridge={bridge} generation={2} submissions={[]} />,
      ),
    );
    await act(async () =>
      resolve({ ...facts, servers: [{ ...facts.servers[0]!, id: 'late-server' }] }),
    );
    expect(host.textContent).not.toContain('late-server');
    expect(host.textContent).toContain('server');
  }));

test('full immutable descriptor verifies ordered bytes and SHA while read closure never cancels execution', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
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
      root.render(
        <NativeMcpSettings panelHost={panelHost} bridge={bridge} generation={1} submissions={[]} />,
      ),
    );
    await act(async () => button(host, 'Open tools record').click());
    await act(async () => {
      button(panelHost, 'Read full descriptor 0').click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(panelHost.querySelector('[data-mcp-descriptor="verified"]')?.textContent).toBe(body);
    const chunks = calls.filter((value) => value.method === 'settings.mcp.descriptor.read');
    expect(chunks.length).toBeGreaterThan(1);
    expect(calls.some((value) => value.method === 'settings.mcp.descriptor.close')).toBe(true);
    expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
    await act(async () => button(panelHost, 'Close tool reader').click());
    expect(panelHost.querySelector('[data-mcp-descriptor="verified"]')).toBeNull();
  }));

test('Remove reads exact fallback preview before confirmation and failure cannot mutate', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
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
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          submissions={[original]}
        />,
      ),
    );
    expect(host.textContent).toContain('Select a current Session');
    await act(async () => button(host, `管理来源 workspace ${source.id}`).click());
    await act(async () => button(panelHost, `Remove exact workspace source ${source.id}`).click());
    expect(panelHost.textContent).toContain('mcp_removal_preview_unavailable');
    expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    expect(calls.some((value) => value.method === 'settings.mcp.submit')).toBe(false);
    fail = false;
    await act(async () => button(panelHost, `Remove exact workspace source ${source.id}`).click());
    expect(panelHost.textContent).toContain('Declaration to remove');
    expect(panelHost.textContent).toContain('user-fallback');
    expect(panelHost.textContent).toContain('Fallback after removal');
    expect(calls.some((value) => value.method === 'settings.mcp.submit')).toBe(false);
    await act(async () => button(panelHost, 'Close operation review').click());
    expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    expect(calls.some((value) => value.method === 'settings.mcp.submit')).toBe(false);
    await act(async () => button(panelHost, `Remove exact workspace source ${source.id}`).click());
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
    expect(calls.filter((value) => value.method === 'settings.mcp.submit')).toEqual([
      {
        method: 'settings.mcp.submit',
        generation: 1,
        observationId: 1,
        operation: { kind: 'remove', serverId: source.id, scope: 'workspace' },
      },
    ]);
  }));

const selected = {
  storeId: 'store',
  session: { id: 'session' },
  viewSelection: 1,
  viewGeneration: 1,
} as NativeSelection;
const source: NativeMcpFacts['sources'][number] = {
  id: 'mcp-source',
  name: 'Project source',
  source: { kind: 'workspace', pathDigest: 'a'.repeat(64), rootIdentity: 'b'.repeat(64) },
  rawEntryDigest: 'c'.repeat(64),
  transportDigest: 'd'.repeat(64),
  transport: 'http',
  enabled: true,
  admitted: true,
  reason: null,
  configDigest: 'e'.repeat(64),
};
const removalPreview: NativeMcpRemovalPreview = {
  kind: 'settings.mcp.removePreview',
  observationId: 1,
  serverId: source.id,
  scope: 'workspace',
  preview: {
    target: {
      serverId: source.id,
      name: source.name,
      source: source.source,
      rawEntryDigest: source.rawEntryDigest,
      transport: source.transport,
      enabled: source.enabled,
      reason: null,
    },
    fallback: null,
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}
const field = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
const edit = (host: HTMLElement, label: string, value: string) =>
  editField(field(host, label), value);
async function editField(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value);
    const event = input.ownerDocument.createEvent('Event');
    event.initEvent(input.tagName === 'SELECT' ? 'change' : 'input', true, true);
    input.dispatchEvent(event);
    // Other DOM tests can import React before a browser; drive its legacy input-change fallback too.
    if (input.tagName !== 'SELECT') {
      const keyup = input.ownerDocument.createEvent('Event');
      keyup.initEvent('keyup', true, true);
      input.dispatchEvent(keyup);
    }
  });
}
const submitted = (calls: NativeMcpRequest[]) =>
  calls.filter((value) => value.method === 'settings.mcp.submit');

test('Add and management use only the shared right rail, focus returns, and closing never cancels execution', async () =>
  fixture(async (host, root, calls, bridge, panelHost) => {
    const editorControl = createRef<{ close: () => void } | null>();
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          editorControl={editorControl}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('aside')).toBeNull();
    expect(panelHost.childElementCount).toBe(0);
    expect(editorControl.current).toBeNull();
    const add = button(host, '新增 MCP');
    await act(async () => add.click());
    expect(host.querySelector('form')).toBeNull();
    expect(panelHost.querySelector('aside.right-sidebar[aria-label="新增 MCP"]')).not.toBeNull();
    expect(panelHost.querySelector('form[aria-label="Add MCP source"]')).not.toBeNull();
    expect(host.ownerDocument.activeElement === field(panelHost, 'Name')).toBe(true);
    expect(editorControl.current).not.toBeNull();
    await edit(panelHost, 'Name', 'unsaved draft');
    await edit(panelHost, 'URL or command', 'https://example.invalid/mcp');
    await act(async () => button(panelHost, '取消').click());
    expect(panelHost.childElementCount).toBe(0);
    expect(host.ownerDocument.activeElement === add).toBe(true);
    await act(async () => add.click());
    expect(field(panelHost, 'Name').value).toBe('');
    expect(field(panelHost, 'URL or command').value).toBe('');
    await act(async () => editorControl.current!.close());
    expect(editorControl.current).toBeNull();
    expect(host.ownerDocument.activeElement === add).toBe(true);
    const manage = button(host, '管理连接 server');
    await act(async () => manage.click());
    expect(manage.getAttribute('aria-expanded')).toBe('true');
    expect(host.ownerDocument.activeElement === button(panelHost, '关闭')).toBe(true);
    expect(host.querySelector('input')).toBeNull();
    await act(async () => button(panelHost, '关闭').click());
    expect(manage.getAttribute('aria-expanded')).toBe('false');
    expect(host.ownerDocument.activeElement === manage).toBe(true);
    expect(panelHost.childElementCount).toBe(0);
    expect(submitted(calls)).toHaveLength(0);
    expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
  }));

test('Invalid add fields focus the exact input without submitting and the rail exposes no secret editor', async () =>
  fixture(async (host, root, calls, bridge, panelHost) => {
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, '新增 MCP').click());
    expect(
      [...panelHost.querySelectorAll('input')].map((input) => input.getAttribute('aria-label')),
    ).toEqual(['Name', 'URL or command']);
    expect(panelHost.querySelector('input[type="password"]')).toBeNull();
    await edit(panelHost, 'Name', '   ');
    await act(async () => button(panelHost, 'Review add source').click());
    expect(panelHost.textContent).toContain('mcp_name_required');
    expect(host.ownerDocument.activeElement === field(panelHost, 'Name')).toBe(true);
    expect(field(panelHost, 'Name').getAttribute('aria-invalid')).toBe('true');
    await edit(panelHost, 'Name', 'new source');
    for (const address of [
      '',
      'invalid-url',
      'ftp://example.invalid/mcp',
      'https://username:password@example.invalid/mcp',
      'https://example.invalid/mcp#fragment',
    ]) {
      await edit(panelHost, 'URL or command', address);
      await act(async () => button(panelHost, 'Review add source').click());
      expect(panelHost.textContent).toContain('mcp_http_url_invalid');
      expect(host.ownerDocument.activeElement === field(panelHost, 'URL or command')).toBe(true);
      expect(field(panelHost, 'URL or command').getAttribute('aria-invalid')).toBe('true');
      expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    }
    await edit(panelHost, 'Transport', 'stdio');
    await edit(panelHost, 'URL or command', 'relative-command');
    await act(async () => button(panelHost, 'Review add source').click());
    expect(panelHost.textContent).toContain('mcp_absolute_command_required');
    expect(host.ownerDocument.activeElement === field(panelHost, 'URL or command')).toBe(true);
    expect(submitted(calls)).toHaveLength(0);
    expect(calls.map((value) => value.method)).toEqual(['settings.mcp.read']);
  }));

test('Every add-field edit invalidates exact review and only the latest reviewed operation is submitted', async () =>
  fixture(async (host, root, calls, bridge, panelHost) => {
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, '新增 MCP').click());
    await edit(panelHost, 'Name', 'first');
    await edit(panelHost, 'URL or command', 'https://example.invalid/mcp');
    for (const [label, value] of [
      ['Name', '  final name  '],
      ['Scope', 'workspace'],
      ['URL or command', 'https://other.invalid/mcp'],
      ['Transport', 'stdio'],
    ] as const) {
      await act(async () => button(panelHost, 'Review add source').click());
      expect(button(panelHost, 'Confirm exact MCP operation')).not.toBeUndefined();
      expect(submitted(calls)).toHaveLength(0);
      await edit(panelHost, label, value);
      expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    }
    await edit(panelHost, 'URL or command', '/absolute/server');
    await act(async () => button(panelHost, 'Review add source').click());
    expect(field(panelHost, 'URL or command').getAttribute('aria-invalid')).toBe('false');
    expect(panelHost.textContent).toContain('/absolute/server');
    expect(submitted(calls)).toHaveLength(0);
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
    expect(submitted(calls)).toEqual([
      {
        method: 'settings.mcp.submit',
        generation: 1,
        observationId: 1,
        operation: {
          kind: 'add',
          name: 'final name',
          scope: 'workspace',
          entry: { type: 'stdio', command: '/absolute/server' },
        },
      },
    ]);
    expect(panelHost.childElementCount).toBe(0);
    expect(host.textContent).toContain('pending');
    expect(button(host, '新增 MCP').disabled).toBe(true);
    expect(host.ownerDocument.activeElement?.getAttribute('aria-label')).toBe(
      'Refresh MCP settings',
    );
  }));

for (const close of ['review', 'panel', 'other panel', 'refresh'] as const) {
  test(`A cancelled removal read cannot reappear after closing ${close}`, async () =>
    fixture(async (host, root, calls, _bridge, panelHost) => {
      const pending = deferred<NativeMcpRemovalPreview>();
      const bridge = {
        request: async (request: NativeMcpRequest) => {
          calls.push(request);
          if (request.method === 'settings.mcp.read') return { ...facts, sources: [source] };
          if (request.method === 'settings.mcp.removePreview') return pending.promise;
          return undefined;
        },
      } as unknown as NativeBridge;
      await act(async () =>
        root.render(
          <NativeMcpSettings
            panelHost={panelHost}
            bridge={bridge}
            generation={1}
            selection={selected}
            submissions={[]}
          />,
        ),
      );
      await act(async () => button(host, `管理来源 workspace ${source.id}`).click());
      await act(async () =>
        button(panelHost, `Remove exact workspace source ${source.id}`).click(),
      );
      expect(panelHost.querySelector('[aria-label="MCP removal preview loading"]')).not.toBeNull();
      if (close === 'review')
        await act(async () => button(panelHost, 'Close operation review').click());
      else if (close === 'panel') await act(async () => button(panelHost, '关闭').click());
      else if (close === 'other panel')
        await act(async () => button(host, '管理连接 server').click());
      else await act(async () => button(host, 'Refresh MCP settings').click());
      await act(async () => pending.resolve(removalPreview));
      expect(panelHost.querySelector('[aria-label="MCP removal preview loading"]')).toBeNull();
      expect(panelHost.querySelector('[aria-label="Exact source removal preview"]')).toBeNull();
      expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
      if (close === 'panel' || close === 'refresh') expect(panelHost.childElementCount).toBe(0);
      expect(submitted(calls)).toHaveLength(0);
      expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
    }));
}

test('A late submitted result cannot reopen a closed rail or replay and Main still projects the original', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
    const result = deferred<NativeMcpSubmission>();
    const bridge = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') return facts;
        if (request.method === 'settings.mcp.submit') return result.promise;
        return undefined;
      },
    } as unknown as NativeBridge;
    const render = (submissions: NativeMcpSubmission[] = []) =>
      act(async () =>
        root.render(
          <NativeMcpSettings
            panelHost={panelHost}
            bridge={bridge}
            generation={1}
            selection={selected}
            submissions={submissions}
          />,
        ),
      );
    await render();
    await act(async () => button(host, '管理连接 server').click());
    await act(async () => button(panelHost, 'Select workspace server: disable').click());
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
    expect(submitted(calls)).toHaveLength(1);
    await act(async () => button(panelHost, '关闭').click());
    const completed: NativeMcpSubmission = {
      ...original,
      storeId: 'store',
      sessionId: 'session',
      association: 'current',
      phase: 'completed',
    };
    await act(async () => result.resolve(completed));
    expect(panelHost.childElementCount).toBe(0);
    await render([completed]);
    expect(host.textContent).toContain('completed');
    expect(button(host, 'Check original original').disabled).toBe(false);
    expect(panelHost.childElementCount).toBe(0);
    expect(submitted(calls)).toHaveLength(1);
    expect(calls.some((value) => value.method === 'settings.mcp.lookup')).toBe(false);
    expect(calls.some((value) => value.method === 'settings.mcp.cancel')).toBe(false);
  }));

test('Observation refresh closes an unsubmitted review and a reopened rail uses only fresh facts', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
    let observationId = 1;
    const bridge = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') return { ...facts, observationId };
        if (request.method === 'settings.mcp.submit') return { ...original, phase: 'completed' };
        return undefined;
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, '管理连接 server').click());
    await act(async () => button(panelHost, 'Select workspace server: disable').click());
    expect(button(panelHost, 'Confirm exact MCP operation')).not.toBeUndefined();
    observationId = 2;
    await act(async () => button(host, 'Refresh MCP settings').click());
    expect(panelHost.childElementCount).toBe(0);
    expect(submitted(calls)).toHaveLength(0);
    await act(async () => button(host, '管理连接 server').click());
    expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    await act(async () => button(panelHost, 'Select user server: enable').click());
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
    expect(submitted(calls)).toEqual([
      {
        method: 'settings.mcp.submit',
        generation: 1,
        observationId: 2,
        operation: { kind: 'select', serverId: 'server', scope: 'user', enabled: true },
      },
    ]);
    expect(calls.filter((value) => value.method === 'settings.mcp.read')).toHaveLength(2);
  }));

test('Source binding edits discard the reviewed expiry and never expose or transmit credential secrets', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
    const bridge = {
      request: async (request: NativeMcpRequest) => {
        calls.push(request);
        if (request.method === 'settings.mcp.read') return { ...facts, sources: [source] };
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
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, `管理来源 workspace ${source.id}`).click());
    expect(panelHost.querySelectorAll('input')).toHaveLength(1);
    const expiry = panelHost.querySelector<HTMLInputElement>('input')!;
    expect(expiry.type).toBe('text');
    expect(expiry.inputMode).toBe('numeric');
    expect(panelHost.querySelector('input[type="password"], textarea')).toBeNull();
    const bind = () => button(panelHost, `Review existing credential binding ${source.id}`);
    expect(bind().disabled).toBe(true);
    await editField(expiry, String(Date.now() - 1));
    expect(bind().disabled).toBe(true);
    const firstExpiry = Date.now() + 3600000;
    await editField(expiry, String(firstExpiry));
    await act(async () => bind().click());
    expect(button(panelHost, 'Confirm exact MCP operation')).not.toBeUndefined();
    expect(submitted(calls)).toHaveLength(0);
    const latestExpiry = firstExpiry + 60000;
    await editField(expiry, String(latestExpiry));
    expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    await act(async () => bind().click());
    await act(async () => button(panelHost, 'Confirm exact MCP operation').click());
    expect(submitted(calls)).toEqual([
      {
        method: 'settings.mcp.submit',
        generation: 1,
        observationId: 1,
        operation: { kind: 'bind', serverId: source.id, expiresAt: latestExpiry },
      },
    ]);
    expect(calls.map((value) => value.method)).toEqual([
      'settings.mcp.read',
      'settings.mcp.submit',
    ]);
    expect(panelHost.childElementCount).toBe(0);
  }));

for (const changed of ['generation', 'bridge'] as const) {
  test(`An obsolete ${changed} read cannot finish a newer MCP loading state`, async () =>
    fixture(async (host, root, calls, _bridge, panelHost) => {
      const oldRead = deferred<NativeMcpFacts>();
      const newRead = deferred<NativeMcpFacts>();
      let reads = 0;
      const request = async (input: NativeMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.mcp.read')
          return ++reads === 1 ? oldRead.promise : newRead.promise;
        return undefined;
      };
      const bridge = { request } as unknown as NativeBridge;
      await act(async () =>
        root.render(
          <NativeMcpSettings
            panelHost={panelHost}
            bridge={bridge}
            generation={1}
            selection={selected}
            submissions={[]}
          />,
        ),
      );
      expect(button(host, 'Refresh MCP settings').disabled).toBe(true);
      await act(async () =>
        root.render(
          <NativeMcpSettings
            panelHost={panelHost}
            bridge={changed === 'bridge' ? ({ request } as unknown as NativeBridge) : bridge}
            generation={changed === 'generation' ? 2 : 1}
            selection={selected}
            submissions={[]}
          />,
        ),
      );
      expect(reads).toBe(2);
      await act(async () =>
        oldRead.resolve({ ...facts, servers: [{ ...facts.servers[0]!, id: 'obsolete-server' }] }),
      );
      expect(host.textContent).toContain('正在读取 MCP 配置');
      expect(button(host, 'Refresh MCP settings').disabled).toBe(true);
      expect(host.textContent).not.toContain('obsolete-server');
      await act(async () => newRead.resolve({ ...facts, observationId: 2 }));
      expect(host.textContent).not.toContain('正在读取 MCP 配置');
      expect(button(host, 'Refresh MCP settings').disabled).toBe(false);
      expect(button(host, '管理连接 server')).not.toBeUndefined();
      expect(calls.filter((input) => input.method === 'settings.mcp.close')).toHaveLength(1);
      expect(submitted(calls)).toHaveLength(0);
    }));
}

test('A failed tool read stops loading and a closed late read cannot change the next tool rail', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
    type ToolsResult = Extract<NativeMcpResult, { kind: 'settings.mcp.tools' }>;
    const oldRead = deferred<ToolsResult>();
    const newRead = deferred<ToolsResult>();
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
      toolCount: 0,
      index: null,
    };
    const page = (startIndex: number): ToolsResult => ({
      kind: 'settings.mcp.tools',
      observationId: 1,
      page: {
        version: 1,
        recordKey: 'record',
        binding: { ...origin, indexDigest: 'digest' },
        availability: 'available',
        reason: null,
        toolCount: 0,
        startIndex,
        entries: [],
        nextIndex: null,
        complete: true,
        live: true,
        currentGeneration: 1,
      },
    });
    let reads = 0;
    const bridge = {
      request: async (input: NativeMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.mcp.read') return { ...facts, snapshots: [snapshot] };
        if (input.method === 'settings.mcp.tools') {
          if (++reads === 1) throw Error('mcp_tools_unavailable');
          return reads === 2 ? oldRead.promise : newRead.promise;
        }
        return undefined;
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, 'Open tools record').click());
    expect(panelHost.textContent).toContain('mcp_tools_unavailable');
    expect(panelHost.textContent).not.toContain('正在读取工具快照');
    expect(panelHost.textContent).toContain('暂未取得工具快照');
    await act(async () => button(panelHost, 'Close tool reader').click());
    await act(async () => button(host, 'Open tools record').click());
    expect(panelHost.textContent).toContain('正在读取工具快照');
    await act(async () => button(panelHost, '关闭').click());
    expect(panelHost.childElementCount).toBe(0);
    await act(async () => button(host, 'Open tools record').click());
    await act(async () => oldRead.resolve(page(10)));
    expect(panelHost.textContent).toContain('正在读取工具快照');
    expect(panelHost.textContent).not.toContain('Tool page index 10');
    await act(async () => newRead.resolve(page(20)));
    expect(panelHost.textContent).not.toContain('正在读取工具快照');
    expect(panelHost.textContent).toContain('Tool page index 20');
    expect(panelHost.textContent).not.toContain('mcp_tools_unavailable');
    expect(submitted(calls)).toHaveLength(0);
    expect(calls.some((input) => input.method === 'settings.mcp.cancel')).toBe(false);
  }));

test('Cancelling a loading removal review restores its trigger and rejects the late preview', async () =>
  fixture(async (host, root, calls, _bridge, panelHost) => {
    const pending = deferred<NativeMcpRemovalPreview>();
    const bridge = {
      request: async (input: NativeMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.mcp.read') return { ...facts, sources: [source] };
        if (input.method === 'settings.mcp.removePreview') return pending.promise;
        return undefined;
      },
    } as unknown as NativeBridge;
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, `管理来源 workspace ${source.id}`).click());
    const remove = button(panelHost, `Remove exact workspace source ${source.id}`);
    await act(async () => {
      remove.focus();
      remove.click();
    });
    expect(panelHost.querySelector('[aria-label="MCP removal preview loading"]')).not.toBeNull();
    await act(async () => {
      const close = button(panelHost, 'Close operation review');
      close.focus();
      close.click();
    });
    expect(host.ownerDocument.activeElement === remove).toBe(true);
    expect(panelHost.querySelector('[aria-label="MCP removal preview loading"]')).toBeNull();
    await act(async () => pending.resolve(removalPreview));
    expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    expect(host.ownerDocument.activeElement === remove).toBe(true);
    expect(submitted(calls)).toHaveLength(0);
  }));

test('Exact add review receives focus and returning to edits restores the visible originating field', async () =>
  fixture(async (host, root, calls, bridge, panelHost) => {
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panelHost}
          bridge={bridge}
          generation={1}
          selection={selected}
          submissions={[]}
        />,
      ),
    );
    await act(async () => button(host, '新增 MCP').click());
    await edit(panelHost, 'Name', 'Reviewed source');
    await edit(panelHost, 'URL or command', 'https://example.invalid/mcp');
    for (const submitWith of ['button', 'field'] as const) {
      await act(async () => {
        if (submitWith === 'button') {
          const review = button(panelHost, 'Review add source');
          review.focus();
          review.click();
        } else {
          field(panelHost, 'URL or command').focus();
          panelHost.querySelector<HTMLFormElement>('form')!.requestSubmit();
        }
      });
      const heading = panelHost.querySelector('[aria-label="Confirm exact MCP operation"] h4');
      expect(heading).not.toBeNull();
      expect(host.ownerDocument.activeElement === heading).toBe(true);
      expect(heading?.getAttribute('tabindex')).toBe('-1');
      await act(async () => {
        const editAgain = button(panelHost, 'Close operation review');
        editAgain.focus();
        editAgain.click();
      });
      const expected = field(panelHost, submitWith === 'button' ? 'Name' : 'URL or command');
      expect(host.ownerDocument.activeElement === expected).toBe(true);
      expect(button(panelHost, 'Confirm exact MCP operation')).toBeUndefined();
    }
    expect(submitted(calls)).toHaveLength(0);
    expect(field(panelHost, 'Name').value).toBe('Reviewed source');
    expect(field(panelHost, 'URL or command').value).toBe('https://example.invalid/mcp');
  }));
