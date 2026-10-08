import { expect, test } from 'bun:test';
import type { Execution, Message } from '@kite-ai/client';
import { SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import {
  desktopToolMessage,
  liveToolMessages,
  NativeLiveToolMessage,
  NativeToolMessage,
  useNativeToolMessages,
} from '../../src/native-tool-messages';
import type { NativeToolMessagePage } from '../../src/tool-messages-bridge';
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
    viewSelection,
    viewGeneration: 1,
    session: { id, workspaceId: 'w' },
    runs: [],
    executions: [],
  }) as unknown as NativeSelection;
const message = (id: string, content: string, sessionId = 's'): Message => ({
  id,
  seq: '1',
  role: 'tool',
  status: 'complete',
  runId: 'run',
  sessionId,
  content,
  sourceIds: [`e-${id}`],
});
function Harness({
  bridge,
  selected,
  messages,
  observationRevision = 0,
}: {
  bridge: NativeBridge;
  selected: NativeSelection;
  messages: Message[];
  observationRevision?: number;
}) {
  const facts = useNativeToolMessages({
    bridge,
    generation: 1,
    selection: selected,
    historyEpoch: 0,
    messages,
    observationRevision,
  });
  return (
    <>
      <SessionPage
        workspaces={[]}
        sessionLabel="tools"
        readingKey={selected.session.id}
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        messages={messages.map((value) => ({
          id: value.id,
          text: value.content,
          role: value.role,
          settled: true,
        }))}
        renderMessage={(model) => {
          const fact = facts.entries.find((entry) => entry.messageId === model.id);
          return fact ? (
            <NativeToolMessage message={desktopToolMessage(fact, model.id, model.text)} />
          ) : (
            <pre>{model.text}</pre>
          );
        }}
      />
      {facts.error && <p role="alert">{facts.error}</p>}
      <button type="button" onClick={facts.retry}>
        retry
      </button>
    </>
  );
}
const pageFor = (
  request: Extract<NativeRequest, { method: 'toolMessages.list' }>,
  sessionId: string,
): NativeToolMessagePage => ({
  kind: 'toolMessages.page',
  readId: request.readId,
  scope: {
    generation: 1,
    viewSelection: request.viewSelection,
    historyEpoch: request.historyEpoch,
    storeId: 'store',
    sessionId,
    workspaceId: 'w',
  },
  entries: request.messageIds.map((id) => ({
    messageId: id,
    executionId: `e-${id}`,
    definitionId: id === 'failed' ? 'files.read' : id === 'future' ? 'task' : 'shell.launch',
    definitionVersion: id === 'failed' ? '3' : id === 'future' ? '9' : '1',
    status: id === 'failed' ? 'failed' : id === 'future' ? 'outcome_unknown' : 'succeeded',
    resultRevision: '1',
    target: id === 'failed' ? 'missing.txt' : 'echo 雪🙂',
  })),
});

test('the retained tool UI shows exact failures, Shell acceptance and expandable original results; unknown versions remain literal and escaped', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  const values = [
    message('shell', '{"accepted":true,"shellId":"job 雪🙂"}'),
    message('failed', 'file_not_found'),
    message('future', '<img src="https://invalid.example/leak"> original unknown result'),
  ];
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      return request.method === 'toolMessages.list' ? pageFor(request, 's') : null;
    },
  } as NativeBridge;
  const render = (messages = values) =>
    act(async () =>
      f.root.render(<Harness bridge={bridge} selected={selection()} messages={messages} />),
    );
  try {
    await render();
    expect(f.host.querySelector('.tool-activity-step.failed')?.textContent).toContain(
      '读取missing.txt失败',
    );
    expect(f.host.querySelector('.tool-activity-step.failed')?.querySelector('button')).toBeNull();
    expect(
      f.host.querySelector('.tool-activity-step.failed')?.querySelector('.tool-step-preview'),
    ).toBeNull();
    expect(f.host.textContent).not.toContain('file_not_found');
    const shell = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('启动后台 Shell'),
    )!;
    expect(shell).toBeDefined();
    expect(f.host.textContent).not.toContain('已退出');
    await act(async () => shell.click());
    expect(f.host.querySelector('.tool-detail')?.textContent).toBe(values[0]!.content);
    const future = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('task · 9'),
    )!;
    await act(async () => future.click());
    expect(f.host.textContent).toContain('结果未知');
    expect(
      [...f.host.querySelectorAll('.tool-detail')].some(
        (entry) => entry.textContent === values[2]!.content,
      ),
    ).toBe(true);
    expect(f.host.querySelector('img')).toBeNull();
    await act(async () => shell.click());
    expect(
      [...f.host.querySelectorAll('.tool-detail')].some(
        (entry) => entry.textContent === values[0]!.content,
      ),
    ).toBe(false);
    expect(requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(1);
    expect(
      requests.every((request) =>
        ['toolMessages.list', 'toolMessages.close'].includes(request.method),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('all metadata batches are scope-bound, a late old-Session read cannot replace the later page, and changed original content is never shown with a stale status', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  let release!: (page: NativeToolMessagePage) => void,
    heldRequest: Extract<NativeRequest, { method: 'toolMessages.list' }> | undefined;
  const held = new Promise<NativeToolMessagePage>((resolve) => {
    release = resolve;
  });
  let hold = true;
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.list') return null;
      if (hold) {
        heldRequest = request;
        return held;
      }
      return pageFor(request, 'later');
    },
  } as NativeBridge;
  try {
    await act(async () =>
      f.root.render(
        <Harness
          bridge={bridge}
          selected={selection()}
          messages={[message('original', 'held old result')]}
        />,
      ),
    );
    expect(heldRequest).toBeDefined();
    hold = false;
    const values = Array.from({ length: 40 }, (_, index) =>
      message(`m${index}`, `later original ${index}`, 'later'),
    );
    await act(async () =>
      f.root.render(<Harness bridge={bridge} selected={selection('later', 3)} messages={values} />),
    );
    expect(
      requests
        .filter((request) => request.method === 'toolMessages.list')
        .map((request) => request.messageIds.length),
    ).toEqual([1, 32, 8]);
    expect(f.host.querySelectorAll('.tool-activity')).toHaveLength(40);
    expect(
      requests.some(
        (request) =>
          request.method === 'toolMessages.close' && request.readId === heldRequest!.readId,
      ),
    ).toBe(true);
    await act(async () => release(pageFor(heldRequest!, 's')));
    expect(f.host.textContent).not.toContain('held old result');
    expect(f.host.querySelectorAll('.tool-activity')).toHaveLength(40);
    hold = true;
    const changed = values.map((value, index) =>
      index === 0 ? { ...value, content: 'new unverified result' } : value,
    );
    await act(async () =>
      f.root.render(
        <Harness bridge={bridge} selected={selection('later', 3)} messages={changed} />,
      ),
    );
    expect(f.host.textContent).toContain('new unverified result');
    expect(f.host.querySelectorAll('.tool-activity')).toHaveLength(39);
  } finally {
    await f.close();
  }
});

test('live tool rows come only from current-Store active Run executions and remain distinct from Job completion or a stop request', async () => {
  const f = fixture();
  const execution: Execution = {
    id: 'live',
    originStoreId: 'store',
    sessionId: 's',
    runId: 'run',
    kind: 'tool',
    definitionId: 'shell.launch',
    definitionVersion: '1',
    status: 'running',
    result: null,
    resultRevision: '0',
    cancelRequestedAt: 1,
  };
  const selected: NativeSelection = {
    ...selection(),
    runs: [{ id: 'run', isActive: true }] as unknown as NativeSelection['runs'],
    executions: [
      execution,
      { ...execution, id: 'job', kind: 'job' },
      { ...execution, id: 'foreign', originStoreId: 'old' },
      { ...execution, id: 'other', sessionId: 'other' },
      { ...execution, id: 'old-run', runId: 'old' },
    ],
  };
  try {
    const live = liveToolMessages(selected, []);
    expect(live.map((entry) => entry.execution.id)).toEqual(['live']);
    await act(async () =>
      f.root.render(<NativeLiveToolMessage {...live[0]!} unavailable={false} />),
    );
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    expect(f.host.textContent).not.toContain('已停止');
    expect(f.host.querySelector('button')).toBeNull();
    await act(async () => f.root.render(<NativeLiveToolMessage {...live[0]!} unavailable />));
    expect(f.host.textContent).toContain('上次确认状态');
    expect(
      liveToolMessages(selected, [{ ...message('result', 'recorded'), sourceIds: ['live'] }]),
    ).toEqual([]);
    expect(
      liveToolMessages(selected, [
        {
          ...message('foreign-result', 'old'),
          sourceIds: ['live'],
          originMessage: { storeId: 'old', sessionId: 's', runId: 'run', messageId: 'old' },
        },
      ]),
    ).toHaveLength(1);
    expect(
      liveToolMessages(
        {
          ...selected,
          runs: [{ id: 'run', isActive: false }] as unknown as NativeSelection['runs'],
        },
        [],
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
