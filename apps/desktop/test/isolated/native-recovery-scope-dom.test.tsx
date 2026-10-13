import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeRecoveryFacts,
  NativeRecoverySubmission,
  NativeRequest,
  NativeResult,
  NativeSelection,
} from '../../src/native-bridge';
import { NativeRecoveryView } from '../../src/native-recovery';

function fixture(prepare: (request: NativeRequest) => Promise<NativeResult>) {
  const dom = new JSDOM('<div id="root"></div>'),
    globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean },
    prior = {
      window: globals.window,
      document: globals.document,
      navigator: globals.navigator,
      IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    };
  Object.assign(globals, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!),
    calls: NativeRequest[] = [],
    saved: NativeRecoverySubmission = {
      observationId: 7,
      storeId: 'store',
      sessionId: 'a',
      kind: 'run',
      targetId: 'original-run',
      originalCommandId: 'original-work',
      commandId: 'saved-recovery',
      phase: 'outcome_unknown',
    };
  let refreshes = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      calls.push(request);
      if (request.method === 'recovery.prepare') return prepare(request);
      return null;
    },
  };
  const render = (sessionId: string) =>
    act(async () => {
      root.render(
        <NativeRecoveryView
          bridge={bridge}
          generation={1}
          selection={
            {
              storeId: 'store',
              viewGeneration: sessionId === 'a' ? 1 : 2,
              viewSelection: sessionId === 'a' ? 1 : 2,
              canReadModelOutput: false,
              session: {
                id: sessionId,
                rootSessionId: sessionId,
                parentSessionId: null,
                workspaceId: 'w',
                title: sessionId,
                controlRevision: '0',
                contextSelectionId: `context-${sessionId}`,
                nextSeq: '0',
                deletedAt: null,
              },
              runs: [],
              executions: [],
              interactions: [],
              interactionsAfterId: null,
            } satisfies NativeSelection
          }
          submissions={[saved]}
          onRefresh={async () => {
            refreshes++;
          }}
        />,
      );
    });
  const chooseInterrupt = () =>
    act(async () => {
      const select = dom.window.document.querySelector('select')!;
      select.value = 'interrupt';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  const clickPrepare = () =>
    act(async () => {
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (element) => element.textContent === 'Prepare original recovery',
      )!;
      expect(button.disabled).toBe(false);
      button.click();
    });
  return {
    dom,
    calls,
    saved,
    render,
    chooseInterrupt,
    clickPrepare,
    refreshes: () => refreshes,
    close: async () => {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
      Object.assign(globals, prior);
    },
  };
}

test('Native recovery clears an original Session error on selection while retaining saved originals and current failures', async () => {
  let code = 'original_a_prepare_failed';
  const f = fixture(async () => {
    throw Object.assign(new Error(code), { code });
  });
  try {
    await f.render('a');
    await f.chooseInterrupt();
    await f.clickPrepare();
    expect(f.dom.window.document.querySelector('[role="alert"]')?.textContent).toBe(code);
    await f.render('b');
    expect(Boolean(f.dom.window.document.querySelector('[role="alert"]'))).toBe(false);
    expect(f.dom.window.document.body.textContent).toContain('Original Session b');
    expect(f.dom.window.document.body.textContent).toContain('saved-recovery');
    expect(f.dom.window.document.body.textContent).toContain('original Session a');
    code = 'current_b_prepare_failed';
    await f.clickPrepare();
    expect(f.dom.window.document.querySelector('[role="alert"]')?.textContent).toBe(code);
    expect(f.calls.filter((request) => request.method === 'recovery.prepare')).toHaveLength(2);
    expect(
      f.calls.filter((request) => !['recovery.prepare', 'recovery.close'].includes(request.method)),
    ).toEqual([]);
    expect(f.saved.phase).toBe('outcome_unknown');
  } finally {
    await f.close();
  }
});

test('Native recovery selection closes only its held original read and rejects a late observation without mutation', async () => {
  let release!: (value: NativeRecoveryFacts) => void;
  const held = new Promise<NativeRecoveryFacts>((resolve) => {
      release = resolve;
    }),
    facts: NativeRecoveryFacts = {
      observationId: 9,
      storeId: 'store',
      sessionId: 'a',
      kind: 'interrupt',
    },
    f = fixture(() => held);
  try {
    await f.render('a');
    await f.chooseInterrupt();
    await f.clickPrepare();
    const original = f.calls.find((request) => request.method === 'recovery.prepare')!;
    expect(original.method).toBe('recovery.prepare');
    await f.render('b');
    const closed = f.calls.filter((request) => request.method === 'recovery.close');
    expect(closed.length).toBeGreaterThan(0);
    expect(
      closed.every(
        (request) =>
          request.generation === 1 &&
          request.readId === ('readId' in original ? original.readId : ''),
      ),
    ).toBe(true);
    await act(async () => {
      release(facts);
      await held;
    });
    expect(f.dom.window.document.body.textContent).not.toContain('Verified original');
    expect(Boolean(f.dom.window.document.querySelector('[role="alert"]'))).toBe(false);
    expect(f.dom.window.document.body.textContent).toContain('saved-recovery');
    expect(f.refreshes()).toBe(0);
    expect(
      f.calls.filter((request) => !['recovery.prepare', 'recovery.close'].includes(request.method)),
    ).toEqual([]);
    expect(f.saved.phase).toBe('outcome_unknown');
  } finally {
    await act(async () => {
      release(facts);
      await held;
    });
    await f.close();
  }
});
