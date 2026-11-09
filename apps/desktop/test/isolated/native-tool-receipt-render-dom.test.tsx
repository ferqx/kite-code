import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { backgroundItem } from '../background-item.fixture';
import { installImagePreviewWorker } from '../image-preview-worker.fixture';
import { nextDesktopPresentation, prepareDesktopDom } from '../native-page-dom.fixture';

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

const sentinel = 'RAW_TOOL_RECEIPT_SENTINEL';
const original = JSON.stringify({
  path: sentinel,
  input: { path: sentinel },
  outcome: 'succeeded',
  nested: { preserved: true },
});
type Mode =
  | 'write-diff'
  | 'edit-diff'
  | 'group-diff'
  | 'failed-diff'
  | 'unknown-diff'
  | 'known'
  | 'empty'
  | 'failed'
  | 'future'
  | 'future-unknown'
  | 'unsupported'
  | 'mixed'
  | 'image'
  | 'image-batch'
  | 'mail'
  | 'mail-unverified'
  | 'mail-failed'
  | 'mail-unknown';
function fixture(mode: Mode, testDiagnostics = false) {
  const isDiff = mode.endsWith('-diff');
  const groupedDiff = mode === 'group-diff';
  const diffIds = groupedDiff ? ['receipt', 'receipt-edit'] : ['receipt'];
  const confirmedDiff = isDiff && !['failed-diff', 'unknown-diff'].includes(mode);
  const isMail = mode.startsWith('mail');
  const receiptContent = isMail ? '{"accepted":true,"delivery":"queued"}' : original;
  const isImage = mode === 'image' || mode === 'image-batch';
  const imageCount = mode === 'image-batch' ? 10 : 1;
  const restoreWorker = isImage ? installImagePreviewWorker() : () => {};
  const imageData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==';
  const imageBytes = Buffer.from(imageData, 'base64');
  const imageHash = new Bun.CryptoHasher('sha256').update(imageBytes).digest('hex');
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
  const session = {
    ...backgroundItem().rootSession,
    nextSeq: mode === 'mixed' ? '5' : groupedDiff ? '4' : '3',
  };
  let selected = 'root',
    revision = 1,
    published = false;
  const listeners = new Set<(event: NativeEvent) => void>();
  const requests: NativeRequest[] = [];
  const pending: (() => void)[] = [];
  const pendingTargets: (() => void)[] = [];
  const pendingBodies: (() => void)[] = [];
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection: 1,
      canReadModelOutput: false,
      session: {
        ...session,
        id: selected,
        rootSessionId: selected,
        nextSeq: selected === 'root' && !published ? '1' : session.nextSeq,
      },
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const messages = (): Message[] =>
    selected !== 'root'
      ? [
          {
            id: 'other',
            sessionId: selected,
            seq: '1',
            role: 'assistant',
            status: 'complete',
            runId: null,
            content: 'Other session',
          },
        ]
      : [
          {
            id: 'model',
            sessionId: 'root',
            seq: '1',
            role: 'assistant',
            status: 'complete',
            runId: null,
            content: isMail ? receiptContent : '',
            firstOutput: 'tool_calls',
            toolCalls: [
              {
                id: 'call',
                name: isMail ? 'task.message' : isImage ? 'files.view_images' : 'files.read',
                arguments: JSON.stringify({ path: 'MODEL_ARGS_SENTINEL' }),
              },
            ],
          },
          {
            id: 'receipt',
            sessionId: 'root',
            seq: '2',
            role: 'tool',
            status: 'complete',
            runId: null,
            sourceIds: ['execution'],
            toolCallId: 'call',
            content: receiptContent,
            ...(mode === 'unsupported' ? { contentFormat: 'unsupported' as const } : {}),
          },
          ...(groupedDiff
            ? [
                {
                  id: 'receipt-edit',
                  sessionId: 'root',
                  seq: '3',
                  role: 'tool' as const,
                  status: 'complete' as const,
                  runId: null,
                  sourceIds: ['execution-edit'],
                  content: original,
                },
              ]
            : []),
          ...(mode === 'mixed'
            ? ([
                {
                  id: 'failed-read',
                  sessionId: 'root',
                  seq: '3',
                  role: 'tool',
                  status: 'complete',
                  runId: null,
                  sourceIds: ['failed-execution'],
                  content: JSON.stringify({ path: 'failed.txt', error: 'file_not_found' }),
                },
                {
                  id: 'unverified',
                  sessionId: 'root',
                  seq: '4',
                  role: 'tool',
                  status: 'complete',
                  runId: null,
                  sourceIds: ['unknown-execution'],
                  content: 'PERMANENTLY_UNVERIFIED_ORIGINAL',
                },
              ] satisfies Message[])
            : []),
        ];
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
        case 'select':
          selected = request.sessionId;
          revision++;
          return state();
        case 'directory':
          return {
            storeId: 'store',
            sessions: [
              session,
              { ...session, id: 'other', rootSessionId: 'other', title: 'Other session' },
            ],
            workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
          };
        case 'messages':
          if (!request.upperSeq) throw Error('fixture_requires_history_upper_bound');
          return {
            messages: selected === 'root' && !published ? [] : messages(),
            nextAfterSeq: null,
            highWaterSeq: request.upperSeq,
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
        case 'toolMessages.list':
        case 'fileTargets.list':
        case 'fileChanges.list': {
          const captured = selected;
          return new Promise<NativeResult>((resolve, reject) =>
            (mode === 'mixed' && request.method === 'fileTargets.list'
              ? pendingTargets
              : pending
            ).push(() => {
              if (request.method === 'toolMessages.list' && mode === 'failed') {
                reject(Error('tool_metadata_unavailable'));
                return;
              }
              const entries = isDiff
                ? request.method === 'toolMessages.list'
                  ? diffIds.map((messageId, index) => ({
                      messageId,
                      executionId: index ? 'execution-edit' : 'execution',
                      definitionId: index || mode === 'edit-diff' ? 'files.edit' : 'files.write',
                      definitionVersion: '2',
                      status:
                        mode === 'failed-diff'
                          ? 'failed'
                          : mode === 'unknown-diff'
                            ? 'outcome_unknown'
                            : 'succeeded',
                      resultRevision: '1',
                      target: 'same.txt',
                    }))
                  : request.method === 'fileTargets.list' && confirmedDiff
                    ? diffIds.map((messageId, index) => ({
                        messageId,
                        changeId: `change-${messageId}`,
                        path: 'same.txt',
                        preview: 'available',
                        openable: true,
                        operation: index || mode === 'edit-diff' ? 'edit' : 'write',
                        snapshot: true,
                        diff: true,
                      }))
                    : []
                : mode === 'mixed'
                  ? request.method === 'fileTargets.list'
                    ? [
                        {
                          changeId: 'verified-output',
                          messageId: 'receipt',
                          path: 'delivered.txt',
                          preview: 'available',
                          openable: true,
                          operation: 'write',
                          snapshot: true,
                        },
                      ]
                    : request.method === 'toolMessages.list'
                      ? [
                          {
                            messageId: 'receipt',
                            executionId: 'execution',
                            definitionId: 'files.write',
                            definitionVersion: '2',
                            status: 'succeeded',
                            resultRevision: '1',
                            target: 'delivered.txt',
                          },
                          {
                            messageId: 'failed-read',
                            executionId: 'failed-execution',
                            definitionId: 'files.read',
                            definitionVersion: '4',
                            status: 'failed',
                            resultRevision: '1',
                            target: 'failed.txt',
                          },
                        ]
                      : []
                  : request.method === 'toolMessages.list' &&
                      (isMail ||
                        ['known', 'future', 'future-unknown', 'image', 'image-batch'].includes(
                          mode,
                        ))
                    ? [
                        {
                          messageId: 'receipt',
                          executionId: 'execution',
                          definitionId: isMail
                            ? 'task.message'
                            : isImage
                              ? 'files.view_images'
                              : mode === 'known'
                                ? 'files.read'
                                : 'future.tool',
                          definitionVersion:
                            isMail || isImage ? '1' : mode === 'known' ? '4' : '99',
                          status:
                            mode === 'mail-failed'
                              ? ('failed' as const)
                              : mode === 'future-unknown' || mode === 'mail-unknown'
                                ? ('outcome_unknown' as const)
                                : ('succeeded' as const),
                          resultRevision: '1',
                          ...(mode === 'mail' ? { agentMessageAccepted: true as const } : {}),
                          target: 'README.md',
                          ...(isImage
                            ? {
                                images: Array.from({ length: imageCount }, (_, i) => ({
                                  name: `scan-${i}.png`,
                                  reference: {
                                    mediaType: 'image/png',
                                    size: String(imageBytes.length),
                                  },
                                })),
                              }
                            : {}),
                        },
                      ]
                    : [];
              resolve({
                kind:
                  request.method === 'toolMessages.list'
                    ? 'toolMessages.page'
                    : request.method === 'fileTargets.list'
                      ? 'fileTargets.page'
                      : 'fileChanges.page',
                readId: request.readId,
                scope: {
                  generation: 1,
                  storeId: 'store',
                  sessionId: captured,
                  workspaceId: 'w',
                  viewSelection: request.viewSelection,
                  historyEpoch: request.historyEpoch,
                },
                entries,
              } as NativeResult);
            }),
          );
        }
        case 'input.image.open':
          return {
            kind: 'input.image.open',
            readId: request.readId,
            size: imageBytes.length,
            hash: imageHash,
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
        case 'fileChanges.detail':
          if (isDiff)
            return new Promise<NativeResult>((resolve) =>
              pendingBodies.push(() =>
                resolve({
                  kind: 'fileChanges.detail',
                  changeId: request.changeId,
                  text:
                    request.view === 'diff'
                      ? `--- a/same.txt\n+++ b/same.txt\n@@ -1 +1 @@\n-old-${request.changeId}\n+new-${request.changeId}\n`
                      : `SNAPSHOT_${request.changeId}`,
                  snapshot: request.view === 'snapshot',
                  nextOffset: null,
                }),
              ),
            );
          return {
            kind: 'fileChanges.detail',
            changeId: request.changeId,
            text: 'SAVED_DELIVERY_BYTES',
            snapshot: true,
            nextOffset: null,
          };
        default:
          return null;
      }
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 60 && !ready(); attempt++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  return {
    host,
    until,
    requests,
    settlePresentation: () => act(async () => nextDesktopPresentation(dom)),
    render: async () => {
      await act(async () => root.render(<NativeDesktop testDiagnostics={testDiagnostics} />));
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Original')
          ?.click();
      });
      // Establish the empty selected conversation before publishing an active
      // receipt. Initial historical recovery has its own presentation barrier;
      // this fixture exercises later receipts that must retain their reader.
      await until(
        () =>
          requests.some((request) => request.method === 'messages') &&
          !!host.querySelector('.conversation-viewport') &&
          !host.querySelector('.conversation-loading'),
      );
      await act(async () => {
        published = true;
        revision++;
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      });
      if (mode === 'unsupported') await act(async () => nextDesktopPresentation(dom));
      else await until(() => requests.some((request) => request.method === 'toolMessages.list'));
    },
    flush: () =>
      act(async () => {
        for (const release of [...pending.splice(0), ...pendingTargets.splice(0)]) release();
      }),
    flushBodies: () =>
      act(async () => {
        for (const release of pendingBodies.splice(0)) release();
      }),
    flushTargets: () =>
      act(async () => {
        for (const release of pendingTargets.splice(0)) release();
      }),
    toggle: () =>
      act(async () => {
        const button = host.querySelector<HTMLButtonElement>(
          'button.tool-activity-summary, .tool-diff-toggle',
        );
        expect(!!button).toBe(true);
        button!.click();
      }),
    selectOther: async () => {
      await act(async () => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent === 'Other session',
        );
        expect(!!button).toBe(true);
        button!.click();
      });
      await until(
        () =>
          !!host.querySelector('.conversation-viewport')?.textContent?.includes('Other session'),
      );
    },
    selectOriginal: async () => {
      await act(async () => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent === 'Original',
        );
        expect(!!button).toBe(true);
        button!.click();
      });
      await until(() => !!host.querySelector('.conversation .tool-activity'));
    },
    async close() {
      for (const release of [
        ...pending.splice(0),
        ...pendingTargets.splice(0),
        ...pendingBodies.splice(0),
      ])
        release();
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      restore();
      restoreWorker();
      Object.assign(globalThis, prior);
    },
  };
}

test('actual NativeDesktop keeps a raw tool receipt hidden while metadata readers are held, then displays the known concise tool', async () => {
  const f = fixture('known');
  try {
    await f.render();
    expect(f.requests.some((request) => request.method === 'toolMessages.list')).toBe(true);
    expect(f.requests.some((request) => request.method === 'fileTargets.list')).toBe(true);
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    await f.flush();
    expect(f.host.textContent).toContain('读取');
    expect(f.host.textContent).toContain('README.md');
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    expect(f.host.querySelector('.tool-activity')?.getAttribute('aria-label')).toBe(
      '已读取 · 成功',
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['mail', 'mail-unverified', 'mail-failed', 'mail-unknown'] as const) {
  test(`actual NativeDesktop ${mode} acknowledgment respects Main verification and preserves identical Model text`, async () => {
    const f = fixture(mode);
    const content = '{"accepted":true,"delivery":"queued"}';
    try {
      await f.render();
      expect(f.host.querySelector('.tool-activity')).toBeNull();
      expect(f.host.querySelector('.tool-detail')).toBeNull();
      expect(f.host.textContent).toContain(content);
      await f.flush();
      await f.settlePresentation();
      expect(f.host.textContent).toContain(content);
      if (mode === 'mail') {
        expect(f.host.querySelector('.tool-activity')).toBeNull();
        expect(f.host.querySelector('.tool-detail')).toBeNull();
      } else {
        expect(f.host.querySelector('.tool-activity')).not.toBeNull();
        await f.toggle();
        expect(f.host.querySelector('.tool-detail')!.textContent).toBe(content);
        if (mode === 'mail-unknown') expect(f.host.textContent).toContain('结果未知');
        if (mode === 'mail-failed')
          expect(f.host.querySelector('.tool-activity')!.getAttribute('aria-label')).toContain(
            '失败',
          );
      }
    } finally {
      await f.close();
    }
  });
}

for (const mode of ['known', 'mixed', 'image'] as const)
  test(`actual NativeDesktop keeps the ${mode} tool icon through cached return and held metadata`, async () => {
    const f = fixture(mode);
    try {
      await f.render();
      await f.flush();
      if (mode === 'image')
        await f.until(() => !!f.host.querySelector('.tool-image-thumbnails img'));
      if (mode === 'mixed') await f.toggle();
      await f.settlePresentation();
      const iconSelector =
        '.conversation .tool-activity :is(.tool-step-icon,.tool-activity-kind-icon)';
      const icons = [...f.host.querySelectorAll(iconSelector)];
      expect(icons.length).toBe(mode === 'mixed' ? 3 : 1);
      const drawings = icons.map((icon) => icon.innerHTML);
      const image = f.host.querySelector('.tool-image-thumbnails img');
      for (let round = 0; round < 3; round++) {
        await f.selectOther();
        const pendingReads = f.requests.filter(
          (request) => request.method === 'toolMessages.list',
        ).length;
        const imageReads = f.requests.filter(
          (request) => request.method === 'input.image.open',
        ).length;
        await f.selectOriginal();
        if (round === 0)
          await f.until(
            () =>
              f.requests.filter((request) => request.method === 'toolMessages.list').length >
              pendingReads,
          );
        else await f.settlePresentation();
        const pendingIcons = [...f.host.querySelectorAll(iconSelector)];
        expect(pendingIcons.map((icon) => icon.innerHTML)).toEqual(drawings);
        expect(pendingIcons.every((icon, index) => icon === icons[index])).toBe(true);
        if (mode === 'image') {
          expect(f.host.textContent).toContain('已查看 1 张图像');
          expect(f.host.querySelector('.tool-image-thumbnails img') === image).toBe(true);
          expect(
            f.requests.filter((request) => request.method === 'input.image.open'),
          ).toHaveLength(imageReads);
        }
        if (mode === 'mixed' && round === 0)
          expect(f.host.querySelector('.file-link') === null).toBe(true);
        // Leave once while metadata is still held; late reads belong to that retired scope.
        if (round > 0) await f.flush();
        const currentIcons = [...f.host.querySelectorAll(iconSelector)];
        expect(currentIcons.map((icon) => icon.innerHTML)).toEqual(drawings);
        expect(currentIcons.every((icon, index) => icon === icons[index])).toBe(true);
        await f.settlePresentation();
      }
    } finally {
      await f.close();
    }
  });

for (const count of [1, 10] as const)
  test(`actual NativeDesktop renders ${count} verified view_images thumbnails in its counted disclosure and removes them on session switch`, async () => {
    const f = fixture(count === 1 ? 'image' : 'image-batch');
    try {
      await f.render();
      await f.flush();
      await f.until(() => f.host.querySelectorAll('.tool-image-thumbnails img').length === count);
      expect(f.host.textContent).toContain(`已查看 ${count} 张图像`);
      expect(f.host.textContent).not.toContain(sentinel);
      expect(f.host.querySelectorAll('.tool-image-thumbnails img')).toHaveLength(count);
      await f.toggle();
      await f.until(() => !f.host.querySelector('.tool-image-thumbnails img'));
      expect(f.host.textContent).toContain(`已查看 ${count} 张图像`);
      await f.toggle();
      await f.until(() => f.host.querySelectorAll('.tool-image-thumbnails img').length === count);
      await f.selectOther();
      expect(f.host.querySelector('.tool-image-thumbnails img')).toBeNull();
    } finally {
      await f.close();
    }
  });

for (const mode of ['empty', 'failed', 'unsupported'] as const) {
  test(`actual NativeDesktop ${mode} metadata withholds the complete tool row until its input and receipt identity can be verified`, async () => {
    const f = fixture(mode);
    try {
      await f.render();
      await f.flush();
      expect(f.host.querySelector('.tool-activity')).toBeNull();
      expect(f.host.textContent).not.toContain(sentinel);
      expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
      expect(f.host.textContent).not.toContain('状态待核对');
      expect(f.host.textContent).not.toContain('结果未知');
      await f.selectOther();
      expect(f.host.textContent).toContain('Other session');
      expect(f.host.textContent).not.toContain(sentinel);
    } finally {
      await f.close();
    }
  });
}
for (const mode of ['future'] as const) {
  test(`actual NativeDesktop ${mode} metadata keeps original receipt available only after explicit expansion and scoped to its session`, async () => {
    const f = fixture(mode);
    try {
      await f.render();
      await f.flush();
      expect(f.host.textContent).not.toContain(sentinel);
      expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
      expect(f.host.textContent).not.toContain('状态待核对');
      expect(f.host.textContent).not.toContain('结果未知');
      await f.toggle();
      expect(f.host.textContent).toContain(original);
      await f.toggle();
      expect(f.host.textContent).not.toContain(sentinel);
      await f.toggle();
      expect(f.host.textContent).toContain(sentinel);
      await f.selectOther();
      expect(f.host.textContent).toContain('Other session');
      expect(f.host.textContent).not.toContain(sentinel);
    } finally {
      await f.close();
    }
  });
}

test('actual NativeDesktop preserves a verified future tool outcome_unknown instead of the unverified metadata hint', async () => {
  const f = fixture('future-unknown');
  try {
    await f.render();
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    expect(f.host.textContent).not.toContain(sentinel);
    await f.flush();
    expect(f.host.textContent).toContain('future.tool');
    expect(f.host.textContent).not.toContain('future.tool · 99');
    expect(f.host.textContent).toContain('结果未知');
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain(sentinel);
    await f.toggle();
    expect(f.host.textContent).toContain(original);
    await f.toggle();
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).toContain('结果未知');
  } finally {
    await f.close();
  }
});

test('isolated Native diagnostics also wait for complete tool metadata without publishing a partial tool row', async () => {
  const f = fixture('known', true);
  try {
    await f.render();
    expect(f.host.querySelector('.tool-activity')).toBeNull();
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain('结果未知');
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
    await f.flush();
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.querySelector('.tool-activity')?.getAttribute('aria-label')).toBe(
      '已读取 · 成功',
    );
    expect(f.host.textContent).not.toContain(sentinel);
  } finally {
    await f.close();
  }
});

test('a permanently unverified mixed tool preserves its verified sibling file action and mounted delivery', async () => {
  const f = fixture('mixed');
  try {
    await f.render();
    expect(f.host.querySelector('.tool-activity')).toBeNull();
    await f.flush();
    const aggregate = f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!;
    expect(aggregate.textContent).toContain('编辑文件');
    expect(aggregate.textContent).toContain('读取文件');
    await f.toggle();
    await f.flushTargets();
    expect(f.host.querySelector('.tool-activity-summary')).toBe(aggregate);
    const file = f.host.querySelector<HTMLButtonElement>('.tool-activity-steps button.file-link')!;
    expect(file.textContent).toBe('delivered.txt');
    const delivery = [...f.host.querySelectorAll<HTMLDetailsElement>('details')].find(
      (element) => element.querySelector('summary')?.textContent === '查看本次交付的文件',
    )!;
    expect(delivery).toBeDefined();
    await act(async () => {
      delivery.open = true;
      delivery.dispatchEvent(new f.host.ownerDocument.defaultView!.Event('toggle'));
    });
    expect(delivery.textContent).toContain('SAVED_DELIVERY_BYTES');
    const body = delivery.querySelector('pre');
    expect(body).not.toBeNull();
    await f.flush();
    expect(f.host.querySelector('.tool-activity-summary')).toBe(aggregate);
    expect(f.host.querySelector('.tool-activity-steps button.file-link')).toBe(file);
    expect(delivery.isConnected).toBe(true);
    expect(delivery.querySelector('pre')).toBe(body);
    expect(delivery.open).toBe(true);
    expect(f.host.querySelectorAll('.tool-activity-steps button.file-link')).toHaveLength(1);
    const failed = [...f.host.querySelectorAll('.tool-activity-steps > .tool-activity')].find(
      (node) => node.textContent?.includes('failed.txt'),
    );
    expect(failed?.textContent).toContain('failed.txt');
    expect(failed?.querySelector('button.file-link')).toBeNull();
    expect(f.host.textContent).not.toContain('PERMANENTLY_UNVERIFIED_ORIGINAL');
    const originalReader = [
      ...f.host.querySelectorAll<HTMLButtonElement>(
        '.tool-activity-steps button.tool-activity-summary',
      ),
    ].find((button) => button.textContent?.includes('工具结果'))!;
    expect(originalReader).toBeUndefined();
    expect(f.host.textContent).not.toContain('PERMANENTLY_UNVERIFIED_ORIGINAL');
    expect(delivery.querySelector('pre')).toBe(body);
    await act(async () => file.click());
    expect(f.requests.filter((request) => request.method === 'fileChanges.open')).toEqual([
      { method: 'fileChanges.open', generation: 1, changeId: 'verified-output', editor: 'vscode' },
    ]);
  } finally {
    await f.close();
  }
});

for (const mode of ['write-diff', 'edit-diff'] as const) {
  test(`actual NativeDesktop ${mode} lazily reads operation diff independently of delivery snapshot`, async () => {
    const f = fixture(mode);
    const bodies = () => f.requests.filter((request) => request.method === 'fileChanges.detail');
    try {
      await f.render();
      expect(bodies()).toHaveLength(0);
      await f.flush();
      expect(f.host.textContent).toContain('same.txt');
      expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
      expect(bodies()).toHaveLength(0);
      await f.toggle();
      expect(bodies()).toHaveLength(1);
      expect(bodies()[0]).toMatchObject({ changeId: 'change-receipt', view: 'diff' });
      expect(f.host.textContent).toContain('正在读取本次差异');
      await f.flushBodies();
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('new-change-receipt');
      expect(f.host.textContent).not.toContain('SNAPSHOT_');
      const disclosure = [...f.host.querySelectorAll('details')].find(
        (node) => node.querySelector('summary')?.textContent === '查看本次交付的文件',
      );
      expect(disclosure).toBeDefined();
      await act(async () => {
        disclosure!.open = true;
        disclosure!.dispatchEvent(new f.host.ownerDocument.defaultView!.Event('toggle'));
      });
      expect(bodies()).toHaveLength(2);
      expect(bodies()[1]).toMatchObject({ changeId: 'change-receipt', view: 'snapshot' });
      await f.flushBodies();
      expect(disclosure!.textContent).toContain('SNAPSHOT_change-receipt');
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('new-change-receipt');
      for (let round = 0; round < 3; round++) {
        await f.toggle();
        expect(f.host.querySelector('.tool-diff-toggle')?.getAttribute('aria-expanded')).toBe(
          'false',
        );
        await f.toggle();
        expect(f.host.querySelector('.tool-diff-toggle')?.getAttribute('aria-expanded')).toBe(
          'true',
        );
        await f.flushBodies();
        expect(f.host.querySelector('.tool-activity')?.textContent).toContain('new-change-receipt');
        expect(disclosure!.textContent).toContain('SNAPSHOT_change-receipt');
      }
      expect(bodies().filter((request) => request.view === 'snapshot')).toHaveLength(1);
      expect(f.requests.some((request) => request.method === 'fileChanges.open')).toBe(false);
    } finally {
      await f.close();
    }
  });
}

test('actual NativeDesktop grouped operations on the same path read distinct receipt diffs only when each item opens', async () => {
  const f = fixture('group-diff');
  const bodies = () => f.requests.filter((request) => request.method === 'fileChanges.detail');
  try {
    await f.render();
    await f.flush();
    expect(bodies()).toHaveLength(0);
    await f.toggle();
    expect(bodies()).toHaveLength(0);
    const items = [
      ...f.host.querySelectorAll<HTMLButtonElement>('.tool-activity-steps .tool-diff-toggle'),
    ];
    expect(items).toHaveLength(2);
    await act(async () => items[0]!.click());
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({ changeId: 'change-receipt', view: 'diff' });
    await f.flushBodies();
    expect(f.host.textContent).toContain('new-change-receipt');
    expect(f.host.textContent).not.toContain('new-change-receipt-edit');
    await act(async () => items[1]!.click());
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1]).toMatchObject({ changeId: 'change-receipt-edit', view: 'diff' });
    await f.flushBodies();
    expect(items[0]!.closest('.tool-activity')?.textContent).toContain('new-change-receipt');
    expect(items[1]!.closest('.tool-activity')?.textContent).toContain('new-change-receipt-edit');
  } finally {
    await f.close();
  }
});

for (const mode of ['failed-diff', 'unknown-diff'] as const) {
  test(`actual NativeDesktop ${mode} does not infer confirmed changes from tool arguments or raw receipt`, async () => {
    const f = fixture(mode);
    try {
      await f.render();
      await f.flush();
      await f.toggle();
      expect(f.requests.filter((request) => request.method === 'fileChanges.detail')).toHaveLength(
        0,
      );
      expect(f.host.querySelector('.tool-activity')?.getAttribute('aria-label')).toContain(
        mode === 'failed-diff' ? '失败' : '结果未知',
      );
      expect(f.host.textContent).not.toContain('查看本次交付的文件');
      expect(f.host.textContent).not.toContain('正在读取本次差异');
    } finally {
      await f.close();
    }
  });
}

test('actual NativeDesktop ignores a late operation diff body after switching sessions', async () => {
  const f = fixture('write-diff');
  try {
    await f.render();
    await f.flush();
    await f.toggle();
    const request = f.requests.find((request) => request.method === 'fileChanges.detail');
    expect(request).toMatchObject({ changeId: 'change-receipt', view: 'diff' });
    await f.selectOther();
    await f.flushBodies();
    expect(f.host.querySelector('.conversation-viewport')?.textContent).toContain('Other session');
    expect(f.host.querySelector('.conversation-viewport')?.textContent).not.toContain(
      'new-change-receipt',
    );
    expect(f.host.querySelector('.conversation-viewport')?.textContent).not.toContain('SNAPSHOT_');
  } finally {
    await f.close();
  }
});
