import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { type PermissionFacts, PermissionPanel } from '../src';

const facts = (sessionId = 'root'): PermissionFacts => ({
  mode: {
    storeId: 'store',
    sessionId,
    scopeSessionId: 'root',
    mode: 'ask',
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
    const radios = host.querySelectorAll<HTMLInputElement>('input[type=radio]');
    await act(async () => {
      radios[3]!.click();
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
