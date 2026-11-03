import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, Suspense, startTransition, useLayoutEffect, useState } from 'react';
import type { ComposerProps } from '../../../../packages/ui/src/desktop/Composer';
import { useNativePermissionChange } from '../../src/use-native-permission-change';
import { prepareDesktopDom } from '../native-page-dom.fixture';

async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    DocumentFragment: dom.window.DocumentFragment,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { Composer } = await import('../../../../packages/ui/src/desktop/Composer');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  type Scope = 'A' | 'B';
  const changes: { scope: Scope; mode: NonNullable<ComposerProps['permission']> }[] = [],
    attempts: Scope[] = [],
    requests: { signal: AbortSignal; resolve(value: boolean): void }[] = [];
  const confirmFullPermission: NonNullable<ComposerProps['confirmFullPermission']> = ({ signal }) =>
    new Promise<boolean>((resolve) => requests.push({ signal, resolve }));
  let select!: (scope: Scope) => void,
    rerender!: () => void,
    release!: () => void,
    committed: Scope | undefined,
    callback: ((mode: NonNullable<ComposerProps['permission']>) => void) | undefined,
    ready = false,
    mounted = true;
  const pending = new Promise<void>((resolve) => {
    release = () => {
      ready = true;
      resolve();
    };
  });
  function Gate({ scope }: { scope: Scope }) {
    if (scope === 'B' && !ready) throw pending;
    return null;
  }
  function Parent() {
    const [scope, setScope] = useState<Scope>('A');
    const [revision, setRevision] = useState(0);
    select = setScope;
    rerender = () => setRevision((value) => value + 1);
    attempts.push(scope);
    const onPermissionChange = useNativePermissionChange((mode) => changes.push({ scope, mode }));
    useLayoutEffect(() => {
      committed = scope;
      callback = onPermissionChange;
    });
    return (
      <>
        <span data-committed-scope={scope}>{scope}</span>
        <Composer
          scopeKey={scope}
          fullPermissionScope={`permission-${scope}`}
          permission="auto"
          onPermissionChange={onPermissionChange}
          confirmFullPermission={confirmFullPermission}
          draft={`Revision ${revision}`}
          onChange={() => {}}
          active={false}
          stopping={false}
          disabled={false}
        />
        <Gate scope={scope} />
      </>
    );
  }
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };
  return {
    changes,
    requests,
    attempts,
    committed: () => committed,
    callback: () => callback!,
    visible: () =>
      document.querySelector('[data-committed-scope]')?.getAttribute('data-committed-scope'),
    mount: () =>
      act(async () =>
        root.render(
          <Suspense fallback={<div>Replacing session</div>}>
            <Parent />
          </Suspense>,
        ),
      ),
    transitionB: () => act(async () => startTransition(() => select('B'))),
    commitB: () => act(async () => release()),
    keepA: () => act(async () => select('A')),
    rerender: () => act(async () => rerender()),
    async chooseFull() {
      await act(async () =>
        document.querySelector('[data-permission-trigger]')!.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (item) => item.textContent?.includes('Full permission'),
      );
      expect(item).toBeDefined();
      await act(async () => item!.click());
    },
    unmount,
    async close() {
      await unmount();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      dom.window.close();
      restore();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('a full confirmation for committed A cannot route to B while its replacement render is suspended', async () => {
  const f = await fixture();
  try {
    await f.mount();
    await f.chooseFull();
    const callback = f.callback();
    await f.transitionB();
    expect(f.attempts).toContain('B');
    expect(f.committed()).toBe('A');
    expect(f.visible()).toBe('A');
    expect(f.requests[0]!.signal.aborted).toBe(false);
    await act(async () => f.requests[0]!.resolve(true));
    expect(f.changes).toEqual([{ scope: 'A', mode: 'full' }]);
    expect(f.callback()).toBe(callback);
  } finally {
    await f.close();
  }
});

test('committing B aborts the old Composer confirmation and admits only a fresh B confirmation', async () => {
  const f = await fixture();
  try {
    await f.mount();
    await f.chooseFull();
    const callback = f.callback();
    await f.transitionB();
    expect(f.requests[0]!.signal.aborted).toBe(false);
    await f.commitB();
    expect(f.committed()).toBe('B');
    expect(f.visible()).toBe('B');
    expect(f.callback()).toBe(callback);
    expect(f.requests[0]!.signal.aborted).toBe(true);
    await act(async () => f.requests[0]!.resolve(true));
    expect(f.changes).toEqual([]);
    await f.chooseFull();
    expect(f.requests).toHaveLength(2);
    await act(async () => f.requests[1]!.resolve(true));
    expect(f.changes).toEqual([{ scope: 'B', mode: 'full' }]);
  } finally {
    await f.close();
  }
});

test('discarding a suspended B render preserves the original A confirmation and committed action', async () => {
  const f = await fixture();
  try {
    await f.mount();
    await f.chooseFull();
    await f.transitionB();
    expect(f.attempts).toContain('B');
    await f.keepA();
    expect(f.committed()).toBe('A');
    expect(f.visible()).toBe('A');
    expect(f.requests[0]!.signal.aborted).toBe(false);
    await act(async () => f.requests[0]!.resolve(true));
    expect(f.changes).toEqual([{ scope: 'A', mode: 'full' }]);
  } finally {
    await f.close();
  }
});

test('ordinary committed rerenders keep the permission callback stable without cancelling its confirmation', async () => {
  const f = await fixture();
  try {
    await f.mount();
    await f.chooseFull();
    const callback = f.callback();
    await f.rerender();
    expect(f.callback()).toBe(callback);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.signal.aborted).toBe(false);
    await act(async () => f.requests[0]!.resolve(true));
    expect(f.changes).toEqual([{ scope: 'A', mode: 'full' }]);
  } finally {
    await f.close();
  }
});

test('unmount retires the native permission action as well as its pending Composer confirmation', async () => {
  const f = await fixture();
  try {
    await f.mount();
    await f.chooseFull();
    const callback = f.callback();
    await f.unmount();
    expect(f.requests[0]!.signal.aborted).toBe(true);
    callback('full');
    await act(async () => f.requests[0]!.resolve(true));
    expect(f.changes).toEqual([]);
  } finally {
    await f.close();
  }
});
