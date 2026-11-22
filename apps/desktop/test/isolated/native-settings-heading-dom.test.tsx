import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createRef } from 'react';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const initial = {
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
const { NativeSettingsDetail } = await import('../../src/native-settings-heading');
const { NativeSettingsWorkspace } = await import('../../src/native-settings-workspace');
Object.assign(globalThis, initial);
bootstrap.window.close();

test('all Settings categories render a consistent heading and detail retains its focus target', async () => {
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
  const doc = dom.window.document;
  const root = createRoot(doc.querySelector('#root')!);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsWorkspace
          bridge={{
            request: async () => {
              throw new Error('fixture_offline');
            },
          }}
          state={{
            instanceId: 'fixture',
            generation: 1,
            storeId: 'store',
            canReadWebSearch: true,
            windowsShell: false,
            editor: 'vscode',
            appearance: 'system',
            theme: 'dark',
          }}
          onClose={() => {}}
          onEditorChange={() => {}}
          onThemeChange={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    for (const [category, title] of [
      ['常规', '常规'],
      ['外观', '外观'],
      ['提供商与模型', '提供商与模型'],
      ['MCP', 'MCP'],
      ['技能', 'Skills'],
      ['网页搜索', '网页搜索'],
      ['轨迹与集成', '轨迹与集成'],
    ]) {
      const nav = [...doc.querySelectorAll<HTMLButtonElement>('.native-settings-rail nav button')];
      const item = nav.find((button) => button.textContent === category);
      expect(item).toBeDefined();
      await act(async () => item?.click());
      const headings = doc.querySelectorAll(
        '.settings-content > section > header.native-settings-heading',
      );
      expect(headings).toHaveLength(1);
      expect(headings[0]?.querySelector('h2')?.textContent).toBe(title);
      expect(headings[0]?.querySelector('p')?.textContent?.trim()).toBeTruthy();
    }
    const detailFocus = createRef<HTMLHeadingElement>();
    await act(async () =>
      root.render(
        <NativeSettingsDetail
          title="Skill 详情"
          description="本地工具"
          label="Skill 详情"
          detailFocus={detailFocus}
          onClose={() => {}}
        >
          <div className="right-sidebar-editor">
            <div className="right-sidebar-editor-body">正文</div>
            <footer className="right-sidebar-editor-footer">安装</footer>
          </div>
        </NativeSettingsDetail>,
      ),
    );
    expect(doc.querySelector('.native-settings-detail header h2')?.textContent).toBe('Skill 详情');
    expect(detailFocus.current?.tagName).toBe('H3');
    detailFocus.current?.focus();
    expect(doc.activeElement).toBe(detailFocus.current);
    expect(doc.querySelectorAll('.native-settings-detail header')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    restore();
    dom.window.close();
  }
});
