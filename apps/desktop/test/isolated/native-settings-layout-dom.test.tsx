import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { NativeSettingsDetail } from '../../src/native-settings-heading';
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
        onPageChange={(nextPage) => {
          setEditing(false);
          setPage(nextPage);
        }}
        canReadWebSearch={webSearch}
        onClose={() => closes++}
        onEditorBack={() => setEditing(false)}
        setEditorHost={setHost}
      >
        <p data-current-page="true">{page}</p>
        <button type="button" onClick={() => setEditing(true)}>
          Open editor
        </button>
        {editing &&
          host &&
          createPortal(
            <NativeSettingsDetail title="Editor" label="Editor" onClose={() => setEditing(false)}>
              Detail
            </NativeSettingsDetail>,
            host,
          )}
      </NativeSettingsLayout>
    );
  }
  const button = (label: string) =>
    [...target.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!;
  const press = (element: HTMLButtonElement) => act(async () => element.click());
  const backButtons = () => [
    ...target.querySelectorAll<HTMLButtonElement>('.native-settings-topbar button'),
  ];
  const closeButtons = () => [
    ...target.querySelectorAll<HTMLButtonElement>('button[aria-label="关闭设置"]'),
  ];
  const expectBack = (mode: 'list' | 'categories', text: string) => {
    const buttons = backButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.dataset.backTo).toBe(mode);
    expect(buttons[0]?.textContent).toBe(text);
    return buttons[0]!;
  };
  try {
    await act(async () => root.render(<Fixture webSearch={false} />));
    expect(button('网页搜索')).toBeUndefined();
    expect(button('常规').getAttribute('aria-pressed')).toBe('true');
    const back = expectBack('categories', '设置');
    expect(closeButtons()).toHaveLength(1);
    const close = closeButtons()[0]!;
    expect(close?.parentElement?.classList.contains('native-settings-layout')).toBe(true);
    await press(back);
    expect(
      target.querySelector('.native-settings-layout')?.getAttribute('data-narrow-screen'),
    ).toBe('categories');
    const appearance = button('外观');
    // JSDOM has no geometry; these controls are visible in the corresponding narrow step.
    for (const control of [button('常规'), appearance, back])
      Object.defineProperty(control, 'getClientRects', { value: () => ({ length: 1 }) });
    appearance.focus();
    await press(appearance);
    expect(target.querySelector('[data-current-page]')?.textContent).toBe('appearance');
    expect(appearance.getAttribute('aria-pressed')).toBe('true');
    expect(button('常规').getAttribute('aria-pressed')).toBe('false');
    expect(expectBack('categories', '设置')).toBe(back);
    expect(document.activeElement === back).toBe(true);
    await press(back);
    expect(document.activeElement === appearance).toBe(true);
    await press(appearance);
    expect(document.activeElement === back).toBe(true);
    await act(async () => root.render(<Fixture webSearch />));
    expect(button('网页搜索')).toBeDefined();
    const categories = [...target.querySelectorAll('.native-settings-rail nav button')];
    expect(categories).toHaveLength(7);
    for (const category of categories) {
      expect(category.getAttribute('data-variant')).toBe('plain');
      expect(category.classList.contains('transition-none')).toBe(true);
      expect(category.className).not.toContain('hover:');
    }

    await press(button('MCP'));
    const list = target.querySelector('.settings-content');
    const editor = target.querySelector('.settings-editor-panel');
    expect(list?.parentElement).toBe(editor?.parentElement);
    await press(button('Open editor'));
    expect(target.querySelector('.settings-content')).toBe(list);
    expect(editor?.querySelector('.right-sidebar h2')?.textContent).toBe('Editor');
    expect(editor?.querySelector('.right-sidebar-close')).toBeNull();
    expect(expectBack('list', 'MCP 连接')).toBe(back);
    expect(closeButtons()).toEqual([close]);
    await press(back);
    expect(editor?.childElementCount).toBe(0);
    expect(target.querySelector('.settings-content')).toBe(list);
    expect(expectBack('categories', '设置')).toBe(back);
    await press(button('Open editor'));
    expect(expectBack('list', 'MCP 连接')).toBe(back);
    await press(button('技能'));
    expect(expectBack('categories', '设置')).toBe(back);
    await press(button('Open editor'));
    expect(expectBack('list', '技能')).toBe(back);
    await press(back);
    expect(expectBack('categories', '设置')).toBe(back);
    expect(closes).toBe(0);
    await press(close);
    expect(closes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    restore();
    dom.window.close();
  }
});
