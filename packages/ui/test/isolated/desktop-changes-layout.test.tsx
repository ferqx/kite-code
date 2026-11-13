import { JSDOM } from 'jsdom';
import { act, Children, type ComponentProps, isValidElement } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { afterAll, expect, mock, test } from '#kite-test';
import type { SessionPageProps } from '../../src/desktop/SessionPage';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const matchMedia = (query: string) =>
  Object.assign(new dom.window.EventTarget(), { matches: false, media: query });
Object.assign(dom.window, { ResizeObserver: ResizeObserverStub, matchMedia });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLIFrameElement: dom.window.HTMLIFrameElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  DOMRect: dom.window.DOMRect,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: ResizeObserverStub,
  matchMedia,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const actualResizable = await import('../../src/desktop/components/ui/resizable');
const OriginalPanelGroup = actualResizable.ResizablePanelGroup;
const resizableExports = { ...actualResizable };
let contentLayout: ComponentProps<typeof OriginalPanelGroup> | undefined;
mock.module('../../src/desktop/components/ui/resizable', () => ({
  ...resizableExports,
  ResizablePanelGroup(props: ComponentProps<typeof OriginalPanelGroup>) {
    if (props.id === 'content-layout') contentLayout = props;
    return <OriginalPanelGroup {...props} />;
  },
}));
const { SessionPage } = await import('../../src/desktop/SessionPage');
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// Use the actual SessionPage, tab model and Panel implementation. Only browser
// geometry and frame timing are controlled; this does not certify rendered pixels.
function fixture(nativeChanges = true) {
  const host = document.getElementById('root')!,
    root = createRoot(host),
    frames = new Map<number, FrameRequestCallback>(),
    raf = globalThis.requestAnimationFrame,
    cancel = globalThis.cancelAnimationFrame,
    rect = dom.window.HTMLElement.prototype.getBoundingClientRect,
    offset = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetWidth')!,
    left = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetLeft')!;
  let serial = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++serial, callback);
    return serial;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return ['client-layout', 'content-layout'].includes(this.id)
      ? new dom.window.DOMRect(0, 0, 3000, 800)
      : rect.call(this);
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      if (['client-layout', 'content-layout'].includes(this.id)) return 3000;
      if (['navigation', 'workspace', 'content', 'details'].includes(this.id)) return 1500;
      return offset.get!.call(this);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get() {
      return this.parentElement?.hasAttribute('data-group')
        ? Array.from(this.parentElement.children).indexOf(this) * 1500
        : left.get!.call(this);
    },
  });
  const messages: SessionPageProps['messages'] = [
    { id: 'body', role: 'assistant', text: 'Unchanged conversation', settled: true },
  ];
  const show = (options: { scope?: string; revision?: number; covered?: boolean } = {}) =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={[]}
          readingKey={options.scope ?? 'session-a'}
          tabsScopeKey={options.scope ?? 'session-a'}
          sessionLabel="Review session"
          messages={messages}
          connected
          connectionLabel=""
          loading={false}
          actions={{}}
          covered={options.covered}
          fileChangesContent={
            nativeChanges ? (
              <div data-changes-revision={options.revision ?? 0}>Changes reader</div>
            ) : undefined
          }
          renderBrowser={({ id, visible, tools }) => (
            <section data-browser-id={id} data-visible={visible}>
              {tools}
            </section>
          )}
          composer={{
            draft: 'Unsent original draft',
            scopeKey: options.scope ?? 'session-a',
            onChange() {},
            active: false,
            stopping: false,
            disabled: false,
          }}
        />,
      ),
    );
  const click = (label: string) =>
    act(() => {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      button!.click();
    });
  const frame = () =>
    act(() => {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(0);
    });
  const panel = () => {
    const node = Children.toArray(contentLayout?.children).find(
      (child) => isValidElement(child) && (child.props as { id?: string }).id === 'details',
    );
    if (!isValidElement<{ panelRef: { current: PanelImperativeHandle | null } }>(node))
      throw Error('Missing actual details panel');
    if (!node.props.panelRef.current) throw Error('Missing actual panel handle');
    return node.props.panelRef.current;
  };
  const changes = () =>
    act(() => {
      const button = host.querySelector<HTMLButtonElement>('.session-browser-tool');
      expect(button).not.toBeNull();
      button!.click();
    });
  const selectTab = (title: string) =>
    act(() => {
      const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (item) => item.title === title,
      );
      expect(tab).toBeDefined();
      tab!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      tab!.click();
    });
  return {
    host,
    show,
    click,
    frame,
    changes,
    selectTab,
    width: () => Number(host.querySelector<HTMLElement>('#details')!.style.flexGrow),
    resize: (size: string) => act(() => panel().resize(size)),
    userResized: () =>
      act(() =>
        contentLayout?.onLayoutChanged?.({ content: 52, details: 48 }, { isUserInteraction: true }),
      ),
    constraints: () =>
      JSON.parse(host.querySelector('#details')!.getAttribute('data-native-browser-layout')!),
    pending: () => frames.size,
    async open() {
      await click('标签页');
      await frame();
      await changes();
    },
    async close() {
      await act(() => root.unmount());
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = cancel;
      dom.window.HTMLElement.prototype.getBoundingClientRect = rect;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', offset);
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', left);
      contentLayout = undefined;
    },
  };
}

test('first changes opening prepares 62%, permits up to 85%, and retains the conversation and user width on refresh, tab selection and reopening', async () => {
  const f = fixture();
  try {
    await f.show();
    const conversation = f.host.querySelector('.conversation-viewport'),
      composer = f.host.querySelector('textarea.prompt-editor');
    await f.open();
    await f.frame();
    expect(f.width()).toBeCloseTo(62, 5);
    expect(f.constraints()).toMatchObject({ minSize: '240px', maxSize: '85%' });
    await f.resize('90%');
    expect(f.width()).toBeCloseTo(85, 5);
    await f.resize('48%');
    expect(f.width()).toBeCloseTo(48, 5);
    await f.show({ revision: 1 });
    await f.frame();
    expect(f.width()).toBeCloseTo(48, 5);
    await f.selectTab('新标签页');
    await f.selectTab('变更');
    await f.frame();
    expect(f.width()).toBeCloseTo(48, 5);
    await f.click('标签页');
    await f.frame();
    expect(f.width()).toBe(0);
    await f.click('标签页');
    await f.frame();
    expect(f.width()).toBeCloseTo(48, 5);
    expect(f.host.querySelector('.conversation-viewport') === conversation).toBe(true);
    expect(f.host.querySelector('textarea.prompt-editor') === composer).toBe(true);
    expect((composer as HTMLTextAreaElement).value).toBe('Unsent original draft');
    expect(f.host.textContent?.match(/Unchanged conversation/g)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const interruption of ['close', 'scope', 'covered', 'tab'] as const)
  test(`pending first changes resize is cancelled on ${interruption}, with a fresh 62% opening still available`, async () => {
    const f = fixture();
    try {
      await f.show();
      await f.open();
      expect(f.pending()).toBeGreaterThan(0);
      if (interruption === 'close') await f.click('标签页');
      else if (interruption === 'scope') await f.show({ scope: 'session-b' });
      else if (interruption === 'covered') await f.show({ covered: true });
      else await f.selectTab('新标签页');
      await f.frame();
      expect(f.width()).not.toBeCloseTo(62, 5);
      if (interruption === 'scope') await f.open();
      else if (interruption === 'tab') await f.selectTab('变更');
      else if (interruption === 'covered') await f.show();
      else await f.click('标签页');
      await f.frame();
      await f.frame();
      expect(f.width()).toBeCloseTo(62, 5);
    } finally {
      await f.close();
    }
  });

test('ordinary browser-only details retain their original constraints and never receive the changes initial width', async () => {
  const f = fixture(false);
  try {
    await f.show();
    await f.click('标签页');
    await f.frame();
    expect(f.constraints()).toMatchObject({ minSize: '300px', maxSize: '640px' });
    expect(f.width()).not.toBeCloseTo(62, 5);
    await f.resize('500px');
    const width = f.width();
    await f.show({ revision: 1 });
    await f.click('标签页');
    await f.frame();
    await f.click('标签页');
    await f.frame();
    expect(f.width()).toBeCloseTo(width, 5);
  } finally {
    await f.close();
  }
});

test('an explicit user resize before the initial changes frame wins over automatic preparation', async () => {
  const f = fixture();
  try {
    await f.show();
    await f.open();
    expect(f.pending()).toBeGreaterThan(0);
    await f.resize('48%');
    await f.userResized();
    await f.frame();
    await f.frame();
    expect(f.width()).toBeCloseTo(48, 5);
    await f.show({ revision: 1 });
    await f.click('标签页');
    await f.frame();
    await f.click('标签页');
    await f.frame();
    expect(f.width()).toBeCloseTo(48, 5);
  } finally {
    await f.close();
  }
});
