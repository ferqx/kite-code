import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createRef } from 'react';
import type {
  NativeUserMcpFacts,
  NativeUserMcpRequest,
  NativeUserMcpResult,
  NativeUserMcpSubmission,
} from '../src/mcp-bridge';
import type { NativeBridge } from '../src/native-bridge';

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
const serverId = `mcp-${'1'.repeat(64)}`;
const facts: NativeUserMcpFacts = {
  kind: 'settings.userMcp',
  observationId: 1,
  storeId: 'store',
  canWrite: true,
  errors: [],
  sources: [
    {
      id: serverId,
      name: 'Knowledge',
      transport: 'http',
      address: 'https://example.com/mcp',
      enabled: true,
      configured: true,
      diagnostics: [],
      authentication: { policy: 'oauth', status: 'unknown', loginAllowed: true },
      connection: { state: 'ready', generation: 2, toolCount: 1 },
    },
  ],
};
const original: NativeUserMcpSubmission = {
  kind: 'settings.userMcp.submission',
  commandId: 'secret-original-id',
  storeId: 'store',
  operation: { kind: 'connect', serverId },
  phase: 'outcome_unknown',
  association: 'current',
};
async function fixture(
  run: (f: {
    host: HTMLElement;
    panel: HTMLElement;
    bridge: NativeBridge;
    calls: NativeUserMcpRequest[];
    render: (options?: {
      storeId?: string;
      generation?: number;
      submissions?: readonly NativeUserMcpSubmission[];
      bridge?: NativeBridge;
    }) => Promise<void>;
    root: ReturnType<typeof createRoot>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<main id="root"></main><div id="panel"></div>');
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
    panel = dom.window.document.getElementById('panel')!,
    root = createRoot(host),
    calls: NativeUserMcpRequest[] = [];
  const bridge = {
    request: async (input: NativeUserMcpRequest) => {
      calls.push(input);
      if (input.method === 'settings.userMcp.read') return facts;
      if (input.method === 'settings.userMcp.submit')
        return { ...original, operation: input.operation, phase: 'completed' };
      if (input.method === 'settings.userMcp.lookup' || input.method === 'settings.userMcp.cancel')
        return {
          ...original,
          phase: input.method === 'settings.userMcp.cancel' ? 'cancelled' : 'outcome_unknown',
        };
      if (input.method === 'settings.userMcp.tools')
        return {
          kind: 'settings.userMcp.tools',
          observationId: 1,
          page: {
            scope: 'user',
            storeId: 'store',
            serverId,
            generation: 2,
            entries: [
              {
                index: 0,
                definitionId: 'internal-tool-id',
                definitionVersion: '1'.repeat(64),
                descriptor: { name: 'search', description: 'Search knowledge.' },
              },
            ],
            nextAfterIndex: null,
            complete: true,
          },
        };
      return undefined;
    },
  } as unknown as NativeBridge;
  const render = async (
    options: {
      storeId?: string;
      generation?: number;
      submissions?: readonly NativeUserMcpSubmission[];
      bridge?: NativeBridge;
    } = {},
  ) => {
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panel}
          bridge={options.bridge ?? bridge}
          generation={options.generation ?? 1}
          storeId={options.storeId ?? 'store'}
          submissions={options.submissions ?? []}
        />,
      ),
    );
  };
  try {
    await run({ host, panel, bridge, calls, render, root });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  )!;
const type = (host: HTMLElement, label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const window = input.ownerDocument.defaultView!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
    input,
    value,
  );
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
test('global MCP reads and edits without any Session and exposes no project scope', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    expect(calls).toEqual([{ method: 'settings.userMcp.read', generation: 1 }]);
    expect(host.textContent).toContain('Knowledge');
    expect(host.textContent).not.toContain('选择会话');
    expect(host.textContent).not.toContain('工作区');
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '停用').click());
    expect(calls.find((c) => c.method === 'settings.userMcp.submit')).toEqual({
      method: 'settings.userMcp.submit',
      generation: 1,
      observationId: 1,
      operation: { kind: 'enabled', serverId, enabled: false },
    });
    await render();
    expect(calls.filter((c) => c.method === 'settings.userMcp.read')).toHaveLength(2);
  }));
test('add reuses the right sidebar, validates fields and confirms the exact user-only operation', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    await act(async () => button(host, '新增 MCP').click());
    expect(panel.ownerDocument.activeElement?.getAttribute('aria-label')).toBe('Name');
    expect(panel.querySelector('select[aria-label="Scope"]')).toBeNull();
    await act(async () => button(panel, '添加').click());
    expect(panel.textContent).toContain('请填写名称');
    await act(async () => type(panel, 'Name', 'new-server'));
    await act(async () => type(panel, 'URL or command', 'https://example.com/mcp?token=private'));
    await act(async () => button(panel, '添加').click());
    expect(panel.textContent).toContain('不含登录信息或查询参数');
    expect(calls.some((c) => c.method === 'settings.userMcp.submit')).toBe(false);
    await act(async () => type(panel, 'URL or command', 'https://example.com/new'));
    await act(async () => button(panel, '添加').click());
    expect(panel.textContent).toContain('确认更改');
    expect(calls.some((c) => c.method === 'settings.userMcp.submit')).toBe(false);
    await act(async () => button(panel, 'Confirm exact MCP operation').click());
    expect(calls.find((c) => c.method === 'settings.userMcp.submit')).toEqual({
      method: 'settings.userMcp.submit',
      generation: 1,
      observationId: 1,
      operation: {
        kind: 'add',
        name: 'new-server',
        entry: { type: 'http', url: 'https://example.com/new' },
      },
    });
    expect(panel.textContent).toBe('');
    expect(host.ownerDocument.activeElement === button(host, '新增 MCP')).toBe(true);
  }));
test('rerendering after Session changes keeps the global list, open editor and read lease', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    await act(async () => button(host, '新增 MCP').click());
    await act(async () => type(panel, 'Name', 'preserved'));
    await render();
    expect(panel.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe(
      'preserved',
    );
    expect(calls.map((c) => c.method)).toEqual(['settings.userMcp.read']);
  }));
test('unknown originals require explicit lookup or cancel and never show internal metadata', async () =>
  fixture(async ({ host, calls, render }) => {
    await render({ submissions: [original] });
    expect(host.textContent).toContain('操作结果待确认');
    expect(host.textContent).not.toContain(original.commandId);
    expect(host.textContent).not.toContain(serverId);
    expect(button(host, '新增 MCP').disabled).toBe(true);
    expect(calls.some((c) => c.method.includes('lookup'))).toBe(false);
    await act(async () => button(host, '查看结果').click());
    expect(calls.at(-1)).toEqual({
      method: 'settings.userMcp.lookup',
      generation: 1,
      commandId: original.commandId,
    });
    await act(async () => button(host, '取消操作').click());
    expect(calls.find((c) => c.method === 'settings.userMcp.cancel')).toEqual({
      method: 'settings.userMcp.cancel',
      generation: 1,
      commandId: original.commandId,
    });
    expect(calls.some((c) => c.method === 'settings.userMcp.submit')).toBe(false);
  }));
test('unavailable originals remain visible after read failure and cannot be queried on another Store', async () =>
  fixture(async ({ host, calls, render }) => {
    const broken = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read') throw Error('mcp_source_unavailable');
      },
    } as unknown as NativeBridge;
    await render({ bridge: broken, submissions: [{ ...original, association: 'unavailable' }] });
    expect(host.textContent).toContain('操作结果待确认');
    expect(host.textContent).toContain('暂时无法读取配置');
    expect(button(host, '查看结果').disabled).toBe(true);
    expect(calls.some((c) => c.method.includes('lookup'))).toBe(false);
  }));
test('tools display names and descriptions and closing the editor never cancels a business operation', async () =>
  fixture(async ({ host, panel, calls, bridge, root }) => {
    const editorControl = createRef<{ close: () => void }>();
    await act(async () =>
      root.render(
        <NativeMcpSettings
          panelHost={panel}
          bridge={bridge}
          generation={1}
          storeId="store"
          submissions={[]}
          editorControl={editorControl}
        />,
      ),
    );
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '查看工具').click());
    expect(panel.textContent).toContain('search');
    expect(panel.textContent).toContain('Search knowledge.');
    expect(panel.textContent).not.toContain('internal-tool-id');
    await act(async () => editorControl.current!.close());
    expect(panel.textContent).toBe('');
    expect(calls.some((c) => c.method === 'settings.userMcp.cancel')).toBe(false);
  }));
test('late reads from a previous Store cannot replace the current global view', async () =>
  fixture(async ({ host, calls, render }) => {
    let resolveOld!: (result: NativeUserMcpResult) => void;
    let count = 0;
    const controlled = {
      request: (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read') {
          if (++count === 1)
            return new Promise<NativeUserMcpResult>((resolve) => {
              resolveOld = resolve;
            });
          return Promise.resolve({ ...facts, storeId: 'other-store', sources: [] });
        }
        return Promise.resolve(undefined);
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await render({ bridge: controlled, storeId: 'other-store', generation: 2 });
    await act(async () => resolveOld(facts));
    expect(host.textContent).not.toContain('Knowledge');
    expect(host.textContent).toContain('暂无 MCP');
    expect(calls.filter((c) => c.method === 'settings.userMcp.close')).toEqual([
      { method: 'settings.userMcp.close', generation: 1 },
    ]);
  }));

test.each([
  false,
  true,
])('an owner with configured=%s exposes only exact disconnect despite read errors or unrelated pending operations', async (configured) =>
  fixture(async ({ host, panel, calls, render }) => {
    const unavailable: NativeUserMcpFacts = {
      ...facts,
      canWrite: false,
      errors: ['mcp_source_unavailable'],
      sources: [
        {
          ...facts.sources[0]!,
          enabled: configured,
          configured,
          diagnostics: ['mcp_source_entry_missing'],
          connection: configured
            ? facts.sources[0]!.connection
            : { state: 'failed', generation: null, toolCount: null },
        },
      ],
    };
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read') return unavailable;
        if (input.method === 'settings.userMcp.submit')
          return {
            ...original,
            commandId: 'exact-stop',
            operation: input.operation,
            phase: 'completed',
          };
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled, submissions: [original] });
    expect(button(host, '新增 MCP').disabled).toBe(true);
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('配置已不可用');
    expect(host.textContent).toContain(configured ? '已连接' : '待断开');
    expect(button(panel, '断开连接').disabled).toBe(false);
    for (const label of [
      '启用',
      '停用',
      '建立连接',
      '重新连接',
      '检查状态',
      '登录',
      '刷新登录',
      '清除登录',
      '撤销登录',
      '查看工具',
      '刷新工具',
      '删除 MCP',
    ])
      expect(button(panel, label)).toBeUndefined();
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(0);
    await act(async () => button(panel, '断开连接').click());
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toEqual([
      {
        method: 'settings.userMcp.submit',
        generation: 1,
        observationId: facts.observationId,
        operation: { kind: 'disconnect', serverId },
      },
    ]);
    expect(
      calls.some(
        (call) =>
          call.method === 'settings.userMcp.lookup' || call.method === 'settings.userMcp.cancel',
      ),
    ).toBe(false);
  }));

test('an unresolved exact disconnect keeps the unavailable owner stop disabled', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    const unavailable: NativeUserMcpFacts = {
      ...facts,
      canWrite: false,
      errors: ['mcp_source_unavailable'],
      sources: [
        {
          ...facts.sources[0]!,
          enabled: false,
          configured: false,
          connection: { state: 'outcome_unknown', generation: null, toolCount: null },
        },
      ],
    };
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        return input.method === 'settings.userMcp.read' ? unavailable : undefined;
      },
    } as unknown as NativeBridge;
    await render({
      bridge: controlled,
      submissions: [{ ...original, operation: { kind: 'disconnect', serverId } }],
    });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(button(panel, '断开连接').disabled).toBe(true);
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
  }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const toolsResult = (id: string, name: string): NativeUserMcpResult => ({
  kind: 'settings.userMcp.tools',
  observationId: 1,
  page: {
    scope: 'user',
    storeId: 'store',
    serverId: id,
    generation: 2,
    entries: [
      {
        index: 0,
        definitionId: 'synthetic-tool',
        definitionVersion: '1'.repeat(64),
        descriptor: { name },
      },
    ],
    nextAfterIndex: null,
    complete: true,
  },
});

test.each([
  'success',
  'failure',
] as const)('switching MCP panels discards the previous tool request %s', async (outcome) =>
  fixture(async ({ host, panel, calls, render }) => {
    const late = deferred<NativeUserMcpResult>();
    const secondId = `mcp-${'2'.repeat(64)}`;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [facts.sources[0], { ...facts.sources[0]!, id: secondId, name: 'Second' }],
          };
        if (input.method === 'settings.userMcp.tools')
          return input.serverId === serverId ? late.promise : toolsResult(secondId, 'SECOND_TOOL');
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '查看工具').click());
    expect(button(host, '管理 Second').disabled).toBe(false);
    await act(async () => button(host, '管理 Second').click());
    expect(panel.querySelector('aside')?.getAttribute('aria-label')).toBe('Second');
    await act(async () => {
      if (outcome === 'success') late.resolve(toolsResult(serverId, 'FIRST_TOOL'));
      else late.reject(Error('mcp_tools_unavailable'));
    });
    expect(panel.textContent).not.toContain('FIRST_TOOL');
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(button(panel, '查看工具').disabled).toBe(false);
    await act(async () => button(panel, '查看工具').click());
    expect(panel.textContent).toContain('SECOND_TOOL');
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(0);
  }));

test.each([
  'success',
  'failure',
] as const)('refresh invalidates an in-flight tool request %s without leaving its loading state behind', async (outcome) =>
  fixture(async ({ host, panel, calls, render }) => {
    const late = deferred<NativeUserMcpResult>(),
      refreshed = deferred<NativeUserMcpResult>();
    let reads = 0,
      toolReads = 0;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read')
          return ++reads === 1 ? facts : refreshed.promise;
        if (input.method === 'settings.userMcp.tools')
          return ++toolReads === 1 ? late.promise : toolsResult(serverId, 'CURRENT_TOOL');
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '查看工具').click());
    expect(button(host, 'Refresh MCP settings').disabled).toBe(false);
    await act(async () => button(host, 'Refresh MCP settings').click());
    expect(button(panel, '查看工具').disabled).toBe(true);
    await act(async () => refreshed.resolve({ ...facts, observationId: 2 }));
    await act(async () => {
      if (outcome === 'success') late.resolve(toolsResult(serverId, 'STALE_TOOL'));
      else late.reject(Error('mcp_tools_unavailable'));
    });
    expect(panel.textContent).not.toContain('STALE_TOOL');
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(button(panel, '查看工具').disabled).toBe(false);
    await act(async () => button(panel, '查看工具').click());
    expect(panel.textContent).toContain('CURRENT_TOOL');
    expect(calls.filter((call) => call.method === 'settings.userMcp.tools').at(-1)).toMatchObject({
      observationId: 2,
    });
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(0);
  }));

test('closing an MCP panel also retires late tool errors before the same source reopens', async () =>
  fixture(async ({ host, panel, render }) => {
    const late = deferred<NativeUserMcpResult>();
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.read') return facts;
        if (input.method === 'settings.userMcp.tools') return late.promise;
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '查看工具').click());
    await act(async () => button(panel, '关闭').click());
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => late.reject(Error('mcp_tools_unavailable')));
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(button(panel, '查看工具').disabled).toBe(false);
  }));
