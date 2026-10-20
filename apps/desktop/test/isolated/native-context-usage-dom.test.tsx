import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../../packages/ui/src/desktop/Composer';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { useNativeContextUsage } from '../../src/native-context-usage';
import type { NativeContextUsagePage } from '../../src/tool-messages-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const selected = (id = 's', viewSelection = 2) =>
  ({
    storeId: 'store',
    session: { id, workspaceId: 'w', contextSelectionId: `context-${id}` },
    viewSelection,
  }) as NativeSelection;
const message = (id = 's', seq = '1'): Message => ({
  id: `message-${id}`,
  sessionId: id,
  seq,
  runId: `run-${id}`,
  role: 'assistant',
  status: 'complete',
  content: `answer-${id}`,
  sourceIds: [`model-${id}`],
});
type Request = Extract<NativeRequest, { method: 'toolMessages.contextUsage' }>;
const page = (
  request: Request,
  id: string,
  totalInputTokens = 340,
  contextWindowTokens: number | undefined = 500,
): NativeContextUsagePage => ({
  kind: 'toolMessages.contextUsage',
  readId: request.readId,
  scope: {
    generation: request.generation,
    storeId: 'store',
    sessionId: id,
    workspaceId: 'w',
    viewSelection: request.viewSelection,
    historyEpoch: request.historyEpoch,
  },
  context: {
    modelId: 'route',
    contextSelectionId: `context-${id}`,
    totalInputTokens,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  },
});

function Harness({
  bridge,
  selection = selected(),
  messages = [message()],
  complete = true,
  generation = 1,
  historyEpoch = 0,
  modelId,
  cached = 99,
}: {
  bridge: NativeBridge;
  selection?: NativeSelection;
  messages?: readonly Message[];
  complete?: boolean;
  generation?: number;
  historyEpoch?: number;
  modelId?: string;
  cached?: number;
}) {
  const facts = useNativeContextUsage({
    bridge,
    selection,
    generation,
    historyEpoch,
    messages,
    historyComplete: complete,
    modelId,
  });
  return (
    <div className="kite-client">
      <Composer
        draft=""
        onChange={() => {}}
        active={false}
        stopping={false}
        disabled={false}
        cacheMetrics={{ cacheHitTokens: cached, cacheMissTokens: 100 - cached }}
        contextUsage={facts.metrics}
      />
    </div>
  );
}

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const layout = prepareDesktopDom(dom);
  const previous = { window: globalThis.window, document: globalThis.document };
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
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      layout();
      Object.assign(globalThis, previous);
    },
  };
}

test('the context ring uses current input over the full window, independently of the cache hit percentage', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      return request.method === 'toolMessages.contextUsage' ? page(request, 's') : null;
    },
  } as NativeBridge;
  const render = (cached = 99, messages: readonly Message[] = [message()]) =>
    act(async () => f.root.render(<Harness bridge={bridge} cached={cached} messages={messages} />));
  try {
    await render();
    const ring = f.host.querySelector('.composer-context-usage')!;
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 99%');
    expect(ring.getAttribute('aria-label')).toBe('上下文占用约 68%');
    expect(ring.querySelector('[stroke-dasharray]')?.getAttribute('stroke-dasharray')).toBe(
      '68 100',
    );
    expect(ring.getAttribute('aria-description')).toBe('上下文估算 340 / 500 tokens');
    await render(10, [{ ...message() }]);
    expect(f.host.querySelector('.composer-context-usage')).toBe(ring);
    expect(f.host.querySelector('.composer-cache-rate')?.textContent).toBe('缓存 10%');
    expect(ring.querySelector('[stroke-dasharray]')?.getAttribute('stroke-dasharray')).toBe(
      '68 100',
    );
    expect(
      requests.filter((request) => request.method === 'toolMessages.contextUsage'),
    ).toHaveLength(1);
    await render(10, [message(), { ...message(), id: 'tool', seq: '2', role: 'tool' }]);
    expect(
      requests.filter((request) => request.method === 'toolMessages.contextUsage'),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('context reads and retained ratios remain bound to their Session, model, epoch and exact original message', async () => {
  const f = fixture();
  let hold = false,
    release: (() => void) | undefined;
  const bridge = {
    request: async (request: NativeRequest) => {
      if (request.method !== 'toolMessages.contextUsage') return null;
      const id = request.messageIds[0]!.slice('message-'.length);
      if (hold && id === 's')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return page(request, id, id === 's' ? 340 : 100);
    },
  } as NativeBridge;
  const render = (
    id = 's',
    view = 2,
    complete = true,
    modelId?: string,
    epoch = 0,
    messages = [message(id)],
  ) =>
    act(async () =>
      f.root.render(
        <Harness
          bridge={bridge}
          selection={selected(id, view)}
          messages={messages}
          complete={complete}
          modelId={modelId}
          historyEpoch={epoch}
        />,
      ),
    );
  try {
    await render();
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用约 68%',
    );
    await render('b', 3);
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用约 20%',
    );
    await render('s', 4, false);
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用约 68%',
    );
    hold = true;
    await render('s', 4);
    expect(release).toBeDefined();
    await render('b', 5);
    await act(async () => release!());
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用约 20%',
    );
    await render('b', 5, false, 'different-route');
    expect(f.host.querySelector('.composer-context-usage')).toBeNull();
    await render('b', 5, false, undefined, 1);
    expect(f.host.querySelector('.composer-context-usage')).toBeNull();
    await render('b', 5, false, undefined, 1, []);
    expect(f.host.querySelector('.composer-context-usage')).toBeNull();
  } finally {
    await f.close();
  }
});

test('unknown capacity stays unknown, real zero stays zero and over-capacity labels do not wrap the ring', async () => {
  const f = fixture();
  let tokens = 0,
    capacity: number | undefined = 500;
  const bridge = {
    request: async (request: NativeRequest) =>
      request.method === 'toolMessages.contextUsage'
        ? {
            ...page(request, 's', tokens),
            context: {
              modelId: 'route',
              contextSelectionId: 'context-s',
              totalInputTokens: tokens,
              ...(capacity === undefined ? {} : { contextWindowTokens: capacity }),
            },
          }
        : null,
  } as NativeBridge;
  const render = (view: number) =>
    act(async () => f.root.render(<Harness bridge={bridge} selection={selected('s', view)} />));
  try {
    await render(2);
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用约 0%',
    );
    expect(f.host.querySelector('[stroke-dasharray]')).toBeNull();
    tokens = 200;
    capacity = undefined;
    await render(3);
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用未知',
    );
    expect(f.host.querySelector('[stroke-dasharray]')).toBeNull();
    capacity = 100;
    await render(4);
    expect(f.host.querySelector('.composer-context-usage')?.getAttribute('aria-label')).toBe(
      '上下文占用约 200%',
    );
    expect(f.host.querySelector('[stroke-dasharray]')?.getAttribute('stroke-dasharray')).toBe(
      '100 100',
    );
  } finally {
    await f.close();
  }
});
