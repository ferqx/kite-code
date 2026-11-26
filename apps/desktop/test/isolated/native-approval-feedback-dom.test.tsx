import { expect, jest, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { NativeApprovalFeedback } from '../../src/native-approval-feedback';
import type { NativeApprovalNotice } from '../../src/native-approval-presentation';
import { NativeToast } from '../../src/native-message';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const original = { window: globalThis.window, document: globalThis.document };
Object.assign(globalThis, { window: bootstrap.window, document: bootstrap.window.document });
const { createRoot } = await import('react-dom/client');
Object.assign(globalThis, original);
bootstrap.window.close();

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const notice = (
  id = 'a',
  phase: 'unknown' | 'failed' = 'unknown',
  retryable = false,
): NativeApprovalNotice => ({
  key: JSON.stringify(['store', 'session', id, '1']),
  phase,
  retryable,
  ...(retryable ? {} : { commandId: `original-${id}` }),
});
async function fixture(initial: readonly NativeApprovalNotice[]) {
  const dom = new JSDOM('<textarea id="draft">keep draft</textarea><main id="root"></main>', {
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
  const host = document.getElementById('root')!,
    root = createRoot(host);
  let scope: string | undefined = 'generation-1/store/session',
    notices = initial,
    paused = false,
    container: HTMLElement | undefined;
  const queries: { notice: NativeApprovalNotice; flight: ReturnType<typeof deferred> }[] = [];
  const render = async (
    next: {
      scope?: string;
      notices?: readonly NativeApprovalNotice[];
      paused?: boolean;
      container?: HTMLElement;
    } = {},
  ) => {
    if ('scope' in next) scope = next.scope;
    if (next.notices) notices = next.notices;
    if ('paused' in next) paused = next.paused!;
    if ('container' in next) container = next.container;
    await act(() =>
      root.render(
        <>
          <NativeToast
            message={paused ? { id: 900, text: '其他操作失败。' } : undefined}
            onDismiss={() => {}}
            container={container}
          />
          <NativeApprovalFeedback
            scope={scope}
            notices={notices}
            paused={paused}
            container={container}
            onLookup={(item) => {
              const flight = deferred();
              queries.push({ notice: item, flight });
              return flight.promise;
            }}
          />
        </>,
      ),
    );
  };
  await render();
  return {
    dom,
    host,
    queries,
    render,
    toast: () => dom.window.document.querySelector<HTMLElement>('.native-toast-card'),
    button: (label: string) =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === label || b.getAttribute('aria-label') === label,
      )!,
    advance: (ms: number) => act(() => jest.advanceTimersByTime(ms)),
    async close() {
      await act(() => root.unmount());
      dom.window.close();
      restore();
      Object.assign(globalThis, previous);
    },
  };
}

for (const [phase, retryable, text] of [
  ['unknown', false, '未能确认审批答复结果'],
  ['failed', false, '审批提交失败'],
  ['failed', true, '审批回答未提交'],
] as const)
  test(`${phase}/${retryable} uses the existing error Toast outside conversation, never an inline notice or progress`, async () => {
    const f = await fixture([notice('original', phase, retryable)]);
    try {
      const toast = f.toast()!;
      expect(toast.getAttribute('role')).toBe('alert');
      expect(toast.textContent).toContain(text);
      expect(toast.closest('.native-toast')!.parentElement).toBe(f.dom.window.document.body);
      expect(f.host.textContent).toBe('');
      expect(f.host.querySelector('[role="status"], [aria-label="审批答复核对"]')).toBeNull();
      expect(toast.textContent).not.toMatch(/正在|等待执行|已批准|提交中|核对中/);
      expect(f.dom.window.document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
        'keep draft',
      );
      await act(() => f.button('核对原答复').click());
      expect(f.queries).toHaveLength(1);
      expect(f.queries[0]!.notice).toEqual(notice('original', phase, retryable));
      expect(f.button('核对原答复').disabled).toBe(true);
      expect(f.toast()!.textContent).not.toMatch(/正在|核对中/);
      await act(async () => f.queries[0]!.flight.resolve());
      expect(f.toast()!.textContent).toContain(text);
      expect(f.button('核对原答复').disabled).toBe(false);
    } finally {
      await f.close();
    }
  });

test('timeout and close retire only an occurrence, refresh cannot repeat it; unresolved original can be checked on return', async () => {
  jest.useFakeTimers();
  const item = notice(),
    f = await fixture([item]);
  try {
    const first = f.toast();
    await f.advance(3000);
    await f.render({ notices: [{ ...item }] });
    expect(f.toast()).toBe(first);
    await f.advance(3000);
    expect(f.toast()).toBeNull();
    await f.render({ notices: [{ ...item }] });
    expect(f.toast()).toBeNull();
    expect(f.queries).toHaveLength(0);
    await f.render({ scope: undefined });
    await f.render({ scope: 'generation-1/store/session' });
    expect(f.toast()!.textContent).toContain('未能确认');
    await act(() => f.button('关闭提示').click());
    await f.render();
    expect(f.toast()).toBeNull();
    expect(item.commandId).toBe('original-a');
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('multiple failures queue behind an ordinary operation without overlapping or losing originals', async () => {
  const a = notice('a'),
    b = notice('b', 'failed'),
    c = notice('c', 'failed', true);
  const f = await fixture([]);
  try {
    await f.render({ paused: true, notices: [a, b, c] });
    expect(f.dom.window.document.querySelectorAll('.native-toast')).toHaveLength(1);
    expect(f.toast()!.textContent).toContain('其他操作失败');
    await f.render({ paused: false });
    expect(f.toast()!.textContent).toContain('另有 2 项审批异常');
    await act(() => f.button('核对原答复').click());
    expect(f.queries[0]!.notice.commandId).toBe('original-a');
    await act(async () => f.queries[0]!.flight.resolve());
    await act(() => f.button('关闭提示').click());
    expect(f.toast()!.textContent).toContain('审批提交失败');
    await act(() => f.button('核对原答复').click());
    expect(f.queries[1]!.notice.commandId).toBe('original-b');
    await act(async () => f.queries[1]!.flight.resolve());
    await act(() => f.button('关闭提示').click());
    expect(f.toast()!.textContent).toContain('审批回答未提交');
    await act(() => f.button('关闭提示').click());
    expect(f.toast()).toBeNull();
    await f.render({ scope: undefined });
    await f.render({ scope: 'generation-1/store/session' });
    expect(f.toast()!.textContent).toContain('未能确认');
    await act(() => f.button('关闭提示').click());
    expect(f.toast()).toBeNull(); // Already seen terminal failures are not replayed on every visit.
  } finally {
    await f.close();
  }
});

test('phase changes are new errors, accepted results disappear silently and a later real attempt may notify again', async () => {
  const f = await fixture([notice()]);
  try {
    const oldClose = f.button('关闭提示');
    await act(() => oldClose.click());
    await f.render({ notices: [notice('a', 'failed')] });
    expect(f.toast()!.textContent).toContain('审批提交失败');
    await act(() => oldClose.click());
    expect(f.toast()).not.toBeNull();
    await act(() => f.button('关闭提示').click());
    await f.render({ notices: [] });
    expect(f.toast()).toBeNull();
    await f.render({ notices: [notice('a', 'failed')] });
    expect(f.toast()!.textContent).toContain('审批提交失败');
    await f.render({ notices: [] });
    expect(f.toast()).toBeNull();
    expect(f.queries).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('original lookup double clicks are read-deduplicated; lookup failure gets an actionable fresh error occurrence', async () => {
  jest.useFakeTimers();
  const f = await fixture([notice()]);
  try {
    await f.advance(5900);
    const query = f.button('核对原答复');
    await act(() => {
      query.click();
      query.click();
    });
    expect(f.queries).toHaveLength(1);
    await act(async () => f.queries[0]!.flight.reject(new Error('private internal code')));
    expect(f.toast()!.textContent).toContain('暂时无法核对原审批答复');
    expect(f.toast()!.textContent).not.toContain('private internal code');
    await f.advance(200);
    expect(f.toast()).not.toBeNull();
    await act(() => f.button('核对原答复').click());
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]!.notice.commandId).toBe(f.queries[0]!.notice.commandId);
    await act(async () => f.queries[1]!.flight.resolve());
    expect(f.toast()!.textContent).not.toContain('成功');
    await f.advance(5800);
    expect(f.toast()).toBeNull();
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('leaving the exact scope revokes old actions, late failed lookups and old timers cannot affect the next scope', async () => {
  jest.useFakeTimers();
  const f = await fixture([notice()]);
  try {
    const oldQuery = f.button('核对原答复'),
      oldClose = f.button('关闭提示');
    await act(() => oldQuery.click());
    await f.advance(5000);
    await f.render({ scope: undefined });
    expect(f.toast()).toBeNull();
    await act(() => oldQuery.click());
    expect(f.queries).toHaveLength(1);
    await f.render({ scope: 'generation-2/other-store/session', notices: [notice('b', 'failed')] });
    await act(async () => f.queries[0]!.flight.reject(new Error('late original')));
    await act(() => oldClose.click());
    await f.advance(1000);
    expect(f.toast()!.textContent).toContain('审批提交失败');
    expect(f.toast()!.textContent).not.toContain('暂时无法核对');
    await act(() => f.button('核对原答复').click());
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]!.notice.commandId).toBe('original-b');
    await act(async () => f.queries[1]!.flight.resolve());
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('active errors use the existing settings Toast host and hover/focus lifetime, without changing conversation layout', async () => {
  jest.useFakeTimers();
  const f = await fixture([notice()]);
  try {
    const dialog = f.dom.window.document.createElement('div');
    f.dom.window.document.body.append(dialog);
    await f.advance(2000);
    await act(() => f.button('核对原答复').focus());
    await f.advance(7000);
    expect(f.toast()).not.toBeNull();
    await f.render({ container: dialog });
    expect(dialog.querySelector('.native-toast')).not.toBeNull();
    expect(f.dom.window.document.querySelectorAll('.native-toast')).toHaveLength(1);
    expect(f.host.textContent).toBe('');
    await f.advance(3999);
    expect(f.toast()).not.toBeNull();
    await f.advance(1);
    expect(f.toast()).toBeNull();
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('unrecorded approval recovery remains available until the original issue resolves', async () => {
  jest.useFakeTimers();
  const original = { ...notice(), phase: 'unknown' as const, commandId: undefined };
  const f = await fixture([original]);
  try {
    await f.advance(10000);
    expect(f.toast()!.textContent).toContain('未能确认审批答复结果');
    await act(() => f.button('核对原答复').click());
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]!.notice.commandId).toBeUndefined();
    await act(async () => f.queries[0]!.flight.resolve());
    expect(f.button('核对原答复').disabled).toBe(false);
    await f.render({ notices: [] });
    expect(f.toast()).toBeNull();
  } finally {
    await f.close();
    jest.useRealTimers();
  }
});

test('an original lookup failure remains queued while another operation or settings temporarily owns the foreground', async () => {
  const f = await fixture([notice()]);
  try {
    const oldQuery = f.button('核对原答复');
    await act(() => oldQuery.click());
    await f.render({ paused: true });
    await act(() => oldQuery.click());
    expect(f.queries).toHaveLength(1);
    await act(async () => f.queries[0]!.flight.reject(new Error('lookup unavailable')));
    expect(f.dom.window.document.querySelectorAll('.native-toast')).toHaveLength(1);
    expect(f.toast()!.textContent).toContain('其他操作失败');
    await f.render({ paused: false });
    expect(f.toast()!.textContent).toContain('暂时无法核对原审批答复');
    expect(f.button('核对原答复').disabled).toBe(false);
    await act(() => f.button('核对原答复').click());
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]!.notice.commandId).toBe('original-a');
    await act(async () => f.queries[1]!.flight.resolve());
  } finally {
    await f.close();
  }
});
