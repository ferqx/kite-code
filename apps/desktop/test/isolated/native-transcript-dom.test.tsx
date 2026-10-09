import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { ModelOutputMessage } from '@kite-ai/ui';
import { MessageContent, SessionPage, ToolActivity } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { desktopTranscript, useNativeRuns } from '../../src/native-transcript';
import type {
  NativeRunFact,
  NativeToolMessageFact,
  NativeToolRunPage,
} from '../../src/tool-messages-bridge';
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
const run = (id = 'r', sessionId = 's'): NativeRunFact => ({
  id,
  sessionId,
  originStoreId: 'store',
  status: 'completed',
  isActive: false,
  createdAt: 1000,
  finishedAt: 3000,
  reason: null,
});
const message = (id: string, role: Message['role'], seq: string, content: string): Message => ({
  id,
  role,
  seq,
  content,
  sessionId: 's',
  runId: 'r',
  status: 'complete',
});
const tool = (id: string): NativeToolMessageFact => ({
  messageId: id,
  executionId: `e-${id}`,
  definitionId: 'files.read',
  definitionVersion: '3',
  status: 'succeeded',
  resultRevision: '1',
  target: `${id}.txt`,
});

test('the original Conversation owns collapsed Run history, adjacent exploration and exact copy controls while host body/file callbacks retain their identities', async () => {
  const f = fixture(),
    copied: string[] = [],
    opened: string[] = [];
  const messages = [
    message('u', 'user', '1', '原用户 雪🙂'),
    {
      ...message('before', 'assistant', '2', '工具前说明'),
      toolCalls: [{ id: 'call', name: 'files.read', arguments: '{}' }],
    },
    { ...message('read-a', 'tool', '3', 'first raw result'), sourceIds: ['e-read-a'] },
    { ...message('read-b', 'tool', '4', 'second raw result'), sourceIds: ['e-read-b'] },
    message('final', 'assistant', '5', '最终回复 雪🙂\r\n'),
  ];
  const transcript = desktopTranscript({
    messages,
    runs: [run()],
    tools: [tool('read-a'), tool('read-b')],
    storeId: 'store',
    sessionId: 's',
  });
  try {
    await act(async () =>
      f.root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="original"
          readingKey="s"
          loading={false}
          connected
          connectionLabel="local"
          actions={{}}
          messages={transcript.messages}
          turnActivity={transcript.turnActivity}
          writeClipboardText={async (text) => {
            copied.push(text);
          }}
          renderMessageContent={(model) => <MessageContent text={model.text} />}
          renderToolActivity={(group, state) => (
            <ToolActivity
              {...state}
              messages={group}
              renderChildren={() => null}
              openFileForMessage={(model) => (path) => opened.push(`${model.id}:${path}`)}
            />
          )}
        />,
      ),
    );
    expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(1);
    expect(f.host.querySelector('.agent-turn-final')!.textContent).toContain('最终回复');
    expect(f.host.querySelector('.agent-turn-final')!.textContent).not.toContain('工具前说明');
    expect(f.host.querySelector('[aria-label="复制本轮Agent回复"]')).not.toBeNull();
    await act(async () =>
      (f.host.querySelector('[aria-label="复制本轮Agent回复"]') as HTMLButtonElement).click(),
    );
    expect(copied).toEqual(['最终回复 雪🙂\r\n']);
    await act(async () =>
      (f.host.querySelector('[aria-label="复制本轮用户消息"]') as HTMLButtonElement).click(),
    );
    expect(copied).toEqual(['最终回复 雪🙂\r\n', '原用户 雪🙂']);
    const process = f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    expect(process.getAttribute('aria-expanded')).toBe('false');
    await act(async () => process.click());
    expect(process.getAttribute('aria-expanded')).toBe('true');
    const activity = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    expect(activity.textContent).toContain('2');
    await act(async () => activity.click());
    expect(f.host.querySelectorAll('.tool-activity-steps .tool-activity-step')).toHaveLength(2);
    const paths = [
      ...f.host.querySelectorAll<HTMLButtonElement>('.tool-activity-steps button.file-link'),
    ];
    expect(paths.map((button) => button.textContent)).toEqual(['read-a.txt', 'read-b.txt']);
    await act(async () => paths[1]!.click());
    expect(opened).toEqual(['read-b:read-b.txt']);
    await act(async () => process.click());
    await act(async () => process.click());
    expect(
      f.host.querySelector('button.tool-activity-summary')!.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(f.host.querySelectorAll('.message-copy')).toHaveLength(2);
    const failed = desktopTranscript({
      messages: [
        messages[0]!,
        messages[1]!,
        { ...message('new-user', 'user', '6', '下一轮'), runId: 'r2' },
        { ...message('new-final', 'assistant', '7', '下一轮最终'), runId: 'r2' },
      ],
      runs: [{ ...run(), status: 'failed', reason: '真实原因' }, run('r2')],
      tools: [],
      storeId: 'store',
      sessionId: 's',
    });
    expect(failed.messages.findIndex((model) => model.systemKind === 'turn_failure')).toBeLessThan(
      failed.messages.findIndex((model) => model.id === 'new-user'),
    );
    expect(failed.messages.find((model) => model.id === 'before')!.finalReply).toBeUndefined();
    const sealed = desktopTranscript({
      messages: [
        {
          ...messages[4]!,
          originMessage: { storeId: 'store', sessionId: 's', messageId: 'origin', runId: 'r' },
        },
      ],
      runs: [run()],
      tools: [],
      storeId: 'store',
      sessionId: 's',
    });
    expect(sealed.messages[0]!.turnId).toBeUndefined();
    expect(sealed.messages[0]!.finalReply).toBeUndefined();
    const restored = desktopTranscript({
      messages: [messages[4]!],
      runs: [{ ...run(), originStoreId: 'previous-store' }],
      tools: [],
      storeId: 'store',
      sessionId: 's',
    });
    expect(restored.messages.find((model) => model.id === 'final')).toMatchObject({
      finalReply: true,
      copyText: '最终回复 雪🙂\r\n',
    });
    expect(restored.turnActivity).toBeUndefined();
    const foreignActive = desktopTranscript({
      messages: [messages[4]!],
      runs: [{ ...run(), originStoreId: 'previous-store', status: 'running', isActive: true }],
      tools: [],
      storeId: 'store',
      sessionId: 's',
    });
    expect(foreignActive.messages[0]!.turnId).toBeUndefined();
    expect(foreignActive.messages[0]!.finalReply).toBeUndefined();
    expect(foreignActive.turnActivity).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('the original final reply copy becomes available only for the displayed complete body and disappears when that reader closes', async () => {
  const f = fixture(),
    copied: string[] = [],
    content = '完整最终正文 雪🙂\r\nEND',
    contentBytes = String(new TextEncoder().encode(content).length);
  const final: Message = {
    ...message('final', 'assistant', '2', 'PREVIEW'),
    outputBody: {
      kind: 'model_output',
      executionId: 'model',
      complete: true,
      contentBytes,
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  // This is the UI reader boundary fixture; real SHA/EOF verification remains in the Native port and window tests.
  const snapshot: ModelOutputSnapshot = {
    storeId: 'store',
    sessionId: 's',
    rootSessionId: 's',
    runId: 'r',
    executionId: 'model',
    originCommandId: 'c',
    rootWorkCommandId: 'c',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    bodyHash: 'a'.repeat(64),
    bodyBytes: '1',
    contentBytes,
    reasoningBytes: '0',
    snapshotCursor: '1',
    output: { content, reasoning: '', toolCalls: [], complete: true },
  };
  let reads = 0;
  function Harness() {
    const [full, setFull] = useState<string>();
    const transcript = desktopTranscript({
      messages: [message('u', 'user', '1', 'user'), final],
      runs: [run()],
      tools: [],
      storeId: 'store',
      sessionId: 's',
      fullReply: () => full,
    });
    return (
      <SessionPage
        workspaces={[]}
        sessionLabel="body"
        readingKey="s"
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        messages={transcript.messages}
        writeClipboardText={async (text) => {
          copied.push(text);
        }}
        renderMessageContent={(model) =>
          model.id === 'final' ? (
            <ModelOutputMessage
              message={final}
              storeId="store"
              onContent={setFull}
              onRead={async () => {
                reads++;
                return snapshot;
              }}
            />
          ) : (
            <MessageContent text={model.text} />
          )
        }
      />
    );
  }
  try {
    await act(async () => f.root.render(<Harness />));
    expect(f.host.querySelector('[aria-label="复制本轮Agent回复"]')).toBeNull();
    const read = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Read complete recorded Model output',
    )!;
    await act(async () => read.click());
    expect(f.host.textContent).toContain('END');
    const copy = f.host.querySelector<HTMLButtonElement>('[aria-label="复制本轮Agent回复"]')!;
    expect(copy).not.toBeNull();
    await act(async () => copy.click());
    expect(copied).toEqual([content]);
    const close = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.startsWith('Close'),
    )!;
    await act(async () => close.click());
    expect(f.host.querySelector('[aria-label="复制本轮Agent回复"]')).toBeNull();
    expect(f.host.textContent).toContain('PREVIEW');
    expect(reads).toBe(1);
  } finally {
    await f.close();
  }
});

test('all historical Run batches stay in the selected read scope; late metadata only closes its own read and cannot replace the next Session', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  const selected = (id: string, viewSelection: number) =>
    ({
      storeId: 'store',
      viewSelection,
      viewGeneration: 1,
      session: { id, workspaceId: 'w' },
      runs: [],
      executions: [],
    }) as unknown as NativeSelection;
  const messages = (id: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...message(`m-${id}-${i}`, 'user', String(i + 1), 'original'),
      sessionId: id,
      runId: `r-${i}`,
    }));
  let release!: (value: NativeToolRunPage) => void,
    held: Extract<NativeRequest, { method: 'toolMessages.runs' }> | undefined;
  const page = (
    request: Extract<NativeRequest, { method: 'toolMessages.runs' }>,
    id: string,
  ): NativeToolRunPage => ({
    kind: 'toolMessages.runs',
    readId: request.readId,
    scope: {
      generation: 1,
      viewSelection: request.viewSelection,
      historyEpoch: 0,
      storeId: 'store',
      sessionId: id,
      workspaceId: 'w',
    },
    runs: request.messageIds.map((value) => run(`r-${value.split('-').at(-1)}`, id)),
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      requests.push(request);
      if (request.method !== 'toolMessages.runs') return null;
      if (request.viewSelection === 4) {
        held = request;
        return new Promise<NativeToolRunPage>((resolve) => {
          release = resolve;
        });
      }
      return page(request, request.viewSelection === 5 ? 'b' : 'a');
    },
  };
  function Harness({ id, view, count }: { id: string; view: number; count: number }) {
    const facts = useNativeRuns({
      bridge,
      generation: 1,
      selection: selected(id, view),
      historyEpoch: 0,
      messages: messages(id, count),
      observationRevision: 1,
    });
    return <pre>{JSON.stringify(facts.runs.map((value) => [value.sessionId, value.id]))}</pre>;
  }
  try {
    await act(async () => f.root.render(<Harness id="a" view={2} count={40} />));
    expect(
      requests
        .filter((request) => request.method === 'toolMessages.runs')
        .map((request) => request.messageIds.length),
    ).toEqual([32, 8]);
    expect(JSON.parse(f.host.textContent!)).toHaveLength(40);
    await act(async () => f.root.render(<Harness id="a" view={4} count={1} />));
    expect(held).toBeDefined();
    await act(async () => f.root.render(<Harness id="b" view={5} count={1} />));
    expect(JSON.parse(f.host.textContent!)).toEqual([['b', 'r-0']]);
    await act(async () => release(page(held!, 'a')));
    expect(JSON.parse(f.host.textContent!)).toEqual([['b', 'r-0']]);
    expect(
      requests.some(
        (request) => request.method === 'toolMessages.close' && request.readId === held!.readId,
      ),
    ).toBe(true);
    expect(
      requests.every(
        (request) =>
          request.method === 'toolMessages.runs' || request.method === 'toolMessages.close',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('original ask receipts show human answers and cancellation of information without changing a running Tool owner into a stopped Run', async () => {
  const f = fixture();
  const messages = [
    { ...message('answer', 'tool', '1', 'recorded answer'), sourceIds: ['e-answer'] },
    { ...message('cancel', 'tool', '2', '{"cancelled":true}'), sourceIds: ['e-cancel'] },
  ];
  const questions = [
    { id: 'q1', question: '主线' },
    { id: 'q2', question: '补充' },
  ];
  const facts: NativeToolMessageFact[] = [
    {
      messageId: 'answer',
      executionId: 'e-answer',
      definitionId: 'ask_user',
      definitionVersion: '1',
      status: 'succeeded',
      resultRevision: '1',
      ask: { questions, answers: { q1: '保留原代码', q2: '原文 雪🙂\r\n' } },
    },
    {
      messageId: 'cancel',
      executionId: 'e-cancel',
      definitionId: 'ask_user',
      definitionVersion: '1',
      status: 'succeeded',
      resultRevision: '1',
      ask: { questions, cancelled: true },
    },
  ];
  const transcript = desktopTranscript({
    messages,
    runs: [
      { ...run(), status: 'running', isActive: true, finishedAt: null, createdAt: Date.now() },
    ],
    tools: facts,
    storeId: 'store',
    sessionId: 's',
  });
  try {
    await act(async () =>
      f.root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="ask"
          readingKey="s"
          loading={false}
          connected
          connectionLabel="local"
          actions={{}}
          messages={transcript.messages}
          turnActivity={transcript.turnActivity}
          renderToolActivity={(group, state) => (
            <ToolActivity {...state} messages={group} renderChildren={() => null} />
          )}
        />,
      ),
    );
    expect(f.host.querySelector('.agent-turn')!.getAttribute('data-turn-status')).toBe('running');
    expect(f.host.textContent).toContain('已取消回答');
    const receipts = [
      ...f.host.querySelectorAll<HTMLButtonElement>('button.tool-activity-summary'),
    ];
    expect(receipts).toHaveLength(2);
    await act(async () => receipts[0]!.click());
    expect(f.host.querySelector('.tool-ask-answers')!.textContent).toContain('主线：保留原代码');
    expect(f.host.querySelector('.tool-ask-answers')!.textContent).toContain('原文 雪🙂\r\n');
    expect(f.host.querySelector('.tool-ask-answers')!.textContent).not.toContain('q1-o1');
    await act(async () => receipts[1]!.click());
    expect(f.host.querySelectorAll('.tool-ask-answers')[1]!.textContent).toBe('已取消回答');
    expect(f.host.querySelector('.agent-turn')!.getAttribute('data-turn-status')).toBe('running');
    expect(f.host.querySelector('[aria-label="复制本轮Agent回复"]')).toBeNull();
    expect(
      transcript.messages.filter((model) => model.role === 'tool').map((model) => model.status),
    ).toEqual(['completed', 'completed']);
  } finally {
    await f.close();
  }
});

test('same reading identity retains terminal Conversation nodes and manual process expansion while fresh metadata is held; current facts and explicit missing win', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  const messages = Array.from({ length: 33 }, (_, i) => [
    { ...message(`u-${i}`, 'user', String(i * 3 + 1), `user ${i}`), runId: `r-${i}` },
    {
      ...message(`p-${i}`, 'assistant', String(i * 3 + 2), `process ${i}`),
      runId: `r-${i}`,
      toolCalls: [{ id: `call-${i}`, name: 'files.read', arguments: '{}' }],
    },
    { ...message(`f-${i}`, 'assistant', String(i * 3 + 3), `final ${i}`), runId: `r-${i}` },
  ]).flat();
  const held: {
    request: Extract<NativeRequest, { method: 'toolMessages.runs' }>;
    release: (page: NativeToolRunPage) => void;
  }[] = [];
  const page = (
    request: Extract<NativeRequest, { method: 'toolMessages.runs' }>,
    runs: NativeRunFact[],
  ): NativeToolRunPage => ({
    kind: 'toolMessages.runs',
    readId: request.readId,
    scope: {
      generation: request.generation,
      viewSelection: request.viewSelection,
      historyEpoch: request.historyEpoch,
      storeId: 'store',
      sessionId: 's',
      workspaceId: 'w',
    },
    runs,
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      requests.push(request);
      if (request.method !== 'toolMessages.runs') return null;
      if (request.historyEpoch === 0)
        return page(
          request,
          request.messageIds.map((id) => run(`r-${id.split('-').at(-1)}`)),
        );
      return new Promise<NativeToolRunPage>((release) => held.push({ request, release }));
    },
  };
  function Harness({
    epoch,
    current = [],
    session = 's',
    viewSelection = 2,
  }: {
    epoch: number;
    current?: NativeRunFact[];
    session?: string;
    viewSelection?: number;
  }) {
    const selection = {
      storeId: 'store',
      viewSelection,
      viewGeneration: 1,
      session: { id: session, workspaceId: 'w' },
      runs: current,
      executions: [],
    } as unknown as NativeSelection;
    const facts = useNativeRuns({
      bridge,
      generation: 1,
      selection,
      historyEpoch: epoch,
      messages: session === 's' ? messages : [],
      observationRevision: epoch + 1,
    });
    const transcript = desktopTranscript({
      messages: session === 's' ? messages : [],
      runs: facts.runs,
      tools: [],
      storeId: 'store',
      sessionId: session,
    });
    return (
      <SessionPage
        workspaces={[]}
        sessionLabel={session}
        readingKey={session}
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        messages={transcript.messages}
        turnActivity={transcript.turnActivity}
        renderMessageContent={(model) => <MessageContent text={model.text} />}
      />
    );
  }
  try {
    await act(async () => f.root.render(<Harness epoch={0} />));
    const nodes = [...f.host.querySelectorAll<HTMLElement>('.agent-turn')];
    expect(nodes).toHaveLength(33);
    await act(async () =>
      f.root.render(<Harness epoch={0} current={[{ ...run('r-0'), status: 'cancelled' }]} />),
    );
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('cancelled');
    await act(async () => f.root.render(<Harness epoch={0} />));
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('cancelled');
    await act(async () =>
      f.root.render(
        <Harness
          epoch={0}
          current={[{ ...run('r-0'), status: 'running', isActive: true, finishedAt: null }]}
        />,
      ),
    );
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('running');
    await act(async () => f.root.render(<Harness epoch={0} />));
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('running');
    await act(async () =>
      f.root.render(<Harness epoch={0} current={[{ ...run('r-0'), status: 'interrupted' }]} />),
    );
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('aborted');
    await act(async () => f.root.render(<Harness epoch={0} />));
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('aborted');
    await act(async () => f.root.render(<Harness epoch={0} current={[run('r-0')]} />));
    await act(async () => f.root.render(<Harness epoch={0} />));
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('completed');
    const toggle = nodes[32]!.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => f.root.render(<Harness epoch={1} />));
    expect(held[0]!.request.messageIds).toHaveLength(32);
    expect(
      [...f.host.querySelectorAll('.agent-turn')].every((node, index) => node === nodes[index]) &&
        f.host.querySelectorAll('.agent-turn').length === nodes.length,
    ).toBe(true);
    expect(nodes[32]!.isConnected).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const first = held[0]!;
    await act(async () =>
      first.release(
        page(
          first.request,
          first.request.messageIds.flatMap((id) => {
            const index = id.split('-').at(-1)!;
            return index === '1'
              ? []
              : [
                  {
                    ...run(`r-${index}`),
                    ...(index === '0' ? { status: 'failed' as const, reason: 'new fact' } : {}),
                  },
                ];
          }),
        ),
      ),
    );
    expect(held[1]!.request.messageIds).toHaveLength(1);
    expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(32);
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('failed');
    expect(nodes[1]!.isConnected).toBe(false);
    expect(nodes[32]!.isConnected).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      f.root.render(<Harness epoch={1} current={[{ ...run('r-32'), status: 'cancelled' }]} />),
    );
    expect(nodes[32]!.getAttribute('data-turn-status')).toBe('cancelled');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => f.root.render(<Harness epoch={2} />));
    expect(nodes[32]!.getAttribute('data-turn-status')).toBe('cancelled');
    expect(nodes[32]!.isConnected).toBe(true);
    await act(async () =>
      f.root.render(
        <Harness
          epoch={2}
          current={[
            { ...run('r-32'), status: 'running', isActive: true, finishedAt: null },
            { ...run('r-0'), status: 'interrupted' },
          ]}
        />,
      ),
    );
    expect(nodes[32]!.getAttribute('data-turn-status')).toBe('running');
    expect(nodes[0]!.getAttribute('data-turn-status')).toBe('aborted');
    await act(async () => f.root.render(<Harness epoch={3} />));
    expect(nodes[32]!.isConnected).toBe(false);
    expect(nodes[0]!.isConnected).toBe(false);
    expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(30);
    await act(async () => f.root.render(<Harness epoch={3} viewSelection={3} />));
    expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(0);
    await act(async () => f.root.render(<Harness epoch={2} session="foreign" />));
    expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(0);
    const late = held.at(-1)!;
    await act(async () => late.release(page(late.request, [run('r-0')])));
    expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(0);
    expect(
      requests
        .filter((request) => request.method === 'toolMessages.runs')
        .map((request) => request.historyEpoch),
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(
      requests.every(
        (request) =>
          request.method === 'toolMessages.runs' || request.method === 'toolMessages.close',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
