import { expect, test } from 'bun:test';
import { ErrorFeedbackContext, MessageCopyButton, useErrorFeedback } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, type ReactNode, Suspense, startTransition, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NativeApprovalFeedback } from '../../src/native-approval-feedback';
import type { NativeApprovalNotice } from '../../src/native-approval-presentation';
import { useNativeErrorFeedback } from '../../src/native-error-feedback';
import { NativeToast } from '../../src/native-message';
import { useNativeSettingsFeedback } from '../../src/native-settings-feedback';
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
async function fixture() {
  const dom = new JSDOM('<main id="root"></main><aside id="dialog"></aside>', {
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
    dialog = document.getElementById('dialog')!,
    root = createRoot(host);
  const queries: NativeApprovalNotice[] = [];
  const props = {
    scope: 'generation-1/store/session-A/view-1/conversation',
    settings: false,
    notices: [] as NativeApprovalNotice[],
    writer: async (_text: string) => {},
    child: undefined as ReactNode,
  };
  let feedback!: ReturnType<typeof useNativeErrorFeedback>;
  let settingsFeedback!: ReturnType<typeof useNativeSettingsFeedback>;
  let inherited!: (message: string) => void;
  function Consumer() {
    const onError = useErrorFeedback();
    const settings = useNativeSettingsFeedback('settings-producer');
    useLayoutEffect(() => {
      inherited = onError!;
      settingsFeedback = settings;
    });
    return (
      <>
        <MessageCopyButton text="saved reply" writeClipboardText={props.writer} />
        {createPortal(
          <button type="button" onClick={() => onError?.('面板操作失败，请重试。')}>
            面板操作
          </button>,
          dialog,
        )}
      </>
    );
  }
  function Harness() {
    const current = useNativeErrorFeedback(props.scope);
    useLayoutEffect(() => {
      feedback = current;
    });
    return (
      <ErrorFeedbackContext.Provider value={current.report}>
        <Consumer />
        {props.child}
        <NativeToast
          message={current.message}
          onDismiss={current.dismiss}
          container={props.settings ? dialog : undefined}
        />
        <NativeApprovalFeedback
          scope={props.scope}
          notices={props.notices}
          paused={!!current.message || props.settings}
          onLookup={async (notice) => {
            queries.push(notice);
          }}
        />
      </ErrorFeedbackContext.Provider>
    );
  }
  const render = async (update: Partial<typeof props> = {}) => {
    Object.assign(props, update);
    await act(async () => root.render(<Harness />));
  };
  await render();
  return {
    host,
    dialog,
    dom,
    queries,
    render,
    renderContent: (content: ReactNode) => act(async () => root.render(content)),
    get feedback() {
      return feedback;
    },
    get inherited() {
      return inherited;
    },
    get settingsFeedback() {
      return settingsFeedback;
    },
    toast: () => document.querySelector<HTMLElement>('.native-toast-card'),
    button: (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === name || button.getAttribute('aria-label') === name,
      )!,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      restore();
      Object.assign(globalThis, previous);
    },
  };
}

test('stable captured presentation retires old errors and callbacks across A → B → A', async () => {
  const f = await fixture();
  try {
    const originalReport = f.inherited;
    await f.render();
    expect(f.inherited).toBe(originalReport);
    await act(async () => originalReport('A失败'));
    const originalId = f.feedback.message!.id;
    const clearOriginal = f.feedback.report;
    expect(f.toast()?.textContent).toContain('A失败');
    await f.render({ scope: 'generation-1/store/session-B/view-2/conversation' });
    expect(f.toast()).toBeNull();
    await act(async () => originalReport('A迟到失败'));
    expect(f.toast()).toBeNull();
    await act(async () => f.inherited('B失败'));
    await act(async () => clearOriginal());
    await act(async () => f.feedback.dismiss(originalId));
    expect(f.toast()?.textContent).toContain('B失败');
    await f.render({ scope: 'generation-1/store/session-A/view-1/conversation' });
    expect(f.inherited).not.toBe(originalReport);
    expect(f.toast()).toBeNull();
    await act(async () => originalReport('返回A后的旧失败'));
    expect(f.toast()).toBeNull();
    await act(async () => f.inherited('A新的失败'));
    expect(f.toast()?.textContent).toContain('A新的失败');
  } finally {
    await f.close();
  }
});

test('a suspended uncommitted scope cannot retarget or retire the committed reporter', async () => {
  const f = await fixture(),
    gate = deferred();
  let ready = false;
  let select!: (scope: string) => void;
  const reports = new Map<string, ReturnType<typeof useNativeErrorFeedback>['report']>();
  function Gate({ scope }: { scope: string }) {
    if (scope === 'B' && !ready) throw gate.promise;
    return null;
  }
  function Scoped({ scope }: { scope: string }) {
    const feedback = useNativeErrorFeedback(scope);
    reports.set(scope, feedback.report);
    return (
      <>
        <NativeToast message={feedback.message} onDismiss={feedback.dismiss} />
        <Gate scope={scope} />
      </>
    );
  }
  function Scenario() {
    const [scope, setScope] = useState('A');
    useLayoutEffect(() => {
      select = setScope;
    }, []);
    return (
      <Suspense fallback={<p>waiting</p>}>
        <Scoped scope={scope} />
      </Suspense>
    );
  }
  try {
    await f.renderContent(<Scenario />);
    const reportA = reports.get('A')!;
    await act(async () => reportA('A failed'));
    await act(async () => startTransition(() => select('B')));
    expect(f.host.textContent).not.toContain('waiting');
    expect(f.toast()?.textContent).toContain('A failed');
    await act(async () => reports.get('B')!('uncommitted B failed'));
    expect(f.toast()?.textContent).toContain('A failed');
    await act(async () => reportA('A still owns feedback'));
    expect(f.toast()?.textContent).toContain('A still owns feedback');
    await act(async () => {
      ready = true;
      gate.resolve();
    });
    expect(f.toast()).toBeNull();
    await act(async () => reportA('retired A failed'));
    expect(f.toast()).toBeNull();
    await act(async () => reports.get('B')!('committed B failed'));
    expect(f.toast()?.textContent).toContain('committed B failed');
  } finally {
    await f.close();
  }
});

test('portal consumers use the same host and switching settings categories or closing rejects late failures', async () => {
  const f = await fixture();
  try {
    await f.render({ scope: 'settings/providers', settings: true });
    const oldProvider = f.inherited;
    await act(async () => f.button('面板操作').click());
    expect(f.dialog.querySelector('.native-toast-card')?.textContent).toContain('面板操作失败');
    expect(document.querySelectorAll('.native-toast')).toHaveLength(1);
    await f.render({ scope: 'settings/skills' });
    expect(f.toast()).toBeNull();
    await act(async () => oldProvider('提供商迟到失败'));
    expect(f.toast()).toBeNull();
    const oldSkills = f.inherited;
    await f.render({ scope: 'conversation/A', settings: false });
    await act(async () => oldSkills('已关闭的设置迟到失败'));
    expect(f.toast()).toBeNull();
    await f.render({ scope: 'settings/skills', settings: true });
    await act(async () => oldSkills('上次设置的迟到失败'));
    expect(f.toast()).toBeNull();
    await act(async () => f.inherited('本次设置失败'));
    expect(f.toast()?.textContent).toContain('本次设置失败');
  } finally {
    await f.close();
  }
});

test('ordinary errors and the original approval queue never stack, and dismiss preserves original read-only lookup', async () => {
  const f = await fixture();
  const originalNotice: NativeApprovalNotice = {
    key: 'approval-original',
    phase: 'unknown',
    commandId: 'original-command',
    retryable: false,
  };
  try {
    await f.render({ notices: [originalNotice] });
    expect(f.toast()?.textContent).toContain('不会重复提交');
    await act(async () => f.inherited('复制失败，请重试'));
    expect(document.querySelectorAll('.native-toast')).toHaveLength(1);
    expect(f.toast()?.textContent).toContain('复制失败');
    expect(f.button('核对原答复')).toBeUndefined();
    await act(async () => f.button('关闭提示').click());
    expect(document.querySelectorAll('.native-toast')).toHaveLength(1);
    expect(f.toast()?.textContent).toContain('不会重复提交');
    await act(async () => f.button('核对原答复').click());
    expect(f.queries).toEqual([originalNotice]);
    await act(async () => f.button('关闭提示').click());
    await f.render({ notices: [{ ...originalNotice }] });
    expect(f.toast()).toBeNull();
    expect(f.queries).toEqual([originalNotice]);
  } finally {
    await f.close();
  }
});

test('the real copy control uses error Toast only, remains quiet while pending or successful, and retries the same failure', async () => {
  const f = await fixture();
  const first = deferred(),
    second = deferred(),
    success = deferred();
  let attempt = 0;
  try {
    await f.render({ writer: () => [first, second, success][attempt++]!.promise });
    const copy = () => f.host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => copy().click());
    expect(f.toast()).toBeNull();
    await act(async () => first.reject(Error('clipboard failed')));
    expect(f.toast()?.textContent).toContain('复制失败，请重试');
    expect(f.host.textContent).not.toContain('复制失败');
    await act(async () => f.button('关闭提示').click());
    await act(async () => copy().click());
    await act(async () => second.reject(Error('clipboard failed again')));
    expect(f.toast()?.textContent).toContain('复制失败，请重试');
    await act(async () => f.button('关闭提示').click());
    await act(async () => copy().click());
    expect(f.toast()).toBeNull();
    await act(async () => success.resolve());
    expect(f.toast()).toBeNull();
    expect(attempt).toBe(3);
  } finally {
    await f.close();
  }
});

test('a pending real copy cannot report into settings or the revisited conversation', async () => {
  const f = await fixture(),
    first = deferred();
  try {
    await f.render({ writer: () => first.promise });
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    await f.render({ scope: 'settings/providers', settings: true });
    await f.render({ scope: 'generation-1/store/session-A/view-1/conversation', settings: false });
    await act(async () => first.reject(Error('old clipboard failed')));
    expect(f.toast()).toBeNull();
  } finally {
    await f.close();
  }
});

test('settings automatic failure episodes do not reappear after dismissal, while an explicit retry can notify again', async () => {
  const f = await fixture();
  try {
    await f.render({ scope: 'settings/providers', settings: true });
    await act(async () => f.settingsFeedback.report('read', '配置读取失败'));
    expect(f.toast()?.textContent).toContain('配置读取失败');
    await act(async () => f.button('关闭提示').click());
    await f.render();
    await act(async () => f.settingsFeedback.report('read', '配置读取失败'));
    expect(f.toast()).toBeNull();
    await act(async () => {
      f.settingsFeedback.reset('read');
      f.settingsFeedback.report('read', '配置读取失败');
    });
    expect(f.toast()?.textContent).toContain('配置读取失败');
  } finally {
    await f.close();
  }
});
