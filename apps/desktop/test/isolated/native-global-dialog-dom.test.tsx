import { JSDOM } from 'jsdom';
import { act } from 'react';
import { expect, test } from '#kite-test';
import type {
  NativeGlobalDialogBridge,
  NativeGlobalDialogState,
} from '../../src/native-global-dialog-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    DocumentFragment: dom.window.DocumentFragment,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { NativeGlobalDialog } = await import('../../src/native-global-dialog');
  const events: unknown[] = [];
  let listener: ((state: NativeGlobalDialogState) => void) | undefined;
  const bridge: NativeGlobalDialogBridge = {
    watch(receive) {
      listener = receive;
      events.push('watch');
      return () => {
        listener = undefined;
        events.push('unwatch');
      };
    },
    ready() {
      events.push('ready');
    },
    presented(id) {
      events.push(['presented', id]);
    },
    decide(id, value) {
      events.push(['decision', id, value]);
    },
  };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<NativeGlobalDialog bridge={bridge} />));
  const frame = (callbacks?: FrameRequestCallback[]) =>
    act(async () => {
      const batch = callbacks ?? [...frames.values()];
      if (!callbacks) frames.clear();
      for (const callback of batch) callback(0);
    });
  return {
    dom,
    events,
    frame,
    frames,
    bridge,
    listener: () => listener!,
    render: (next?: NativeGlobalDialogBridge) =>
      act(async () => root.render(<NativeGlobalDialog bridge={next} />)),
    show: (state: NativeGlobalDialogState) => act(async () => listener!(state)),
    button: (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === text,
      )!,
    async close() {
      await act(async () => root.unmount());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      restore();
    },
  };
}
const state = (
  requestId: string,
  language: 'zh' | 'en' = 'zh',
): NonNullable<NativeGlobalDialogState> => ({
  requestId,
  kind: 'full-permission',
  language,
  theme: 'dark',
});

test('provider removal shows only the connection and model count in the global confirmation', async () => {
  const f = await fixture();
  try {
    await f.show({
      ...state('provider'),
      kind: 'provider-removal',
      label: 'Fixture',
      modelCount: 3,
    });
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector('.full-permission-title')?.textContent).toBe('删除「Fixture」？');
    expect(dialog.querySelector('.full-permission-intro')?.textContent).toBe(
      '将删除此连接及 3 个关联模型的配置。',
    );
    expect(dialog.querySelector('ul')).toBeNull();
    expect(document.activeElement).toBe(f.button('取消'));
    await f.frame();
    await act(async () => f.button('确认删除提供商').click());
    expect(f.events.at(-1)).toEqual(['decision', 'provider', true]);
  } finally {
    await f.close();
  }
});

test('the overlay subscribes before ready, paints the shared warning and reports presented only after its frame', async () => {
  const f = await fixture();
  try {
    expect(f.events).toEqual(['watch', 'ready']);
    await f.show(state('one'));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      '文件可能被覆盖或删除',
    );
    expect(document.querySelectorAll('.full-permission-risks li')).toHaveLength(2);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.activeElement).toBe(f.button('取消'));
    expect(f.button('启用完全权限').disabled).toBe(true);
    expect(f.events).toEqual(['watch', 'ready']);
    await f.frame();
    expect(f.events).toEqual(['watch', 'ready', ['presented', 'one']]);
    expect(f.button('启用完全权限').disabled).toBe(false);
    const dialog = document.querySelector('.full-permission-dialog')!;
    const mask = dialog.previousElementSibling!;
    expect(mask.classList.contains('bg-black/50')).toBe(true);
    await act(async () => {
      mask.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      (mask as HTMLElement).click();
    });
    expect(f.events).toEqual(['watch', 'ready', ['presented', 'one']]);
    await act(async () => f.button('启用完全权限').click());
    expect(f.events).toEqual(['watch', 'ready', ['presented', 'one'], ['decision', 'one', true]]);
    await act(async () => f.button('取消').click());
    expect(f.events).toHaveLength(4);
    await f.show(null);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await f.close();
  }
});

test('the English overlay cancels explicitly and a null or replaced request cannot report a stale frame', async () => {
  const f = await fixture();
  try {
    await f.show(state('old', 'en'));
    const stale = [...f.frames.values()];
    await f.show(null);
    await f.frame(stale);
    expect(f.events).toEqual(['watch', 'ready']);
    await f.show(state('new', 'en'));
    await f.frame();
    expect(document.documentElement.lang).toBe('en');
    expect(document.activeElement).toBe(f.button('Cancel'));
    await act(async () => f.button('Cancel').click());
    expect(f.events).toEqual(['watch', 'ready', ['presented', 'new'], ['decision', 'new', false]]);
    await f.show(state('next'));
    await f.frame();
    expect(f.events.at(-1)).toEqual(['presented', 'next']);
    await act(async () => f.button('启用完全权限').click());
    expect(f.events.at(-1)).toEqual(['decision', 'next', true]);
  } finally {
    await f.close();
  }
});

test('same-request theme changes update committed appearance without another decision or presented event', async () => {
  const f = await fixture();
  try {
    await f.show(state('theme'));
    await f.frame();
    await f.show({ ...state('theme'), theme: 'light' });
    await f.frame();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(f.events).toEqual(['watch', 'ready', ['presented', 'theme']]);
  } finally {
    await f.close();
  }
});

test('a missing or replaced bridge retires its listener and cannot report the previous request', async () => {
  const f = await fixture();
  try {
    await f.show(state('old'));
    const staleFrames = [...f.frames.values()];
    const lateState = f.listener();
    await f.render();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => lateState(state('late')));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    const next = { ...f.bridge };
    await f.render(next);
    await f.show(state('current'));
    await f.frame(staleFrames);
    expect(f.events.filter((event) => Array.isArray(event))).toEqual([]);
    await f.frame();
    expect(f.events.at(-1)).toEqual(['presented', 'current']);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await act(async () =>
      dialog.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.events.at(-1)).toEqual(['decision', 'current', false]);
  } finally {
    await f.close();
  }
});

test('workspace removal uses the shared warning, fixed copy and explicit Cancel/Escape/confirm decisions', async () => {
  const f = await fixture();
  const label = '<img src=x onerror=alert(1)> 工作空间';
  const cancel = '保留空间';
  const confirm = '移除空间';
  const next = (requestId: string): NonNullable<NativeGlobalDialogState> => ({
    requestId,
    language: 'zh',
    theme: 'dark',
    kind: 'workspace-removal',
    label,
  });
  try {
    await f.show(next('cancel'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(`移除空间“${label}”？`);
    expect(dialog.textContent).toContain(
      '将移除本地项目登记及全部会话列表，并请求停止运行中的任务。历史先保留；任务结束并过宽限期后，可在退出客户端后通过离线维护清理。未结束或结果未知的执行证据会继续保留。不会删除工作目录中的文件。',
    );
    expect(dialog.querySelector('img, script')).toBeNull();
    expect(dialog.querySelector('.full-permission-risks')).toBeNull();
    expect(document.activeElement).toBe(f.button(cancel));
    expect(f.button(confirm).disabled).toBe(true);
    const mask = dialog.previousElementSibling!;
    await act(async () => (mask as HTMLElement).click());
    expect(f.events).toEqual(['watch', 'ready']);
    await f.frame();
    expect(f.button(confirm).disabled).toBe(false);
    await act(async () => f.button(cancel).click());
    expect(f.events.at(-1)).toEqual(['decision', 'cancel', false]);

    await f.show(next('escape'));
    await f.frame();
    await act(async () =>
      document.querySelector('[role="alertdialog"]')!.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.events.at(-1)).toEqual(['decision', 'escape', false]);

    await f.show(next('stale'));
    const stale = [...f.frames.values()];
    const staleButton = f.button(confirm);
    await f.show(next('confirm'));
    await f.frame(stale);
    await act(async () => staleButton.click());
    expect(f.events.some((event) => Array.isArray(event) && event[1] === 'stale')).toBe(false);
    expect(document.activeElement).toBe(f.button(cancel));
    await f.frame();
    expect(f.events.at(-1)).toEqual(['presented', 'confirm']);
    await act(async () => f.button(confirm).click());
    expect(f.events.at(-1)).toEqual(['decision', 'confirm', true]);
    await act(async () => f.button(confirm).click());
    expect(
      f.events.filter(
        (event) => Array.isArray(event) && event[0] === 'decision' && event[1] === 'confirm',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
