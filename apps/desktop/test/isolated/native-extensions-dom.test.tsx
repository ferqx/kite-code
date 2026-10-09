import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeExtensionScope } from '../../src/extensions-bridge';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { readNativeExtensionBody } from '../../src/native-extension-read';
import { NativeExtensions } from '../../src/native-extensions';

const scope: NativeExtensionScope = {
  generation: 1,
  viewSelection: 1,
  historyEpoch: 0,
  storeId: 'store',
  sessionId: 'session',
  workspaceId: 'workspace',
  contextSelectionId: 'context',
};
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const catalogue = [
  {
    extensionId: 'public-extension',
    version: '1',
    actions: [{ id: 'save', version: '1', description: 'Save', inputSchema: schema }],
    queries: [{ id: 'read', version: '1', description: 'Read', inputSchema: schema }],
  },
];
const views = [
  {
    extensionId: 'public-extension',
    contentType: 'future.public',
    contentVersion: 99,
    summary: 'Complete public result',
    payload: { text: '完整原文' },
    artifactRefs: [],
    actions: [
      { actionId: 'save', definitionVersion: '1', label: '保存结果', input: { text: '完整原文' } },
    ],
  },
];
function fixture() {
  let serial = 0;
  const calls: NativeRequest[] = [],
    bodies = new Map<string, Buffer>();
  const bridge = {
    async request(request: NativeRequest) {
      calls.push(request);
      if (request.method === 'extensions.open' || request.method === 'extensions.query') {
        const bytes = Buffer.from(
          JSON.stringify(request.method === 'extensions.open' ? catalogue : views),
        );
        bodies.set(request.readId, bytes);
        return {
          kind: 'extensions.head',
          readId: request.readId,
          observationId: ++serial,
          scope,
          bodyBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          content: request.method === 'extensions.open' ? 'catalogue' : 'views',
        };
      }
      if (request.method === 'extensions.read') {
        const bytes = bodies.get(request.readId)!;
        return {
          kind: 'extensions.chunk',
          readId: request.readId,
          offset: request.offset,
          nextOffset: bytes.length,
          eof: true,
          data: bytes.toString('base64'),
        };
      }
      if (request.method === 'extensions.invoke' || request.method === 'extensions.lookup')
        return {
          kind: 'extensions.command',
          metadata: {
            scope: {
              storeId: scope.storeId,
              sessionId: scope.sessionId,
              workspaceId: scope.workspaceId,
            },
            request: { kind: 'extension.invoke', commandId: request.commandId },
          },
          outcome:
            request.method === 'extensions.invoke' &&
            calls.filter((call) => call.method === 'extensions.invoke').length === 1
              ? 'succeeded'
              : 'unknown',
        };
      return undefined;
    },
  } as NativeBridge;
  return { calls, bridge };
}

test('real panel reads query and complete public view, invokes exact offered input once and only looks up unknown original', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!),
    host = dom.window.document;
  const { calls, bridge } = fixture();
  async function flush(action: () => void) {
    await act(async () => {
      action();
      await Bun.sleep(20);
    });
  }
  try {
    await flush(() =>
      root.render(<NativeExtensions bridge={bridge} scope={scope} canRead canInvoke />),
    );
    expect(calls).toHaveLength(0);
    await flush(() => {
      const details = host.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new dom.window.Event('toggle'));
    });
    expect(host.body.textContent).toContain('Save');
    const actionForm = [...host.querySelectorAll('form')].find((form) =>
      form.textContent?.includes('执行动作'),
    )!;
    await flush(() => {
      const input = actionForm.querySelector('input')!;
      input.value = 'original action';
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(() => {
      actionForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      actionForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls.filter((call) => call.method === 'extensions.invoke')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'extensions.invoke')).toMatchObject({
      input: { text: 'original action' },
    });
    await flush(() =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '新动作')!
        .click(),
    );
    const queryForm = [...host.querySelectorAll('form')].find((form) =>
      form.textContent?.includes('读取结果'),
    )!;
    await flush(() => {
      const input = queryForm.querySelector('input')!;
      input.value = 'original query';
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush(() =>
      queryForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(host.body.textContent).toContain('完整原文');
    await flush(() =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '刷新扩展目录')!
        .click(),
    );
    expect(host.body.textContent).toContain('完整原文');
    const oldAction = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '保存结果',
    )!;
    expect(oldAction.disabled).toBe(true);
    await flush(() => oldAction.click());
    expect(calls.filter((call) => call.method === 'extensions.invoke')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'extensions.lookup')).toHaveLength(0);
    expect(host.body.textContent).not.toContain('unknown');
    await flush(() =>
      queryForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    const action = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '保存结果',
    )!;
    await flush(() => {
      action.click();
      action.click();
    });
    const invoke = calls.filter((call) => call.method === 'extensions.invoke');
    expect(invoke).toHaveLength(2);
    expect(invoke[1]).toMatchObject({
      observationId: 4,
      extensionId: 'public-extension',
      actionId: 'save',
      input: { text: '完整原文' },
      viewIndex: 0,
      actionIndex: 0,
    });
    expect(host.body.textContent).toContain('unknown');
    await flush(() =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '查询原命令')!
        .click(),
    );
    expect(calls.filter((call) => call.method === 'extensions.invoke')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'extensions.lookup')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'extensions.close')).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('complete reader rejects late scope and integrity failure, closes only the body', async () => {
  const { bridge, calls } = fixture();
  let current = true;
  const original = bridge.request.bind(bridge);
  bridge.request = async (request) => {
    const value = await original(request);
    if (request.method === 'extensions.read') current = false;
    return value;
  };
  await expect(
    readNativeExtensionBody(
      bridge,
      {
        method: 'extensions.open',
        generation: 1,
        readId: 'late',
        viewSelection: 1,
        historyEpoch: 0,
      },
      scope,
      'catalogue',
      () => current,
    ),
  ).rejects.toThrow('扩展视图已改变');
  expect(calls.at(-1)?.method).toBe('extensions.close');
  expect(calls.some((call) => call.method === 'extensions.release')).toBe(false);
  current = true;
  bridge.request = async (request) => {
    const value = await original(request);
    if (value && 'sha256' in value) return { ...value, sha256: '0'.repeat(64) };
    return value;
  };
  await expect(
    readNativeExtensionBody(
      bridge,
      {
        method: 'extensions.open',
        generation: 1,
        readId: 'bad',
        viewSelection: 1,
        historyEpoch: 0,
      },
      scope,
      'catalogue',
      () => current,
    ),
  ).rejects.toThrow('扩展内容校验失败');
});

test('real panel drops a late catalogue after session selection and releases its observation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!),
    host = dom.window.document;
  const { calls, bridge } = fixture();
  const original = bridge.request.bind(bridge);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  bridge.request = async (request) => {
    if (request.method === 'extensions.open') await waiting;
    return original(request);
  };
  try {
    await act(async () =>
      root.render(<NativeExtensions key="a" bridge={bridge} scope={scope} canRead canInvoke />),
    );
    await act(async () => {
      const details = host.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new dom.window.Event('toggle'));
      await Bun.sleep(10);
    });
    await act(async () =>
      root.render(
        <NativeExtensions
          key="b"
          bridge={bridge}
          scope={{ ...scope, sessionId: 'other', viewSelection: 2 }}
          canRead
          canInvoke
        />,
      ),
    );
    await act(async () => {
      release();
      await Bun.sleep(10);
    });
    expect(host.body.textContent).not.toContain('Save');
    expect(calls.some((call) => call.method === 'extensions.release')).toBe(true);
    expect(calls.filter((call) => call.method === 'extensions.close')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'extensions.invoke')).toBe(false);
    expect(host.querySelector('details')?.open).toBe(false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
