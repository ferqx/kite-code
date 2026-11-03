import { expect, jest, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ReactNode, Suspense, startTransition, useLayoutEffect, useState } from 'react';
import {
  humanReadableOperationError,
  NativeMessage,
  type NativeMessageProps,
} from '../../src/native-message';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const original = { window: globalThis.window, document: globalThis.document };
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document });
const { createRoot } = await import('react-dom/client');
Object.assign(globalThis, original);
bootstrap.window.close();

async function fixture() {
  const dom = new JSDOM('<input id="outside"><main id="root"></main>', {
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const dismissed: number[] = [];
  let replace!: (message: NativeMessageProps['message']) => void;
  function Harness() {
    const [message, setMessage] = useState<NativeMessageProps['message']>();
    replace = setMessage;
    return (
      <NativeMessage
        message={message}
        onDismiss={(id) => {
          dismissed.push(id);
          setMessage((current) => (current?.id === id ? undefined : current));
        }}
      />
    );
  }
  await act(() => root.render(<Harness />));
  return {
    dom,
    host,
    dismissed,
    render: (content: ReactNode) => act(() => root.render(content)),
    show: (id: number, text = '工作区暂不可用，请检查目录是否仍存在且可以访问。') =>
      act(() => replace({ id, text })),
    advance: (ms: number) => act(() => jest.advanceTimersByTime(ms)),
    closeButton: () => host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!,
    async close() {
      await act(() => root.unmount());
      dom.window.close();
      restore();
      Object.assign(globalThis, previous);
    },
  };
}

async function suspenseFixture(sameId: boolean) {
  const f = await fixture();
  const events: { context: string; id: number }[] = [];
  let select!: (value: 'A' | 'B') => void;
  let ready = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  function Gate({ context }: { context: string }) {
    if (context === 'B' && !ready) throw pending;
    return <span data-context={context} />;
  }
  function Scenario() {
    const [context, setContext] = useState<'A' | 'B'>('A');
    useLayoutEffect(() => {
      select = setContext;
    }, []);
    return (
      <Suspense fallback={<p>Waiting for B</p>}>
        <NativeMessage
          message={{ id: context === 'A' || sameId ? 101 : 202, text: `${context}提示` }}
          onDismiss={(id) => events.push({ context, id })}
        />
        <Gate context={context} />
      </Suspense>
    );
  }
  await f.render(<Scenario />);
  return {
    ...f,
    events,
    transitionB: () => act(async () => startTransition(() => select('B'))),
    commitB: () =>
      act(async () => {
        ready = true;
        release();
      }),
  };
}

for (const sameId of [false, true])
  test(`an uncommitted suspended replacement with ${sameId ? 'the same ID' : 'a new ID'} cannot retarget or suppress the committed message`, async () => {
    jest.useFakeTimers();
    const f = await suspenseFixture(sameId);
    try {
      await f.advance(5000);
      await f.transitionB();
      expect(f.host.querySelector('[role="status"]')?.textContent).toContain('A提示');
      expect(f.host.textContent).not.toContain('B提示');
      expect(f.host.textContent).not.toContain('Waiting for B');
      const oldClose = f.closeButton();
      await act(() => oldClose.click());
      expect(f.events).toEqual([{ context: 'A', id: 101 }]);
      await f.advance(1000);
      expect(f.events).toEqual([
        { context: 'A', id: 101 },
        { context: 'A', id: 101 },
      ]);
      await f.commitB();
      expect(f.host.querySelector('[role="status"]')?.textContent).toContain('B提示');
      if (!sameId) {
        await act(() => oldClose.click());
        await f.advance(5999);
        expect(f.events).toHaveLength(2);
        await f.advance(1);
        expect(f.events.at(-1)).toEqual({ context: 'B', id: 202 });
        expect(f.events).toHaveLength(3);
      } else {
        await act(() => f.closeButton().click());
        expect(f.events.at(-1)).toEqual({ context: 'B', id: 101 });
      }
    } finally {
      await f.close();
      jest.useRealTimers();
    }
  });

test('a readable local status preserves focus and dismisses automatically after six seconds', async () => {
  jest.useFakeTimers();
  const f = await fixture();
  try {
    const outside = document.getElementById('outside')!;
    outside.focus();
    await f.show(1);
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain('工作区暂不可用');
    expect(document.activeElement).toBe(outside);
    expect(document.querySelector('[role="dialog"], [aria-modal="true"], [inert]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    await f.advance(5999);
    expect(f.host.querySelector('[role="status"]')).not.toBeNull();
    await f.advance(1);
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(f.dismissed).toEqual([1]);
    expect(document.activeElement).toBe(outside);
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('hover and keyboard focus both pause the remaining reading time until both leave', async () => {
  jest.useFakeTimers();
  const f = await fixture();
  try {
    await f.show(2);
    await f.advance(2000);
    const card = f.host.querySelector('.native-message-card')!;
    await act(() =>
      card.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true })),
    );
    await f.advance(7000);
    expect(f.dismissed).toEqual([]);
    await act(() => f.closeButton().focus());
    await act(() =>
      card.dispatchEvent(
        new f.dom.window.MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.getElementById('outside'),
        }),
      ),
    );
    await f.advance(7000);
    expect(f.dismissed).toEqual([]);
    await act(() => document.getElementById('outside')!.focus());
    await f.advance(3999);
    expect(f.host.querySelector('[role="status"]')).not.toBeNull();
    await f.advance(1);
    expect(f.dismissed).toEqual([2]);
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('a replacement gets its own reading time and retired timers or close controls cannot dismiss it', async () => {
  jest.useFakeTimers();
  const f = await fixture();
  try {
    await f.show(3, '旧提示');
    const oldClose = f.closeButton();
    await f.advance(5900);
    await f.show(4, '新提示');
    await act(() => oldClose.click());
    await f.advance(100);
    expect(f.dismissed).toEqual([]);
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain('新提示');
    expect(f.host.querySelectorAll('[role="status"]')).toHaveLength(1);
    await f.advance(5899);
    expect(f.dismissed).toEqual([]);
    await f.advance(1);
    expect(f.dismissed).toEqual([4]);
    await f.show(5);
    await act(() => f.closeButton().click());
    expect(f.dismissed).toEqual([4, 5]);
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    await f.advance(6000);
    expect(f.dismissed).toEqual([4, 5]);
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('repeated occurrences with identical text remain independently dismissible', async () => {
  jest.useFakeTimers();
  const f = await fixture();
  try {
    await f.show(6, '相同提示');
    await act(() => f.closeButton().click());
    await f.show(7, '相同提示');
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain('相同提示');
    await f.advance(6000);
    expect(f.dismissed).toEqual([6, 7]);
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('operation errors expose finite readable copy and never echo an unknown cause, stack or token', () => {
  expect(humanReadableOperationError('permission_denied')).toContain('权限');
  expect(humanReadableOperationError('workspace_not_found')).toContain('工作区已不存在');
  expect(humanReadableOperationError('workspace_unavailable')).toContain('工作区暂不可用');
  expect(humanReadableOperationError('workspace_untrusted')).toContain('尚未受信任');
  expect(humanReadableOperationError('branch_not_found')).toContain('分支已不存在');
  expect(humanReadableOperationError('native_directory_unavailable')).toContain('目录暂时无法读取');
  expect(humanReadableOperationError('network_unavailable')).toContain('连接暂不可用');
  expect(humanReadableOperationError('read_only')).toContain('只读');
  for (const code of [
    'unexpected_code',
    'constructor',
    '__proto__',
    'token=private\n at cause:7',
  ]) {
    expect(humanReadableOperationError(code)).toBe('这一步未能完成，请稍后重试。');
    expect(humanReadableOperationError(code, '切换分支')).toBe('切换分支未能完成，请稍后重试。');
  }
  for (const code of [
    'network_outcome_unknown',
    'conversation_response_unknown',
    'result_unknown',
  ]) {
    const message = humanReadableOperationError(code, '发送');
    expect(message).toContain('核对原操作结果');
    expect(message).toContain('避免重复提交');
    expect(message).not.toContain('重试');
    expect(message).not.toContain(code);
  }
});
