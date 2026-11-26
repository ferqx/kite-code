import type { Message, OutputFileSummary, Run } from '@kite-ai/client';
import { NativeOutputDisplayVersions } from '../electron/output-display-versions';
import type { NativeRequest } from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';

export function historyIsolationFixture(
  histories: Map<string, Message[]>,
  runs: Map<string, Run[]>,
) {
  const display = new NativeOutputDisplayVersions();
  const changes: string[] = [];
  const files: OutputFileSummary[] = [];
  const queries: (string | undefined)[] = [];
  const targetOpens: string[] = [];
  const diffReads: string[] = [];
  let selectionOffset = 0;
  let rescan: { barrier: Promise<void>; release: () => void; started: boolean } | undefined;
  let targets: { barrier: Promise<void>; release: () => void; started: boolean } | undefined;
  let newDiff: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const addFile = (runId: string, name: string) => {
    const fileId = `${runId}-${files.length}`;
    files.push({
      storeId: 'store',
      sessionId: 'a',
      ownerRunId: runId,
      fileId,
      name,
      locator: { kind: 'delivery', key: `delivery/00000000000000000001/job/${fileId}` },
      size: '10',
      mediaType: 'application/pdf',
      publishedAt: '2026-11-11T00:00:00Z',
    });
    display.changed({
      cursor: String(files.length),
      revision: String(files.length),
      type: 'extension.record_updated',
      sessionId: 'a',
      objectId: 'builtin.files/delivery/example',
      payload: { outputRunId: runId },
    });
  };
  const history = histories.get('a')!;
  for (let index = 1; index <= 4; index++) {
    const runId = `old-run-${index}`;
    runs.get('a')!.push({
      ...backgroundItem().run!,
      id: runId,
      sessionId: 'a',
      originCommandId: `old-command-${index}`,
      status: 'completed',
      isActive: false,
      createdAt: Date.now() - 10_000,
      finishedAt: Date.now() - 8_000,
      configuration: {
        modelId: 'model-a',
        snapshot: {
          version: 1,
          digest: 'a'.repeat(64),
          configuration: {
            models: [
              {
                id: 'model-a',
                provider: 'compatible',
                model: 'Model A',
                protocol: 'chat-completions',
              },
            ],
          },
        },
      },
    });
    const row = (message: Pick<Message, 'id' | 'role' | 'content'> & Partial<Message>) =>
      history.push({
        ...message,
        sessionId: 'a',
        runId,
        seq: String(history.length + 1),
        status: 'complete',
      } as Message);
    row({
      id: `old-input-${index}`,
      role: 'user',
      content: `旧轮输入 ${index}`,
      files: [{ name: `原始输入-${index}.pdf`, uri: `file:///fixture/source-${index}.pdf` }],
    });
    row({
      id: `old-tool-${index}`,
      role: 'tool',
      sourceIds: [`old-exe-${index}`],
      toolCallId: `old-call-${index}`,
      content: JSON.stringify({ path: `原档-${index}.md`, content: `已读取旧文档 ${index}` }),
    });
    if (index === 1)
      row({
        id: 'old-tool-edit',
        role: 'tool',
        sourceIds: ['old-exe-edit'],
        toolCallId: 'old-call-edit',
        content: JSON.stringify({ path: '原差异.md' }),
      });
    row({
      id: `old-reply-${index}`,
      role: 'assistant',
      content: `旧轮正文 ${index}\n\n**已经完成的全文**。\n\n| 项 | 值 |\n| - | - |\n| 文件 | 已确认 |`,
    });
    addFile(runId, `成果-${index}.pdf`);
    addFile(runId, `数据-${index}.pdf`);
  }
  let cursor = 1;
  return {
    queries,
    targetOpens,
    diffReads,
    releaseDiff() {
      newDiff?.resolve();
    },
    async readDiff(changeId: string) {
      if (changeId === 'target-old-tool-edit-1') {
        newDiff ??= Promise.withResolvers<void>();
        diffReads.push(changeId);
        await newDiff.promise;
      } else if (changeId === 'target-old-tool-edit') diffReads.push(changeId);
      else throw Error('fixture_diff_wrong_observation');
      return {
        kind: 'fileChanges.detail' as const,
        changeId,
        text: '--- a/original.md\n+++ b/original.md\n@@ -1 +1 @@\n-修改前的正文\n+修改后的正文\n',
      };
    },
    selectionOffset: () => selectionOffset,
    holdNextRescan() {
      selectionOffset++;
      const history = Promise.withResolvers<void>();
      rescan = { barrier: history.promise, release: history.resolve, started: false };
      const metadata = Promise.withResolvers<void>();
      targets = { barrier: metadata.promise, release: metadata.resolve, started: false };
    },
    rescanStarted: () => rescan?.started === true,
    releaseRescan() {
      rescan?.release();
      rescan = undefined;
    },
    fileTargetsPending: () => targets?.started === true,
    releaseFileTargets() {
      targets?.release();
      targets = undefined;
    },
    async readFileTargets() {
      const offset = selectionOffset;
      if (targets) {
        targets.started = true;
        await targets.barrier;
      }
      return offset;
    },
    activate: () => {
      cursor = changes.length + 1;
    },
    cursor: () => ({
      historyCursor: String(cursor),
      historyTargetCursor: String(changes.length + 1),
    }),
    display: (id: string) => display.snapshot('store', 'history-isolation', id),
    changed: (message: Message) => changes.push(message.id),
    start: (runId: string) =>
      display.changed({
        cursor: '1',
        revision: '1',
        type: 'run.started',
        sessionId: 'a',
        objectId: runId,
        payload: { outputRunId: runId },
      }),
    addFile,
    async readMessages(request: Extract<NativeRequest, { method: 'messages' }>) {
      const change = request.changes;
      if (!change && rescan) {
        rescan.started = true;
        await rescan.barrier;
      }
      const ids =
        change &&
        new Set(changes.slice(Number(change.afterCursor) - 1, Number(change.upperCursor) - 1));
      const upper = request.upperSeq ?? String(histories.get(request.sessionId)!.length + 1);
      const eligible = histories
        .get(request.sessionId)!
        .filter(
          (message) =>
            BigInt(message.seq) > BigInt(request.afterSeq ?? 0) &&
            BigInt(message.seq) <= BigInt(upper) &&
            (!ids || ids.has(message.id)),
        );
      const messages = eligible.slice(0, request.limit);
      return structuredClone({
        messages,
        nextAfterSeq: eligible.length > messages.length ? messages.at(-1)!.seq : null,
        highWaterSeq: upper,
        ...(change
          ? { changes: { ...change, nextCursor: change.upperCursor, removedIds: [] } }
          : {}),
      });
    },
    readOutputs(request: Extract<NativeRequest, { method: 'outputs.query' }>) {
      queries.push(request.runId);
      return {
        kind: 'outputs.page' as const,
        page: {
          scope: request.scope,
          revision: String(files.length),
          collections: [],
          items:
            request.scope.sessionId === 'a'
              ? files.filter(
                  (file) => request.runId === undefined || file.ownerRunId === request.runId,
                )
              : [],
        },
      };
    },
  };
}
