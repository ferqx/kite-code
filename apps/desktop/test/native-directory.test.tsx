import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeDirectory } from '../src/native-directory';

test('PC directory groups original IDs, keeps navigation available during creation, and folds without a business call', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
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
  const element = dom.window.document.getElementById('root')!;
  const root = createRoot(element);
  const selected: string[] = [],
    created: string[] = [];
  const session = (id: string, workspaceId: string): Session => ({
    id,
    workspaceId,
    parentSessionId: null,
    rootSessionId: id,
    title: '同名会话🙂',
    controlRevision: '0',
    contextSelectionId: 'selection',
    nextSeq: '0',
    deletedAt: null,
  });
  const workspaces = ['a', 'b', 'empty'].map((id) => ({
    id,
    name: `项目 ${id}`,
    rootUri: `file:///${id}`,
  }));
  const render = (creating: boolean) =>
    root.render(
      <NativeDirectory
        workspaces={workspaces}
        sessions={[session('first', 'a'), session('second', 'b'), session('late', 'later')]}
        selectedId="first"
        creating={creating}
        onCreate={(id) => created.push(id)}
        onSelect={(id) => selected.push(id)}
      />,
    );
  const group = (id: string) =>
    element.querySelector<HTMLElement>(`section[aria-label="项目 ${id}"]`)!;
  try {
    await act(async () => render(true));
    expect(group('a').querySelector('button[aria-current=page]')?.textContent).toBe('同名会话🙂');
    expect(group('b').querySelector('button[aria-current]')).toBeNull();
    expect(group('empty').textContent).toContain('暂无聊天');
    expect(element.querySelector('section[aria-label="项目待读取的会话"]')?.textContent).toContain(
      '同名会话🙂',
    );
    const a = group('a').querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => a.click());
    expect(a.getAttribute('aria-expanded')).toBe('false');
    expect(group('a').querySelector('ul')).toBeNull();
    expect(group('b').querySelector('ul')).not.toBeNull();
    expect(selected).toEqual([]);
    expect(created).toEqual([]);
    await act(async () => a.click());
    const original = group('a').querySelector<HTMLButtonElement>('li button')!;
    original.focus();
    await act(async () =>
      original.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(dom.window.document.activeElement).toBe(
      group('b').querySelector('button[aria-expanded]'),
    );
    expect(selected).toEqual([]);
    const other = group('b').querySelector<HTMLButtonElement>('li button')!;
    expect(other.disabled).toBe(false);
    await act(async () => other.click());
    expect(selected).toEqual(['second']);
    expect(
      group('b').querySelector<HTMLButtonElement>('button:not([data-directory-item])')!.disabled,
    ).toBe(true);
    await act(async () => render(false));
    await act(async () =>
      group('b').querySelector<HTMLButtonElement>('button:not([data-directory-item])')!.click(),
    );
    expect(created).toEqual(['b']);
    expect(selected).toEqual(['second']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
