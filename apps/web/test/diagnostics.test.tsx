import { expect, test } from 'bun:test';
import { type BrowserView, ClientError, type SelectedContextPage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { type DiagnosticPort, Diagnostics, readContext, readOutput } from '../src/diagnostics';

function view(sessionId = 'session', selectionId = 'selection'): BrowserView {
  return {
    storeId: 'store',
    snapshotCursor: '1',
    session: {
      id: sessionId,
      workspaceId: 'workspace',
      parentSessionId: null,
      title: 'Title',
      controlRevision: '1',
      contextSelectionId: selectionId,
      nextSeq: '9',
      deletedAt: null,
    },
    runs: [],
    executions: ['job1', 'job2'].map((id) => ({
      id,
      sessionId,
      runId: null,
      kind: 'job',
      definitionId: 'neutral.job',
      definitionVersion: '1',
      status: 'running',
      resultRevision: '0',
      cancelRequestedAt: null,
    })),
  };
}
function page(
  messages: number[],
  sources: string[],
  nextMessage: string | null = null,
  nextSource: string | null = null,
): SelectedContextPage {
  return {
    selection: {
      id: 'selection',
      sessionId: 'session',
      previousSelectionId: null,
      boundaryMessageId: null,
      boundarySeq: '0',
      tailFromSeq: '1',
      ranges: [],
    },
    highWaterSeq: '9',
    snapshotCursor: '1',
    messages: messages.map((seq) => ({
      id: `message${seq}`,
      sessionId: 'session',
      runId: null,
      seq: String(seq),
      status: 'complete',
      role: 'user',
      content: `Full message ${seq}`,
    })),
    resultSources: sources.map((id) => ({
      id,
      seq: '1',
      sessionId: 'session',
      createdSelectionId: 'original',
      executionId: 'original-job',
      resultRevision: '1',
      originStoreId: 'store',
      inclusion: 'explicit',
      result: { full: 'result' },
    })),
    nextAfterSeq: nextMessage,
    nextAfterSourceId: nextSource,
  };
}
function port(overrides: Partial<DiagnosticPort> = {}): DiagnosticPort {
  return {
    serverInfo: {
      storeId: 'store',
      instanceId: 'instance',
      buildId: 'build',
      pageIdentity: 'a'.repeat(64),
      dataAvailability: 'available',
      capabilities: ['context', 'execution_output'],
    },
    async getContext() {
      return page([1], ['source1']);
    },
    async listExecutionOutput(_session, id) {
      return {
        highWaterSeq: '1',
        items: [
          {
            executionId: id,
            seq: '1',
            throughSeq: '1',
            stream: 'stderr',
            content: 'Complete error output',
            droppedBytes: '0',
          },
        ],
      };
    },
    ...overrides,
  };
}

test('context reads both finite cursors independently and never restarts the ended stream', async () => {
  const requests: unknown[] = [];
  const client = port({
    async getContext(_session, query) {
      requests.push(query);
      return requests.length === 1 ? page([1], ['source1'], '1', null) : page([2], [], null, null);
    },
  });
  const result = await readContext(client, view(), new AbortController().signal);
  expect(result.messages.map((m) => m.seq)).toEqual(['1', '2']);
  expect(result.resultSources.map((s) => s.id)).toEqual(['source1']);
  expect(requests[1]).toMatchObject({
    contextSelectionId: 'selection',
    upperSeq: '9',
    afterSeq: '1',
    afterSourceId: 'source1',
  });
  expect(result.nextAfterSeq).toBeNull();
  expect(result.nextAfterSourceId).toBeNull();
  const other: unknown[] = [];
  await readContext(
    port({
      async getContext(_session, query) {
        other.push(query);
        return other.length === 1 ? page([1], ['source1'], null, 'source1') : page([], ['source2']);
      },
    }),
    view(),
    new AbortController().signal,
  );
  expect(other[1]).toMatchObject({ afterSeq: '9', upperSeq: '9', afterSourceId: 'source1' });
});

test('context and source Session scope, frozen selection/highwater and non-progress conflict never produce a partial snapshot', async () => {
  for (const mutate of [
    (p: SelectedContextPage) => {
      p.selection.sessionId = 'foreign';
    },
    (p: SelectedContextPage) => {
      p.resultSources[0]!.sessionId = 'foreign';
    },
    (p: SelectedContextPage) => {
      p.nextAfterSeq = '0';
    },
  ]) {
    const bad = page([1], ['source1']);
    mutate(bad);
    await expect(
      readContext(
        port({
          async getContext() {
            return bad;
          },
        }),
        view(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('diagnostic_page_conflict');
  }
  let calls = 0;
  await expect(
    readContext(
      port({
        async getContext() {
          calls++;
          const p = calls === 1 ? page([1], ['source1'], '1', null) : page([2], []);
          if (calls === 2) p.highWaterSeq = '10';
          return p;
        },
      }),
      view(),
      new AbortController().signal,
    ),
  ).rejects.toThrow('diagnostic_page_conflict');
  expect(calls).toBe(2);
});

test('exact Job output freezes Decimal64 upper and preserves stderr/progress plus clipped NULL gap without reclassification', async () => {
  const queries: unknown[] = [];
  const client = port({
    async listExecutionOutput(_session, id, query) {
      queries.push(query);
      return queries.length === 1
        ? {
            highWaterSeq: '9007199254740995',
            items: [
              {
                executionId: id,
                seq: '1',
                throughSeq: '9007199254740992',
                stream: 'stdout',
                content: '',
                droppedBytes: '9007199254740992',
              },
              {
                executionId: id,
                seq: '9007199254740993',
                throughSeq: '9007199254740993',
                stream: 'stderr',
                content: 'stderr complete',
                droppedBytes: '0',
              },
            ],
          }
        : {
            highWaterSeq: '9007199254741000',
            items: [
              {
                executionId: id,
                seq: '9007199254740994',
                throughSeq: '9007199254740995',
                stream: 'progress',
                content: '',
                droppedBytes: null,
              },
            ],
          };
    },
  });
  const result = await readOutput(client, view(), 'job1', new AbortController().signal);
  expect(result.highWaterSeq).toBe('9007199254740995');
  expect(result.items[2]).toMatchObject({
    throughSeq: '9007199254740995',
    stream: 'progress',
    droppedBytes: null,
  });
  expect(queries[1]).toMatchObject({ upperSeq: '9007199254740995', afterSeq: '9007199254740993' });
  await expect(readOutput(client, view(), 'foreign', new AbortController().signal)).rejects.toThrow(
    'job_not_in_selected_view',
  );
  expect(queries).toHaveLength(2);
  await expect(
    readOutput(
      port({
        async listExecutionOutput() {
          return {
            highWaterSeq: '2',
            items: [
              {
                executionId: 'foreign',
                seq: '1',
                throughSeq: '2',
                stream: 'stdout',
                content: '',
                droppedBytes: '3',
              },
            ],
          };
        },
      }),
      view(),
      'job1',
      new AbortController().signal,
    ),
  ).rejects.toThrow('diagnostic_page_conflict');
});

test('output missing intervals, overlapping pages and premature EOF reject instead of claiming a full frozen result', async () => {
  for (const items of [
    [],
    [
      {
        executionId: 'job1',
        seq: '2',
        throughSeq: '2',
        stream: 'stderr' as const,
        content: 'missing first interval',
        droppedBytes: '0',
      },
    ],
    [
      {
        executionId: 'job1',
        seq: '1',
        throughSeq: '2',
        stream: 'stdout' as const,
        content: '',
        droppedBytes: '7',
      },
      {
        executionId: 'job1',
        seq: '2',
        throughSeq: '2',
        stream: 'stdout' as const,
        content: 'overlap',
        droppedBytes: '0',
      },
    ],
  ]) {
    await expect(
      readOutput(
        port({
          async listExecutionOutput() {
            return { items, highWaterSeq: '2' };
          },
        }),
        view(),
        'job1',
        new AbortController().signal,
      ),
    ).rejects.toThrow('diagnostic_page_conflict');
  }
});

async function domFixture(client: DiagnosticPort) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  async function render(v = view()) {
    await act(async () =>
      root.render(
        <Diagnostics client={client} view={v} window={dom.window as unknown as Window} />,
      ),
    );
  }
  await render();
  function button(text: string) {
    return [...dom.window.document.querySelectorAll('button')].find(
      (item) => item.textContent === text,
    )!;
  }
  async function click(text: string) {
    await act(async () =>
      button(text).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    );
  }
  return {
    dom,
    render,
    button,
    click,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, old] of originals) {
        if (old) Object.defineProperty(globalThis, key, old);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('DOM explicit Context/Job reads, same-target stale, local capabilities and no diagnostic polling', async () => {
  let calls = 0,
    fail = false,
    outputFail = false;
  const f = await domFixture(
    port({
      async getContext() {
        calls++;
        if (fail) throw new ClientError('context_selection_changed');
        return page([1], ['source1']);
      },
      async listExecutionOutput(session, id, input) {
        if (outputFail) throw new ClientError('output_read_unavailable');
        return port().listExecutionOutput(session, id, input);
      },
    }),
  );
  try {
    expect(calls).toBe(0);
    await f.click('Read current selected context');
    expect(f.dom.window.document.body.textContent).toContain(
      'not any Model actual input inspector',
    );
    expect(f.dom.window.document.body.textContent).toContain('Full message 1');
    expect(f.dom.window.document.body.textContent).toContain('original-job');
    fail = true;
    await f.click('Refresh diagnostic');
    expect(f.dom.window.document.body.textContent).toContain(
      'stale · Last known same-target snapshot',
    );
    expect(f.dom.window.document.body.textContent).toContain('Full message 1');
    await f.click('Read Job output job1');
    expect(f.dom.window.document.body.textContent).not.toContain('Full message 1');
    expect(f.dom.window.document.body.textContent).toContain('stderr');
    expect(f.dom.window.document.body.textContent).toContain('Complete error output');
    outputFail = true;
    await f.click('Refresh diagnostic');
    expect(f.dom.window.document.body.textContent).toContain('Last known same-target snapshot');
    expect(f.dom.window.document.body.textContent).toContain('Complete error output');
    await f.click('Read Job output job2');
    expect(f.dom.window.document.body.textContent).not.toContain('Complete error output');
    expect(f.dom.window.document.body.textContent).toContain('output_read_unavailable');
    await f.click('Close diagnostic');
    expect(f.dom.window.document.body.textContent).not.toContain('Complete error output');
    await act(async () => {
      await Bun.sleep(25);
    });
    expect(calls).toBe(2);
  } finally {
    await f.close();
  }
  const missing = await domFixture(
    port({
      serverInfo: { ...port().serverInfo!, capabilities: [] },
      async getContext() {
        throw new Error('must not call');
      },
    }),
  );
  try {
    expect(missing.button('Read current selected context').disabled).toBe(true);
    expect(missing.button('Read Job output job1').disabled).toBe(true);
  } finally {
    await missing.close();
  }
});

test('DOM singleflight, hide/close/selection abort owned reads and late response never moves across targets', async () => {
  let resolve!: (value: SelectedContextPage) => void;
  let signal: AbortSignal | undefined,
    calls = 0;
  const held = new Promise<SelectedContextPage>((done) => {
    resolve = done;
  });
  const f = await domFixture(
    port({
      async getContext(_session, _input, options) {
        calls++;
        signal = options?.signal;
        return held;
      },
    }),
  );
  try {
    await f.click('Read current selected context');
    await f.click('Refresh diagnostic');
    expect(calls).toBe(1);
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    expect(signal?.aborted).toBe(true);
    expect(f.dom.window.document.body.textContent).toContain('diagnostic_hidden');
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await f.click('Read Job output job2');
    await act(async () => resolve(page([1], ['source1'])));
    expect(f.dom.window.document.body.textContent).not.toContain('Full message 1');
    expect(f.dom.window.document.body.textContent).toContain('Job output job2');
    await f.render(view('new-session', 'new-selection'));
    expect(f.dom.window.document.body.textContent).not.toContain('Complete error output');
    expect(f.dom.window.document.querySelector('.diagnostic-panel')).toBeNull();
  } finally {
    resolve(page([], []));
    await f.close();
  }
});

test('close and changed selection abort owned Context reads, old Store/capability admission calls zero ports', async () => {
  const signals: AbortSignal[] = [];
  const completions: Array<(value: SelectedContextPage) => void> = [];
  const f = await domFixture(
    port({
      async getContext(_session, _input, options) {
        signals.push(options!.signal!);
        return new Promise<SelectedContextPage>((resolve) => completions.push(resolve));
      },
    }),
  );
  try {
    await f.click('Read current selected context');
    await f.click('Close diagnostic');
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => completions[0]!(page([1], ['source1'])));
    expect(f.dom.window.document.querySelector('.diagnostic-panel')).toBeNull();
    await f.click('Read current selected context');
    await f.render(view('session', 'changed-selection'));
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => completions[1]!(page([1], ['source1'])));
    expect(f.dom.window.document.body.textContent).not.toContain('Full message 1');
  } finally {
    for (const done of completions) done(page([], []));
    await f.close();
  }
  let calls = 0;
  const client = port({
    async getContext() {
      calls++;
      return page([], []);
    },
  });
  const old = view();
  old.storeId = 'old-store';
  await expect(readContext(client, old, new AbortController().signal)).rejects.toThrow(
    'browser_identity_mismatch',
  );
  await expect(
    readContext(
      port({ ...client, serverInfo: { ...client.serverInfo!, capabilities: [] } }),
      view(),
      new AbortController().signal,
    ),
  ).rejects.toThrow('capability_unavailable');
  expect(calls).toBe(0);
});

test('coalesced cross-stream gaps retain both facts and next cursor uses maximum throughSeq, not the last sorted row', async () => {
  const queries: unknown[] = [];
  const result = await readOutput(
    port({
      async listExecutionOutput(_session, id, query) {
        queries.push(query);
        return queries.length === 1
          ? {
              highWaterSeq: '203',
              items: Array.from({ length: 200 }, (_, index) => ({
                executionId: id,
                seq: String(index + 1),
                throughSeq: String(index + 1),
                stream: 'stdout' as const,
                content: `chunk${index + 1}`,
                droppedBytes: '0',
              })),
            }
          : {
              highWaterSeq: '203',
              items: [
                {
                  executionId: id,
                  seq: '201',
                  throughSeq: '203',
                  stream: 'stdout',
                  content: '',
                  droppedBytes: null,
                },
                {
                  executionId: id,
                  seq: '202',
                  throughSeq: '202',
                  stream: 'stderr',
                  content: '',
                  droppedBytes: '12',
                },
              ],
            };
      },
    }),
    view(),
    'job1',
    new AbortController().signal,
  );
  expect(queries).toHaveLength(2);
  expect(queries[1]).toMatchObject({ afterSeq: '200', upperSeq: '203' });
  expect(result.items).toHaveLength(202);
  expect(result.items.at(-2)).toMatchObject({ throughSeq: '203', droppedBytes: null });
  expect(result.items.at(-1)).toMatchObject({ throughSeq: '202', droppedBytes: '12' });
});

test('DOM preserves normal other-stream content inside a gap and overlapping cross-stream gaps without hiding any fact', async () => {
  const f = await domFixture(
    port({
      async listExecutionOutput(_session, id) {
        return {
          highWaterSeq: '4',
          items: [
            {
              executionId: id,
              seq: '1',
              throughSeq: '3',
              stream: 'stdout',
              content: '',
              droppedBytes: null,
            },
            {
              executionId: id,
              seq: '2',
              throughSeq: '2',
              stream: 'stderr',
              content: 'Retained original stderr inside stdout gap',
              droppedBytes: '0',
            },
            {
              executionId: id,
              seq: '3',
              throughSeq: '3',
              stream: 'progress',
              content: '',
              droppedBytes: '7',
            },
            {
              executionId: id,
              seq: '4',
              throughSeq: '4',
              stream: 'stderr',
              content: 'Original stderr tail',
              droppedBytes: '0',
            },
          ],
        };
      },
    }),
  );
  try {
    await f.click('Read Job output job1');
    const panel = f.dom.window.document.querySelector('[aria-label="Job output chunks"]')!;
    expect(panel.querySelectorAll('article')).toHaveLength(4);
    expect(panel.textContent).toContain('Retained original stderr inside stdout gap');
    expect(panel.textContent).toContain('Original stderr tail');
    expect(panel.textContent).toContain('byte count unavailable / clipped interval');
    expect(panel.textContent).toContain('7 bytes');
    expect(f.dom.window.document.body.textContent).not.toContain('diagnostic_page_conflict');
  } finally {
    await f.close();
  }
});

test('restored context keeps complete original Store sources across independent pages', async () => {
  const first = page([1], ['source1'], null, 'source1'),
    last = page([], ['source2']);
  const sources = [...first.resultSources, ...last.resultSources];
  for (const source of sources) {
    source.originStoreId = 'original-store';
    source.result = {
      outcome: 'succeeded',
      content: `完整原结果 ${source.id} 雪🙂`,
      details: { original: source.id },
    };
  }
  const queries: unknown[] = [];
  const result = await readContext(
    port({
      async getContext(_session, query) {
        queries.push(query);
        return queries.length === 1 ? first : last;
      },
    }),
    view(),
    new AbortController().signal,
  );
  expect(result.resultSources).toEqual(sources);
  expect(result.messages).toEqual(first.messages);
  expect(result.nextAfterSeq).toBeNull();
  expect(result.nextAfterSourceId).toBeNull();
  expect(queries).toHaveLength(2);
  expect(queries[1]).toMatchObject({
    contextSelectionId: 'selection',
    upperSeq: '9',
    afterSeq: '9',
    afterSourceId: 'source1',
  });
});
