import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { NativeSettingsLayout, type NativeSettingsPage } from '../../src/native-settings-layout';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('settings routes share a retained list and a separate editor host in one workspace', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restore = prepareDesktopDom(dom);
  const previous = {
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
  const target = dom.window.document.querySelector('#root')!;
  const root = createRoot(target);
  let closes = 0;
  function Fixture({ webSearch }: { webSearch: boolean }) {
    const [page, setPage] = useState<NativeSettingsPage>('general');
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [editing, setEditing] = useState(false);
    return (
      <NativeSettingsLayout
        page={page}
        onPageChange={setPage}
        canReadWebSearch={webSearch}
        onClose={() => closes++}
        onEditorBack={() => setEditing(false)}
        setEditorHost={setHost}
      >
        <p data-current-page="true">{page}</p>
        <button type="button" onClick={() => setEditing(true)}>
          Open editor
        </button>
        {editing && host && createPortal(<aside className="right-sidebar">Editor</aside>, host)}
      </NativeSettingsLayout>
    );
  }
  const button = (label: string) =>
    [...target.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!;
  const press = (element: HTMLButtonElement) => act(async () => element.click());
  try {
    await act(async () => root.render(<Fixture webSearch={false} />));
    expect(button('网页搜索')).toBeUndefined();
    expect(button('常规').getAttribute('aria-pressed')).toBe('true');
    await press(button('外观'));
    expect(target.querySelector('[data-current-page]')?.textContent).toBe('appearance');
    await act(async () => root.render(<Fixture webSearch />));
    expect(button('网页搜索')).toBeDefined();

    await press(button('MCP'));
    const list = target.querySelector('.settings-content');
    const editor = target.querySelector('.settings-editor-panel');
    expect(list?.parentElement).toBe(editor?.parentElement);
    await press(button('Open editor'));
    expect(target.querySelector('.settings-content')).toBe(list);
    expect(editor?.querySelector('.right-sidebar')?.textContent).toBe('Editor');
    await press(button('MCP 连接'));
    expect(editor?.childElementCount).toBe(0);
    expect(target.querySelector('.settings-content')).toBe(list);
    expect(closes).toBe(0);
    await press(
      target.querySelector<HTMLButtonElement>('.native-settings-topbar [aria-label="关闭设置"]')!,
    );
    expect(closes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    restore();
    dom.window.close();
  }
});
