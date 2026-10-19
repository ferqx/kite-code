import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { useNativeCacheMetrics } from '../../src/native-cache-metrics';
import { NativeDisplayCache } from '../../src/native-display-cache';
import type { NativeModelUsagePage } from '../../src/tool-messages-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const layout = prepareDesktopDom(dom),
    previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    dom,
    host,
    root,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      layout();
      Object.assign(globalThis, previous);
    },
  };
}
const selection = (id = 's', viewSelection = 2) =>
  ({
    storeId: 'store',
    session: { id, workspaceId: 'w' },
    viewSelection,
  }) as NativeSelection;
const message = (id: string, sessionId = 's'): Message => ({
  id,
  sessionId,
  seq: '1',
  runId: `run-${id}`,
  role: 'assistant',
  status: 'complete',
  content: `original ${id}`,
  sourceIds: [`model-${id}`],
});
type UsageRequest = Extract<NativeRequest, { method: 'toolMessages.usage' }>;
function pageFor(
  request: UsageRequest,
  sessionId: string,
  entries: NativeModelUsagePage['entries'],
): NativeModelUsagePage {
  return {
    kind: 'toolMessages.usage',
    readId: request.readId,
    scope: {
      generation: request.generation,
      storeId: 'store',
      sessionId,
      workspaceId: 'w',
      viewSelection: request.viewSelection,
      historyEpoch: request.historyEpoch,
    },
    entries,
  };
}
function Harness({
  bridge,
  selected,
  messages,
  complete = true,
  revision = 0,
  generation = 1,
  historyEpoch = 0,
  suspended = false,
}: {
  bridge: NativeBridge;
  selected: NativeSelection;
  messages: Message[];
  complete?: boolean;
  revision?: number;
  generation?: number;
  historyEpoch?: number;
  suspended?: boolean;
}) {
  const facts = useNativeCacheMetrics({
    bridge,
    generation,
    selection: selected,
    historyEpoch,
    messages,
    historyComplete: complete,
    observationRevision: revision,
    suspended,
  });
  return (
    <>
      <SessionPage
        workspaces={[]}
        sessionLabel={selected.session.id}
        readingKey={selected.session.id}
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        messages={[]}
        composer={{
          draft: '',
          onChange: () => {},
          active: false,
          stopping: false,
          disabled: false,
          cacheMetrics: facts.metrics,
        }}
      />
      {facts.error && <p role="alert">{facts.error}</p>}
      <button type="button" onClick={facts.retry}>
        重新读取缓存指标
      </button>
    </>
  );
}

test('the original Composer displays cumulative observed usage once per Model, retains confirmed samples during calibration and distinguishes no sample from a real zero hit rate', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  const values = Array.from({ length: 35 }, (_, index) => message(`usage-${index}`));
  values.push({
    ...values[0]!,
    id: 'alias',
    runId: null,
    originMessage: {
      storeId: 'store',
      sessionId: 's',
      messageId: values[0]!.id,
      runId: values[0]!.runId ?? null,
    },
  });
  const observed = new Map([
    ['model-usage-0', [40, 60]],
    ['model-usage-1', [160, 40]],
    ['model-usage-2', [0, 100]],
    ['model-zero', [0, 100]],
  ]);
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.usage') return null;
      const sessionId =
        request.viewSelection === 2 ? 's' : request.viewSelection === 3 ? 'empty' : 'zero';
      const entries = request.messageIds.flatMap((id) => {
        const executionId = id === 'alias' ? 'model-usage-0' : `model-${id}`;
        const sample = observed.get(executionId);
        return sample
          ? [
              {
                messageId: id,
                executionId,
                originStoreId: 'store',
                cacheHitTokens: sample[0]!,
                cacheMissTokens: sample[1]!,
              },
            ]
          : [];
      });
      return pageFor(request, sessionId, entries);
    },
  } as NativeBridge;
  const render = (messages = values, selected = selection(), complete = true) =>
    act(async () =>
      f.root.render(
        <Harness bridge={bridge} selected={selected} messages={messages} complete={complete} />,
      ),
    );
  try {
    await render();
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 50%');
    expect(f.host.querySelector('.composer-cache-rate')?.getAttribute('title')).toBe(
      '缓存命中 200 / 400 tokens',
    );
    expect(
      requests
        .filter((request) => request.method === 'toolMessages.usage')
        .map((request) => request.messageIds.length),
    ).toEqual([32, 4]);
    await render([...values], selection(), false);
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 50%');
    await render([...values]);
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 50%');
    expect(requests.filter((request) => request.method === 'toolMessages.usage').length).toBe(2);
    await render([message('no-sample', 'empty')], selection('empty', 3));
    expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
    await render([message('zero', 'zero')], selection('zero', 4));
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 0%');
    expect(f.host.querySelector('.composer-cache-rate')?.getAttribute('title')).toBe(
      '缓存命中 0 / 100 tokens',
    );
    expect(
      requests.every((request) =>
        ['toolMessages.usage', 'toolMessages.close'].includes(request.method),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('confirmed cache text and input nodes survive repeated calibration and the next round pending or failed usage', async () => {
  const f = fixture();
  const requests: NativeRequest[] = [];
  let release: (() => void) | undefined;
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.usage') return null;
      if (request.messageIds.includes('next'))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (request.messageIds.includes('failed')) throw Error('model_usage_unavailable');
      return pageFor(
        request,
        's',
        request.messageIds.map((id) => ({
          messageId: id,
          executionId: `model-${id}`,
          originStoreId: 'store',
          cacheHitTokens: id === 'next' ? 160 : 40,
          cacheMissTokens: id === 'next' ? 40 : 60,
        })),
      );
    },
  } as NativeBridge;
  const original = message('original');
  const render = (messages = [original], complete = true, revision = 0) =>
    act(async () =>
      f.root.render(
        <Harness
          bridge={bridge}
          selected={{ ...selection(), viewLoading: !complete, permissionUnavailable: !complete }}
          messages={messages}
          complete={complete}
          revision={revision}
        />,
      ),
    );
  try {
    await render();
    const rate = f.host.querySelector('.composer-cache-rate')!,
      input = f.host.querySelector('.composer [role="textbox"][contenteditable]');
    expect(rate.textContent).toBe('缓存 40%');
    for (let revision = 1; revision <= 8; revision++) {
      await render([{ ...original }], false, revision);
      expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
      expect(rate.getAttribute('title')).toBe('缓存命中 40 / 100 tokens');
      expect(f.host.querySelector('.composer [role="textbox"][contenteditable]')).toBe(input);
      await render([{ ...original }], true, revision);
      expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    }
    expect(requests.filter((request) => request.method === 'toolMessages.usage').length).toBe(1);
    const next = message('next');
    await render([original, { ...next, status: 'incomplete' }], true, 9);
    expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    await render([original, next], true, 10);
    expect(release).toBeDefined();
    expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    expect(rate.getAttribute('title')).toBe('缓存命中 40 / 100 tokens');
    await act(async () => release!());
    expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    expect(rate.textContent).toBe('缓存 67%');
    expect(rate.getAttribute('title')).toBe('缓存命中 200 / 300 tokens');
    await render([original, next, message('failed')], true, 11);
    expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    expect(rate.getAttribute('title')).toBe('缓存命中 200 / 300 tokens');
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('缓存指标未更新');
    expect(f.host.querySelector('.composer [role="textbox"][contenteditable]')).toBe(input);
  } finally {
    await f.close();
  }
});

test('retained samples still require the original body and source, and never cross reading scopes', async () => {
  const f = fixture();
  let reads = 0;
  const bridge = {
    request: async (request: NativeRequest) => {
      if (request.method !== 'toolMessages.usage') return null;
      reads++;
      return pageFor(request, 's', [
        {
          messageId: 'original',
          executionId: 'model-original',
          originStoreId: 'store',
          cacheHitTokens: 40,
          cacheMissTokens: 60,
        },
      ]);
    },
  } as NativeBridge;
  const original = message('original');
  const render = (options: Partial<Parameters<typeof Harness>[0]> = {}) =>
    act(async () =>
      f.root.render(
        <Harness bridge={bridge} selected={selection()} messages={[original]} {...options} />,
      ),
    );
  try {
    await render();
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 40%');
    for (const messages of [
      [],
      [{ ...original, content: 'replaced body' }],
      [{ ...original, sourceIds: ['another-model'] }],
      [{ ...original, status: 'incomplete' as const }],
    ]) {
      await render({ messages, complete: false });
      expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
    }
    await render({ complete: false });
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 40%');
    for (const scope of [
      { generation: 2 },
      { historyEpoch: 1 },
      { selected: { ...selection(), storeId: 'another-store' } },
      {
        selected: {
          ...selection(),
          session: { ...selection().session, workspaceId: 'another-workspace' },
        },
      },
      { selected: selection('another-session', 2) },
      { selected: selection('s', 3) },
      { suspended: true },
    ]) {
      await render({ ...scope, complete: false });
      expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
    }
    expect(reads).toBe(1);
  } finally {
    await f.close();
  }
});

test('returning to cached Sessions displays their own verified rate while fresh usage is held; late reads and epoch resets cannot revive old facts', async () => {
  const f = fixture();
  let hold = false,
    release: (() => void) | undefined;
  const bridge = {
    request: async (request: NativeRequest) => {
      if (request.method !== 'toolMessages.usage') return null;
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const id = request.messageIds[0]!;
      return pageFor(request, id, [
        {
          messageId: id,
          executionId: `model-${id}`,
          originStoreId: 'store',
          cacheHitTokens: id === 'a' ? 40 : 90,
          cacheMissTokens: id === 'a' ? 60 : 10,
        },
      ]);
    },
  } as NativeBridge;
  const render = (id: string, view: number, complete = true, epoch = 0) =>
    act(async () =>
      f.root.render(
        <Harness
          bridge={bridge}
          selected={selection(id, view)}
          messages={[message(id, id)]}
          complete={complete}
          historyEpoch={epoch}
        />,
      ),
    );
  try {
    await render('a', 2);
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 40%');
    await render('b', 3);
    const rate = f.host.querySelector('.composer-cache-rate');
    expect(rate?.textContent).toBe('缓存 90%');
    await render('a', 4, false);
    expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    expect(rate?.textContent).toBe('缓存 40%');
    hold = true;
    await render('a', 4);
    expect(release).toBeDefined();
    expect(f.host.querySelector('.composer-cache-rate')).toBe(rate);
    expect(rate?.textContent).toBe('缓存 40%');
    await render('b', 5, false);
    expect(rate?.textContent).toBe('缓存 90%');
    await act(async () => release!());
    expect(rate?.textContent).toBe('缓存 90%');
    await render('b', 3, false, 1);
    expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
    await render('b', 3, false, 0);
    expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
  } finally {
    await f.close();
  }
});

test('display snapshots bound both entry count and retained bytes, including replacement and LRU use', () => {
  const snapshots = new NativeDisplayCache<string>();
  for (let i = 0; i < 12; i++) snapshots.set(String(i), `value ${i}`);
  expect(snapshots.get('0')).toBe('value 0');
  snapshots.set('12', 'new');
  expect(snapshots.get('1')).toBeUndefined();
  expect(snapshots.get('0')).toBe('value 0');
  snapshots.clear();
  const large = 'x'.repeat(1_600_000);
  for (let i = 0; i < 6; i++) snapshots.set(String(i), large);
  expect(snapshots.get('0')).toBeUndefined();
  expect(snapshots.get('5')).toBe(large);
  snapshots.set('5', 'replacement');
  expect(snapshots.get('5')).toBe('replacement');
  snapshots.set('huge', 'x'.repeat(2_100_000));
  expect(snapshots.get('huge')).toBeUndefined();
});

test('late cache reads cannot enter another Session; changed Message samples do not reuse old usage and failed reads require an explicit retry', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  let release!: (page: NativeModelUsagePage) => void, heldRequest!: UsageRequest;
  const held = new Promise<NativeModelUsagePage>((resolve) => {
    release = resolve;
  });
  let fail = false;
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.usage') return null;
      if (request.viewSelection === 2) {
        heldRequest = request;
        return held;
      }
      if (fail) throw Error('model_usage_unavailable');
      return pageFor(
        request,
        'b',
        request.messageIds.map((id) => ({
          messageId: id,
          executionId: `model-${id}`,
          originStoreId: 'store',
          cacheHitTokens: 5,
          cacheMissTokens: 5,
        })),
      );
    },
  } as NativeBridge;
  const original = message('b', 'b');
  const render = (selected = selection('b', 3), messages = [original], revision = 0) =>
    act(async () =>
      f.root.render(
        <Harness bridge={bridge} selected={selected} messages={messages} revision={revision} />,
      ),
    );
  try {
    await render(selection(), [message('old')]);
    expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
    await render();
    expect(f.host.querySelector('.composer-cache-rate')?.getAttribute('title')).toBe(
      '缓存命中 5 / 10 tokens',
    );
    await act(async () =>
      release(
        pageFor(heldRequest, 's', [
          {
            messageId: 'old',
            executionId: 'model-old',
            originStoreId: 'store',
            cacheHitTokens: 90,
            cacheMissTokens: 10,
          },
        ]),
      ),
    );
    expect(f.host.querySelector('.composer-cache-rate')?.getAttribute('title')).toBe(
      '缓存命中 5 / 10 tokens',
    );
    const changed = { ...original, content: 'changed original body' };
    fail = true;
    await render(selection('b', 3), [changed]);
    expect(f.host.querySelector('.composer-cache-rate')).toBeNull();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('缓存指标未更新');
    await render(selection('b', 3), [{ ...changed }]);
    expect(requests.filter((request) => request.method === 'toolMessages.usage').length).toBe(3);
    fail = false;
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((button) => button.textContent === '重新读取缓存指标')!
        .click(),
    );
    expect(f.host.querySelector('.composer-cache-rate')?.getAttribute('title')).toBe(
      '缓存命中 5 / 10 tokens',
    );
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    expect(
      requests.every((request) =>
        ['toolMessages.usage', 'toolMessages.close'].includes(request.method),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
