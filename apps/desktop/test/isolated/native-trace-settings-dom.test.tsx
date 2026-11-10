import { expect, test } from 'bun:test';
import type { TraceInstallation } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeSelection } from '../../src/native-bridge';
import type { NativeTraceOperation } from '../../src/native-trace-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>');
const previous = {
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
const { NativeTraceSettings } = await import('../../src/native-trace-settings');
Object.assign(globalThis, previous);
bootstrap.window.close();
const installation: TraceInstallation = {
  kind: 'third_party',
  installationId: 'plugin',
  name: 'Example Trace',
  digest: 'a'.repeat(64),
  status: 'installed',
  manifest: {
    apiVersion: 1,
    name: 'Example Trace',
    history: true,
    eventKinds: ['model', 'tool'],
    evidenceKinds: ['model_output'],
    origins: ['https://collector.example'],
    settings: { batchSize: 'number' },
  },
  settings: { batchSize: 20 },
  grant: null,
  partitions: [],
  credentials: [],
};
function button(host: HTMLElement, label: string) {
  const node = [...host.querySelectorAll('button')].find(
    (node) => node.textContent === label || node.getAttribute('aria-label') === label,
  );
  if (!node) throw Error(`button_missing:${label}`);
  return node;
}
function toggle(host: HTMLElement, label: string) {
  const wrapper = [...host.querySelectorAll('label')].find((node) => node.textContent === label);
  if (!wrapper) throw Error(`toggle_missing:${label}`);
  return host.querySelector<HTMLElement>(`[id="${wrapper.htmlFor}"]`)!;
}
async function fixture(
  run: (value: {
    host: HTMLElement;
    calls: NativeTraceOperation[];
    render(sessionId?: string): Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<main id="root"></main>', { pretendToBeVisual: true });
  const restore = prepareDesktopDom(dom);
  const old = {
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
    calls: NativeTraceOperation[] = [];
  const saved = structuredClone(installation);
  let uninstalled = false;
  const bridge = {
    async request(input: { method: string; operation: NativeTraceOperation }) {
      if (input.method !== 'trace.manage') throw Error('unexpected_native_request');
      const operation = input.operation;
      calls.push(structuredClone(operation));
      if (operation.kind === 'list')
        return {
          kind: 'trace.installations',
          value: {
            installations: uninstalled
              ? []
              : [
                  {
                    kind: 'third_party',
                    installationId: 'plugin',
                    name: 'Example Trace',
                    digest: installation.digest,
                    status: 'installed',
                  },
                ],
          },
        };
      if (operation.kind === 'inspect') {
        if (uninstalled) throw Error('unexpected_uninstalled_inspect');
        return { kind: 'trace.installation', value: structuredClone(saved) };
      }
      if (operation.kind === 'grant')
        saved.grant = { revision: '1', epoch: '1', active: true, grant: operation.input };
      if (operation.kind === 'enable') throw Error('trace_result_unknown');
      if (operation.kind === 'uninstall') {
        uninstalled = true;
        saved.status = 'uninstalled';
      }
      if (operation.kind === 'delivery')
        return { kind: 'trace.delivery', value: { kind: 'third_party', status: 'not_applicable' } };
      return { kind: 'trace.action', value: { completed: true } };
    },
  } as unknown as NativeBridge;
  async function render(sessionId = 'session-a') {
    await act(async () =>
      root.render(
        <NativeTraceSettings
          bridge={bridge}
          generation={1}
          storeId="store"
          selection={{ storeId: 'store', session: { id: sessionId } } as NativeSelection}
        />,
      ),
    );
  }
  try {
    await run({ host, calls, render });
  } finally {
    await act(async () => root.unmount());
    restore();
    dom.window.close();
    Object.assign(globalThis, old);
  }
}

test('Trace settings keeps installation, grant and enable separate; unknown mutation refreshes without retry', async () =>
  fixture(async ({ host, calls, render }) => {
    await render();
    expect(host.textContent).toContain('安装后仍需单独授权和启用');
    await act(async () => button(host, 'Example Trace').click());
    expect(
      [...host.querySelectorAll('[role="switch"]')].every(
        (node) => node.getAttribute('aria-checked') === 'false',
      ),
    ).toBe(true);
    expect(calls.filter((call) => !['list', 'inspect'].includes(call.kind))).toEqual([]);
    await act(async () => button(host, '启用').click());
    expect(calls.filter((call) => call.kind === 'enable')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'grant')).toHaveLength(0);
    expect(calls.filter((call) => call.kind === 'list').length).toBeGreaterThan(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('trace_result_unknown');
    await act(async () => toggle(host, '当前会话：session-a').click());
    await act(async () => toggle(host, '模型').click());
    await act(async () => toggle(host, '真实时间').click());
    await act(async () => button(host, '保存并替换授权').click());
    expect(calls.find((call) => call.kind === 'grant')).toEqual({
      kind: 'grant',
      installationId: 'plugin',
      input: {
        scopes: [{ storeId: 'store', sessionId: 'session-a' }],
        eventKinds: ['model'],
        metadata: ['timing'],
        evidenceKinds: [],
        origins: [],
        originalIdentity: false,
        allowHistory: false,
        allowPrivateNetwork: false,
        credentialHandles: [],
        evidenceContent: 'redacted',
      },
    });
    await render('session-b');
    expect(toggle(host, '当前会话：session-b').getAttribute('aria-checked')).toBe('false');
    expect(toggle(host, '模型').getAttribute('aria-checked')).toBe('false');
  }));

test('Trace credential form clears secret after binding and leaves credential use ungranted', async () =>
  fixture(async ({ host, calls, render }) => {
    await render();
    await act(async () => button(host, 'Example Trace').click());
    await act(async () => host.querySelector<HTMLElement>('[aria-label="凭据来源"]')!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === 'https://collector.example',
    )!;
    expect(option).toBeDefined();
    await act(async () => option.click());
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!,
      window = input.ownerDocument.defaultView!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'opaque-secret-value',
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('opaque-secret-value');
    await act(async () => button(host, '绑定凭据').click());
    expect(input.value).toBe('');
    expect(calls.find((call) => call.kind === 'bindCredential')).toEqual({
      kind: 'bindCredential',
      installationId: 'plugin',
      input: { origin: 'https://collector.example', secret: 'opaque-secret-value' },
    });
    expect(calls.filter((call) => call.kind === 'grant' || call.kind === 'enable')).toEqual([]);
    expect(host.textContent).not.toContain('opaque-secret-value');
  }));

test('history export requires independent history grant and preserves exact Decimal64 range', async () =>
  fixture(async ({ host, calls, render }) => {
    await render();
    await act(async () => button(host, 'Example Trace').click());
    expect(button(host, '创建历史导出').disabled).toBe(true);
    await act(async () => toggle(host, '当前会话：session-a').click());
    await act(async () => toggle(host, '模型').click());
    await act(async () => toggle(host, '允许历史导出').click());
    await act(async () => button(host, '保存并替换授权').click());
    expect(button(host, '创建历史导出').disabled).toBe(false);
    async function fill(label: string, value: string) {
      const wrapper = [...host.querySelectorAll('label')].find((node) =>
        node.textContent?.startsWith(label),
      )!;
      const input = host.querySelector<HTMLInputElement>(`[id="${wrapper.htmlFor}"]`)!,
        window = input.ownerDocument.defaultView!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    }
    await fill('起始序号（含）', '9007199254740993');
    await fill('结束序号（含；留空固定为当前上界）', '9223372036854775807');
    await act(async () => button(host, '创建历史导出').click());
    expect(calls.find((call) => call.kind === 'history')).toEqual({
      kind: 'history',
      installationId: 'plugin',
      input: {
        scope: { storeId: 'store', sessionId: 'session-a' },
        fromSequence: '9007199254740993',
        toSequence: '9223372036854775807',
        contentMode: 'metadata',
      },
    });
    await fill('结束序号（含；留空固定为当前上界）', '9223372036854775808');
    await act(async () => button(host, '创建历史导出').click());
    expect(calls.filter((call) => call.kind === 'history')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('trace_history_range_invalid');
  }));

test('confirmed uninstall clears the selected installation and never inspects its retired id', async () =>
  fixture(async ({ host, calls, render }) => {
    await render();
    await act(async () => button(host, 'Example Trace').click());
    await act(async () => toggle(host, '当前会话：session-a').click());
    await act(async () => toggle(host, '模型').click());
    const password = host.querySelector<HTMLInputElement>('input[type="password"]')!,
      window = password.ownerDocument.defaultView!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        password,
        'pending-unsubmitted-secret',
      );
      password.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => button(host, '检查远端状态').click());
    expect(host.textContent).toContain('第三方安装：无官方远端接收状态。');
    const inspected = calls.filter((call) => call.kind === 'inspect').length;
    await act(async () => button(host, '卸载').click());
    expect(host.textContent).toContain('卸载已完成。');
    expect(host.textContent).toContain('尚无安装。');
    expect(host.querySelector('[aria-label="所选 Trace"]')).toBeNull();
    expect(host.querySelector('[aria-label="Trace 独立授权"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(
      [...host.querySelectorAll('button')].some((node) =>
        ['启用', '停用', '撤销授权', '卸载'].includes(node.textContent ?? ''),
      ),
    ).toBe(false);
    expect(host.querySelector('[aria-label="远端接收状态"]')).toBeNull();
    expect(calls.filter((call) => call.kind === 'inspect')).toHaveLength(inspected);
    await act(async () => button(host, '刷新状态').click());
    expect(calls.filter((call) => call.kind === 'inspect')).toHaveLength(inspected);
    expect(calls.filter((call) => call.kind === 'uninstall')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  }));
