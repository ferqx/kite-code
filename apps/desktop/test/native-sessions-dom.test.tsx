import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeRequest,
  NativeSelection,
  NativeSessionFacts,
} from '../src/native-bridge';
import { NativeSessionPanel } from '../src/native-sessions';

test('Native management DOM late observation cannot replace another view; same in-flight choice dispatches once and child is read-only', async () => {
  const dom = new JSDOM('<div id="root"></div>'),
    prior = {
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
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element),
    calls: NativeRequest[] = [];
  let release!: (value: NativeSessionFacts) => void, finish!: () => void;
  const waiting = new Promise<NativeSessionFacts>((resolve) => {
      release = resolve;
    }),
    mutation = new Promise<null>((resolve) => {
      finish = () => resolve(null);
    });
  const selected = (id: string, child = false) =>
    ({
      storeId: 'store',
      viewGeneration: 1,
      viewSelection: id === 'old' ? 1 : 2,
      canReadContext: true,
      canReadModelOutput: false,
      session: {
        id,
        workspaceId: 'w',
        rootSessionId: child ? 'root' : id,
        parentSessionId: child ? 'root' : null,
        title: id,
        controlRevision: '7',
        contextSelectionId: 'selection',
        nextSeq: '0',
        deletedAt: null,
      },
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    }) as NativeSelection;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method === 'session.observe')
        return input.sessionId === 'old'
          ? waiting
          : { observationId: 2, session: selected(input.sessionId).session };
      if (input.method === 'session.rename') return mutation;
      return null;
    },
  };
  const render = (id: string, child = false) =>
      root.render(
        <NativeSessionPanel
          bridge={bridge}
          generation={1}
          selection={selected(id, child)}
          submissions={[]}
          onRefresh={async () => {}}
          onSelect={async () => {}}
        />,
      ),
    button = (name: string) =>
      [...element.querySelectorAll('button')].find((value) => value.textContent === name)!;
  try {
    await act(async () => render('old'));
    await act(async () => button('读取当前会话管理事实').click());
    await act(async () => render('new'));
    await act(async () => release({ observationId: 1, session: selected('old').session }));
    expect(element.textContent).not.toContain('原会话 old');
    await act(async () => button('读取当前会话管理事实').click());
    expect(element.textContent).toContain('控制修订 7');
    await act(async () => {
      button('保存当前会话名称').click();
      button('保存当前会话名称').click();
    });
    expect(calls.filter((value) => value.method === 'session.rename')).toHaveLength(1);
    expect(calls.find((value) => value.method === 'session.rename')).toEqual({
      method: 'session.rename',
      generation: 1,
      observationId: 2,
      title: 'new',
    });
    await act(async () => render('child', true));
    await act(async () => finish());
    await act(async () => button('读取当前会话管理事实').click());
    expect(element.textContent).toContain('当前会话管理只读');
    expect(
      [...element.querySelectorAll('button')].some((value) => value.textContent === '删除当前会话'),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
