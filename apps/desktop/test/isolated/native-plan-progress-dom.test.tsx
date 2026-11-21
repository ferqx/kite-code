import { expect, test } from 'bun:test';
import { PlanExecutionProgress } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { NativePlanHistory, useNativePlanProgress } from '../../src/native-plan-progress';
import type {
  NativePlanProgress,
  NativePlanProgressResult,
} from '../../src/native-plan-progress-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('plan progress retains verified steps during interruption and retires after history is shown', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restore = prepareDesktopDom(dom);
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, globals);
  const root = createRoot(document.getElementById('root')!);
  const plan: NativePlanProgress = {
    planId: 'p',
    digest: 'digest',
    version: 1,
    reviewExecutionId: 'original-review',
    title: '原计划',
    steps: [{ id: 'one', title: '核对内容', status: 'running' }],
  };
  const terminal = { ...plan, steps: [{ ...plan.steps[0]!, status: 'failed' as const }] };
  let live: (() => void) | undefined;
  let historical: (() => void) | undefined;
  const bridge = {
    async request(request: NativeRequest) {
      if (request.method !== 'planning.progress') throw Error('wrong request');
      const result: NativePlanProgressResult = {
        kind: 'planning.progress',
        storeId: 'store',
        sessionId: 'session',
        runId: request.runId,
        plans: [request.history ? terminal : plan],
      };
      return new Promise<NativePlanProgressResult>((resolve) => {
        if (request.history) historical = () => resolve(result);
        else live = () => resolve(result);
      });
    },
  } as NativeBridge;
  const selection = (id: string) =>
    ({
      storeId: 'store',
      session: { id },
      viewSelection: 1,
    }) as NativeSelection;
  type View = {
    sessionId?: string;
    revision?: string;
    connected?: boolean;
    historyEpoch?: number;
    waiting?: boolean;
    ended?: boolean;
    visible?: boolean;
  };
  let locations = 0;
  const locate = () => {
    locations++;
  };
  function Harness({
    sessionId = 'session',
    revision = 'start',
    connected = true,
    historyEpoch = 0,
    waiting = false,
    ended = false,
    visible = true,
  }: View) {
    const model = useNativePlanProgress({
      bridge,
      generation: 1,
      selection: selection(sessionId),
      historyEpoch,
      available: connected,
      unconfirmed: !connected,
      activeRun: ended || sessionId !== 'session' ? undefined : { id: 'run', revision },
      waitingForReview: waiting,
    });
    return (
      <>
        {model.active && (
          <PlanExecutionProgress
            {...model.active}
            open={model.open}
            onOpenChange={model.setOpen}
            onLocate={locate}
          />
        )}
        {ended && (
          <NativePlanHistory
            runId="run"
            outcome="failed"
            read={model.read}
            onReady={model.settle}
            onLocate={locate}
          />
        )}
        <button type="button" onClick={() => model.onEnvironmentVisibilityChange(visible)}>
          切换环境卡
        </button>
      </>
    );
  }
  const render = (view: View) => act(async () => root.render(<Harness {...view} />));
  const progress = () => document.querySelector<HTMLButtonElement>('.native-plan-progress-toggle');
  const list = () => document.querySelector('.native-plan-steps');
  try {
    await render({});
    await act(async () => live?.());
    expect(progress()?.textContent).toContain('进行中');
    const title = document.querySelector<HTMLButtonElement>('.native-plan-locate');
    expect(title?.parentElement).toBe(progress()?.parentElement ?? null);
    expect(progress()?.getAttribute('aria-label')).toBe(
      '展开计划步骤，已完成 0/1，进行中 · 核对内容',
    );
    await act(async () => title?.click());
    expect(locations).toBe(1);
    expect(progress()?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => progress()?.click());
    expect(locations).toBe(1);
    expect(list()?.querySelector('li')?.dataset.status).toBe('running');

    await render({ connected: false });
    expect(progress()?.textContent).toContain('状态待核实');
    expect(list()?.querySelector('li')?.dataset.status).toBe('running');
    await render({ revision: 'late', historyEpoch: 1 });
    expect(progress()?.textContent).toContain('状态待核实');
    const late = live;
    await render({ sessionId: 'another' });
    await act(async () => late?.());
    expect(progress()).toBeNull();

    await render({ waiting: true });
    expect(progress()).toBeNull();
    await render({});
    await act(async () => live?.());
    if (!list()) await act(async () => progress()?.click());
    await render({ ended: true, visible: false });
    expect(progress()?.textContent).toContain('进行中');
    expect(document.querySelector('.native-plan-history')).toBeNull();
    await act(async () => historical?.());
    expect(progress()?.textContent).toContain('本轮异常结束');
    expect(list()?.querySelector('li')?.dataset.status).toBe('failed');
    expect(document.querySelector('.native-plan-history')?.textContent).toContain('查看执行步骤');
    await act(async () => document.querySelector<HTMLButtonElement>('button:last-child')?.click());
    expect(progress()).toBeNull();
    expect(document.querySelector('.native-plan-history')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    restore();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
