import { expect, test } from 'bun:test';
import type { Execution, Run, SelectedContextPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ContextPanel, ContextSubmissionNotice } from '../src';

test('DOM include freezes displayed Run, queued remains pending and missing accurate target disables', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const context = {
    selection: {
      id: 'selection-original',
      sessionId: 'original',
      previousSelectionId: null,
      boundaryMessageId: null,
      boundarySeq: '0',
      tailFromSeq: '0',
      ranges: [],
    },
    highWaterSeq: '0',
    snapshotCursor: '0',
    messages: [],
    resultSources: [],
    nextAfterSeq: null,
    nextAfterSourceId: null,
  } as SelectedContextPage;
  const execution = {
    id: 'job',
    originStoreId: 'original-store',
    sessionId: 'original',
    kind: 'job',
    status: 'succeeded',
    delivery: 'suppressed',
    resultRevision: '9',
    runId: 'old-run',
    definitionId: 'fixture.job',
    definitionVersion: '1',
    cancelRequestedAt: null,
    result: { content: 'original' },
  } as Execution;
  let saved: unknown;
  const render = (activeRun?: Run) =>
    root.render(
      <ContextPanel
        context={context}
        storeId="store"
        history={[execution]}
        busy
        activeRun={activeRun}
        onInclude={(_execution, scope) => {
          saved = scope;
        }}
      />,
    );
  try {
    await act(async () =>
      render({ id: 'run-original', sessionId: 'original', isActive: true } as Run),
    );
    expect(host.textContent).toContain('run-original');
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(saved).toEqual({
      storeId: 'store',
      sessionId: 'original',
      contextSelectionId: 'selection-original',
      targetRunId: 'run-original',
    });
    await act(async () => render());
    expect(host.querySelector('button')!.disabled).toBe(true);
    await act(async () =>
      root.render(
        <ContextSubmissionNotice
          submission={{ kind: 'include', commandId: 'saved-command', phase: 'queued' }}
        />,
      ),
    );
    expect(host.textContent).toContain('not yet included');
    expect(host.textContent).toContain('saved-command');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
