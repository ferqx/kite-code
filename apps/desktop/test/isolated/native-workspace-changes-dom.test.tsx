import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeSelection,
} from '../../src/native-bridge';
import { NativeWorkspaceChanges } from '../../src/native-workspace-changes';
import type {
  NativeWorkspaceChange,
  NativeWorkspaceChangeDetail,
} from '../../src/workspace-changes-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

function change(index: number, path = `src/${index}.txt`): NativeWorkspaceChange {
  return {
    changeId: `change-${index}`,
    path,
    indexStatus: 'M',
    worktreeStatus: 'M',
    untracked: false,
  };
}

async function fixture(entries = Array.from({ length: 65 }, (_, index) => change(index))) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const previous = {
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
  const listeners = new Set<(event: NativeEvent) => void>();
  const heldDetails: { readId: string; release: () => void }[] = [];
  const heldLists: (() => void)[] = [];
  const state = {
    entries,
    sessionId: 'one',
    viewSelection: 1,
    listMode: 'normal' as 'normal' | 'held' | 'failure' | 'nonrepo' | 'mismatch' | 'filters',
    detailMode: 'normal' as 'normal' | 'held' | 'failure' | 'mismatch',
    detailReason: undefined as NativeWorkspaceChangeDetail['reason'],
    detailEmpty: false,
    truncated: false,
    detailTruncated: false,
    refreshKey: '',
    detailVersion: '',
  };
  const bridge: NativeBridge = {
    watch: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async request(input) {
      requests.push(input);
      if (input.method === 'workspaceChanges.list') {
        if (state.listMode === 'failure') throw Error('git_read_failed');
        if (state.listMode === 'filters') throw Error('workspace_changes_filters_unsupported');
        const result: NativeResult = {
          kind: 'workspaceChanges.page',
          readId: input.readId,
          scope: {
            generation: 1,
            viewSelection: input.viewSelection,
            storeId: 'store',
            sessionId: state.listMode === 'mismatch' ? 'foreign' : state.sessionId,
            workspaceId: 'w',
          },
          repository: state.listMode !== 'nonrepo',
          truncated: state.truncated,
          entries: state.listMode === 'nonrepo' ? [] : state.entries,
        };
        if (state.listMode === 'held')
          return new Promise((resolve) => heldLists.push(() => resolve(result)));
        return result;
      }
      if (input.method === 'workspaceChanges.detail') {
        if (state.detailMode === 'failure') throw Error('git_read_failed');
        const result: NativeResult = {
          kind: 'workspaceChanges.detail',
          readId: state.detailMode === 'mismatch' ? 'foreign' : input.readId,
          changeId: input.changeId,
          text:
            state.detailReason || state.detailEmpty
              ? undefined
              : `--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old-${input.changeId}\n+current-${input.changeId}${state.detailVersion}\n`,
          reason: state.detailReason,
          truncated: state.detailTruncated,
        };
        if (state.detailMode === 'held')
          return new Promise((resolve) =>
            heldDetails.push({ readId: input.readId, release: () => resolve(result) }),
          );
        return result;
      }
      return null;
    },
  };
  async function settle(ms = 20) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
  async function render(visible = true, wait = true) {
    await act(async () => {
      root.render(
        visible ? (
          <NativeWorkspaceChanges
            bridge={bridge}
            generation={1}
            selection={
              {
                storeId: 'store',
                viewGeneration: 1,
                viewSelection: state.viewSelection,
                session: { id: state.sessionId, workspaceId: 'w' },
              } as NativeSelection
            }
            refreshKey={state.refreshKey}
          />
        ) : null,
      );
    });
    if (wait) await settle();
  }
  async function clickButton(text: string) {
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === text)!.click();
    });
    await settle();
  }
  async function select(index: number) {
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-change-id="change-${index}"]`)!.click();
    });
  }
  async function filter(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      // Native input event exercises the controlled field, not a test-only component prop.
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  }
  async function key(value: string) {
    await act(async () => {
      dom.window.document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }),
      );
    });
  }
  async function cleanup() {
    await act(async () => root.unmount());
    restore();
    Object.assign(globalThis, previous);
    dom.window.close();
  }
  return {
    dom,
    host,
    state,
    requests,
    heldDetails,
    heldLists,
    render,
    settle,
    clickButton,
    select,
    filter,
    key,
    cleanup,
    async invalidate(
      overrides: Partial<Extract<NativeEvent, { kind: 'workspaceChanges.changed' }>> = {},
    ) {
      const last = [...requests]
        .reverse()
        .find((input) => input.method === 'workspaceChanges.list')!;
      await act(async () => {
        for (const listener of listeners)
          listener({
            kind: 'workspaceChanges.changed',
            generation: 1,
            readId: last.readId,
            scope: {
              generation: 1,
              viewSelection: state.viewSelection,
              storeId: 'store',
              sessionId: state.sessionId,
              workspaceId: 'w',
            },
            ...overrides,
          });
      });
    },
    async visibility(value: 'visible' | 'hidden') {
      Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value });
      await act(async () =>
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')),
      );
      await settle();
    },
  };
}

function requestCount(requests: NativeRequest[], method: NativeRequest['method']) {
  return requests.filter((item) => item.method === method).length;
}

test('workspace tree is metadata-first and fixed-page bounded; selecting a new file closes the old read', async () => {
  const f = await fixture();
  try {
    await f.render(false);
    expect(f.requests).toHaveLength(0);
    await f.render();
    expect(f.host.textContent).toContain('不代表 Agent 的贡献');
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(50);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(0);
    expect(f.host.textContent).toContain('选择文件查看差异');
    await f.clickButton('下一页');
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(16);
    await f.select(64);
    expect(f.host.textContent).toContain('current-change-64');
    const firstRead = [...f.requests]
      .reverse()
      .find((item) => item.method === 'workspaceChanges.detail')!;
    await f.clickButton('上一页');
    await f.select(0);
    expect(f.host.textContent).toContain('current-change-0');
    expect(f.host.textContent).not.toContain('current-change-64');
    expect(
      f.requests.some(
        (item) =>
          item.method === 'workspaceChanges.close' &&
          'readId' in firstRead &&
          item.readId === firstRead.readId,
      ),
    ).toBe(true);
    expect(f.host.querySelectorAll('.workspace-change-preview')).toHaveLength(1);
    expect(f.host.textContent).toContain('已暂存 M / 未暂存 M');
    expect(
      f.requests
        .filter((item) => item.method === 'workspaceChanges.detail')
        .every((item) => !('path' in item)),
    ).toBe(true);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="关闭当前文件差异"]')!.click(),
    );
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test('filtering and directory folding keep selection distinct, cancel hidden reads and preserve rename/status metadata', async () => {
  const entries = [
    change(0, 'src/alpha.ts'),
    {
      ...change(1, 'src/beta.ts'),
      oldPath: 'legacy/old.ts',
      indexStatus: 'R',
      worktreeStatus: ' ',
    },
    { ...change(2, 'notes/new.md'), untracked: true },
    { ...change(3, 'src/conflict.ts'), indexStatus: 'U', worktreeStatus: 'U' },
  ];
  const f = await fixture(entries);
  try {
    await f.render();
    await f.select(0);
    const src = [...f.host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
      (node) => node.title === 'src/',
    )!;
    await act(async () => src.click());
    expect(src.getAttribute('aria-expanded')).toBe('false');
    expect(src.hasAttribute('aria-selected')).toBe(false);
    expect(f.host.textContent).toContain('current-change-0');
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(1);
    expect(f.host.querySelector('[data-change-id="change-0"]') === null).toBe(true);
    await f.filter('OLD.TS');
    expect(f.host.querySelectorAll('[data-change-id]')).toHaveLength(1);
    expect(f.host.querySelector('[data-change-id="change-1"]') !== null).toBe(true);
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    await f.select(1);
    expect(f.host.textContent).toContain('重命名：legacy/old.ts → src/beta.ts');
    expect(f.host.textContent).toContain('已暂存 R');
    await f.filter('missing');
    expect(f.host.textContent).toContain('没有匹配的变更文件');
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    await f.filter('');
    expect(
      f.host.querySelector('[data-change-id="change-2"]')?.getAttribute('aria-label'),
    ).toContain('未跟踪');
    expect(
      f.host.querySelector('[data-change-id="change-3"]')?.getAttribute('aria-label'),
    ).toContain('冲突 UU');
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test('keyboard navigation crosses pages, folds directories and exposes only one tree tab stop', async () => {
  const f = await fixture();
  try {
    await f.render();
    const first = f.host.querySelector<HTMLElement>('[role="treeitem"]')!;
    await act(async () => first.focus());
    await f.key('ArrowLeft');
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    await f.key('ArrowRight');
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(50);
    await f.key('ArrowRight');
    expect(f.dom.window.document.activeElement?.getAttribute('data-change-id')).toBe('change-0');
    await f.key('End');
    expect(f.dom.window.document.activeElement?.getAttribute('data-change-id')).toBe('change-64');
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(16);
    expect(f.host.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
    expect(f.dom.window.document.activeElement?.getAttribute('aria-level')).toBe('2');
    await f.key('ArrowLeft');
    expect(f.dom.window.document.activeElement?.getAttribute('title')).toBe('src/');
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(50);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test('rapid selection, filter, refresh, scope replacement and closing ignore late details and list replies', async () => {
  const f = await fixture();
  try {
    await f.render();
    f.state.detailMode = 'held';
    await f.select(0);
    const stale = f.heldDetails[0]!;
    await f.select(1);
    expect(
      f.requests.some(
        (item) => item.method === 'workspaceChanges.close' && item.readId === stale.readId,
      ),
    ).toBe(true);
    await act(async () => stale.release());
    expect(f.host.textContent).not.toContain('current-change-0');
    await f.filter('2.txt');
    await act(async () => f.heldDetails[1]!.release());
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    await f.select(2);
    const filteredRead = f.heldDetails[2]!;
    f.state.refreshKey = 'new-message';
    await f.render(true, false);
    await f.settle(1_100);
    expect(f.host.querySelector('.workspace-change-preview') !== null).toBe(true);
    expect(
      f.requests.some(
        (item) => item.method === 'workspaceChanges.close' && item.readId === filteredRead.readId,
      ),
    ).toBe(true);
    await act(async () => filteredRead.release());
    expect(f.host.textContent).not.toContain('current-change-2');
    await f.settle(1_100);
    f.state.listMode = 'held';
    await f.clickButton('刷新变更');
    await f.settle(1_100);
    const lateList = f.heldLists[0]!;
    f.state.sessionId = 'two';
    f.state.viewSelection = 2;
    f.state.entries = [change(99, 'target/current.txt')];
    f.state.listMode = 'normal';
    await f.render();
    await act(async () => lateList());
    expect(f.host.querySelector('[data-change-id="change-0"]') === null).toBe(true);
    await f.settle(1_100);
    expect(f.host.querySelector('[data-change-id="change-99"]') !== null).toBe(true);
    await f.select(99);
    const closed = f.heldDetails.at(-1)!;
    await f.render(false);
    await act(async () => closed.release());
    expect(f.host.textContent).toBe('');
    const count = f.requests.length;
    await act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event('focus')));
    await f.settle(1_100);
    expect(f.requests).toHaveLength(count);
  } finally {
    await f.cleanup();
  }
});

test('failed, unsupported, truncated, binary and empty reads keep their true state instead of reporting a clean workspace', async () => {
  const f = await fixture([change(0)]);
  try {
    await f.render();
    f.state.detailReason = 'binary';
    await f.select(0);
    expect(f.host.textContent).toContain('二进制文件不显示文本差异');
    expect(f.host.textContent).toContain('src/0.txt');
    for (const [reason, message] of [
      ['too_large', '文件过大'],
      ['unsupported', '不支持文本预览'],
      ['unavailable', '差异目前不可读'],
    ] as const) {
      f.state.detailReason = reason;
      await f.clickButton('刷新变更');
      await f.select(0);
      expect(f.host.textContent).toContain(message);
      expect(f.host.textContent).not.toContain('本次读取未发现');
    }
    f.state.detailReason = undefined;
    f.state.detailEmpty = true;
    await f.clickButton('刷新变更');
    await f.select(0);
    expect(f.host.textContent).toContain('当前文件内容与 HEAD 相同；暂存区仍可能有独立改动');
    f.state.detailEmpty = false;
    f.state.detailTruncated = true;
    await f.clickButton('刷新变更');
    await f.select(0);
    expect(f.host.textContent).toContain('未显示全部改动');
    f.state.detailMode = 'mismatch';
    await f.clickButton('刷新变更');
    await f.select(0);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('无法读取当前差异');
    for (const [mode, message] of [
      ['failure', '读取失败不表示没有改动'],
      ['filters', '为避免执行外部程序'],
      ['mismatch', '无法确认工作区变更'],
    ] as const) {
      f.state.listMode = mode;
      await f.clickButton('刷新变更');
      expect(f.host.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(f.host.textContent).not.toContain('本次读取未发现');
      expect(f.host.querySelector('[role="tree"]') !== null).toBe(true);
      expect(f.host.textContent).toContain('当前显示上次读取的结果');
    }
    f.state.listMode = 'nonrepo';
    await f.clickButton('刷新变更');
    expect(f.host.textContent).toContain('不在 Git 仓库');
    f.state.listMode = 'normal';
    f.state.entries = [];
    f.state.truncated = true;
    await f.clickButton('刷新变更');
    expect(f.host.textContent).toContain('仓库变更列表已截断');
    expect(f.host.textContent).not.toContain('本次读取未发现');
    f.state.truncated = false;
    await f.clickButton('刷新变更');
    expect(f.host.textContent).toContain('本次读取未发现');
  } finally {
    await f.cleanup();
  }
});

test('huge metadata and long/deep paths keep a bounded tree and original detail request identity', async () => {
  const long = `${'deep/'.repeat(80)}${'long'.repeat(1_500)}.tsx`;
  const f = await fixture([
    change(0, long),
    ...Array.from({ length: 1_004 }, (_, index) => change(index + 1, `files/${index}.ts`)),
  ]);
  try {
    await f.render();
    expect(f.host.querySelectorAll('[role="treeitem"]')).toHaveLength(50);
    expect(f.host.textContent).toContain('1000+ 个文件');
    expect(f.host.textContent).toContain('仓库变更列表已截断');
    expect(f.host.querySelectorAll('[role="treeitem"][aria-level="26"]')).toHaveLength(0);
    const row = f.host.querySelector<HTMLElement>('[data-change-id="change-0"]')!;
    expect(row.title.length).toBeLessThanOrEqual(1_024);
    expect(
      row.querySelector('.workspace-change-tree-name')!.textContent!.length,
    ).toBeLessThanOrEqual(240);
    expect(row.textContent).toContain('…/');
    expect(f.host.textContent).toContain('部分目录已简化为相对路径');
    await f.select(0);
    expect(
      [...f.requests].reverse().find((item) => item.method === 'workspaceChanges.detail'),
    ).toMatchObject({
      changeId: 'change-0',
    });
    await f.filter('files/1003.ts');
    expect(f.host.querySelector('[data-change-id="change-1004"]') === null).toBe(true);
    expect(f.host.textContent).toContain('没有匹配的变更文件');
    await f.filter('files/998.ts');
    expect(f.host.querySelector('[data-change-id="change-999"]') !== null).toBe(true);
    expect(f.host.querySelectorAll('[role="treeitem"]').length).toBeLessThanOrEqual(50);
  } finally {
    await f.cleanup();
  }
});

test('refresh revalidates only the selected path and keeps layout; missing paths and new scopes clear selection', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.clickButton('下一页');
    await f.select(64);
    await f.clickButton('统一');
    expect(
      f.host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.textContent,
    ).toBe('统一');
    f.state.entries = f.state.entries.map((entry) => ({
      ...entry,
      changeId: `fresh-${entry.changeId}`,
    }));
    f.state.listMode = 'held';
    await f.clickButton('刷新变更');
    expect(f.host.textContent).toContain('current-change-64');
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(1);
    await act(async () => f.heldLists.shift()!());
    expect(
      [...f.requests].reverse().find((item) => item.method === 'workspaceChanges.detail'),
    ).toMatchObject({
      changeId: 'fresh-change-64',
    });
    expect(
      f.host.querySelector('[data-change-id="fresh-change-64"][aria-selected="true"]') !== null,
    ).toBe(true);
    expect(
      f.host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.textContent,
    ).toBe('统一');
    expect(f.host.textContent).toContain('current-fresh-change-64');
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(2);
    f.state.listMode = 'normal';
    f.state.entries = [change(0)];
    await f.clickButton('刷新变更');
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(2);
    await f.select(0);
    f.state.sessionId = 'other';
    f.state.viewSelection = 2;
    await f.render();
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(3);
    await f.select(0);
    expect(
      f.host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.textContent,
    ).toBe('双栏');
    await f.render(false);
    await f.render();
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(4);
  } finally {
    await f.cleanup();
  }
});

test('same-scope filter survives manual, focus and message refresh without restoring a filtered-out detail', async () => {
  const f = await fixture();
  const query = () => f.host.querySelector<HTMLInputElement>('input[type="search"]')!.value;
  try {
    await f.render();
    await f.filter('64.txt');
    await f.select(64);
    await f.clickButton('刷新变更');
    expect(query()).toBe('64.txt');
    expect(f.host.querySelectorAll('[data-change-id]')).toHaveLength(1);
    expect(f.host.textContent).toContain('current-change-64');
    await act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event('focus')));
    await f.settle();
    expect(query()).toBe('64.txt');
    expect(
      f.host.querySelector('[data-change-id="change-64"][aria-selected="true"]') !== null,
    ).toBe(true);
    f.state.refreshKey = 'next-message';
    await f.render(true, false);
    expect(f.host.textContent).toContain('current-change-64');
    await f.settle(1_100);
    expect(query()).toBe('64.txt');
    expect(f.host.textContent).toContain('current-change-64');
    await f.filter('63.txt');
    const detailCount = requestCount(f.requests, 'workspaceChanges.detail');
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    f.state.refreshKey = 'another-message';
    await f.render(true, false);
    await f.settle(1_100);
    expect(query()).toBe('63.txt');
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(detailCount);
    expect(f.host.querySelector('[data-change-id="change-63"]') !== null).toBe(true);
    f.state.sessionId = 'other';
    f.state.viewSelection = 2;
    await f.render(true, false);
    await f.settle(1_100);
    expect(query()).toBe('');
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test('refreshed rename metadata clears a selection that no longer matches the retained filter', async () => {
  const f = await fixture([{ ...change(0, 'src/current.ts'), oldPath: 'legacy/previous.ts' }]);
  try {
    await f.render();
    await f.filter('previous.ts');
    await f.select(0);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(1);
    f.state.entries = [change(0, 'src/current.ts')];
    await f.clickButton('刷新变更');
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    expect(f.host.textContent).toContain('没有匹配的变更文件');
    f.state.entries = [{ ...change(0, 'src/current.ts'), oldPath: 'legacy/previous.ts' }];
    await f.clickButton('刷新变更');
    expect(f.host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe(
      'previous.ts',
    );
    expect(f.host.querySelector('[data-change-id="change-0"]') !== null).toBe(true);
    expect(f.host.querySelector('.workspace-change-preview') === null).toBe(true);
    expect(requestCount(f.requests, 'workspaceChanges.detail')).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test('workspace invalidations synchronize selected content without remounting the reader or tree', async () => {
  const f = await fixture([change(0, 'src/main.ts'), change(1, 'other/one.ts')]);
  try {
    await f.render();
    await f.select(0);
    await f.clickButton('统一');
    const reader = f.host.querySelector<HTMLElement>('.file-diff')!;
    const scroll = f.host.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    if (scroll) {
      scroll.scrollTop = 64;
      scroll.scrollLeft = 21;
    }
    const directory = f.host.querySelector<HTMLButtonElement>('[title="other/"]')!;
    await act(async () => directory.click());
    const tree = f.host.querySelector<HTMLElement>('[role="tree"]')!;
    tree.scrollTop = 50;
    f.state.listMode = 'held';
    for (let n = 0; n < 20; n++) await f.invalidate();
    await f.settle(1_100);
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(2);
    expect(f.host.querySelector('.file-diff')).toBe(reader);
    expect(f.host.querySelector('[role="tree"]')).toBe(tree);
    expect(tree.scrollTop).toBe(50);
    expect(directory.getAttribute('aria-expanded')).toBe('false');
    f.state.detailMode = 'held';
    f.state.detailVersion = '-updated';
    await act(async () => f.heldLists.shift()!());
    expect(f.host.textContent).toContain('current-change-0');
    expect(f.host.querySelector('.file-diff')).toBe(reader);
    await act(async () => f.heldDetails.shift()!.release());
    expect(f.host.textContent).toContain('current-change-0-updated');
    expect(f.host.querySelector('.file-diff')).toBe(reader);
    expect(directory.getAttribute('aria-expanded')).toBe('false');
    expect(f.host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('统一');
    if (scroll) {
      expect(scroll.scrollTop).toBe(64);
      expect(scroll.scrollLeft).toBe(21);
    }
  } finally {
    await f.cleanup();
  }
});

test('continuous events keep one successor instead of cancelling reads; foreign and released leases are ignored', async () => {
  const f = await fixture([change(0)]);
  try {
    await f.render();
    await f.invalidate({ readId: 'old-lease' });
    await f.invalidate({ generation: 2 });
    await f.invalidate({
      scope: {
        generation: 1,
        viewSelection: 1,
        storeId: 'foreign',
        sessionId: 'one',
        workspaceId: 'w',
      },
    });
    await f.settle(1_100);
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(1);
    f.state.listMode = 'held';
    await f.invalidate();
    await f.settle(1_100);
    for (let n = 0; n < 20; n++) await f.invalidate();
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(2);
    await act(async () => f.heldLists.shift()!());
    await f.settle(4_500);
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(3);
    await act(async () => f.heldLists.shift()!());
    await f.settle(1_100);
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(3);
    await f.render(false);
    const count = f.requests.length;
    await f.invalidate();
    await f.settle(1_100);
    expect(f.requests.length).toBe(count);
  } finally {
    await f.cleanup();
  }
});

test('hidden windows release observation, reject late replies and refresh once visible', async () => {
  const f = await fixture([change(0)]);
  try {
    await f.render();
    await f.select(0);
    f.state.listMode = 'held';
    await f.invalidate();
    await f.settle(1_100);
    await f.visibility('hidden');
    const count = requestCount(f.requests, 'workspaceChanges.list');
    f.state.entries = [];
    await f.invalidate();
    await act(async () => f.heldLists.shift()!());
    await f.settle(1_100);
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(count);
    expect(f.host.textContent).toContain('current-change-0');
    f.state.listMode = 'normal';
    await f.visibility('visible');
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(count + 1);
    expect(f.host.textContent).toContain('本次读取未发现');
    expect(f.host.querySelector('.file-diff') === null).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test('transient automatic refresh failure retains last result and retries without a user action', async () => {
  const f = await fixture([change(0)]);
  try {
    await f.render();
    await f.select(0);
    const reader = f.host.querySelector('.file-diff');
    f.state.listMode = 'failure';
    await f.invalidate();
    await f.settle(1_100);
    expect(f.host.textContent).toContain('尚未确认最新内容');
    expect(f.host.querySelector('.file-diff')).toBe(reader);
    f.state.listMode = 'normal';
    f.state.detailVersion = '-recovered';
    await f.settle(3_200);
    expect(f.host.textContent).toContain('current-change-0-recovered');
    expect(f.host.textContent).not.toContain('尚未确认最新内容');
    expect(f.host.querySelector('.file-diff')).toBe(reader);
    expect(requestCount(f.requests, 'workspaceChanges.list')).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test('automatic insertion before a folded directory preserves its actual path, focus and selected reader', async () => {
  const f = await fixture([change(0, 'b/file.ts'), change(1, 'c/file.ts')]);
  try {
    await f.render();
    await f.select(1);
    const b = f.host.querySelector<HTMLButtonElement>('[title="b/"]')!;
    await act(async () => {
      b.click();
      b.focus();
    });
    const reader = f.host.querySelector('.file-diff');
    f.state.entries = [change(2, 'a/file.ts'), change(0, 'b/file.ts'), change(1, 'c/file.ts')];
    await f.invalidate();
    await f.settle(1_100);
    expect(f.host.querySelector('[title="b/"]')).toBe(b);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(f.dom.window.document.activeElement).toBe(b);
    expect(f.host.querySelector('[data-change-id="change-2"]') !== null).toBe(true);
    expect(f.host.querySelector('[data-change-id="change-0"]') === null).toBe(true);
    expect(f.host.querySelector('.file-diff')).toBe(reader);
  } finally {
    await f.cleanup();
  }
});
