import { expect, test } from 'bun:test';
import type { BackgroundExecutionSummary } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeSelection } from '../../src/native-bridge';
import { useNativeEnvironment } from '../../src/native-environment';
import { backgroundShellItem } from '../background-item.fixture';

const bootstrap = new JSDOM('<div/>');
const prior = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
Object.assign(globalThis, prior);
bootstrap.window.close();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const dom = new JSDOM('<div id="root"/>');
  const before = {
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
  const root = createRoot(dom.window.document.getElementById('root')!);
  const item = backgroundShellItem(1);
  let observation = 0,
    opens = 0,
    stops = 0,
    revision = 0,
    sessionId = 'root';
  let heldDirectory: ReturnType<typeof deferred> | undefined,
    heldStop: ReturnType<typeof deferred> | undefined;
  let unavailable = false,
    controlUnavailable = false,
    directoryFailed = false,
    empty = false;
  let stopObservation: number | undefined;
  let stopUnknown = false;
  let click!: () => void;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      if (request.method === 'background.open') {
        opens++;
        const id = ++observation,
          wait = heldDirectory;
        heldDirectory = undefined;
        if (wait) await wait.promise;
        if (directoryFailed) throw Error('fixture_environment_unavailable');
        return {
          kind: 'background.page',
          viewGeneration: 1,
          viewSelection: sessionId === 'root' ? 1 : 2,
          rootSessionId: sessionId,
          storeId: 'store',
          readId: request.readId,
          observationId: id,
          startIndex: 0,
          nextIndex: empty ? 0 : 1,
          total: empty ? 0 : 1,
          complete: true,
          entries: empty ? [] : [{ ...item, rootSession: { ...item.rootSession, id: sessionId } }],
        };
      }
      if (request.method === 'background.stop') {
        stops++;
        stopObservation = request.observationId;
        if (heldStop) await heldStop.promise;
        if (observation !== request.observationId) throw Error('background_stop_unavailable');
        return { id: request.commandId, status: stopUnknown ? 'unknown' : 'accepted' } as never;
      }
      return null;
    },
  };
  function Harness() {
    const environment = useNativeEnvironment({
      bridge,
      generation: 1,
      selection: {
        viewGeneration: 1,
        viewSelection: sessionId === 'root' ? 1 : 2,
        storeId: 'store',
        session: { ...item.rootSession, id: sessionId },
        runs: [],
        executions: [],
        interactions: [],
        interactionsAfterId: null,
        canReadModelOutput: false,
      } as NativeSelection,
      revision,
      unavailable,
      controlUnavailable,
      onChanged: async () => {},
    });
    // Retain the previously actionable event handler, exercising an event accepted
    // before React commits the pending-directory disabled state.
    const card = environment.card as React.ReactElement<{
      children: React.ReactElement<{
        onStop?: (row: BackgroundExecutionSummary) => void;
        busy?: boolean;
      }>[];
    }>;
    const handler = card?.props.children[0]?.props.onStop;
    if (handler && !card.props.children[0]?.props.busy)
      click = () =>
        handler({ executionId: item.execution.id, canStop: true } as BackgroundExecutionSummary);
    return environment.card;
  }
  return {
    host: dom.window.document,
    get opens() {
      return opens;
    },
    get stops() {
      return stops;
    },
    get stopObservation() {
      return stopObservation;
    },
    get observation() {
      return observation;
    },
    get text() {
      return dom.window.document.body.textContent;
    },
    click: () => click(),
    unknownStop() {
      stopUnknown = true;
    },
    holdDirectory() {
      heldDirectory = deferred();
      return heldDirectory;
    },
    holdStop() {
      heldStop = deferred();
      return heldStop;
    },
    unavailable(value: boolean) {
      unavailable = value;
    },
    controlUnavailable(value: boolean) {
      controlUnavailable = value;
    },
    failDirectory(value: boolean) {
      directoryFailed = value;
    },
    emptyDirectory() {
      empty = true;
    },
    async render(nextRoot = sessionId) {
      sessionId = nextRoot;
      revision++;
      await act(async () => root.render(<Harness />));
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, before);
    },
  };
}
test('routine environment refresh retains card text and controls while blocking writes; read failures recover silently', async () => {
  const f = fixture();
  let held: ReturnType<typeof deferred> | undefined;
  try {
    await f.render();
    const card = f.host.querySelector('[aria-label="环境信息"]')!;
    const text = card.textContent;
    const stop = card.querySelector<HTMLButtonElement>('.background-execution-stop')!;
    expect(stop).not.toBeNull();
    expect(stop.disabled).toBe(false);
    held = f.holdDirectory();
    await f.render();
    expect(f.host.querySelector('[aria-label="环境信息"]')).toBe(card);
    expect(card.textContent).toBe(text);
    expect(card.querySelector('.background-stale')).toBeNull();
    expect(card.querySelector('.background-execution-stop')).toBe(stop);
    expect(stop.disabled).toBe(true);
    await act(async () => stop.click());
    expect(f.stops).toBe(0);
    await f.render();
    expect(card.textContent).toBe(text);
    await act(async () => held!.resolve());
    expect(card.querySelector('.background-execution-stop')).toBe(stop);
    expect(stop.disabled).toBe(false);
    f.controlUnavailable(true);
    await f.render();
    expect(card.textContent).toBe(text);
    expect(card.querySelector('.background-execution-stop')).toBe(stop);
    expect(stop.disabled).toBe(true);
    f.controlUnavailable(false);
    f.failDirectory(true);
    await f.render();
    expect(card.textContent).not.toContain('上次状态 · 待核实');
    expect(card.textContent).not.toContain('fixture_environment_unavailable');
    expect(card.querySelector('.background-execution-stop')).toBeNull();
    f.unavailable(true);
    await f.render();
    expect(card.textContent).not.toContain('environment_unavailable');
    expect(f.stops).toBe(0);
  } finally {
    held?.resolve();
    await f.close();
  }
});

test('a verified empty environment does not insert loading text during a background refresh', async () => {
  const f = fixture();
  let held: ReturnType<typeof deferred> | undefined;
  try {
    f.emptyDirectory();
    await f.render();
    const card = f.host.querySelector('[aria-label="环境信息"]')!;
    const text = card.textContent;
    expect(card.querySelector('[aria-label="子智能体"]')?.textContent).toContain('暂无');
    held = f.holdDirectory();
    await f.render();
    expect(card.textContent).toBe(text);
    expect(card.textContent).not.toContain('正在读取');
    expect(card.querySelector('.background-stale')).toBeNull();
  } finally {
    held?.resolve();
    await f.close();
  }
});

test('same-scope directory revisions wait for exactly one accepted stop and resume afterwards', async () => {
  const f = fixture();
  let hold: ReturnType<typeof deferred> | undefined;
  try {
    await f.render();
    hold = f.holdStop();
    await act(async () => f.click());
    const opened = f.opens;
    await f.render();
    await f.render();
    expect(f.opens).toBe(opened);
    expect(f.stops).toBe(1);
    await act(async () => hold!.resolve());
    expect(f.text).not.toContain('停止请求已受理');
    expect(f.opens).toBe(opened + 1);
    expect(f.stops).toBe(1);
  } finally {
    hold?.resolve();
    await f.close();
  }
});
test('accepted stop waits for existing directory EOF and uses latest facts; navigation drops only an unsubmitted stop', async () => {
  for (const switchScope of [false, true]) {
    const f = fixture();
    let hold: ReturnType<typeof deferred> | undefined;
    try {
      await f.render();
      hold = f.holdDirectory();
      await f.render();
      await act(async () => f.click());
      expect(f.stops).toBe(0);
      if (switchScope) await f.render('other-root');
      else {
        await f.render();
        expect(f.opens).toBe(2);
      }
      await act(async () => hold!.resolve());
      expect(f.stops).toBe(switchScope ? 0 : 1);
      if (!switchScope) expect(f.stopObservation).toBe(2);
      else expect(f.opens).toBeGreaterThanOrEqual(3);
    } finally {
      hold?.resolve();
      await f.close();
    }
  }
});

test('unknown or already submitted stops are never replayed and scope switching resumes its own directory', async () => {
  for (const switchScope of [false, true]) {
    const f = fixture();
    let held: ReturnType<typeof deferred> | undefined;
    try {
      await f.render();
      f.unknownStop();
      held = f.holdStop();
      await act(async () => f.click());
      expect(f.stops).toBe(1);
      const opened = f.opens;
      if (switchScope) {
        await f.render('other-root');
        expect(f.opens).toBe(opened + 1);
      } else {
        await f.render();
        expect(f.opens).toBe(opened);
      }
      await act(async () => held!.resolve());
      expect(f.stops).toBe(1);
      if (!switchScope) expect(f.text).not.toContain('停止结果待核实');
      else expect(f.text).not.toContain('原停止申请');
      await f.render();
      expect(f.stops).toBe(1);
      expect(f.opens).toBeGreaterThan(opened);
    } finally {
      held?.resolve();
      await f.close();
    }
  }
});

test('an unavailable environment silently rechecks and recovers without another event or stop replay', async () => {
  const f = fixture();
  try {
    f.failDirectory(true);
    await f.render();
    expect(f.text).not.toContain('fixture_environment_unavailable');
    const failed = f.opens;
    f.failDirectory(false);
    const deadline = Date.now() + 2000;
    while (f.opens === failed && Date.now() < deadline)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    expect(f.opens).toBeGreaterThan(failed);
    expect(f.stops).toBe(0);
    expect(f.text).not.toContain('fixture_environment_unavailable');
    expect(f.host.querySelector('.background-stale')).toBeNull();
    const completed = f.opens;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(f.opens).toBe(completed);
  } finally {
    await f.close();
  }
});
