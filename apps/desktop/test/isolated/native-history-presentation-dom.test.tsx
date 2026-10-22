import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import type { Message as DisplayMessage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { NativeTranscriptDisplay } from '../../src/native-transcript-display';
import { backgroundItem } from '../background-item.fixture';
import { installImagePreviewWorker } from '../image-preview-worker.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const globals = {
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
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, globals);
bootstrap.window.close();

const final = '项目包含 Core、Desktop 与共享 UI。';
const summary = 'PRIVATE_COMPRESSION_SUMMARY';
const raw = 'ORIGINAL_TOOL_RECEIPT';
type Reader = 'runs' | 'tools';
function fixture(failTools = false, failRuns = false, withImage = false) {
  const restoreWorker = withImage ? installImagePreviewWorker() : () => {};
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const prior = {
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
  const session = { ...backgroundItem().rootSession, nextSeq: '6' };
  let selected = 'root',
    revision = 1,
    viewSelection = 1,
    historyEpoch = 0,
    holdSelection = false;
  let releaseSelection: (() => void) | undefined;
  let holdMessages = false,
    releaseMessages: (() => void) | undefined;
  const imageData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==';
  const imageBytes = Buffer.from(imageData, 'base64');
  const imageReference = {
    id: 'image-artifact',
    storeId: 'store',
    sessionId: 'root',
    subjectId: 'owner',
    scope: { kind: 'session' as const, id: 'root' },
    hash: new Bun.CryptoHasher('sha256').update(imageBytes).digest('hex'),
    size: String(imageBytes.length),
    mediaType: 'image/png' as const,
  };
  const urls: string[] = [],
    revoked: string[] = [];
  const createUrl = URL.createObjectURL,
    revokeUrl = URL.revokeObjectURL;
  if (withImage) {
    URL.createObjectURL = () => {
      const url = `blob:history-image-${urls.length}`;
      urls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
    };
  }
  const requests: NativeRequest[] = [];
  const pending: Record<Reader, (() => void)[]> = { runs: [], tools: [] };
  const listeners = new Set<(event: NativeEvent) => void>();
  const state = (): NativeState => ({
    generation: 1,
    historyEpoch,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection,
      canReadModelOutput: false,
      session: {
        ...session,
        id: selected,
        rootSessionId: selected,
        nextSeq: selected === 'root' ? '6' : '2',
      },
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const message = (id: string, role: Message['role'], seq: string, content: string): Message => ({
    id,
    role,
    seq,
    content,
    status: 'complete',
    runId: 'old-run',
    sessionId: 'root',
  });
  const messages: Message[] = [
    message('user', 'user', '1', '了解当前项目'),
    {
      ...message('compression', 'assistant', '2', summary),
      sourceIds: ['compression-model'],
      compression: { id: 'compression', trigger: 'automatic', status: 'completed' },
    },
    ...[1, 2].map((number) => ({
      ...message(
        `tool-${number}`,
        'tool',
        String(number + 2),
        JSON.stringify({ path: `file-${number}.ts`, content: raw }),
      ),
      sourceIds: [`execution-${number}`],
    })),
    message('final', 'assistant', '5', final),
  ];
  if (withImage) messages[0]!.images = [{ name: 'selected.png', reference: imageReference }];
  const bridge: NativeBridge = {
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(request): Promise<NativeResult> {
      requests.push(request);
      switch (request.method) {
        case 'attach':
        case 'state':
          return state();
        case 'select': {
          selected = request.sessionId;
          revision++;
          viewSelection++;
          if (holdSelection) {
            holdSelection = false;
            const value = state();
            return new Promise((resolve) => {
              releaseSelection = () => resolve(value);
            });
          }
          return state();
        }
        case 'directory':
          return {
            storeId: 'store',
            sessions: [
              session,
              {
                ...session,
                id: 'other',
                rootSessionId: 'other',
                title: 'Other session',
                nextSeq: '2',
              },
            ],
            workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
          };
        case 'messages': {
          const page = {
            messages:
              selected === 'root'
                ? messages
                : [
                    {
                      ...message('other-message', 'assistant', '1', 'Other ready'),
                      sessionId: 'other',
                      runId: null,
                    },
                  ],
            nextAfterSeq: null,
            highWaterSeq: request.upperSeq!,
          };
          if (holdMessages) {
            holdMessages = false;
            return new Promise((resolve) => {
              releaseMessages = () => resolve(page);
            });
          }
          return page;
        }
        case 'input.image.open':
          return {
            kind: 'input.image.open',
            readId: request.readId,
            hash: imageReference.hash,
            size: imageBytes.length,
            mediaType: 'image/png',
          };
        case 'input.image.read':
          return {
            kind: 'input.image.chunk',
            readId: request.readId,
            offset: 0,
            nextOffset: imageBytes.length,
            data: imageData,
            done: true,
          };
        case 'draft.read':
          return {
            id: selected,
            storeId: 'store',
            workspaceId: 'w',
            rootSessionId: selected,
            revision: 1,
            content: '',
          };
        case 'conversation.branch':
          return {
            kind: 'conversation.branch',
            storeId: 'store',
            workspaceId: 'w',
            repository: false,
            branches: [],
            label: '本地目录',
          };
        case 'conversation.models.read':
        case 'input.models.read':
          return {
            kind: 'settings.models',
            observationId: 1,
            scope: 'user',
            storeId: 'store',
            canWrite: false,
            defaultModelId: null,
            errors: [],
            models: [],
          };
        case 'fileTargets.list':
        case 'fileChanges.list':
          return {
            kind: request.method === 'fileTargets.list' ? 'fileTargets.page' : 'fileChanges.page',
            readId: request.readId,
            scope: {
              generation: 1,
              storeId: 'store',
              sessionId: selected,
              workspaceId: 'w',
              viewSelection: request.viewSelection,
              historyEpoch: request.historyEpoch,
            },
            entries: [],
          };
        case 'toolMessages.runs':
        case 'toolMessages.list': {
          const captured = selected,
            reader = request.method === 'toolMessages.runs' ? 'runs' : 'tools';
          return new Promise<NativeResult>((resolve, reject) =>
            pending[reader].push(() => {
              if ((reader === 'tools' && failTools) || (reader === 'runs' && failRuns)) {
                reject(Error('history_tool_metadata_unavailable'));
                return;
              }
              const scope = {
                generation: 1,
                storeId: 'store',
                sessionId: captured,
                workspaceId: 'w',
                viewSelection: request.viewSelection,
                historyEpoch: request.historyEpoch,
              };
              resolve(
                reader === 'runs'
                  ? {
                      kind: 'toolMessages.runs',
                      readId: request.readId,
                      scope,
                      runs: [
                        {
                          id: 'old-run',
                          originStoreId: 'store',
                          sessionId: captured,
                          status: withImage ? 'running' : 'completed',
                          isActive: withImage,
                          createdAt: 1000,
                          finishedAt: withImage ? null : 3000,
                          reason: null,
                        },
                      ],
                    }
                  : {
                      kind: 'toolMessages.page',
                      readId: request.readId,
                      scope,
                      entries: [1, 2].map((number) => ({
                        messageId: `tool-${number}`,
                        executionId: `execution-${number}`,
                        definitionId: 'files.read',
                        definitionVersion: '4',
                        status: 'succeeded' as const,
                        resultRevision: '1',
                        target: `file-${number}.ts`,
                      })),
                    },
              );
            }),
          );
        }
        default:
          return null;
      }
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 1200 && !ready(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  const release = (reader: Reader) =>
    act(async () => {
      for (const resolve of pending[reader].splice(0)) resolve();
    });
  return {
    host,
    requests,
    urls,
    revoked,
    until,
    release,
    async select(title: string) {
      await act(async () => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent === title,
        );
        expect(button).toBeDefined();
        button!.click();
      });
    },
    pending: (reader: Reader) => pending[reader].length,
    fail(reader: Reader, value = true) {
      if (reader === 'runs') failRuns = value;
      else failTools = value;
    },
    holdNextSelection() {
      holdSelection = true;
    },
    releaseSelection: () => act(async () => releaseSelection?.()),
    async stream(text: string) {
      releaseMessages = undefined;
      await act(async () => {
        messages[messages.length - 1] = { ...messages.at(-1)!, content: text };
        revision++;
        holdMessages = true;
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
      await until(() => !!releaseMessages);
    },
    releaseMessages: () => act(async () => releaseMessages?.()),
    async recalibrateHistory() {
      await act(async () => {
        historyEpoch++;
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
      await until(() => pending.runs.length > 0 && pending.tools.length > 0);
    },
    async render() {
      await act(async () => root.render(<NativeDesktop />));
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Original')
          ?.click();
      });
      await until(() => pending.runs.length > 0 && pending.tools.length > 0);
    },
    async close() {
      await act(async () => root.unmount());
      releaseSelection?.();
      releaseMessages?.();
      for (const reader of ['runs', 'tools'] as const)
        for (const resolve of pending[reader].splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restore();
      Object.assign(globalThis, prior);
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
      restoreWorker();
    },
  };
}

function expectReadableDuringMetadata(host: HTMLElement) {
  expect(host.querySelector('.conversation-loading')).toBeNull();
  expect(host.textContent).toContain(final);
  // Ownership and tool facts can still enrich grouping independently. Neither
  // private compression text nor unchecked raw tool receipts become visible.
  expect(host.textContent).not.toContain(summary);
  expect(host.textContent).not.toContain(raw);
}

test('retained transcript does not cover changed complete reply bytes, message sources or a new owner boundary', () => {
  const display = new NativeTranscriptDisplay();
  const saved = { messages: [] };
  const fresh: { messages: DisplayMessage[] } = {
    messages: [{ id: 'fresh', role: 'assistant', text: 'new verified reply', settled: true }],
  };
  const original: Message = {
    id: 'message',
    sessionId: 'root',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    runId: 'run',
    content: 'saved preview',
    sourceIds: ['original-source'],
  };
  const input = {
    bridge: {},
    boundary: 'generation/store',
    key: 'root/epoch',
    messages: [original],
    replies: [{ identity: 'original-body', text: 'old complete bytes' }],
    transcript: saved,
    loading: false,
    unavailable: false,
    complete: true,
  };
  display.project(input);
  expect(display.project({ ...input, loading: true, transcript: fresh }).messages).toBe(
    saved.messages,
  );
  expect(
    display.project({
      ...input,
      loading: true,
      replies: [{ identity: 'original-body', text: 'new complete bytes 雪🙂' }],
      transcript: fresh,
    }),
  ).toBe(fresh);
  expect(
    display.project({
      ...input,
      loading: true,
      messages: [{ ...original, sourceIds: ['different-source'] }],
      transcript: fresh,
    }),
  ).toBe(fresh);
  expect(
    display.project({
      ...input,
      loading: true,
      boundary: 'new-generation/store',
      transcript: fresh,
    }),
  ).toBe(fresh);
});

test('sent image thumbnails retain verified nodes and URLs through streaming and cached session switches', async () => {
  const f = fixture(false, false, true);
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.native-user-image img'));
    const card = f.host.querySelector('.native-user-image')!;
    const image = card.querySelector('img')!;
    const viewport = f.host.querySelector('.conversation-viewport')!;
    expect(f.urls).toHaveLength(1);
    for (let index = 1; index <= 3; index++) {
      await f.stream(`streamed reply ${index}`);
      expect(f.host.querySelector('.native-user-image')).toBe(card);
      expect(card.querySelector('img')).toBe(image);
      expect(f.host.querySelector('.conversation-viewport')).toBe(viewport);
      expect(f.revoked).toHaveLength(0);
      await f.releaseMessages();
      await f.until(() => !!f.host.textContent?.includes(`streamed reply ${index}`));
      expect(f.host.querySelector('.native-user-image')).toBe(card);
      expect(card.querySelector('img')).toBe(image);
      expect(f.urls).toHaveLength(1);
    }
    expect(f.requests.filter((request) => request.method === 'input.image.open')).toHaveLength(1);
    await f.select('Other session');
    await f.until(() => !!f.host.textContent?.includes('Other ready'));
    expect(f.host.querySelector('.native-user-image')).toBeNull();
    expect(f.revoked).toHaveLength(0);
    await f.select('Original');
    await f.until(() => f.pending('runs') > 0 && f.pending('tools') > 0);
    expect(f.host.querySelector('.conversation-viewport') === viewport).toBe(true);
    expect(f.urls).toHaveLength(1);
    expect(f.host.querySelector('.native-user-image img') === image).toBe(true);
    expect(image.getAttribute('src')).toBe(f.urls[0]!);
    expect(f.requests.filter((request) => request.method === 'input.image.open')).toHaveLength(1);
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.native-user-image img'));
    expect(f.urls).toHaveLength(1);
    expect(f.host.querySelector('.native-user-image img') === image).toBe(true);
    expect(image.getAttribute('src')).toBe(f.urls[0]!);
    expect(f.revoked).toHaveLength(0);
    expect(f.requests.filter((request) => request.method === 'input.image.open')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const first of ['runs', 'tools'] as const) {
  test(`historical Native transcript remains readable with ${first} facts arriving first, then enriches the completed collapsed Turn`, async () => {
    const f = fixture();
    try {
      await f.render();
      expect(f.pending('runs')).toBe(1);
      expect(f.pending('tools')).toBe(1);
      expectReadableDuringMetadata(f.host);
      await f.release(first);
      expect(f.pending(first === 'runs' ? 'tools' : 'runs')).toBe(1);
      expectReadableDuringMetadata(f.host);
      await f.release(first === 'runs' ? 'tools' : 'runs');
      await f.until(() => !!f.host.querySelector('[data-turn-status="completed"]'));
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(f.host.querySelectorAll('.agent-turn')).toHaveLength(1);
      expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(f.host.textContent).toContain(final);
      expect(f.host.querySelector('.context-compacted')).toBeNull();
      expect(f.host.textContent).not.toContain('状态待核对');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click(),
      );
      expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
      expect(f.host.querySelectorAll('.tool-activity-summary')).toHaveLength(1);
      expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('读取');
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('2');
      expect(f.host.textContent).not.toContain(summary);
      expect(f.host.textContent).not.toContain(raw);
    } finally {
      await f.close();
    }
  });
}

test('a failed historical tool check keeps receipts readable and retries without extra session controls', async () => {
  const f = fixture(true);
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    expect(f.host.textContent).not.toContain('重新核对工具状态');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.textContent).not.toContain('部分工具状态尚无法核实');
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
    expect(f.host.textContent).not.toContain(raw);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!.click(),
    );
    expect(f.host.textContent).toContain(raw);
    f.fail('tools', false);
    await f.until(() => f.pending('tools') > 0);
    const pendingReads = f.requests.filter(
      (request) => request.method === 'toolMessages.list',
    ).length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(f.requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(
      pendingReads,
    );
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    await f.release('tools');
  } finally {
    await f.close();
  }
});

test('a failed historical Run check retains readable messages and reconciles automatically', async () => {
  const f = fixture(false, true);
  try {
    await f.render();
    await f.release('tools');
    expectReadableDuringMetadata(f.host);
    await f.release('runs');
    await f.until(() => f.pending('runs') > 0);
    expect(f.host.textContent).not.toContain('重新核对本轮状态');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
    expect(f.host.textContent).not.toContain('无法核对本轮状态，已保留原消息');
    expect(f.host.textContent).not.toContain(summary);
    expect(f.host.textContent).not.toContain(raw);
    f.fail('runs', false);
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    await f.release('runs');
  } finally {
    await f.close();
  }
});

test('reentering cached history restores the original DOM before fresh ownership and tool checks, with operations gated', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!.click(),
    );
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    const originalViewport = f.host.querySelector('.conversation-viewport')!,
      originalReply = f.host.querySelector('.agent-turn-final')!;
    await f.select('Other session');
    await f.until(
      () => !!f.host.querySelector('.conversation-viewport')?.textContent?.includes('Other ready'),
    );
    expect(originalViewport.isConnected).toBe(false);
    await f.select('Original');
    await f.until(() => f.pending('runs') > 0 && f.pending('tools') > 0);
    expect(f.host.querySelector('.conversation-loading') === null).toBe(true);
    expect(f.host.querySelector('.conversation-viewport') === originalViewport).toBe(true);
    expect(f.host.querySelector('.agent-turn-final') === originalReply).toBe(true);
    expect(
      f.host.querySelector('.agent-turn-process')?.getAttribute('data-restored-expanded'),
    ).toBe('true');
    expect(f.host.querySelector('.tool-activity')?.getAttribute('data-restored-expanded')).toBe(
      'true',
    );
    expect(
      f.host.querySelector('fieldset.conversation-cache-entry')?.hasAttribute('aria-disabled'),
    ).toBe(false);
    const copy = f.host.querySelector<HTMLButtonElement>('.agent-turn-final .message-copy')!;
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    const beforeLocalActions = f.requests.length;
    await act(async () => copy.click());
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.requests.slice(beforeLocalActions)).toEqual([]);
    expect(f.host.querySelector('.agent-turn-final')).toBe(originalReply);
    expect(f.host.textContent).toContain(final);
    await f.release('tools');
    expect(f.host.querySelector('.conversation-viewport') === originalViewport).toBe(true);
    expect(f.host.querySelector('.agent-turn-final') === originalReply).toBe(true);
    await f.release('runs');
    expect(f.host.querySelector('.conversation-viewport') === originalViewport).toBe(true);
    expect(f.host.querySelector('.agent-turn-final') === originalReply).toBe(true);
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(
      f.host.querySelector('.agent-turn-process')?.getAttribute('data-restored-expanded'),
    ).toBeNull();
    expect(f.host.querySelector('.tool-activity')?.getAttribute('data-restored-expanded')).toBe(
      'true',
    );
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    expect(
      f.host.querySelector('.agent-turn-process')?.getAttribute('data-restored-expanded'),
    ).toBeNull();
    expect(f.host.querySelector('.context-compacted')?.textContent).toBe('上下文压缩完成');
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain(summary);
    expect(f.host.textContent).not.toContain(raw);
    expect(f.host.textContent).toContain(final);
  } finally {
    await f.close();
  }
});

test('cached ownership never delays changed complete messages while both metadata readers remain held', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-final'));
    await f.select('Other session');
    await f.until(() => !!f.host.textContent?.includes('Other ready'));
    await f.select('Original');
    await f.until(() => f.pending('runs') > 0 && f.pending('tools') > 0);
    await f.stream('New complete saved reply while metadata remains held');
    await f.releaseMessages();
    await f.until(
      () => !!f.host.textContent?.includes('New complete saved reply while metadata remains held'),
    );
    expect(f.pending('runs')).toBeGreaterThan(0);
    expect(f.pending('tools')).toBeGreaterThan(0);
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).not.toContain(final);
    expect(f.host.textContent).not.toContain(summary);
    expect(f.host.textContent).not.toContain(raw);
    await f.release('runs');
    await f.release('tools');
  } finally {
    await f.close();
  }
});

test('a fresh metadata failure discards stale grouping and reconciles automatically', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-final'));
    await f.select('Other session');
    await f.until(() => !!f.host.textContent?.includes('Other ready'));
    await f.select('Original');
    await f.until(() => f.pending('runs') > 0 && f.pending('tools') > 0);
    f.fail('tools');
    await f.release('tools');
    expect(f.host.textContent).not.toContain('重新核对工具状态');
    expectReadableDuringMetadata(f.host);
    expect(f.host.textContent).not.toContain('部分工具状态尚无法核实');
    expect(f.host.querySelector('.agent-turn-final')).toBeNull();
    await f.release('runs');
    f.fail('tools', false);
    await f.until(() => f.pending('tools') > 0);
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-final'));
    expect(f.host.textContent).not.toContain('部分工具状态尚无法核实');
    expect(f.host.textContent).toContain(final);
  } finally {
    await f.close();
  }
});

test('same-session history epoch recalibration keeps admitted readable content visible while fresh metadata is held', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    expect(f.host.textContent).toContain(final);
    await f.recalibrateHistory();
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    await f.release('tools');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    await f.release('runs');
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.textContent).toContain(final);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  } finally {
    await f.close();
  }
});

test('repeatedly opening the current conversation preserves its nodes and reading state without selecting or reading again', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!.click(),
    );
    const viewport = f.host.querySelector<HTMLElement>('.conversation-viewport')!,
      reply = f.host.querySelector('.message.assistant[data-final-reply="true"]'),
      compression = f.host.querySelector('.context-compacted'),
      input = f.host.querySelector('[role="textbox"][contenteditable]');
    viewport.scrollTop = 23;
    const requests = f.requests.length;
    for (let index = 0; index < 3; index++) await f.select('Original');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.session-row[aria-current="page"]')!.dispatchEvent(
        new f.host.ownerDocument.defaultView!.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
        }),
      ),
    );
    expect(f.requests.slice(requests)).toEqual([]);
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.querySelector('.conversation-viewport')).toBe(viewport);
    expect(f.host.querySelector('.message.assistant[data-final-reply="true"]')).toBe(reply);
    expect(f.host.querySelector('.context-compacted')).toBe(compression);
    expect(f.host.querySelector('[role="textbox"][contenteditable]')).toBe(input);
    expect(viewport.scrollTop).toBe(23);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  } finally {
    await f.close();
  }
});

test('reopening the same history while metadata loads does not restart its pending readers', async () => {
  const f = fixture();
  try {
    await f.render();
    const requests = f.requests.length;
    await f.select('Original');
    await f.select('Original');
    expect(f.requests.slice(requests)).toEqual([]);
    expect(f.pending('runs')).toBe(1);
    expect(f.pending('tools')).toBe(1);
    expectReadableDuringMetadata(f.host);
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    expect(f.host.textContent).toContain(final);
  } finally {
    await f.close();
  }
});

test('repeatedly selecting an in-flight target reuses the original selection request', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.until(() => !!f.host.querySelector('.agent-turn-summary'));
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    const reply = f.host.querySelector('.agent-turn-final')!,
      process = f.host.querySelector('.agent-turn-process')!;
    f.holdNextSelection();
    await f.select('Other session');
    expect(f.host.querySelector('.conversation-loading') === null).toBe(true);
    expect(f.host.querySelector('.agent-turn-final') === reply).toBe(true);
    expect(f.host.querySelector('.agent-turn-process') === process).toBe(true);
    expect(f.host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.session-row[aria-current="page"]') === null).toBe(true);
    expect(
      f.host.querySelector<HTMLButtonElement>('.composer button[type="submit"]')?.disabled,
    ).toBe(true);
    const requests = f.requests.filter((request) => request.method === 'select').length;
    await f.select('Other session');
    await f.select('Other session');
    expect(f.requests.filter((request) => request.method === 'select')).toHaveLength(requests);
    await f.releaseSelection();
    await f.until(
      () => !!f.host.querySelector('.conversation-viewport')?.textContent?.includes('Other ready'),
    );
  } finally {
    await f.close();
  }
});

test('metadata recovery pauses while hidden and stops on success without exposing retry controls', async () => {
  const f = fixture(true);
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    const reads = () =>
      f.requests.filter((request) => request.method === 'toolMessages.list').length;
    const before = reads();
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(reads()).toBe(before);
    f.fail('tools', false);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await f.until(() => f.pending('tools') > 0);
    await f.release('tools');
    const completed = reads();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(reads()).toBe(completed);
    expect(f.host.textContent).not.toContain('重新核对工具状态');
    expect(f.host.textContent).toContain(final);
  } finally {
    await f.close();
  }
});

test('leaving a failed metadata scope cancels its automatic recovery', async () => {
  const f = fixture(true);
  try {
    await f.render();
    await f.release('runs');
    await f.release('tools');
    await f.select('Other session');
    await f.until(() => !!f.host.textContent?.includes('Other ready'));
    const before = f.requests.filter((request) => request.method === 'toolMessages.list').length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(f.requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(
      before,
    );
    expect(f.host.textContent).not.toContain('重新核对工具状态');
  } finally {
    await f.close();
  }
});
