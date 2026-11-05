import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PermissionFacts } from '../../src';
import type { ComposerProps } from '../../src/desktop/Composer';

// Initialize the shared Radix dependency family against a DOM before exercising each fixture.
const bootstrap = new JSDOM('<!doctype html><div></div>');
const priorBootstrap = { window: globalThis.window, document: globalThis.document };
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document });
const { PermissionPanel } = await import('../../src');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

const facts = (sessionId = 'root'): PermissionFacts => ({
  mode: {
    storeId: 'store',
    sessionId,
    scopeSessionId: 'root',
    mode: 'accept_edits',
    revision: '11',
    defaultMode: 'auto',
    defaultRevision: '9',
  },
  trust: {
    storeId: 'store',
    workspaceId: 'w',
    status: 'scope_changed',
    trusted: false,
    revision: '8',
    canonicalIdentity: 'a'.repeat(64),
    externalReadScopeDigest: 'b'.repeat(64),
    readScopes: [{ kind: 'external', description: '已展示的额外只读范围' }],
  },
});
test('actual React DOM keyboard makes one explicit mode/default choice; old late result cannot overwrite replacement or authorize trust', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
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
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const calls: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((el) => el.textContent === label)!;
  const render = (value: PermissionFacts, callbacks = true, busy = false) =>
    act(async () =>
      root.render(
        <PermissionPanel
          facts={value}
          busy={busy}
          onSetMode={
            callbacks
              ? async (mode, makeDefault) => {
                  calls.push([value.mode.sessionId, mode, makeDefault]);
                  await pending;
                }
              : undefined
          }
          onSetTrust={
            callbacks
              ? async (trusted) => {
                  calls.push([value.mode.sessionId, trusted]);
                }
              : undefined
          }
        />,
      ),
    );
  try {
    await render(facts(), false);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('已展示的额外只读范围');
    expect(host.textContent).toContain('scope_changed');
    await render(facts());
    expect(button('保存模式选择').disabled).toBe(true);
    const full = host.querySelector<HTMLInputElement>('input[name=permission-mode][value=full]')!;
    expect(host.querySelectorAll('input[name=permission-mode]')).toHaveLength(3);
    await act(async () => {
      full.click();
      host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    });
    await act(async () => {
      const target = button('保存模式选择');
      target.focus();
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }),
      );
      target.click();
    });
    expect(calls).toEqual([['root', 'full', true]]);
    expect(button('撤销工作区信任').closest('fieldset')!.disabled).toBe(true);
    await act(async () => button('撤销工作区信任').click());
    expect(calls).toHaveLength(1);
    await render({
      ...facts(),
      mode: { ...facts().mode, sessionId: 'other', scopeSessionId: 'other' },
    });
    release();
    await act(async () => {
      await pending;
    });
    expect(host.textContent).not.toContain('回执已收到');
    expect(button('保存模式选择').disabled).toBe(true);
    expect(button('信任所显示的范围').disabled).toBe(true);
    const boxes = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    await act(async () => boxes[1]!.click());
    await act(async () =>
      button('信任所显示的范围').dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      ),
    );
    expect(calls).toEqual([
      ['root', 'full', true],
      ['other', true],
    ]);
    await render(facts('child'));
    expect(host.textContent).toContain('子会话继承');
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(0);
  } finally {
    release();
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
test('failed or unknown host answer leaves exact selection visible and busy public facts cannot write', async () => {
  const dom = new JSDOM('<div id="root"></div>');
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
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  let writes = 0;
  const onSetMode = async () => {
    writes++;
    throw Error('unknown');
  };
  try {
    await act(async () => root.render(<PermissionPanel facts={facts()} onSetMode={onSetMode} />));
    await act(async () => host.querySelector<HTMLInputElement>('input[type=radio]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[type=submit]')!.click());
    expect(writes).toBe(1);
    expect(host.querySelector<HTMLInputElement>('input[type=radio]')!.checked).toBe(true);
    expect(host.textContent).toContain('未确认应用');
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () =>
      root.render(
        <PermissionPanel
          facts={{ ...facts(), mode: { ...facts().mode, revision: '12' } }}
          busy
          onSetMode={onSetMode}
        />,
      ),
    );
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('button[type=submit]')!.click());
    expect(writes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

async function composerPermissionFixture(language = 'zh-CN') {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window.navigator, 'language', { value: language });
  Object.assign(dom.window.Range.prototype, {
    getBoundingClientRect: () => new dom.window.DOMRect(),
    getClientRects: () => [],
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { Composer } = await import('../../src/desktop/Composer');
  const host = document.getElementById('root')!,
    root = createRoot(host),
    changes: string[] = [],
    requests: {
      language: 'zh' | 'en';
      signal: AbortSignal;
      resolve(value: boolean): void;
      reject(cause: unknown): void;
    }[] = [];
  const confirmFullPermission: NonNullable<ComposerProps['confirmFullPermission']> = (options) =>
    new Promise<boolean>((resolve, reject) => requests.push({ ...options, resolve, reject }));
  const defaults: ComposerProps = {
    scopeKey: 'original',
    fullPermissionScope: 'original-authority',
    draft: '',
    onChange() {},
    active: false,
    stopping: false,
    disabled: false,
    permission: 'auto',
    onPermissionChange: (permission) => changes.push(permission),
    confirmFullPermission,
  };
  let mounted = true;
  const show = (overrides: Partial<ComposerProps> = {}) =>
    act(async () => root.render(<Composer {...defaults} {...overrides} />));
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
  const openMenu = () =>
    act(async () => {
      trigger().dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
  const choosePermission = async (mode: NonNullable<ComposerProps['permission']>) => {
    await openMenu();
    const labels = language.startsWith('zh')
      ? { full: '完全访问', auto: '自动审核', accept_edits: '请求批准' }
      : { full: 'Full permission', auto: 'Automatic check', accept_edits: 'Request Approval' };
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.querySelector('.permission-menu-copy > span')?.textContent === labels[mode],
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
  };
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };
  return {
    dom,
    host,
    defaults,
    changes,
    requests,
    show,
    trigger,
    openMenu,
    choosePermission,
    chooseFull: () => choosePermission('full'),
    unmount,
    async close() {
      await unmount();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Composer uses one exact asynchronous host confirmation without mounting its DOM warning', async () => {
  const f = await composerPermissionFixture();
  try {
    await f.show();
    await f.chooseFull();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.language).toBe('zh');
    expect(f.requests[0]!.signal.aborted).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(f.changes).toEqual([]);
    expect(f.trigger().disabled).toBe(true);
    await f.show({ draft: 'An unrelated draft update' });
    expect(f.requests[0]!.signal.aborted).toBe(false);
    await f.openMenu();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(f.requests).toHaveLength(1);
    await act(async () => f.requests[0]!.resolve(true));
    expect(f.changes).toEqual(['full']);
    expect(f.trigger().disabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('Composer host cancellation and non-boolean answers never enable full permission and allow a new choice', async () => {
  const f = await composerPermissionFixture();
  try {
    await f.show();
    for (const answer of [false, 1 as unknown as boolean]) {
      await f.chooseFull();
      await act(async () => f.requests.at(-1)!.resolve(answer));
      expect(f.changes).toEqual([]);
      expect(f.trigger().disabled).toBe(false);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }
    await f.chooseFull();
    await act(async () => f.requests.at(-1)!.resolve(true));
    expect(f.requests).toHaveLength(3);
    expect(f.changes).toEqual(['full']);
  } finally {
    await f.close();
  }
});

for (const language of ['zh-CN', 'en-US'])
  test(`Composer reports a bounded ${language} host-confirmation failure and lets the user retry`, async () => {
    const f = await composerPermissionFixture(language);
    try {
      await f.show();
      await f.chooseFull();
      expect(f.requests[0]!.language).toBe(language.startsWith('zh') ? 'zh' : 'en');
      await act(async () => f.requests[0]!.reject(Error('private host details')));
      expect(f.changes).toEqual([]);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(document.querySelector('[role="alert"]')!.textContent).toBe(
        language.startsWith('zh')
          ? '未能完成权限确认，请重试。'
          : 'Permission confirmation did not complete. Please try again.',
      );
      await f.chooseFull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      await act(async () => f.requests[1]!.resolve(true));
      expect(f.changes).toEqual(['full']);
    } finally {
      await f.close();
    }
  });

for (const retired of [
  'scopeKey',
  'fullPermissionScope',
  'disabled',
  'permissionDisabled',
  'permissionPending',
  'promptHidden',
  'permission',
  'onPermissionChange',
  'confirmFullPermission',
  'unmount',
] as const)
  test(`Composer aborts the exact host confirmation on ${retired} and rejects its late answer`, async () => {
    const f = await composerPermissionFixture();
    const replacementChanges: string[] = [];
    try {
      await f.show();
      await f.chooseFull();
      const original = f.requests[0]!;
      if (retired === 'unmount') await f.unmount();
      else {
        const changes: Partial<ComposerProps> =
          retired === 'scopeKey' || retired === 'fullPermissionScope'
            ? { [retired]: 'replacement' }
            : retired === 'permission'
              ? { permission: 'full' }
              : retired === 'onPermissionChange'
                ? { onPermissionChange: (mode) => replacementChanges.push(mode) }
                : retired === 'confirmFullPermission'
                  ? { confirmFullPermission: async () => true }
                  : { [retired]: true };
        await f.show(changes);
        // Returning to the same props must not revive the retired confirmation.
        await f.show();
        await f.chooseFull();
      }
      expect(original.signal.aborted).toBe(true);
      await act(async () => {
        if (retired === 'confirmFullPermission') original.reject(Error('retired host failure'));
        else original.resolve(true);
      });
      expect(f.changes).toEqual([]);
      expect(replacementChanges).toEqual([]);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      if (retired !== 'unmount') {
        expect(f.requests).toHaveLength(2);
        expect(f.trigger().disabled).toBe(true);
        await act(async () => f.requests[1]!.resolve(true));
        expect(f.changes).toEqual(['full']);
      }
    } finally {
      await f.close();
    }
  });

for (const language of ['zh-CN', 'en-US'])
  test(`Composer without a host port retains the ${language} DOM warning and both explicit choices`, async () => {
    const f = await composerPermissionFixture(language);
    try {
      await f.show({ confirmFullPermission: undefined });
      await f.chooseFull();
      const dialog = document.querySelector('[role="alertdialog"]')!;
      expect(dialog).not.toBeNull();
      expect(f.requests).toHaveLength(0);
      expect([...dialog.querySelectorAll('li')].map((node) => node.textContent)).toEqual(
        language.startsWith('zh')
          ? ['文件可能被覆盖或删除', '敏感数据可能外泄，后果难以撤销']
          : [
              'Files may be overwritten or deleted',
              'Sensitive data may be exposed, with consequences that are hard to undo',
            ],
      );
      const button = (text: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
          (button) => button.textContent === text,
        )!;
      await act(async () => button(language.startsWith('zh') ? '取消' : 'Cancel').click());
      expect(f.changes).toEqual([]);
      await f.chooseFull();
      await act(async () =>
        button(language.startsWith('zh') ? '启用完全权限' : 'Enable Full').click(),
      );
      expect(f.changes).toEqual(['full']);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('Composer keeps ordinary permission menu changes direct, including leaving full permission', async () => {
  const f = await composerPermissionFixture();
  try {
    await f.show({ permission: 'full' });
    await f.choosePermission('auto');
    await f.show();
    await f.choosePermission('accept_edits');
    expect(f.changes).toEqual(['auto', 'accept_edits']);
    expect(f.requests).toHaveLength(0);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await f.close();
  }
});

for (const unavailable of ['disabled', 'permissionPending'] as const)
  test(`Composer ${unavailable} prevents full confirmation while preserving ordinary menu choices`, async () => {
    const f = await composerPermissionFixture();
    try {
      await f.show({ [unavailable]: true });
      expect(f.trigger().disabled).toBe(false);
      await f.chooseFull();
      expect(f.requests).toHaveLength(0);
      expect(f.changes).toEqual([]);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      await f.choosePermission('accept_edits');
      expect(f.changes).toEqual(['accept_edits']);
    } finally {
      await f.close();
    }
  });
