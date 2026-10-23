import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { NativeOutputFile } from '../../src/native-file-changes';

test('delivery cards lazily read their own immutable version when the current file is missing', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: NativeRequest[] = [];
  const bridge = {
    watch: () => () => {},
    request: async (request: NativeRequest) => {
      calls.push(request);
      return request.method === 'fileChanges.detail'
        ? {
            kind: 'fileChanges.detail',
            changeId: request.changeId,
            snapshot: true,
            text: request.changeId === 'old' ? '原报告 中文' : '修改后的报告',
            nextOffset: null,
          }
        : null;
    },
  } as NativeBridge;
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <>
          {['old', 'new'].map((id) => (
            <NativeOutputFile
              key={id}
              bridge={bridge}
              generation={1}
              editor="vscode"
              entry={{
                changeId: id,
                messageId: id,
                snapshot: true,
                preview: 'available',
                openable: false,
              }}
            />
          ))}
        </>,
      );
    });
    expect(calls).toEqual([]);
    const cards = [...container.querySelectorAll('details')];
    await act(async () => {
      for (const card of cards) {
        card.open = true;
        card.dispatchEvent(new dom.window.Event('toggle'));
      }
    });
    expect(cards[0]!.textContent).toContain('原报告 中文');
    expect(cards[1]!.textContent).toContain('修改后的报告');
    expect(container.textContent).not.toContain('打开当前文件');
    expect(
      calls
        .filter((request) => request.method === 'fileChanges.detail')
        .map((request) => request.changeId),
    ).toEqual(['old', 'new']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
