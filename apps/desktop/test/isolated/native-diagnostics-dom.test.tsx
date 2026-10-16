import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeCallerMetadata, NativeRequest, NativeState } from '../../src/native-bridge';
import { NativeCallerView } from '../../src/native-caller';
import { NativeDiagnosticsProvider } from '../../src/native-diagnostics';
import { NativeExecutionResult } from '../../src/native-result';

test('ordinary caller UI hides machine identities and ended diagnostics while unknown lookup/cancel retain exact commands', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const before = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const rendered = createRoot(dom.window.document.getElementById('root')!);
  const row = (id: string, phase: NativeCallerMetadata['phase']): NativeCallerMetadata => ({
    scope: { storeId: 'private-store-id', sessionId: 'private-session-id', workspaceId: 'w' },
    subjectId: 'subject',
    target: { kind: 'session', id: 'private-session-id' },
    request: { kind: 'run.start', commandId: id, expectedStoreId: 'private-store-id' },
    bodyDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    phase,
  });
  const state: NativeState = {
    generation: 7,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    callerSubmissions: [
      row('original-unknown-command', 'unknown'),
      row('ended-command', 'applied'),
    ],
  };
  const requests: NativeRequest[] = [];
  const bridge = {
    async request(request: NativeRequest) {
      requests.push(request);
      return state;
    },
    watch: () => () => {},
  };
  const draw = (enabled?: boolean) =>
    act(async () => {
      rendered.render(
        <NativeDiagnosticsProvider enabled={enabled}>
          <NativeCallerView bridge={bridge} state={state} onRefresh={async () => {}} />
        </NativeDiagnosticsProvider>,
      );
    });
  try {
    await draw();
    const text = () => dom.window.document.body.textContent ?? '';
    expect(text()).not.toContain('original-unknown-command');
    expect(text()).not.toContain('private-session-id');
    expect(text()).not.toContain('ended-command');
    expect(text()).not.toContain('原完整请求');
    const buttons = () => [...dom.window.document.querySelectorAll('button')];
    await act(async () =>
      buttons()
        .find((button) => button.textContent === '只查原申请')!
        .click(),
    );
    await act(async () =>
      buttons()
        .find((button) => button.textContent === '取消原申请')!
        .click(),
    );
    expect(requests).toEqual([
      { method: 'caller.lookup', generation: 7, commandId: 'original-unknown-command' },
      { method: 'cancelInput', generation: 7, commandId: 'original-unknown-command' },
    ]);
    await act(async () =>
      buttons()
        .find((button) => button.textContent === '查看提交记录')!
        .click(),
    );
    expect(text()).not.toContain('ended-command');
    expect(buttons().some((button) => button.textContent === '查看原提交内容')).toBe(true);
    expect(buttons().some((button) => button.textContent === '清理已核实提交记录')).toBe(true);
    expect(requests).toHaveLength(2);
    await draw(true);
    expect(text()).toContain('original-unknown-command');
    expect(text()).toContain('private-session-id');
    expect(text()).toContain('ended-command');
    expect(text()).toContain('原完整请求');
    expect(text()).toContain('清除已核实申请');
    expect(requests).toHaveLength(2);
    const buildConstant = Object.getOwnPropertyDescriptor(
      globalThis,
      '__KITE_DESKTOP_TEST_DIAGNOSTICS__',
    );
    try {
      // Both the dev renderer and ordinary release build compile this value to false.
      Object.defineProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__', {
        configurable: true,
        value: false,
      });
      await draw(true);
      expect(text()).not.toContain('original-unknown-command');
      expect(text()).not.toContain('private-session-id');
      expect(text()).not.toContain('ended-command');
      expect(text()).not.toContain('原完整请求');
      expect(requests).toHaveLength(2);
    } finally {
      if (buildConstant)
        Object.defineProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__', buildConstant);
      else Reflect.deleteProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__');
    }
  } finally {
    await act(async () => rendered.unmount());
    Object.assign(globalThis, before);
    dom.window.close();
  }
});

test('ordinary Tool result preserves every business field and exact text; diagnostics retains the original JSON', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const before = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const rendered = createRoot(dom.window.document.getElementById('root')!);
  const result = {
    text: 'first line\nsecond line  \n原文😀',
    code: 17,
    error: { code: 'real_tool_error', message: 'precise failure\nwith details' },
    rows: ['original array text', null, false, { unknownBusinessField: 'kept' }],
    nullable: null,
    completed: false,
    sessionId: 'business result identity is content',
    emptyArray: [],
    emptyObject: {},
  };
  const draw = (enabled = false, model = false) =>
    act(async () => {
      rendered.render(
        <NativeDiagnosticsProvider enabled={enabled}>
          <NativeExecutionResult result={result} model={model} />
        </NativeDiagnosticsProvider>,
      );
    });
  try {
    await draw();
    const content = () => dom.window.document.body.textContent ?? '';
    for (const name of Object.keys(result)) expect(content()).toContain(name);
    for (const value of [
      result.text,
      result.error.message,
      '17',
      'real_tool_error',
      'original array text',
      'null',
      'false',
      'unknownBusinessField',
      'kept',
      result.sessionId,
      '[]',
      '{}',
    ])
      expect(content()).toContain(value);
    expect(
      [...dom.window.document.querySelectorAll('pre')].some(
        (pre) => pre.textContent === result.text,
      ),
    ).toBe(true);
    await draw(true);
    expect(dom.window.document.querySelector('pre')!.textContent).toBe(
      JSON.stringify(result, null, 2),
    );
    await draw(false, true);
    expect(content()).toBe('');
  } finally {
    await act(async () => rendered.unmount());
    Object.assign(globalThis, before);
    dom.window.close();
  }
});
