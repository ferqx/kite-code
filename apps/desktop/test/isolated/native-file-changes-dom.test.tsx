import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { NativeFileChanges, NativeOutputFile } from '../../src/native-file-changes';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('retained FileChanges mounts only through the selected changes tab, reads all metadata pages and lazy saved bodies, and routes the selected editor by observation ID', async () => {
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
      (button) => button.textContent === text || button.getAttribute('aria-label') === text,
    )!;
  try {
    await act(async () => {
      render();
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      button('标签页').click();
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      button('变更').click();
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
      button('打开当前文件：written.txt').click();
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
      button('打开当前文件：written.txt').click();
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
    expect(button('标签页').getAttribute('aria-expanded')).toBe('false');
    expect(dom.window.document.querySelector('.session-tab-changes')).toBeNull();
    await act(async () => {
      button('标签页').click();
    });
    expect(button('标签页').getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dom.window.document.querySelector('.session-tab-changes')).toBeNull();
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

test('tool delivery snapshots use the named shared viewport while retaining original paging, close and current-file actions', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
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
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const requests: NativeRequest[] = [];
  const first = '原交付第一段\nUnicode 漢字🙂\n';
  const nextOffset = new TextEncoder().encode(first).byteLength;
  const tail = '原交付最后一段\nSAVED_SNAPSHOT_TAIL';
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      requests.push(input);
      if (input.method === 'fileChanges.detail')
        return {
          kind: 'fileChanges.detail',
          changeId: input.changeId,
          text: input.offset === nextOffset ? tail : first,
          snapshot: true,
          offset: input.offset ?? 0,
          nextOffset: input.offset === nextOffset ? null : nextOffset,
        };
      return null;
    },
  };
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent === text,
    )!;
  try {
    await act(async () =>
      root.render(
        <NativeOutputFile
          bridge={bridge}
          generation={7}
          editor="textedit"
          entry={{
            changeId: 'original-delivery',
            messageId: 'original-tool',
            path: 'report.txt',
            preview: 'available',
            openable: true,
            snapshot: true,
          }}
        />,
      ),
    );
    expect(requests).toEqual([]);
    const details = host.querySelector('details')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new dom.window.Event('toggle'));
    });
    const viewport = host.querySelector<HTMLElement>('[aria-label="交付文件历史内容"]')!;
    expect(viewport.getAttribute('data-slot')).toBe('scroll-area-viewport');
    expect(viewport.getAttribute('role')).toBe('region');
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(viewport.classList.contains('scroll-fade-y')).toBe(true);
    expect(viewport.closest('.tool-snapshot-scroll')).not.toBeNull();
    viewport.focus();
    expect(dom.window.document.activeElement).toBe(viewport);
    const pre = viewport.querySelector<HTMLPreElement>('pre.tool-file-snapshot')!;
    expect(pre.textContent).toBe(first);
    expect(pre.style.whiteSpace).toBe('pre-wrap');
    expect(pre.style.overflowWrap).toBe('anywhere');
    expect(pre.style.overflow).toBe('');
    expect(pre.style.maxHeight).toBe('');
    expect(pre.getAttribute('tabindex')).toBeNull();
    await act(async () => button('读取下一段').click());
    expect(host.querySelector('[aria-label="交付文件历史内容"] pre')?.textContent).toBe(tail);
    expect(button('读取下一段')).toBeUndefined();
    await act(async () => button('回到开头').click());
    expect(host.querySelector('[aria-label="交付文件历史内容"] pre')?.textContent).toBe(first);
    const reads = requests.filter((entry) => entry.method === 'fileChanges.detail');
    expect(reads.map((entry) => entry.offset)).toEqual([0, nextOffset, 0]);
    expect(
      reads.every((entry) => entry.changeId === 'original-delivery' && entry.generation === 7),
    ).toBe(true);
    await act(async () => button('打开当前文件：report.txt').click());
    expect(requests.filter((entry) => entry.method === 'fileChanges.open')).toEqual([
      {
        method: 'fileChanges.open',
        generation: 7,
        changeId: 'original-delivery',
        editor: 'textedit',
      },
    ]);
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new dom.window.Event('toggle'));
    });
    expect(host.querySelector('[aria-label="交付文件历史内容"]')).toBeNull();
    expect(
      requests.filter((entry) => entry.method === 'fileChanges.close').map((entry) => entry.readId),
    ).toEqual(reads.map((entry) => entry.readId));
    expect(requests.every((entry) => entry.method.startsWith('fileChanges.'))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    restoreLayout();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
