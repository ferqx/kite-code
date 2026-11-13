import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import { afterAll, afterEach, expect, test } from '#kite-test';
import type {
  NativeBrowserMenuAction,
  NativeBrowserMenuRequest,
} from '../../src/native-browser-bridge';
import { useNativeBrowserPopup } from '../../src/native-browser-menu';
import type { NativeBrowserMenuRect } from '../../src/native-browser-toolbar-types';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
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
const restore = prepareDesktopDom(dom);
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
const requests: NativeBrowserMenuRequest[] = [],
  cancels: string[] = [],
  actions: NativeBrowserMenuAction[] = [],
  errors: unknown[] = [];
let resolve!: (action: NativeBrowserMenuAction | null) => void, reject!: (cause: Error) => void;
const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 };
function Harness({
  identity = 'a',
  visible = true,
  enabled = true,
  scoped = true,
  draft,
  hostKey,
  generation = 1,
  anchor,
  onLayout,
}: {
  identity?: string;
  visible?: boolean;
  enabled?: boolean;
  scoped?: boolean;
  draft?: string;
  hostKey?: string;
  generation?: number;
  anchor?: NativeBrowserMenuRect;
  onLayout?: () => void;
}) {
  const popup = useNativeBrowserPopup({
    identity,
    hostKey,
    visible,
    scope: scoped ? { ...scope, generation } : undefined,
    draft,
    page: { id: 'page', control: { incarnation: 'inc', navigation: 2 } },
    items: [{ action: draft ? 'reload' : 'close', enabled }],
    details: ['Original reason and error'],
    onAction: (action) => actions.push(action),
    onError: (cause) => errors.push(cause),
  });
  useLayoutEffect(() => onLayout?.(), [onLayout]);
  return (
    <button type="button" onClick={(event) => popup(anchor ?? event.currentTarget)}>
      Menu
    </button>
  );
}
const flush = (action: () => void = () => {}) =>
  act(async () => {
    action();
    await fixtureDelay(5);
  });
async function render(props: Parameters<typeof Harness>[0] = {}) {
  root ??= createRoot(document.body);
  await flush(() => root!.render(<Harness {...props} />));
}
const open = () => flush(() => document.querySelector('button')!.click());
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  requests.length = cancels.length = actions.length = errors.length = 0;
  Object.assign(window, {
    kiteNative: {
      showBrowserMenu(input: NativeBrowserMenuRequest) {
        requests.push(input);
        return new Promise<NativeBrowserMenuAction | null>((done, fail) => {
          resolve = done;
          reject = fail;
        });
      },
      cancelBrowserMenu(id: string) {
        cancels.push(id);
      },
    },
  });
});
afterAll(() => {
  restore();
  dom.window.close();
  Object.assign(globalThis, prior);
});
// Install the same bridge before the first test as after every test.
Object.assign(window, {
  kiteNative: {
    showBrowserMenu(input: NativeBrowserMenuRequest) {
      requests.push(input);
      return new Promise<NativeBrowserMenuAction | null>((done, fail) => {
        resolve = done;
        reject = fail;
      });
    },
    cancelBrowserMenu(id: string) {
      cancels.push(id);
    },
  },
});

test('one native popup returns one finite action without reading or replacing page pixels', async () => {
  await render();
  await open();
  await open();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    id: 'page',
    scope,
    incarnation: 'inc',
    navigation: 2,
    items: [{ action: 'close', enabled: true }],
    details: ['Original reason and error'],
  });
  expect(document.querySelector('img, [role="menu"], [role="dialog"]')).toBeNull();
  await flush(() => resolve('close'));
  expect(actions).toEqual(['close']);
});
test('identity changes cancel the old native popup and reject its late selection', async () => {
  await render();
  await open();
  const first = requests[0]!;
  await render({ identity: 'b' });
  expect(cancels).toEqual([first.requestId]);
  await flush(() => resolve('close'));
  expect(actions).toHaveLength(0);
});
test('hiding cancels without reopening a menu on return', async () => {
  await render();
  await open();
  await render({ visible: false });
  expect(cancels).toEqual([requests[0]!.requestId]);
  await flush(() => resolve('close'));
  await render();
  expect(actions).toHaveLength(0);
  expect(requests).toHaveLength(1);
});
test('a newly disabled action cannot use an earlier enabled native result', async () => {
  await render();
  await open();
  await render({ enabled: false });
  await flush(() => resolve('close'));
  expect(actions).toHaveLength(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toEqual(Error('browser_menu_state_changed'));
});
test('a native failure retains its error and allows an explicit retry', async () => {
  await render();
  await open();
  const failure = Error('browser_presentation_unavailable');
  await flush(() => reject(failure));
  expect(errors).toEqual([failure]);
  expect(actions).toHaveLength(0);
  await open();
  expect(requests).toHaveLength(2);
  await flush(() => resolve('close'));
  expect(actions).toEqual(['close']);
});
for (const boundary of ['hide', 'host', 'owner'] as const)
  test(`a ${boundary} commit retires the old popup before passive cleanup and its late rejection cannot affect the next explicit menu`, async () => {
    const replies: {
      accept(action: NativeBrowserMenuAction | null): void;
      decline(cause: Error): void;
    }[] = [];
    Object.assign(window, {
      kiteNative: {
        ...window.kiteNative,
        showBrowserMenu(input: NativeBrowserMenuRequest) {
          requests.push(input);
          // Deliver the already queued native reaction at a controlled layout
          // boundary; awaiting React act would flush passive cleanup first.
          return {
            // biome-ignore lint/suspicious/noThenProperty: This lifecycle regression intentionally delivers a native reaction before passive cleanup.
            then(
              accept: (action: NativeBrowserMenuAction | null) => void,
              decline: (cause: Error) => void,
            ) {
              replies.push({ accept, decline });
              return Promise.resolve();
            },
          };
        },
      },
    });
    await render({ hostKey: 'chrome' });
    await open();
    expect(replies).toHaveLength(1);
    const first = requests[0]!;
    let retiredAtLayout = false;
    let requestCountAtLayout = 0;
    let errorsAtLayout: unknown[] = [];
    await render({
      hostKey: boundary === 'host' ? 'root' : 'chrome',
      generation: boundary === 'owner' ? 2 : 1,
      visible: boundary !== 'hide',
      onLayout() {
        retiredAtLayout = cancels.includes(first.requestId);
        if (boundary !== 'hide') document.querySelector('button')!.click();
        replies[0]!.decline(Error('browser_presentation_unavailable'));
        requestCountAtLayout = requests.length;
        errorsAtLayout = [...errors];
      },
    });
    expect(retiredAtLayout).toBe(true);
    expect(errorsAtLayout).toEqual([]);
    expect(errors).toEqual([]);
    expect(actions).toEqual([]);
    expect(cancels).toEqual([first.requestId]);
    if (boundary === 'hide') {
      expect(requestCountAtLayout).toBe(1);
      await render({ hostKey: 'chrome' });
      expect(requests).toHaveLength(1); // returning never reopens the old popup
      await open();
    } else expect(requestCountAtLayout).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestId).not.toBe(first.requestId);
    expect(replies).toHaveLength(2);
    await flush(() => replies[1]!.accept('close'));
    expect(actions).toEqual(['close']);
    expect(errors).toEqual([]);
  });
test('late failures from an obsolete identity do not appear in the selected page', async () => {
  await render();
  await open();
  await render({ identity: 'b' });
  await flush(() => reject(Error('old_menu_failed')));
  expect(errors).toHaveLength(0);
  expect(actions).toHaveLength(0);
});
test('a draft popup uses only its draft owner and cancels the old menu when that owner changes', async () => {
  const draft = '00112233445566778899aabbccddeeff';
  await render({ scoped: false, draft });
  await open();
  expect(requests[0]!.draft).toBe(draft);
  expect(requests[0]!.scope).toBeUndefined();
  expect(requests[0]!.incarnation).toBeUndefined();
  expect(requests[0]!.navigation).toBeUndefined();
  const finish = resolve;
  await render({ scoped: false, draft: 'ffeeddccbbaa99887766554433221100' });
  expect(cancels).toEqual([requests[0]!.requestId]);
  await flush(() => finish('reload'));
  expect(actions).toHaveLength(0);
});

test('an unverified scope opens no native popup', async () => {
  await render({ scoped: false });
  await open();
  expect(requests).toHaveLength(0);
});
test('a verified Chrome rectangle preserves CSS anchor coordinates without a DOM element', async () => {
  await render({ anchor: { x: 410, y: 48, width: 32, height: 28 } });
  await open();
  expect(requests[0]).toMatchObject({ x: 442, y: 76, scope });
  await flush(() => resolve('close'));
  expect(actions).toEqual(['close']);
});
test('scope or presentation host replacement cancels an outstanding menu even with the same identity', async () => {
  await render({ hostKey: 'chrome' });
  await open();
  await render({ hostKey: 'root' });
  expect(cancels).toEqual([requests[0]!.requestId]);
  await flush(() => resolve('close'));
  expect(actions).toHaveLength(0);
  await open();
  await render({ hostKey: 'root', generation: 2 });
  expect(cancels).toEqual(requests.map((request) => request.requestId));
  await flush(() => resolve('close'));
  expect(actions).toHaveLength(0);
});
test('invalid rectangle coordinates dispatch no native menu', async () => {
  for (const anchor of [
    { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: -1, height: 10 },
    { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 10 },
  ]) {
    await render({ anchor });
    await open();
  }
  expect(requests).toHaveLength(0);
  expect(errors).toHaveLength(3);
});
test('unmount cancels exactly the pending native menu', async () => {
  await render();
  await open();
  await act(() => root!.unmount());
  root = undefined;
  expect(cancels).toEqual([requests[0]!.requestId]);
  await flush(() => resolve('close'));
  expect(actions).toHaveLength(0);
});

test('the real SessionPage keeps its right pane for popup Escape, then closes for the next ordinary Escape', async () => {
  const { SessionPage } = await import('../../../../packages/ui/src/desktop/SessionPage');
  root ??= createRoot(document.body);
  await flush(() =>
    root!.render(
      <SessionPage
        workspaces={[]}
        readingKey="a"
        selected="a"
        sessionLabel="Session"
        messages={[]}
        loading={false}
        connected
        connectionLabel=""
        actions={{}}
        browserTabRequest={{ requestId: 1, createIfMissing: true }}
        renderBrowser={({ visible }) => <Harness visible={visible} />}
      />,
    ),
  );
  await flush();
  const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  await flush(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Menu')!
      .click(),
  );
  expect(requests).toHaveLength(1);
  const key = (type: string, repeat = false) => {
    const event = new dom.window.KeyboardEvent(type, {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      repeat,
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await flush(() => {
    expect(key('keydown')).toBe(true);
  });
  expect(cancels).toEqual([requests[0]!.requestId]);
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  await flush(() => {
    expect(key('keydown', true)).toBe(true);
  });
  await flush(() => {
    expect(key('keyup')).toBe(true);
    resolve(null);
  });
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  await flush(() => {
    expect(key('keydown')).toBe(false);
  });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(actions).toHaveLength(0);
});

test('pointer dismissal or scope cancellation does not consume the next ordinary Escape', async () => {
  let ordinaryEscapes = 0;
  const ordinary = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) ordinaryEscapes++;
  };
  window.addEventListener('keydown', ordinary);
  try {
    await render();
    await open();
    await flush(() => resolve(null));
    await flush(() =>
      window.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(ordinaryEscapes).toBe(1);
    await open();
    await render({ identity: 'b' });
    await flush(() =>
      window.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(ordinaryEscapes).toBe(2);
  } finally {
    window.removeEventListener('keydown', ordinary);
  }
});
