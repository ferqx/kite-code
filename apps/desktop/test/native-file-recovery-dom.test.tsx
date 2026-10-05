import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeFileRecoveryObservation,
  NativeRequest,
  NativeSelection,
} from '../src/native-bridge';
import { NativeFileRecoveryPanel } from '../src/native-file-recovery';

test('Native Files DOM binds explicit scope to observed point, edits/hide invalidate and late old detail never replaces another Session', async () => {
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
  const selected = (id: string) =>
    ({
      storeId: 'store',
      viewGeneration: 1,
      viewSelection: id === 's' ? 1 : 2,
      canReadModelOutput: false,
      session: {
        id,
        workspaceId: 'w',
        parentSessionId: null,
        title: id,
        controlRevision: '1',
        contextSelectionId: 'selector',
        nextSeq: '4',
        deletedAt: null,
      },
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    }) as NativeSelection;
  const checkpoint = {
    id: 'a'.repeat(64),
    workspace: { device: '1', inode: '2' },
    boundary: {
      storeId: 'origin-A',
      sessionId: 'parent',
      workspaceId: 'original-W',
      runId: 'r',
      contextSelectionId: 'original-selection',
      messageId: null,
      messageSeq: '0',
      triggerMessageId: 'original-message',
      triggerSeq: '3',
    },
  };
  const facts: NativeFileRecoveryObservation = {
    kind: 'fileRecovery.observation',
    observationId: 1,
    inputRevision: 0,
    detail: {
      storeId: 'store',
      sessionId: 's',
      workspaceId: 'w',
      payload: { checkpoint, files: [] },
    },
    boundary: {
      storeId: 'store',
      sessionId: 's',
      workspaceId: 'w',
      contextSelectionId: 'selector',
      checkpoint,
      boundary: null,
      trigger: { messageId: 'mapped-trigger', seq: '3' },
    },
  };
  let release!: (value: NativeFileRecoveryObservation) => void,
    held = false;
  const waiting = new Promise<NativeFileRecoveryObservation>((resolve) => {
    release = resolve;
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method === 'fileRecovery.list')
        return {
          storeId: 'store',
          sessionId: 's',
          workspaceId: 'w',
          payload: { items: [{ checkpoint, revision: '1' }], nextAfterKey: null },
        };
      if (input.method === 'fileRecovery.detail')
        return held ? waiting : { ...facts, inputRevision: input.inputRevision };
      return null;
    },
  };
  const render = (id: string) =>
      root.render(
        <NativeFileRecoveryPanel
          bridge={bridge}
          generation={1}
          selection={selected(id)}
          submissions={[]}
          onRefresh={async () => {}}
          onSelect={async () => {}}
        />,
      ),
    button = (text: string) =>
      [...element.querySelectorAll('button')].find((value) => value.textContent === text)!;
  try {
    await act(async () => render('s'));
    await act(async () => button('文件检查点').click());
    await act(async () => button('读取检查点').click());
    await act(async () => button(`检查点 ${checkpoint.id}`).click());
    expect(element.textContent).toContain('origin-A/parent');
    expect(button('执行恢复').disabled).toBe(true);
    const checkbox = element.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    await act(async () => checkbox.click());
    await act(async () => {
      button('执行恢复').click();
      button('执行恢复').click();
    });
    expect(calls.filter((value) => value.method === 'fileRecovery.begin')).toHaveLength(1);
    const begin = calls.find((value) => value.method === 'fileRecovery.begin')!;
    expect(Object.keys(begin).sort()).toEqual(
      ['generation', 'inputRevision', 'method', 'observationId', 'scope', 'title'].sort(),
    );
    await act(async () => button(`检查点 ${checkpoint.id}`).click());
    await act(async () => {
      const select = element.querySelector('select')!;
      select.value = 'both';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    expect(element.textContent).not.toContain('当前来源');
    held = true;
    await act(async () => {
      button(`检查点 ${checkpoint.id}`).click();
    });
    await act(async () => render('other'));
    await act(async () => release(facts));
    expect(element.textContent).not.toContain('origin-A/parent');
    expect(calls.some((value) => value.method === 'fileRecovery.close')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
