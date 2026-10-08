import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeCreation,
  NativeRequest,
  NativeState,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const priorBootstrap = {
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
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restoreLayout = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: NativeRequest[] = [];
  const sessions: Session[] = ['a', 'b', 'orphan'].map((id) => ({
    id,
    workspaceId: id === 'orphan' ? 'unread-workspace' : 'w',
    rootSessionId: id,
    parentSessionId: null,
    title: id === 'a' ? 'Original A' : id === 'b' ? 'Other B' : 'Unread project session',
    controlRevision: '0',
    contextSelectionId: 'context',
    nextSeq: '0',
    deletedAt: null,
  }));
  let selected = 'a',
    release!: (value: NativeCreation) => void;
  const creation = new Promise<NativeCreation>((resolve) => {
    release = resolve;
  });
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      viewGeneration: 1,
      canReadModelOutput: false,
      storeId: 'store',
      session: sessions.find((session) => session.id === selected)!,
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method === 'attach' || input.method === 'state') return state();
      if (input.method === 'directory')
        return {
          storeId: 'store',
          workspaces: [
            { id: 'w', name: 'Actual Workspace', rootUri: 'file:///workspace' },
            { id: 'empty', name: 'Empty Workspace', rootUri: 'file:///empty' },
          ],
          sessions,
        };
      if (input.method === 'select') {
        selected = input.sessionId;
        return state();
      }
      if (input.method === 'messages')
        return { messages: [], nextAfterSeq: null, highWaterSeq: '0' };
      if (input.method === 'draft.read')
        return {
          id: input.sessionId,
          storeId: 'store',
          workspaceId: 'w',
          rootSessionId: input.sessionId,
          revision: 1,
          content: input.sessionId === 'a' ? 'saved original' : 'saved other',
        };
      if (input.method === 'createSession') return creation;
      return null;
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
  const host = dom.window.document;
  const root = createRoot(host.getElementById('root')!);
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find(
      (entry) => entry.textContent === name || entry.getAttribute('aria-label') === name,
    );
  return {
    dom,
    host,
    root,
    calls,
    selected: () => selected,
    button,
    click: async (name: string) =>
      act(async () => {
        const target = button(name);
        expect(target).toBeDefined();
        target!.click();
      }),
    edit: async (
      target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      value: string,
    ) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')!.set!.call(
          target,
          value,
        );
        target.dispatchEvent(
          new dom.window.Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
        );
      }),
    releaseCreation() {
      const input = calls.find((input) => input.method === 'createSession');
      if (!input || input.method !== 'createSession') return;
      release({
        phase: 'created',
        input: {
          expectedStoreId: input.expectedStoreId,
          workspaceId: input.workspaceId,
          commandId: input.commandId,
          sessionId: input.sessionId,
          title: input.title,
        },
      });
    },
    async close() {
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      restoreLayout();
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}

test('Native reuses the scheduled page and editor with real projects, disabled persistence, and original conversation drafts', async () => {
  const f = fixture();
  const input = () =>
    f.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="当前会话私有草稿"]');
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit(input()!, 'unsaved original\n雪🙂');
    const baseline = f.calls.length;
    await f.click('安排任务');
    expect(f.host.querySelector('.primary-navigation [aria-current="page"]')?.textContent).toBe(
      '安排任务',
    );
    expect(f.host.querySelector('[aria-label="工作台"]')).toBeNull();
    expect(input()).toBeNull();
    expect(f.host.querySelector('#native-session-tools')).toBeNull();
    expect(f.selected()).toBe('a');
    await f.click('创建第一个任务');
    const editor = f.host.querySelector<HTMLFormElement>('.scheduled-editor')!;
    expect(editor).not.toBeNull();
    expect(f.host.querySelector('.scheduled-tasks-page')).not.toBeNull();
    expect(editor.closest('aside')?.getAttribute('aria-label')).toBe('新建安排任务');
    await f.edit(editor.querySelector<HTMLInputElement>('[aria-label="名称"]')!, '原页面草稿');
    await f.edit(
      editor.querySelector<HTMLTextAreaElement>('[aria-label="任务说明"]')!,
      '检查提交\n🙂',
    );
    const selects = [...editor.querySelectorAll('select')];
    expect([...selects[0]!.options].map((option) => [option.value, option.text])).toEqual([
      ['w', 'Actual Workspace'],
      ['empty', 'Empty Workspace'],
    ]);
    await f.edit(selects[0]!, 'empty');
    await f.edit(selects[1]!, 'local');
    await f.edit(selects[2]!, 'weekly-monday-0900');
    expect(selects.map((select) => select.value)).toEqual(['empty', 'local', 'weekly-monday-0900']);
    expect(f.button('保存任务')!.disabled).toBe(true);
    expect(editor.textContent).toContain('当前桌面服务尚未接入任务保存与后台运行');
    await act(async () => {
      editor.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(f.calls.slice(baseline)).toEqual([]);
    await f.click('返回会话');
    expect(input()?.value).toBe('unsaved original\n雪🙂');
    expect(f.calls.slice(baseline)).toEqual([{ method: 'input.models.read', generation: 1 }]);
    await f.click('安排任务');
    await f.click('Original A');
    expect(input()?.value).toBe('unsaved original\n雪🙂');
    expect(f.calls.slice(baseline)).toEqual([
      { method: 'input.models.read', generation: 1 },
      { method: 'input.models.read', generation: 1 },
    ]);
    await f.click('安排任务');
    await f.click('Other B');
    expect(input()?.value).toBe('saved other');
    expect(f.selected()).toBe('b');
    expect(
      f.calls
        .filter((call) => call.method === 'select')
        .map((call) => ('sessionId' in call ? call.sessionId : '')),
    ).toEqual(['a', 'b']);
  } finally {
    await f.close();
  }
});

test('a late creation receipt cannot replace the scheduled page or the original selected draft', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.click('在 Actual Workspace 中新建对话');
    expect(f.calls.filter((call) => call.method === 'createSession')).toHaveLength(1);
    await f.click('安排任务');
    await act(async () => f.releaseCreation());
    expect(f.host.querySelector('.scheduled-tasks-page')).not.toBeNull();
    expect(f.selected()).toBe('a');
    expect(f.calls.filter((call) => call.method === 'select')).toHaveLength(1);
    await f.click('返回会话');
    expect(
      f.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="当前会话私有草稿"]')?.value,
    ).toBe('saved original');
    expect(f.calls.filter((call) => call.method === 'createSession')).toHaveLength(1);
  } finally {
    f.releaseCreation();
    await f.close();
  }
});
