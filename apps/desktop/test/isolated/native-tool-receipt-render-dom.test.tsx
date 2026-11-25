import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { shellOutputPreview } from '@kite-ai/trajectory';
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
  | 'web-search'
  | 'web-search-legacy'
  | 'web-search-wrong-owner'
  | 'web-search-missing'
  | 'web-search-read-failure'
  | 'web-search-trace'
  | 'web-search-many'
  | 'write-diff'
  | 'write-error-diff'
  | 'write-unavailable-diff'
  | 'write-readonly-error-diff'
  | 'write-readonly-unavailable-diff'
  | 'edit-diff'
  | 'group-diff'
  | 'failed-diff'
  | 'unknown-diff'
  | 'known'
  | 'empty'
  | 'failed'
  | 'shell-deferred'
  | 'shell-saved-preview'
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
  const webSearch = mode.startsWith('web-search');
  const isDiff = mode.endsWith('-diff');
  const groupedDiff = mode === 'group-diff';
  const inTurn =
    mode === 'web-search-trace' || groupedDiff || mode === 'edit-diff' || mode === 'mixed';
  const diffIds = groupedDiff ? ['receipt', 'receipt-edit'] : ['receipt'];
  const confirmedDiff = isDiff && !['failed-diff', 'unknown-diff'].includes(mode);
  const isMail = mode.startsWith('mail');
  const savedShell = mode === 'shell-saved-preview';
  const deferredShell = mode === 'shell-deferred' || savedShell;
  const shellOutput = `首段输出\n${'output head\n'.repeat(4000)}${sentinel}\n${'output tail\n'.repeat(4000)}尾段输出\n`;
  const shellDetails = {
    rawReceiptMarker: sentinel,
    ref: {
      extensionId: 'builtin.shell',
      key: 'shell-fixture',
      sessionId: 'root',
      originStoreId: 'store',
      executionId: 'job',
    },
    execution: {
      id: 'job',
      sessionId: 'root',
      originStoreId: 'store',
      kind: 'job',
      definitionId: 'shell.command',
      definitionVersion: '1',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'Shell succeeded', details: { exitCode: 0 } },
    },
    stdout: shellOutput,
    stderr: '',
    stdoutBytes: String(Buffer.byteLength(shellOutput)),
    stderrBytes: '0',
    truncated: true,
    droppedBytes: '123',
  };
  const expectedShellOutput = shellOutputPreview(
    shellDetails,
    'job',
    savedShell ? 20000 : undefined,
  )!.text;
  const shellReceipt = Buffer.from(savedShell ? expectedShellOutput : JSON.stringify(shellDetails));
  const shellHash = new Bun.CryptoHasher('sha256').update(shellReceipt).digest('hex');
  const receiptContent = deferredShell
    ? shellReceipt.toString('utf8', 0, 2048)
    : isMail
      ? '{"accepted":true,"delivery":"queued"}'
      : original;
  const isImage = mode === 'image' || mode === 'image-batch';
  const imageCount = mode === 'image-batch' ? 10 : 1;
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

  const restoreWorker = isImage ? installImagePreviewWorker() : () => {};
  const session = {
    ...backgroundItem().rootSession,
    nextSeq: mode === 'mixed' ? '5' : groupedDiff ? '4' : '3',
  };
  let selected = 'root',
    revision = 1,
    published = false;
  let fileOpenable = !mode.includes('readonly');
  let shellOutputUnavailable = false;
  let shellFailure: { output: string; reason: string } | undefined;
  const listeners = new Set<(event: NativeEvent) => void>();
  const requests: NativeRequest[] = [];
  const pending: (() => void)[] = [];
  const pendingTargets: (() => void)[] = [];
  const pendingBodies: (() => void)[] = [];
  const firstSearchRead = Promise.withResolvers<void>();
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
      canReadWebSearchEvidence: webSearch && mode !== 'web-search-legacy',
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
            runId: inTurn ? 'grouped-run' : null,
            content: isMail ? receiptContent : '',
            firstOutput: 'tool_calls',
            toolCalls: [
              {
                id: 'call',
                name: webSearch
                  ? 'web_search'
                  : deferredShell
                    ? 'shell.execute'
                    : isMail
                      ? 'task.message'
                      : isImage
                        ? 'files.view_images'
                        : mode === 'mixed'
                          ? 'files.write'
                          : 'files.read',
                arguments: JSON.stringify({ path: 'MODEL_ARGS_SENTINEL' }),
              },
              ...(mode === 'mixed'
                ? [
                    { id: 'failed-call', name: 'files.read', arguments: '{"path":"failed.txt"}' },
                    { id: 'unknown-call', name: 'foreign_tool', arguments: '{}' },
                  ]
                : []),
            ],
          },
          {
            id: 'receipt',
            sessionId: 'root',
            seq: '2',
            role: 'tool',
            status: 'complete',
            runId: inTurn ? 'grouped-run' : null,
            sourceIds: [mode === 'web-search-wrong-owner' ? 'unrelated' : 'execution'],
            toolCallId: 'call',
            content: receiptContent,
            ...(deferredShell
              ? { deferredText: { bytes: String(shellReceipt.length), sha256: shellHash } }
              : {}),
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
                  runId: 'grouped-run',
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
                  runId: 'grouped-run',
                  toolCallId: 'failed-call',
                  sourceIds: ['failed-execution'],
                  content: JSON.stringify({ path: 'failed.txt', error: 'file_not_found' }),
                },
                {
                  id: 'unverified',
                  sessionId: 'root',
                  seq: '4',
                  role: 'tool',
                  status: 'complete',
                  runId: 'grouped-run',
                  toolCallId: 'unknown-call',
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
        case 'webSearch.evidence':
          if (
            mode === 'web-search' &&
            requests.filter((r) => r.method === 'webSearch.evidence').length === 1
          )
            await firstSearchRead.promise;
          if (mode === 'web-search-missing') return { kind: 'webSearch.evidence', evidence: null };
          if (mode === 'web-search-read-failure') {
            if (requests.filter((r) => r.method === 'webSearch.evidence').length === 1)
              throw Error('PRIVATE_TRANSPORT_ERROR');
            return {
              kind: 'webSearch.evidence',
              evidence: {
                executionId: request.executionId,
                revision: 1,
                route: 'provider',
                status: 'completed',
                sources: [],
                citations: [],
                blocks: [],
              },
            };
          }
          return {
            kind: 'webSearch.evidence',
            evidence: {
              executionId: request.executionId,
              revision: 1,
              route: 'provider',
              status: 'completed',
              query: 'fixture',
              truncated: true,
              sources:
                mode === 'web-search-many'
                  ? Array.from({ length: 9 }, (_, i) => ({
                      url: `https://safe.example/${i}`,
                      title: `资料 ${i + 1}`,
                      snippet: `摘要 ${i + 1}`,
                    }))
                  : [
                      {
                        url: 'https://example.test/source',
                        title: '<img src=x>',
                        snippet: '甲'.repeat(600),
                      },
                      { url: 'javascript:alert(1)', title: 'BAD_LINK' },
                      { url: 'https://example.test/source', title: 'duplicate' },
                    ],
              citations: [],
              blocks: [],
            },
          };
        case 'messages.text':
          throw Error('unexpected_shell_read');
        case 'toolMessages.runs':
          return {
            kind: 'toolMessages.runs',
            readId: request.readId,
            scope: {
              generation: 1,
              viewSelection: request.viewSelection,
              historyEpoch: request.historyEpoch,
              storeId: 'store',
              sessionId: selected,
              workspaceId: 'w',
            },
            runs:
              inTurn && selected === 'root'
                ? [
                    {
                      id: 'grouped-run',
                      originStoreId: 'store',
                      sessionId: 'root',
                      status: 'completed',
                      isActive: false,
                      createdAt: 1000,
                      finishedAt: 3000,
                      reason: null,
                    },
                  ]
                : [],
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
                      definitionId:
                        groupedDiff || mode === 'edit-diff' ? 'files.edit' : 'files.write',
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
                    ? diffIds.map((messageId) => ({
                        messageId,
                        changeId: `change-${messageId}`,
                        path: 'same.txt',
                        preview: mode.includes('unavailable') ? 'unavailable' : 'available',
                        openable: fileOpenable,
                        operation: groupedDiff || mode === 'edit-diff' ? 'edit' : 'write',
                        snapshot: true,
                        diff: true,
                        ...(groupedDiff || mode === 'edit-diff'
                          ? { diffCounts: { added: 1, removed: 1 } }
                          : {}),
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
                  : request.method === 'toolMessages.list' && deferredShell
                    ? [
                        {
                          messageId: 'receipt',
                          executionId: 'execution',
                          definitionId: 'shell.execute',
                          definitionVersion: '1',
                          status: shellFailure ? 'failed' : 'succeeded',
                          resultRevision: '1',
                          target: '命令描述',
                          shellResultVerified: true,
                          ...(shellOutputUnavailable
                            ? { shellOutputError: true }
                            : {
                                shellDisplay: {
                                  jobStatus: shellFailure ? 'failed' : 'succeeded',
                                  exitCode: shellFailure ? 1 : 0,
                                  outputComplete: false,
                                  output: shellFailure?.output ?? expectedShellOutput,
                                  failureReason: shellFailure?.reason,
                                },
                              }),
                          shellInput: {
                            operation: 'execute',
                            shellId: 'shell-fixture',
                            command: 'Get-Location',
                            commandOffset: 0,
                            commandNextOffset: null,
                          },
                        },
                      ]
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
                entries: webSearch
                  ? request.method === 'toolMessages.list'
                    ? [
                        {
                          messageId: 'receipt',
                          executionId: 'execution',
                          definitionId: 'web.search',
                          target: 'fixture',
                          definitionVersion: '1',
                          status: 'succeeded',
                          resultRevision: '1',
                        },
                      ]
                    : []
                  : entries,
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
            return new Promise<NativeResult>((resolve, reject) =>
              pendingBodies.push(() => {
                if (mode.includes('error') && request.view === 'diff') {
                  reject(Error('file_change_read_failed'));
                  return;
                }
                resolve({
                  kind: 'fileChanges.detail',
                  changeId: request.changeId,
                  text:
                    request.view === 'diff'
                      ? `--- a/same.txt\n+++ b/same.txt\n@@ -1 +1 @@\n-old-${request.changeId}\n+new-${request.changeId}\n`
                      : `SNAPSHOT_${request.changeId}`,
                  snapshot: request.view === 'snapshot',
                  nextOffset: null,
                });
              }),
            );
          if (request.view === 'diff')
            return { kind: 'fileChanges.detail', changeId: request.changeId };
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
    expectedShellOutput,
    releaseFirstSearchRead: () => act(async () => firstSearchRead.resolve()),
    setFileOpenable: (openable: boolean) => {
      fileOpenable = openable;
    },
    setShellOutputUnavailable: (unavailable: boolean) => {
      shellOutputUnavailable = unavailable;
    },
    setShellFailure: (output: string, reason: string) => {
      shellFailure = { output, reason };
    },
    settlePresentation: () => act(async () => nextDesktopPresentation(dom)),
    openTurn: async () => {
      const elapsed = () =>
        [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
          button.textContent?.startsWith('用时'),
        );
      await until(() => !!elapsed());
      await act(async () => elapsed()!.click());
    },
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
          'button.tool-activity-summary, button.tool-file-disclosure',
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
      await until(
        () => !!host.querySelector('.conversation :is(.tool-activity,.conversation-trace)'),
      );
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
      if (mode === 'mixed') {
        await f.openTurn();
        const trace = f.host.querySelector<HTMLButtonElement>('.conversation-trace-trigger')!;
        await act(async () => trace.click());
      }
      await f.settlePresentation();
      const iconSelector =
        '.conversation .tool-activity :is(.tool-step-icon,.tool-activity-kind-icon), .conversation-trace-trigger [data-slot="trace-icon"]:not(.conversation-trace-chevron)';
      const icons = [...f.host.querySelectorAll(iconSelector)];
      expect(icons.length).toBe(mode === 'mixed' ? 3 : 1);
      const drawings = icons.map((icon) => icon.innerHTML);
      const image = f.host.querySelector('.tool-image-thumbnails img');
      const fileHeading = f.host.querySelector('.tool-edit-heading');
      if (mode === 'mixed')
        expect(!!fileHeading?.querySelector('.tool-file-disclosure')).toBe(true);
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
        if (mode === 'mixed' && round === 0) {
          expect(f.host.querySelector('.tool-edit-heading')).toBe(fileHeading);
          expect(fileHeading?.querySelector('.tool-file-disclosure')).toBeNull();
          expect(f.host.querySelector('.file-link') === null).toBe(true);
        }
        // Leave once while metadata is still held; late reads belong to that retired scope.
        if (round > 0) await f.flush();
        const currentIcons = [...f.host.querySelectorAll(iconSelector)];
        expect(currentIcons.map((icon) => icon.innerHTML)).toEqual(drawings);
        expect(currentIcons.every((icon, index) => icon === icons[index])).toBe(true);
        if (mode === 'mixed' && round > 0) {
          expect(f.host.querySelector('.tool-edit-heading')).toBe(fileHeading);
          expect(!!fileHeading?.querySelector('.tool-file-disclosure')).toBe(true);
        }
        await f.settlePresentation();
      }
    } finally {
      await f.close();
    }
  });

for (const mode of ['web-search', 'web-search-legacy', 'web-search-wrong-owner'] as const)
  test(`actual NativeDesktop ordinary non-deferred ${mode} shows only original bounded sources after opening, without querying`, async () => {
    const f = fixture(mode);
    const reads = () => f.requests.filter((r) => r.method === 'webSearch.evidence');
    try {
      await f.render();
      await f.flush();
      if (mode === 'web-search-wrong-owner') {
        await f.settlePresentation();
        expect(f.host.querySelector('.tool-activity')).toBeNull();
        expect(reads()).toHaveLength(0);
        return;
      }
      await f.until(() => !!f.host.querySelector('button.tool-activity-summary'));
      expect(f.host.querySelector('button.tool-activity-summary')?.textContent).toContain('搜索了');
      expect(reads()).toHaveLength(0);
      await f.toggle();
      await f.settlePresentation();
      if (mode === 'web-search') {
        await f.until(() => reads().length === 1);
        expect(f.host.querySelector('.tool-activity-content')?.textContent?.trim()).toBe('');
        await f.releaseFirstSearchRead();
        await f.until(() => !!f.host.querySelector('.web-search-sources a'));
        expect(reads()).toEqual([
          {
            method: 'webSearch.evidence',
            generation: 1,
            viewSelection: 1,
            expectedStoreId: 'store',
            sessionId: 'root',
            executionId: 'execution',
          },
        ]);
        const a = f.host.querySelector<HTMLAnchorElement>('.web-search-sources a')!;
        expect(a.querySelector('.search-source-title')?.textContent).toBe('<img src=x>');
        expect(a.href).toBe('https://example.test/source');
        expect(a.rel).toContain('noopener');
        expect(f.host.querySelectorAll('.web-search-sources a')).toHaveLength(1);
        expect(f.host.textContent).not.toContain('仅显示部分搜索材料');
        expect(f.host.querySelector('.web-search-sources img, .tool-activity pre')).toBeNull();
        expect(f.host.querySelector('.web-search-snippet')).toBeNull();
        const toggle = [...f.host.querySelectorAll('button')].find(
          (b) => b.textContent === '来源详情',
        )!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(f.host.querySelector('.web-search-snippet')?.textContent).toHaveLength(320);
        expect(f.host.textContent).toContain('example.test');
        expect(f.host.textContent).not.toContain('BAD_LINK');
        expect(f.host.textContent).not.toContain('正文引用');
        expect(f.host.textContent).not.toContain(sentinel);
        await f.toggle();
        await f.settlePresentation();
        expect(reads()).toHaveLength(1);
        await f.toggle();
        await f.until(() => reads().length === 2);
        await f.selectOther();
        expect(f.host.querySelector('.web-search-sources')).toBeNull();
      } else {
        expect(reads()).toHaveLength(0);
        expect(f.host.textContent).not.toContain(sentinel);
        if (mode === 'web-search-legacy')
          expect(f.host.textContent).toContain('不支持查看搜索来源');
      }
      expect(
        f.requests.filter(
          (r) => r.method === 'webSearch.settings.test' || r.method === 'messages.text',
        ),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

for (const mode of ['web-search-missing', 'web-search-read-failure', 'web-search-trace'] as const)
  test(`actual NativeDesktop ${mode}: absent vs failed vs verified sources; collapsed prior trace never reads by model ID`, async () => {
    const f = fixture(mode),
      reads = () => f.requests.filter((r) => r.method === 'webSearch.evidence');
    try {
      await f.render();
      await f.flush();
      await f.settlePresentation();
      expect(reads()).toHaveLength(0);
      if (mode === 'web-search-trace') {
        await f.openTurn();
        expect(reads()).toHaveLength(0);
        const trigger = f.host.querySelector<HTMLButtonElement>(
          '.conversation-trace .tool-activity-summary',
        )!;
        expect(f.host.querySelector('.conversation-trace-trigger')).toBeNull();
        expect(trigger.textContent).toContain('搜索了');
        expect(trigger.textContent).toContain('fixture');
        await act(async () => trigger.click());
      } else await f.toggle();
      await f.until(() => reads().length === 1);
      if (mode === 'web-search-missing')
        expect(f.host.querySelector('.tool-activity-content')?.textContent?.trim()).toBe('');
      if (mode === 'web-search-read-failure') {
        expect(f.host.textContent).not.toContain('PRIVATE_TRANSPORT_ERROR');
        const body = () => f.host.querySelector('.tool-activity-content');
        expect(body()?.textContent?.trim()).toBe('暂时无法读取搜索来源。');
        expect(body()?.querySelector('button')).toBeNull();
        await f.toggle();
        await f.settlePresentation();
        expect(reads()).toHaveLength(1);
        await f.toggle();
        await f.until(() => reads().length === 2);
        expect(body()?.textContent?.trim()).toBe('');
      }
      if (mode === 'web-search-trace') {
        expect(f.host.querySelector('.conversation-trace .web-search-sources a')).not.toBeNull();
        expect(
          f.host.querySelector('.conversation-trace')!.textContent!.match(/搜索了/g),
        ).toHaveLength(1);
        expect(
          f.host.querySelector('.conversation-trace')!.textContent!.match(/fixture/g),
        ).toHaveLength(1);
        expect(reads()[0]).toMatchObject({ executionId: 'execution', sessionId: 'root' });
      }
      expect(f.host.textContent).not.toContain(sentinel);
      expect(f.requests.some((r) => r.method === 'webSearch.settings.test')).toBe(false);
    } finally {
      await f.close();
    }
  });
test('many verified search results: eight wrapping sources first; showing more or abstracts is local and reversible', async () => {
  const f = fixture('web-search-many');
  try {
    await f.render();
    await f.flush();
    await f.toggle();
    await f.until(() => !!f.host.querySelector('.search-source-link'));
    const sources = () => Array.from(f.host.querySelectorAll('.search-source-link'));
    const button = (t: string) =>
      Array.from(f.host.querySelectorAll('button')).find((b) => b.textContent === t)!;
    expect(sources()).toHaveLength(8);
    expect(f.host.querySelector('.search-receipt-list')?.getAttribute('aria-label')).toContain(
      '9 个来源',
    );
    expect(f.host.querySelector('.search-source-index, .search-source-domain')).toBeNull();
    await act(async () => button('显示其余 1 个来源').click());
    expect(sources()).toHaveLength(9);
    expect(sources().at(-1)?.getAttribute('href')).toBe('https://safe.example/8');
    await act(async () => button('来源详情').click());
    expect(f.host.querySelectorAll('.web-search-snippet')).toHaveLength(9);
    await act(async () => button('收起更多来源').click());
    expect(f.host.querySelectorAll('.web-search-snippet')).toHaveLength(8);
    expect(f.requests.filter((r) => r.method === 'webSearch.evidence')).toHaveLength(1);
    expect(f.requests.some((r) => r.method === 'webSearch.settings.test')).toBe(false);
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

for (const mode of ['shell-deferred', 'shell-saved-preview'] as const)
  test(`expanded ${mode} shows the complete model output without a body request`, async () => {
    const f = fixture(mode);
    const bodyReads = () => f.requests.filter((request) => request.method === 'messages.text');
    const output = () => f.host.querySelector('.shell-output');
    const retry = () =>
      [...(output()?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === '重试',
      );
    const expectNoReceipt = () => {
      expect(f.host.textContent).not.toContain(sentinel);
      expect(f.host.textContent).not.toContain('正在读取输出');
      expect(f.host.textContent).not.toContain('读取完整记录');
      expect(f.host.textContent).not.toContain('上一段');
      expect(f.host.textContent).not.toContain('下一段');
      expect(f.host.textContent).not.toContain('输出已截断');
    };
    try {
      await f.render();
      await f.flush();
      expect(bodyReads()).toEqual([]);
      expectNoReceipt();
      expect(f.host.textContent).not.toContain('首段输出');
      const metadataReads = f.requests.filter(
        (request) => request.method === 'toolMessages.list',
      ).length;

      await f.toggle();
      expect(output()?.querySelector('.shell-command-text')?.textContent).toBe('Get-Location');
      expect(output()?.querySelector('.shell-console-output')?.textContent).toStartWith(
        '首段输出\n',
      );
      expect(output()?.querySelector('.shell-console-output')?.textContent).toBe(
        f.expectedShellOutput,
      );
      expect(retry()).toBeUndefined();
      expectNoReceipt();
      await f.toggle();
      await f.settlePresentation();
      await f.toggle();
      expect(output()?.querySelector('.shell-console-output')?.textContent).toBe(
        f.expectedShellOutput,
      );
      expect(bodyReads()).toEqual([]);
      expect(f.requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(
        metadataReads,
      );
    } finally {
      await f.close();
    }
  });

test('an unavailable saved Shell receipt shows its original card without a retry action', async () => {
  const f = fixture('shell-saved-preview');
  f.setShellOutputUnavailable(true);
  try {
    await f.render();
    await f.flush();
    await f.toggle();
    const card = f.host.querySelector('.shell-output');
    expect(card).not.toBeNull();
    expect(
      [...card!.querySelectorAll('button')].some((button) => button.textContent === '重试'),
    ).toBe(false);
    expect(card?.textContent).toContain('无法读取已保存的输出');
    expect(card?.textContent).not.toContain(sentinel);
    expect(card?.querySelector('.shell-console-output')?.textContent).toBeFalsy();
    expect(f.requests.filter((request) => request.method === 'messages.text')).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const output of ['', 'command output\n'])
  test(`a failed saved Shell receipt keeps its reason separate from ${output ? 'the original output' : 'empty output'}`, async () => {
    const f = fixture('shell-saved-preview');
    const preview = shellOutputPreview({ stderr: output }, 'job', undefined)!;
    f.setShellFailure(preview.text, '原 Shell 启动失败');
    try {
      await f.render();
      await f.flush();
      expect(f.host.textContent).not.toContain('原 Shell 启动失败');
      await f.toggle();
      const card = f.host.querySelector('.shell-output');
      expect(card?.querySelector('.shell-console-output')?.textContent).toBe(output);
      expect(card?.querySelector('.shell-failure-reason')?.textContent).toBe('原 Shell 启动失败');
      expect(card?.textContent).not.toContain('重试');
      expect(f.requests.filter((request) => request.method === 'messages.text')).toEqual([]);
      await f.toggle();
      expect(f.host.textContent).not.toContain('原 Shell 启动失败');
    } finally {
      await f.close();
    }
  });

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
    expect(f.host.textContent).not.toContain('结果未知');
    expect(f.host.textContent).not.toContain('状态待核对');
    expect(f.host.textContent).not.toContain(sentinel);
    await f.toggle();
    expect(f.host.textContent).toContain(original);
    expect(f.host.querySelector('.tool-detail-status')?.textContent).toBe('结果未知');
    await f.toggle();
    expect(f.host.textContent).not.toContain(sentinel);
    expect(f.host.textContent).not.toContain('结果未知');
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

test('a permanently unverified mixed tool preserves its verified sibling file action without a duplicate delivery viewer', async () => {
  const f = fixture('mixed');
  try {
    await f.render();
    expect(f.host.querySelector('.tool-activity')).toBeNull();
    await f.flush();
    await f.openTurn();
    const aggregate = f.host.querySelector<HTMLButtonElement>('.conversation-trace-trigger')!;
    expect(aggregate.textContent).toBe('写入了文件');
    await act(async () => aggregate.click());
    await f.flushTargets();
    expect(f.host.querySelector('.conversation-trace-trigger') === aggregate).toBe(true);
    const disclosure = f.host.querySelector<HTMLButtonElement>(
      '.conversation-trace-steps button.tool-file-disclosure',
    )!;
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(f.requests.filter((request) => request.method === 'fileChanges.detail')).toHaveLength(0);
    await act(async () => disclosure.click());
    const file = f.host.querySelector<HTMLButtonElement>(
      '.conversation-trace-steps button.file-diff-path.file-link',
    )!;
    expect(file.textContent).toBe('delivered.txt');
    expect(f.host.textContent).not.toContain('查看本次交付的文件');
    await f.flush();
    expect(f.host.querySelector('.conversation-trace-trigger')).toBe(aggregate);
    expect(f.host.querySelector('.conversation-trace-steps button.file-link')).toBe(file);
    expect(f.host.querySelectorAll('.conversation-trace-steps button.file-link')).toHaveLength(1);
    const failed = [...f.host.querySelectorAll('.conversation-trace-steps .tool-activity')].find(
      (node) => node.textContent?.includes('failed.txt'),
    );
    expect(failed?.textContent).toContain('failed.txt');
    expect(failed?.querySelector('button.file-link')).toBeNull();
    const details = f.requests.filter((request) => request.method === 'fileChanges.detail');
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ view: 'diff', changeId: 'verified-output' });
    expect(f.host.querySelectorAll('.conversation-trace-steps > .tool-activity')).toHaveLength(2);
    expect(f.host.textContent).not.toContain('PERMANENTLY_UNVERIFIED_ORIGINAL');
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
      if (mode === 'edit-diff') {
        const elapsed = f.host.querySelector<HTMLButtonElement>('button.agent-turn-summary');
        expect(elapsed).not.toBeNull();
        await act(async () => elapsed!.click());
        expect(f.host.querySelector('.conversation-trace > button')).toBeNull();
      }
      expect(f.host.querySelector('.tool-edit-heading .tool-label')?.textContent).toBe(
        '已编辑的文件',
      );
      expect(f.host.querySelector('.tool-file-disclosure')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(f.host.querySelector('.file-diff')).toBeNull();
      expect(f.host.textContent).not.toContain('MODEL_ARGS_SENTINEL');
      expect(bodies()).toHaveLength(0);
      await f.toggle();
      expect(bodies()).toHaveLength(1);
      expect(bodies()[0]).toMatchObject({ changeId: 'change-receipt', view: 'diff' });
      expect(f.host.textContent).not.toContain('正在读取本次差异');
      expect(f.host.textContent).not.toContain('new-change-receipt');
      await f.flushBodies();
      expect(f.host.querySelector('.tool-activity')?.textContent).toContain('new-change-receipt');
      const card = f.host.querySelector('.file-diff[data-inline]');
      expect(card).not.toBeNull();
      expect(card?.querySelector('.file-diff-path')?.textContent).toBe('same.txt');
      expect(card?.querySelector('.file-diff-counts')?.textContent).toContain('+1');
      expect(card?.querySelector('.file-diff-counts')?.textContent).toContain('-1');
      expect(card?.querySelector('.diff-removed .file-diff-number')?.textContent).toBe('1');
      expect(card?.querySelector('.diff-added .file-diff-number')?.textContent).toBe('1');
      expect(card?.querySelector('[aria-label="复制差异"]')).not.toBeNull();
      expect(f.host.textContent).not.toContain('SNAPSHOT_');
      expect(f.host.textContent).not.toContain('查看本次交付的文件');
      for (let round = 0; round < 3; round++) {
        await f.toggle();
        expect(f.host.querySelector('.tool-file-disclosure')?.getAttribute('aria-expanded')).toBe(
          'false',
        );
        await f.toggle();
        expect(f.host.querySelector('.tool-file-disclosure')?.getAttribute('aria-expanded')).toBe(
          'true',
        );
        await f.flushBodies();
        expect(f.host.querySelector('.tool-activity')?.textContent).toContain('new-change-receipt');
        expect(f.host.textContent).not.toContain('查看本次交付的文件');
      }
      expect(bodies().filter((request) => request.view === 'diff')).toHaveLength(1);
      expect(bodies().filter((request) => request.view === 'snapshot')).toHaveLength(0);
      expect(f.requests.some((request) => request.method === 'fileChanges.open')).toBe(false);
    } finally {
      await f.close();
    }
  });
}

for (const unavailable of [false, true]) {
  for (const openable of [false, true]) {
    const mode =
      `write-${openable ? '' : 'readonly-'}${unavailable ? 'unavailable' : 'error'}-diff` as const;
    test(`Native ${mode} keeps the path scoped while the saved diff is unavailable`, async () => {
      const f = fixture(mode);
      try {
        await f.render();
        await f.flush();
        await f.toggle();
        if (!unavailable) await f.flushBodies();
        const card = f.host.querySelector('.file-diff[data-inline]')!;
        expect(card).not.toBeNull();
        expect(card.querySelector('.file-diff-path')?.textContent).toBe('same.txt');
        expect(card.querySelector('[aria-label="复制差异"]')).toBeNull();
        expect(f.host.textContent).toContain(
          unavailable ? '历史记录未保存可读差异' : '文件操作的原记录目前不可读',
        );
        const path = card.querySelector<HTMLButtonElement>('button.file-link');
        expect(!!path).toBe(openable);
        if (path) {
          await act(async () => path.click());
          expect(f.requests.filter((request) => request.method === 'fileChanges.open')).toEqual([
            {
              method: 'fileChanges.open',
              generation: 1,
              changeId: 'change-receipt',
              editor: 'vscode',
            },
          ]);
        } else {
          expect(f.requests.some((request) => request.method === 'fileChanges.open')).toBe(false);
        }
        expect(
          f.requests.filter((request) => request.method === 'fileChanges.detail'),
        ).toHaveLength(unavailable ? 0 : 1);
      } finally {
        await f.close();
      }
    });
  }
}

test('Native rechecks file opening eligibility after returning to the session', async () => {
  const f = fixture('write-error-diff');
  try {
    await f.render();
    await f.flush();
    await f.toggle();
    await f.flushBodies();
    expect(f.host.querySelector('.file-diff button.file-link')).not.toBeNull();
    await f.selectOther();
    f.setFileOpenable(false);
    const original = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Original',
    )!;
    await act(async () => original.click());
    for (let attempt = 0; attempt < 10; attempt++) {
      await f.flush();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    if (!f.host.querySelector('.file-diff')) {
      await f.toggle();
      await f.flushBodies();
    }
    expect(f.host.querySelector('.file-diff button.file-link')).toBeNull();
    expect(f.host.querySelector('.file-diff-path')?.textContent).toBe('same.txt');
    expect(f.requests.some((request) => request.method === 'fileChanges.open')).toBe(false);
  } finally {
    await f.close();
  }
});

test('actual NativeDesktop grouped operations on the same path read distinct receipt diffs only when each item opens', async () => {
  const f = fixture('group-diff');
  const bodies = () => f.requests.filter((request) => request.method === 'fileChanges.detail');
  try {
    await f.render();
    await f.flush();
    expect(bodies()).toHaveLength(0);
    const elapsed = f.host.querySelector<HTMLButtonElement>('button.agent-turn-summary')!;
    expect(elapsed).not.toBeNull();
    await act(async () => elapsed.click());
    const trace = f.host.querySelector<HTMLButtonElement>('.conversation-trace > button')!;
    expect(trace).not.toBeNull();
    expect(trace.textContent).toBe('编辑了文件');
    await act(async () => trace.click());
    expect(bodies()).toHaveLength(0);
    const items = [
      ...f.host.querySelectorAll<HTMLButtonElement>(
        '.conversation-trace-steps .tool-file-disclosure',
      ),
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
    await act(async () => elapsed.click());
    expect(f.requests).toContainEqual({
      method: 'fileChanges.close',
      generation: 1,
      readId: bodies()[1]!.readId,
    });
    await f.flushBodies();
    expect(f.host.textContent).not.toContain('new-change-receipt-edit');
    await act(async () => elapsed.click());
    expect(bodies()).toHaveLength(3);
    await f.flushBodies();
    const reopened = f.host.querySelectorAll('.conversation-trace-steps .tool-activity');
    expect(reopened[0]?.textContent).toContain('new-change-receipt');
    expect(reopened[1]?.textContent).toContain('new-change-receipt-edit');
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
