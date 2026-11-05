import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createRef } from 'react';
import type {
  NativeUserMcpFacts,
  NativeUserMcpRequest,
  NativeUserMcpResult,
  NativeUserMcpSubmission,
} from '../../src/mcp-bridge';
import type { NativeBridge } from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

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
const { NativeMcpSettings } = await import('../../src/native-mcp-settings');
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
  const dom = new JSDOM('<main id="root"></main><div id="panel"></div>', {
    pretendToBeVisual: true,
  });
  const restoreDom = prepareDesktopDom(dom);
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
    restoreDom();
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
const openMore = async (panel: HTMLElement) =>
  act(async () => {
    button(panel, '更多操作').dispatchEvent(
      new panel.ownerDocument.defaultView!.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }),
    );
  });
const menuItem = (panel: HTMLElement, label: string) =>
  [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  )!;

test('STDIO form submits ordered arguments, explicit environment names and a working directory', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    await act(async () => button(host, '新增 MCP').click());
    await act(async () =>
      button(panel, 'Transport').dispatchEvent(
        new panel.ownerDocument.defaultView!.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }),
      ),
    );
    await act(async () =>
      [...panel.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((node) => node.textContent?.includes('STDIO'))!
        .click(),
    );
    await act(async () => {
      type(panel, 'Name', 'server-memory');
      type(panel, 'URL or command', 'npx');
    });
    await act(async () => button(panel, '＋ 添加参数').click());
    await act(async () => type(panel, '参数 1', '-y'));
    await act(async () => button(panel, '＋ 添加参数').click());
    await act(async () => type(panel, '参数 2', '@modelcontextprotocol/server-memory'));
    await act(async () => button(panel, '＋ 添加环境变量').click());
    await act(async () => {
      type(panel, '环境变量名称 1', 'MEMORY_FILE_PATH');
      type(panel, '环境变量值 1', 'C:\\Data\\memory.jsonl');
    });
    await act(async () => button(panel, '＋ 添加变量').click());
    await act(async () => {
      type(panel, '环境变量传递 1', 'SERVICE_TOKEN');
      type(panel, 'Working directory', '~/code');
    });
    await act(async () => button(panel, '添加').click());
    expect(calls.find((call) => call.method === 'settings.userMcp.submit')).toMatchObject({
      operation: {
        kind: 'add',
        name: 'server-memory',
        entry: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { MEMORY_FILE_PATH: 'C:\\Data\\memory.jsonl' },
          envPassthrough: ['SERVICE_TOKEN'],
          cwd: '~/code',
        },
      },
    });
  }));

test('HTTP form submits static headers and environment references without accepting a literal credential', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    await act(async () => button(host, '新增 MCP').click());
    await act(async () => {
      type(panel, 'Name', 'custom-http');
      type(panel, 'URL or command', 'https://tools.example.test/mcp');
      type(panel, 'Bearer token environment variable', 'MCP_BEARER_TOKEN');
    });
    await act(async () => button(panel, '＋ 添加标头').click());
    await act(async () => {
      type(panel, '标头名称 1', 'Authorization');
      type(panel, '标头值 1', 'synthetic-private-value');
    });
    await act(async () => button(panel, '添加').click());
    expect(panel.textContent).toContain('敏感标头请通过环境变量引用');
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
    await act(async () => {
      type(panel, '标头名称 1', 'X-Client');
      type(panel, '标头值 1', 'kite');
    });
    await act(async () => button(panel, '＋ 添加变量').click());
    await act(async () => {
      type(panel, '来自环境变量的标头名称 1', 'X-Api-Key');
      type(panel, '来自环境变量的标头值 1', 'MCP_API_KEY');
    });
    await act(async () => button(panel, '添加').click());
    expect(calls.find((call) => call.method === 'settings.userMcp.submit')).toMatchObject({
      operation: {
        kind: 'add',
        entry: {
          type: 'http',
          url: 'https://tools.example.test/mcp',
          bearerTokenEnv: 'MCP_BEARER_TOKEN',
          headers: { 'X-Client': 'kite' },
          headersFromEnv: { 'X-Api-Key': 'MCP_API_KEY' },
        },
      },
    });
    expect(JSON.stringify(calls)).not.toContain('synthetic-private-value');
  }));

test('repeated endpoint failures show the latest HTTP failure and dismiss only confirmed originals', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [
              {
                ...facts.sources[0]!,
                authentication: { policy: 'none', status: 'none', loginAllowed: false },
                connection: { state: 'failed', generation: null, toolCount: null },
              },
            ],
          };
        if (input.method === 'settings.userMcp.clear') {
          calls.push(input);
          return { generation: 1 };
        }
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    await render({
      bridge: controlled,
      submissions: [
        { ...original, commandId: 'failure-a', phase: 'failed', error: 'mcp_settings_unavailable' },
        { ...original, commandId: 'failure-b', phase: 'failed', error: 'mcp_http_not_found' },
      ],
    });
    expect(host.querySelectorAll('[aria-label="MCP 操作结果"]')).toHaveLength(0);
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.querySelectorAll('[aria-label="MCP 操作结果"]')).toHaveLength(1);
    expect(panel.textContent).toContain('找不到 MCP 接口（HTTP 404）');
    expect(panel.textContent).toContain('请核对服务地址和路径');
    expect(panel.textContent).not.toContain('示例域名');
    expect(panel.textContent).not.toContain('暂时无法完成操作');
    await act(async () => button(panel, '关闭').click());
    expect(panel.textContent).toBe('');
    expect(host.querySelectorAll('[aria-label="MCP 操作结果"]')).toHaveLength(0);
    expect(calls.some((input) => input.method === 'settings.userMcp.clear')).toBe(false);
    await act(async () => button(host, '新增 MCP').click());
    expect(panel.textContent).not.toContain('HTTP 404');
    expect(host.textContent).not.toContain('HTTP 404');
    await act(async () => button(panel, '关闭').click());
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('HTTP 404');
    expect(calls.some((input) => input.method === 'settings.userMcp.submit')).toBe(false);
    await openMore(panel);
    expect(
      [...panel.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(['删除 MCP']);
    await act(async () =>
      panel.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(
        new panel.ownerDocument.defaultView!.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        }),
      ),
    );
    await act(async () => button(panel, '关闭提示').click());
    expect(panel.querySelectorAll('[aria-label="MCP 操作结果"]')).toHaveLength(0);
    expect(calls.filter((input) => input.method === 'settings.userMcp.clear')).toEqual([
      { method: 'settings.userMcp.clear', generation: 1, commandId: 'failure-a' },
      { method: 'settings.userMcp.clear', generation: 1, commandId: 'failure-b' },
    ]);
    expect(calls.some((input) => input.method === 'settings.userMcp.submit')).toBe(false);
  }));

const endpointFailures = [
  ['mcp_http_not_found', 'HTTP 404'],
  ['mcp_http_endpoint_unsupported', '不接受 MCP 请求'],
  ['mcp_http_forbidden', 'HTTP 403'],
  ['mcp_http_dns_unavailable', '域名'],
  ['mcp_http_timeout', '连接超时'],
  ['mcp_http_rate_limited', '请求过于频繁'],
  ['mcp_http_server_error', '服务发生内部错误'],
  ['mcp_settings_unavailable', 'MCP 接口地址'],
  ['untrusted_private_error_body', 'MCP 接口地址'],
] as const;
test.each(
  ['https://example.com/mcp', 'https://tools.service.test/mcp'].flatMap((address) =>
    endpointFailures.map(([code, message]) => [address, code, message] as const),
  ),
)('%s uses the reported failure %s without inferring a cause from the address', async (address, code, message) =>
  fixture(async ({ host, panel, bridge, render }) => {
    const controlled = {
      request: (input: NativeUserMcpRequest) =>
        input.method === 'settings.userMcp.read'
          ? Promise.resolve({
              ...facts,
              sources: [
                {
                  ...facts.sources[0]!,
                  address,
                  connection: { state: 'failed', generation: null, toolCount: null },
                },
              ],
            })
          : bridge.request(input),
    } as NativeBridge;
    await render({
      bridge: controlled,
      submissions: [{ ...original, phase: 'failed', error: code }],
    });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain(message!);
    expect(panel.textContent).not.toContain('示例域名');
    expect(panel.textContent).not.toContain('untrusted_private_error_body');
    expect(button(panel, '登录')).not.toBeUndefined();
  }));

test('grouped failures never merge or clear unconfirmed originals and a confirmed retry removes stale feedback', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [
              {
                ...facts.sources[0]!,
                connection: { state: 'failed', generation: null, toolCount: null },
              },
            ],
          };
        if (input.method === 'settings.userMcp.clear') {
          calls.push(input);
          return { generation: 1 };
        }
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    const failures = [
      { ...original, commandId: 'failed-1', phase: 'failed', error: 'mcp_http_timeout' },
      { ...original, commandId: 'failed-2', phase: 'failed', error: 'mcp_http_not_found' },
    ] as const;
    await render({
      bridge: controlled,
      submissions: [
        ...failures,
        { ...original, commandId: 'unknown-1' },
        { ...original, commandId: 'unknown-2' },
      ],
    });
    expect(
      [...host.querySelectorAll('button')].filter((node) => node.textContent === '查看结果'),
    ).toHaveLength(2);
    expect(
      [...host.querySelectorAll('button')].filter((node) => node.textContent === '关闭提示'),
    ).toHaveLength(0);
    await act(async () => button(host, '管理 Knowledge').click());
    expect(button(panel, '关闭提示')).not.toBeUndefined();
    await act(async () => button(panel, '关闭提示').click());
    expect(calls.filter((input) => input.method === 'settings.userMcp.clear')).toHaveLength(2);
    expect(
      [...panel.querySelectorAll('button')].filter((node) => node.textContent === '查看结果'),
    ).toHaveLength(2);
    expect(
      calls.some(
        (input) =>
          input.method === 'settings.userMcp.lookup' || input.method === 'settings.userMcp.submit',
      ),
    ).toBe(false);
    const retryFailures = failures.map((row) => ({ ...row, commandId: `retry-${row.commandId}` }));
    await render({ bridge: controlled, submissions: retryFailures });
    expect(panel.querySelectorAll('[aria-label="MCP 操作结果"]')).toHaveLength(1);
    await render({
      bridge: controlled,
      submissions: [
        ...retryFailures,
        { ...original, commandId: 'retry-completed', phase: 'completed' },
      ],
    });
    expect(panel.querySelectorAll('[aria-label="MCP 操作结果"]')).toHaveLength(0);
  }));

test.each([
  'cleanup',
  'retry',
] as const)('a stale held failed connection offers %s without claiming it is connected', async (action) =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const controlled = {
      request: (input: NativeUserMcpRequest) =>
        input.method === 'settings.userMcp.read'
          ? Promise.resolve({
              ...facts,
              sources: [
                {
                  ...facts.sources[0]!,
                  diagnostics: ['mcp_source_conflict'],
                  authentication: { policy: 'none', status: 'none', loginAllowed: false },
                  connection: { state: 'failed', generation: null, toolCount: null },
                },
              ],
            })
          : bridge.request(input),
    } as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    if (action === 'cleanup') {
      await openMore(panel);
      expect(menuItem(panel, '断开连接')).toBeUndefined();
      await act(async () => menuItem(panel, '清理连接').click());
    } else await act(async () => button(panel, '重试连接').click());
    expect(calls.filter((input) => input.method === 'settings.userMcp.submit')).toMatchObject([
      { operation: { kind: action === 'cleanup' ? 'disconnect' : 'reconnect', serverId } },
    ]);
  }));

test('connected services show tools directly and keep maintenance in the in-panel menu with contextual deletion', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    expect(host.textContent).not.toContain('管理');
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('Search knowledge.');
    expect(button(panel, '建立连接')).toBeUndefined();
    expect(button(panel, '检查状态')).toBeUndefined();
    expect(button(panel, '查看工具')).toBeUndefined();
    expect(panel.querySelectorAll('button')).toHaveLength(3); // Close, More, enable switch.
    await openMore(panel);
    expect(
      [...panel.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(['刷新工具', '重新连接', '断开连接', '删除 MCP']);
    await act(async () => menuItem(panel, '删除 MCP').click());
    expect(panel.textContent).toContain('删除 MCP？');
    expect(panel.textContent).toContain('Knowledge');
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
    await act(async () => button(panel, '取消').click());
    expect(panel.textContent).toContain('Search knowledge.');
    await openMore(panel);
    await act(async () => menuItem(panel, '删除 MCP').click());
    await act(async () => button(panel, 'Confirm exact MCP operation').click());
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toEqual([
      {
        method: 'settings.userMcp.submit',
        generation: 1,
        observationId: 1,
        operation: { kind: 'remove', serverId },
      },
    ]);
    expect(panel.textContent).toBe('');
    expect(host.ownerDocument.activeElement).toBe(button(host, '管理 Knowledge'));
  }));

test('authenticated services keep refresh, local logout and remote revocation distinct in More', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const controlled = {
      request: (input: NativeUserMcpRequest) =>
        input.method === 'settings.userMcp.read'
          ? Promise.resolve({
              ...facts,
              sources: [
                {
                  ...facts.sources[0]!,
                  authentication: { policy: 'oauth', status: 'present', loginAllowed: true },
                },
              ],
            })
          : bridge.request(input),
    } as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('已登录');
    await openMore(panel);
    expect(menuItem(panel, '刷新授权')).not.toBeUndefined();
    expect(menuItem(panel, '撤销授权')).not.toBeUndefined();
    await act(async () => menuItem(panel, '退出登录').click());
    expect(panel.textContent).toContain('此设备保存的登录信息');
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
    await act(async () => button(panel, 'Confirm exact MCP operation').click());
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toMatchObject([
      { operation: { kind: 'clear', serverId } },
    ]);
  }));

test('live browser login exposes cancellation in its service detail without a redundant result button', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render({
      submissions: [{ ...original, phase: 'pending', operation: { kind: 'login', serverId } }],
    });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('请在浏览器中完成登录');
    expect(host.textContent).not.toContain('请在浏览器中完成登录');
    expect(button(panel, '查看结果')).toBeUndefined();
    expect(panel.querySelector('[aria-label="MCP 操作结果"]')).toBeNull();
    await act(async () => button(panel, '取消登录').click());
    expect(calls.filter((call) => call.method === 'settings.userMcp.cancel')).toEqual([
      { method: 'settings.userMcp.cancel', generation: 1, commandId: original.commandId },
    ]);
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
  }));

test('confirmed failure can be dismissed through the original record without retrying its operation', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.clear') {
          calls.push(input);
          return { generation: 1 };
        }
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    await render({
      bridge: controlled,
      submissions: [
        {
          ...original,
          phase: 'failed',
          error: 'mcp_oauth_timeout',
          operation: { kind: 'login', serverId },
        },
      ],
    });
    expect(host.textContent).not.toContain('登录已超时');
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('登录已超时');
    expect(button(panel, '查看结果')).toBeUndefined();
    await act(async () => button(panel, '关闭提示').click());
    expect(panel.textContent).not.toContain('登录已超时');
    expect(calls.filter((call) => call.method === 'settings.userMcp.clear')).toEqual([
      { method: 'settings.userMcp.clear', generation: 1, commandId: original.commandId },
    ]);
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
  }));

test.each([
  'submitting',
  'pending',
] as const)('a normal %s enable change has no operation card or extra result buttons', async (phase) =>
  fixture(async ({ host, panel, render, calls }) => {
    await render({
      submissions: [
        { ...original, phase, operation: { kind: 'enabled', serverId, enabled: false } },
      ],
    });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.querySelector('[aria-label="MCP 操作结果"]')).toBeNull();
    expect(host.querySelector('[aria-label="MCP 操作结果"]')).toBeNull();
    expect(panel.textContent).not.toContain('正在处理');
    expect(button(panel, '启用 Knowledge').disabled).toBe(true);
    expect(button(panel, '查看结果')).toBeUndefined();
    expect(button(panel, '取消操作')).toBeUndefined();
    expect(calls.some((input) => input.method === 'settings.userMcp.submit')).toBe(false);
  }));

test('a pending service change can still cancel its exact original through More without a progress card', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render({
      submissions: [
        { ...original, phase: 'pending', operation: { kind: 'enabled', serverId, enabled: false } },
      ],
    });
    await act(async () => button(host, '管理 Knowledge').click());
    await openMore(panel);
    expect(
      [...panel.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(['取消操作']);
    await act(async () => menuItem(panel, '取消操作').click());
    expect(calls.filter((input) => input.method === 'settings.userMcp.cancel')).toEqual([
      { method: 'settings.userMcp.cancel', generation: 1, commandId: original.commandId },
    ]);
    expect(calls.some((input) => input.method === 'settings.userMcp.submit')).toBe(false);
  }));

test('tool loading failure offers an explicit retry and schemas stay collapsed until requested', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    let toolReads = 0;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method !== 'settings.userMcp.tools') return bridge.request(input);
        calls.push(input);
        if (++toolReads === 1) throw Error('mcp_tools_unavailable');
        return {
          ...toolsResult(serverId, 'search'),
          page: {
            ...(
              toolsResult(serverId, 'search') as Extract<
                NativeUserMcpResult,
                { kind: 'settings.userMcp.tools' }
              >
            ).page,
            entries: [
              {
                index: 0,
                definitionId: 'internal-tool',
                definitionVersion: '1'.repeat(64),
                descriptor: {
                  name: 'search',
                  description: 'Full tool description.',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                },
              },
            ],
          },
        };
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('未能加载工具');
    await act(async () => Bun.sleep(20));
    expect(toolReads).toBe(1);
    await act(async () => button(panel, '重试').click());
    expect(panel.textContent).toContain('Full tool description.');
    expect(panel.querySelector('[data-mcp-schema]')).toBeNull();
    await act(async () => button(panel, 'search').click());
    expect(panel.querySelector('[data-mcp-schema="input"]')?.textContent).toContain('query');
    expect(toolReads).toBe(2);
    expect(calls.some((call) => call.method === 'settings.userMcp.submit')).toBe(false);
  }));
test('global MCP reads and edits without any Session and exposes no project scope', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render();
    expect(calls).toEqual([{ method: 'settings.userMcp.read', generation: 1 }]);
    expect(host.textContent).toContain('Knowledge');
    expect(host.textContent).not.toContain('选择会话');
    expect(host.textContent).not.toContain('工作区');
    await act(async () => button(host, '启用 Knowledge').click());
    expect(panel.textContent).toBe('');
    expect(button(host, '管理 Knowledge').getAttribute('aria-expanded')).toBe('false');
    expect(calls.find((c) => c.method === 'settings.userMcp.submit')).toEqual({
      method: 'settings.userMcp.submit',
      generation: 1,
      observationId: 1,
      operation: { kind: 'enabled', serverId, enabled: false },
    });
    await render();
    expect(calls.filter((c) => c.method === 'settings.userMcp.read')).toHaveLength(2);
  }));
test('add reuses the right sidebar, validates fields and directly submits the exact user-only operation', async () =>
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

test('an accepted asynchronous add freezes its draft and closes only after the original completes', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const operation = {
      kind: 'add',
      name: 'new-server',
      entry: { type: 'http', url: 'https://example.com/new' },
    } as const;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (
          input.method === 'settings.userMcp.submit' ||
          input.method === 'settings.userMcp.lookup'
        ) {
          calls.push(input);
          return {
            ...original,
            operation,
            phase: input.method === 'settings.userMcp.submit' ? 'pending' : 'completed',
          };
        }
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '新增 MCP').click());
    await act(async () => type(panel, 'Name', 'new-server'));
    await act(async () => type(panel, 'URL or command', 'https://example.com/new'));
    await act(async () => button(panel, '添加').click());
    expect(panel.textContent).not.toContain('正在处理');
    expect(panel.querySelector('[aria-label="MCP 操作结果"]')).toBeNull();
    expect(panel.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.disabled).toBe(true);
    expect(button(panel, '正在添加…').disabled).toBe(true);
    expect(button(panel, '取消添加')).not.toBeUndefined();
    await act(async () => Bun.sleep(800));
    expect(panel.textContent).toBe('');
    expect(host.ownerDocument.activeElement).toBe(button(host, '新增 MCP'));
    expect(calls.filter((input) => input.method === 'settings.userMcp.submit')).toHaveLength(1);
  }));

test('an accepted asynchronous deletion closes its service when its original completes', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    const operation = { kind: 'remove', serverId } as const;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (
          input.method === 'settings.userMcp.submit' ||
          input.method === 'settings.userMcp.lookup'
        ) {
          calls.push(input);
          return {
            ...original,
            operation,
            phase: input.method === 'settings.userMcp.submit' ? 'pending' : 'completed',
          };
        }
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await openMore(panel);
    await act(async () => menuItem(panel, '删除 MCP').click());
    await act(async () => button(panel, 'Confirm exact MCP operation').click());
    expect(panel.querySelector('aside')).not.toBeNull();
    await act(async () => Bun.sleep(800));
    expect(panel.textContent).toBe('');
    expect(calls.filter((input) => input.method === 'settings.userMcp.submit')).toHaveLength(1);
  }));

test('a delayed deletion result cannot close a different service opened while it was saving', async () =>
  fixture(async ({ host, panel, bridge, render }) => {
    const late = deferred<NativeUserMcpResult>();
    const secondId = `mcp-${'2'.repeat(64)}`;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [facts.sources[0], { ...facts.sources[0]!, id: secondId, name: 'Second' }],
          };
        if (input.method === 'settings.userMcp.submit') return late.promise;
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await openMore(panel);
    await act(async () => menuItem(panel, '删除 MCP').click());
    await act(async () => button(panel, 'Confirm exact MCP operation').click());
    await act(async () => button(host, '管理 Second').click());
    await act(async () =>
      late.resolve({ ...original, phase: 'completed', operation: { kind: 'remove', serverId } }),
    );
    expect(panel.querySelector('aside')?.getAttribute('aria-label')).toBe('Second');
    expect(panel.textContent).not.toContain('删除 MCP？');
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

test('a live connection challenge settles automatically, exposes login and then observes browser completion without reconnecting', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    let challenge = false;
    let authenticated = false;
    let currentOperation: NativeUserMcpSubmission['operation'] = { kind: 'connect', serverId };
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [
              {
                ...facts.sources[0]!,
                authentication: {
                  policy: 'auto',
                  status: authenticated ? 'present' : 'missing',
                  loginAllowed: challenge,
                },
                connection: {
                  state: challenge ? 'failed' : 'disconnected',
                  generation: null,
                  toolCount: null,
                },
              },
            ],
          };
        if (input.method === 'settings.userMcp.submit') {
          currentOperation = input.operation;
          return { ...original, operation: input.operation, phase: 'pending' };
        }
        if (input.method === 'settings.userMcp.lookup') {
          challenge = true;
          if (currentOperation.kind === 'login') authenticated = true;
          return {
            ...original,
            operation: currentOperation,
            phase: authenticated ? 'completed' : 'failed',
            ...(!authenticated ? { error: 'mcp_oauth_login_required' } : {}),
          };
        }
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(button(panel, '登录')).toBeUndefined();
    await act(async () => button(panel, '建立连接').click());
    await act(async () => Bun.sleep(800));
    expect(panel.textContent).toContain('此服务需要登录');
    expect(button(panel, '登录').disabled).toBe(false);
    await act(async () => button(panel, '登录').click());
    expect(panel.textContent).toContain('请在浏览器中完成登录');
    await act(async () => Bun.sleep(800));
    expect(panel.textContent).toContain('已登录');
    expect(panel.textContent).not.toContain('此服务需要登录');
    expect(button(panel, '重试连接').disabled).toBe(false);
    expect(
      calls
        .filter((call) => call.method === 'settings.userMcp.submit')
        .map((call) => call.operation.kind),
    ).toEqual(['connect', 'login']);
    expect(calls.filter((call) => call.method === 'settings.userMcp.lookup')).toHaveLength(2);
  }));

test('a timed out browser login explains retry, while unknown originals are never polled', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    await render({
      submissions: [
        {
          ...original,
          phase: 'failed',
          operation: { kind: 'login', serverId },
          error: 'mcp_oauth_timeout',
        },
        { ...original, commandId: 'unknown-login', operation: { kind: 'login', serverId } },
      ],
    });
    expect(host.textContent).not.toContain('登录已超时');
    await act(async () => button(host, '管理 Knowledge').click());
    expect(panel.textContent).toContain('登录已超时');
    await act(async () => Bun.sleep(800));
    expect(calls.filter((call) => call.method === 'settings.userMcp.lookup')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(0);
  }));

test('successive immediate pending replies keep observing the same original until browser login completes', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    let lookups = 0;
    const operation = { kind: 'login', serverId } as const;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [
              {
                ...facts.sources[0]!,
                authentication: {
                  policy: 'oauth',
                  status: lookups >= 3 ? 'present' : 'missing',
                  loginAllowed: true,
                },
                connection: { state: 'disconnected', generation: null, toolCount: null },
              },
            ],
          };
        if (input.method === 'settings.userMcp.submit')
          return { ...original, operation, phase: 'pending' };
        if (input.method === 'settings.userMcp.lookup')
          return { ...original, operation, phase: ++lookups >= 3 ? 'completed' : 'pending' };
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '登录').click());
    for (let i = 1; i <= 3; i++) {
      await act(async () => Bun.sleep(800));
      expect(lookups).toBe(i);
      if (i < 3) expect(panel.textContent).toContain('请在浏览器中完成登录');
    }
    expect(panel.textContent).toContain('已登录');
    expect(button(panel, '建立连接').disabled).toBe(false);
    expect(
      calls
        .filter((call) => call.method === 'settings.userMcp.lookup')
        .map((call) => ('commandId' in call ? call.commandId : null)),
    ).toEqual([original.commandId, original.commandId, original.commandId]);
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(1);
  }));

test('an immediate authentication failure refreshes login eligibility and a replaced Store retires its pending lookup', async () =>
  fixture(async ({ host, panel, calls, render }) => {
    let challenged = false;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        calls.push(input);
        if (input.method === 'settings.userMcp.read')
          return {
            ...facts,
            sources: [
              {
                ...facts.sources[0]!,
                authentication: { policy: 'auto', status: 'missing', loginAllowed: challenged },
                connection: { state: 'disconnected', generation: null, toolCount: null },
              },
            ],
          };
        if (input.method === 'settings.userMcp.submit') {
          challenged = true;
          return { ...original, phase: 'failed', error: 'mcp_oauth_login_required' };
        }
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(button(panel, '登录')).toBeUndefined();
    await act(async () => button(panel, '建立连接').click());
    await act(async () => Bun.sleep(0));
    expect(calls.filter((call) => call.method === 'settings.userMcp.read')).toHaveLength(2);
    expect(button(panel, '登录').disabled).toBe(false);
    await render({ bridge: controlled, submissions: [{ ...original, phase: 'pending' }] });
    await render({ bridge: controlled, storeId: 'new-store', generation: 2 });
    await act(async () => Bun.sleep(800));
    expect(calls.filter((call) => call.method === 'settings.userMcp.lookup')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(1);
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

test('a failed refresh retires the prior edit and automatic tool observation until a successful read', async () =>
  fixture(async ({ host, panel, bridge, calls, render }) => {
    let reads = 0;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.read' && ++reads === 2) {
          calls.push(input);
          throw Error('mcp_source_unavailable');
        }
        return bridge.request(input);
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    expect(calls.filter((input) => input.method === 'settings.userMcp.tools')).toHaveLength(1);
    await act(async () => button(host, 'Refresh MCP settings').click());
    expect(panel.textContent).toContain('暂时无法读取配置');
    expect(button(host, '新增 MCP').disabled).toBe(true);
    expect(button(panel, '启用 Knowledge').disabled).toBe(true);
    expect(calls.filter((input) => input.method === 'settings.userMcp.tools')).toHaveLength(1);
    expect(panel.textContent).not.toContain('正在加载工具');
    await act(async () => button(panel, '重试').click());
    expect(panel.textContent).toContain('Search knowledge.');
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(button(host, '新增 MCP').disabled).toBe(false);
    expect(calls.filter((input) => input.method === 'settings.userMcp.tools')).toHaveLength(2);
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
    expect(host.textContent).toContain(configured ? '已连接' : '待清理');
    const stopLabel = configured ? '断开连接' : '清理连接';
    expect(button(panel, stopLabel).disabled).toBe(false);
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
    await act(async () => button(panel, stopLabel).click());
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
    expect(button(panel, '清理连接').disabled).toBe(true);
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
    expect(button(host, '管理 Second').disabled).toBe(false);
    await act(async () => button(host, '管理 Second').click());
    expect(panel.querySelector('aside')?.getAttribute('aria-label')).toBe('Second');
    await act(async () => {
      if (outcome === 'success') late.resolve(toolsResult(serverId, 'FIRST_TOOL'));
      else late.reject(Error('mcp_tools_unavailable'));
    });
    expect(panel.textContent).not.toContain('FIRST_TOOL');
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.querySelector('[aria-label="可用工具"]')).not.toBeNull();
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
    expect(button(host, 'Refresh MCP settings').disabled).toBe(false);
    await act(async () => button(host, 'Refresh MCP settings').click());
    expect(panel.querySelector('[aria-label="可用工具"]')?.textContent).toContain('正在加载工具');
    await act(async () => refreshed.resolve({ ...facts, observationId: 2 }));
    await act(async () => {
      if (outcome === 'success') late.resolve(toolsResult(serverId, 'STALE_TOOL'));
      else late.reject(Error('mcp_tools_unavailable'));
    });
    expect(panel.textContent).not.toContain('STALE_TOOL');
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.querySelector('[aria-label="可用工具"]')).not.toBeNull();
    expect(panel.textContent).toContain('CURRENT_TOOL');
    expect(calls.filter((call) => call.method === 'settings.userMcp.tools').at(-1)).toMatchObject({
      observationId: 2,
    });
    expect(calls.filter((call) => call.method === 'settings.userMcp.submit')).toHaveLength(0);
  }));

test('closing an MCP panel also retires late tool errors before the same source reopens', async () =>
  fixture(async ({ host, panel, render }) => {
    const late = deferred<NativeUserMcpResult>();
    let toolReads = 0;
    const controlled = {
      request: async (input: NativeUserMcpRequest) => {
        if (input.method === 'settings.userMcp.read') return facts;
        if (input.method === 'settings.userMcp.tools')
          return ++toolReads === 1 ? late.promise : toolsResult(serverId, 'REOPENED_TOOL');
        return undefined;
      },
    } as unknown as NativeBridge;
    await render({ bridge: controlled });
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => button(panel, '关闭').click());
    await act(async () => button(host, '管理 Knowledge').click());
    await act(async () => late.reject(Error('mcp_tools_unavailable')));
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.textContent).toContain('REOPENED_TOOL');
    expect(toolReads).toBe(2);
  }));
