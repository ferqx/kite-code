import { expect, test } from 'bun:test';
import { type BackgroundExecutionItem, ClientError } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BackgroundExecutions } from '../../src/background';
import { installGlobals } from '../globals.fixture';

function item(): BackgroundExecutionItem {
  const session = {
    id: 's',
    workspaceId: 'w',
    parentSessionId: null,
    rootSessionId: 's',
    title: 'Parent',
    controlRevision: '1',
    contextSelectionId: 'selection',
    nextSeq: '0',
    deletedAt: null,
    ownerInstanceId: null,
    ownerGeneration: '0',
  };
  return {
    seq: '9007199254740993',
    session,
    rootSession: session,
    run: null,
    childRun: null,
    childSession: { ...session, id: 'child', title: 'Child task', parentSessionId: 's' },
    execution: {
      id: 'job',
      sessionId: 's',
      rootSessionId: 's',
      runId: null,
      originCommandId: 'work',
      originStoreId: 'origin',
      rootWorkCommandId: 'work',
      rootWorkSeq: '1',
      parentExecutionId: null,
      childSessionId: 'child',
      cancelWithParent: false,
      stepId: 'step',
      callId: 'call',
      attempt: 1,
      kind: 'job',
      definitionId: 'agent/child',
      definitionVersion: '1',
      status: 'succeeded',
      ownerGeneration: '1',
      cancelRequested: false,
      cancelRequestedAt: null,
      resultRevision: '2',
      delivery: 'pending',
      deliveryReason: null,
      deliveryTargetSessionId: 's',
      contextSelectionId: 'selection',
    },
  };
}

test('background UI uses exact metadata, opens original child, reads full saved output and retains stale metadata without granting controls', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreGlobals = installGlobals({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const opened: string[] = [],
    calls: string[] = [],
    signals: AbortSignal[] = [];
  let outputHold: Promise<void> | undefined,
    releaseOutput = () => {};
  let fail = false,
    hold: Promise<void> | undefined,
    release = () => {};
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['sessions', 'execution_output'] },
    async listAllBackgroundExecutions(options: { rootSessionId: string; signal: AbortSignal }) {
      calls.push(options.rootSessionId);
      signals.push(options.signal);
      const held = hold;
      if (held) await held;
      if (fail) throw new ClientError('offline');
      return [item()];
    },
    async listExecutionOutput(
      sessionId: string,
      executionId: string,
      options: { afterSeq: string; upperSeq?: string; signal: AbortSignal },
    ) {
      expect(sessionId).toBe('s');
      expect(executionId).toBe('job');
      calls.push(`output:${options.afterSeq}`);
      signals.push(options.signal);
      if (outputHold) await outputHold;
      return options.afterSeq === '0'
        ? {
            highWaterSeq: '2',
            items: [
              {
                executionId: 'job',
                seq: '1',
                throughSeq: '1',
                stream: 'stdout',
                content: 'first',
                droppedBytes: '0',
              },
            ],
          }
        : {
            highWaterSeq: '9',
            items: [
              {
                executionId: 'job',
                seq: '2',
                throughSeq: '2',
                stream: 'stderr',
                content: 'tail β',
                droppedBytes: '0',
              },
            ],
          };
    },
  } as unknown as BrowserClient;
  const view = (sessionId: string) => ({
    storeId: 'store',
    session: { ...item().session, id: sessionId },
    runs: [],
    executions: [],
  });
  async function render(sessionId = 's', suspended = false) {
    await act(async () => {
      root.render(
        <BackgroundExecutions
          key={sessionId}
          client={client}
          view={view(sessionId) as never}
          window={dom.window as unknown as Window}
          suspended={suspended}
          onOpen={(id) => opened.push(id)}
        />,
      );
      await Bun.sleep(0);
    });
  }
  async function click(text: string) {
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLElement>('button,a')]
        .find((element) => element.textContent === text)!
        .click();
      await Bun.sleep(0);
    });
  }
  try {
    await render();
    const text = () => dom.window.document.body.textContent!;
    expect(text()).toContain('Origin Store origin');
    expect(text()).toContain('Directory cursor 9007199254740993');
    expect(text()).toContain('Cleanup confirmation unavailable');
    expect(text()).not.toContain('清理已确认');
    expect(dom.window.document.querySelector('a')!.getAttribute('href')).toBe('/sessions/child');
    await click('Open child Session Child task');
    expect(opened).toEqual(['child']);
    await click('Read background output job');
    expect(text()).toContain('Complete saved output through 2');
    expect(text()).toContain('tail β');
    expect(calls).toContain('output:1');
    await click('Close background output job');
    outputHold = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    await click('Read background output job');
    const outputSignal = signals.at(-1)!;
    Object.defineProperty(dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      await Bun.sleep(0);
    });
    expect(outputSignal.aborted).toBe(true);
    releaseOutput();
    outputHold = undefined;
    Object.defineProperty(dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      await Bun.sleep(0);
    });
    expect(text()).not.toContain('tail β');

    fail = true;
    await click('Refresh background executions');
    expect(text()).toContain('Stale · Last known background metadata');
    expect(text()).toContain('Execution job');
    fail = false;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await click('Refresh background executions');
    const pending = signals.at(-1)!;
    await render('other', true);
    expect(pending.aborted).toBe(true);
    release();
    await act(async () => {
      await Bun.sleep(0);
    });
    expect(text()).not.toContain('Execution job');
    expect(text()).not.toContain('tail β');
    expect(
      [...dom.window.document.querySelectorAll('button')].some((button) =>
        /stop|cancel|approve|引导/i.test(button.textContent!),
      ),
    ).toBe(false);
  } finally {
    release();
    releaseOutput();
    await act(async () => root.unmount());
    dom.window.close();
    restoreGlobals();
  }
});
