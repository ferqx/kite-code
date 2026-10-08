import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { NativeFileChanges } from '../../src/native-file-changes';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('retained FileChanges mounts only on the original header action, reads all metadata pages and lazy saved bodies, and routes the selected editor by observation ID', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
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
  const root = createRoot(dom.window.document.getElementById('root')!);
  const requests: NativeRequest[] = [];
  const selection = {
    storeId: 'store',
    viewSelection: 7,
    viewGeneration: 9,
    session: { id: 's', workspaceId: 'w' },
  } as NativeSelection;
  const messages = Array.from(
    { length: 36 },
    (_, index): Message => ({
      id: `m${index}`,
      role: 'tool',
      runId: 'run',
      sessionId: 's',
      seq: String(index + 1),
      content: 'untrusted content is not a diff',
      status: 'complete',
      sourceIds: [`e${index}`],
    }),
  );
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      requests.push(input);
      if (input.method === 'fileChanges.list')
        return {
          kind: 'fileChanges.page',
          readId: input.readId,
          scope: {
            generation: 1,
            viewSelection: 7,
            historyEpoch: 0,
            storeId: 'store',
            sessionId: 's',
            workspaceId: 'w',
          },
          entries: input.messageIds
            .filter((id) => ['m0', 'm33'].includes(id))
            .map((id) => ({
              changeId: `observed-${id}`,
              messageId: id,
              path: id === 'm0' ? 'written.txt' : 'old.txt',
              preview: id === 'm0' ? 'available' : 'unavailable',
              openable: true,
            })),
        };
      if (input.method === 'fileChanges.detail')
        return {
          kind: 'fileChanges.detail',
          changeId: input.changeId,
          text: '2 -saved old\n2 +saved new\n',
          truncated: true,
        };
      return null;
    },
  };
  let editor: 'zed' | 'textedit' = 'zed';
  let tools = true;
  const render = () =>
    root.render(
      <SessionPage
        workspaces={[]}
        sessionLabel="files"
        readingKey="s"
        messages={[]}
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        detailPanel={
          tools
            ? {
                label: '会话工具',
                content: <p>Original host panel</p>,
                onClose() {
                  tools = false;
                  render();
                },
              }
            : undefined
        }
        headerActions={
          <button
            type="button"
            onClick={() => {
              tools = true;
              render();
            }}
          >
            会话工具
          </button>
        }
        fileChangesContent={
          <NativeFileChanges
            bridge={bridge}
            generation={1}
            selection={selection}
            historyEpoch={0}
            messages={messages}
            historyComplete
            editor={editor}
          />
        }
      />,
    );
  const button = (text: string) =>
    [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === text,
    )!;
  try {
    await act(async () => {
      render();
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      button('文件变更').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      requests
        .filter((request) => request.method === 'fileChanges.list')
        .map(
          (request) =>
            (request as Extract<NativeRequest, { method: 'fileChanges.list' }>).messageIds.length,
        ),
    ).toEqual([32, 4]);
    expect(dom.window.document.querySelectorAll('details.file-change')).toHaveLength(2);
    expect(requests.some((request) => request.method === 'fileChanges.detail')).toBe(false);
    const detail = dom.window.document.querySelector('details.file-change') as HTMLDetailsElement;
    await act(async () => {
      detail.open = true;
      detail.dispatchEvent(new dom.window.Event('toggle'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dom.window.document.querySelector('[aria-label="文件差异"]')!.textContent).toContain(
      'saved new',
    );
    expect(dom.window.document.querySelector('.diff-added')!.textContent).toContain('+saved new');
    expect(dom.window.document.body.textContent).toContain('差异预览已截断');
    await act(async () => {
      button('written.txt').click();
    });
    expect(requests.filter((request) => request.method === 'fileChanges.open').at(-1)).toEqual({
      method: 'fileChanges.open',
      generation: 1,
      changeId: 'observed-m0',
      editor: 'zed',
    });
    editor = 'textedit';
    await act(async () => {
      render();
    });
    await act(async () => {
      button('written.txt').click();
    });
    expect(requests.filter((request) => request.method === 'fileChanges.open').at(-1)).toEqual({
      method: 'fileChanges.open',
      generation: 1,
      changeId: 'observed-m0',
      editor: 'textedit',
    });
    const old = dom.window.document.querySelectorAll(
      'details.file-change',
    )[1] as HTMLDetailsElement;
    await act(async () => {
      old.open = true;
      old.dispatchEvent(new dom.window.Event('toggle'));
    });
    expect(old.textContent).toContain('历史记录未保存可读差异');
    expect(old.textContent).not.toContain('untrusted content is not a diff');
    await act(async () => {
      button('会话工具').click();
    });
    expect(button('文件变更').getAttribute('aria-expanded')).toBe('false');
    expect(dom.window.document.querySelector('#session-file-changes')).toBeNull();
    await act(async () => {
      button('文件变更').click();
    });
    expect(button('收起变更').getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dom.window.document.querySelector('#session-file-changes')).toBeNull();
    expect(requests.some((request) => request.method === 'fileChanges.close')).toBe(true);
    expect(requests.every((request) => request.method.startsWith('fileChanges.'))).toBe(true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    restoreLayout();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
