// Explicit production-renderer fixture. No Service, user Store or diagnostic entrypoint.
import type { Message, OutputFileTarget, Run } from '@kite-ai/client';
import { createRoot } from 'react-dom/client';
import { NativeOutputDisplayVersions } from '../electron/output-display-versions';
import { NativeDesktop } from '../src/native';
import type { NativeBridge, NativeRequest } from '../src/native-bridge';
import { type NativeToolMessageFact, nativeRunFact } from '../src/tool-messages-bridge';
import { backgroundItem } from './background-item.fixture';
import { sessionChange } from './native-change.fixture';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

export type PresentationPhase =
  | 'selection'
  | 'history'
  | 'runs'
  | 'tools'
  | 'outputs'
  | 'historicalOutputs'
  | 'liveOutputs';
export interface PresentationEvent {
  kind: 'request' | 'release';
  phase: PresentationPhase;
  time: number;
  sessionId?: string;
  messageIds?: readonly string[];
  afterSeq?: string;
  limit?: number;
  returned?: number;
}
export interface HistoryPresentationFixture {
  events: PresentationEvent[];
  openInAppTargets: OutputFileTarget[];
  finishOpenInApp(error?: string): void;
  startLiveTurn(): void;
  appendLiveReply(text: string): void;
  publishLiveOutput(): void;
  finishLiveTurn(): void;
  release(phase: PresentationPhase): void;
  pending(): Partial<Record<PresentationPhase, number>>;
}
declare global {
  interface Window {
    historyPresentationFixture: HistoryPresentationFixture;
  }
}

const params = new URL(location.href).searchParams;
const count = Number(params.get('turns') ?? 4);
if (!Number.isInteger(count) || count < 2 || count > 40) throw Error('invalid_fixture_turns');
const target = params.get('mode') === 'initial' ? 'a' : 'b';
const viewAll = params.get('viewAll') === 'true';
const turnOutputs = params.has('turnOutputs');
const control = sessionSwitchBridge({
  active: true,
  ...(turnOutputs ? { protocol: 'chat-completions' as const } : {}),
  initialSelection: params.get('mode') !== 'initial',
});
const base = backgroundItem();
const histories = new Map<string, Message[]>();
const runLists = new Map<string, Run[]>();
const tools = new Map<string, NativeToolMessageFact>();
for (const sessionId of ['a', 'b']) {
  const messages: Message[] = [];
  const runs: Run[] = [];
  const outputSummary =
    sessionId === 'b'
      ? '| 文件 | 格式 |\n| --- | --- |\n| 演示文稿示例 | PPT |'
      : '- 表格示例\n- 演示文稿示例\n- 文档示例';
  for (let index = 0; index < count; index++) {
    const runId = `run-${sessionId}-${index}`;
    const active = !turnOutputs && index === count - 1;
    runs.push({
      ...base.run!,
      id: runId,
      sessionId,
      originCommandId: `command-${sessionId}-${index}`,
      rootWorkCommandId: `command-${sessionId}-${index}`,
      rootWorkSeq: String(index + 1),
      status: active ? 'running' : 'completed',
      isActive: active,
      createdAt: 1000 + index * 5000,
      finishedAt: active ? null : 4000 + index * 5000,
      reason: null,
    });
    const add = (suffix: string, role: Message['role'], content: string) => {
      const message: Message = {
        id: `${sessionId}-${index}-${suffix}`,
        sessionId,
        runId,
        seq: String(messages.length + 1),
        role,
        status: 'complete',
        content,
      };
      messages.push(message);
      return message;
    };
    add('user', 'user', `SESSION-${sessionId.toUpperCase()} 第 ${index + 1} 轮：检查会话渲染`);
    add(
      'process',
      'assistant',
      `PROCESS-${sessionId}-${index}：先检查组件，再核对会话保存记录。\n\n${'这一段是工具之前的过程说明。'.repeat(6)}`,
    );
    for (let tool = 0; tool < 2; tool++) {
      const path = `${sessionId}-file-${index}-${tool}.ts`;
      const message = add(
        `tool-${tool}`,
        'tool',
        JSON.stringify({ path, content: 'fixture receipt' }),
      );
      const executionId = `execution-${message.id}`;
      message.sourceIds = [executionId];
      tools.set(message.id, {
        messageId: message.id,
        executionId,
        definitionId: 'files.read',
        definitionVersion: '5',
        status: 'succeeded',
        resultRevision: '1',
        target: path,
      });
    }
    add(
      'reply',
      'assistant',
      `REPLY-${sessionId}-${index}\n\n${'完整回复包含正常段落、中文与 **Markdown**，用来检查阅读位置是否稳定。'.repeat(5)}${turnOutputs ? `\n\n${outputSummary}` : ''}`,
    );
  }
  histories.set(sessionId, messages);
  runLists.set(sessionId, runs);
}
const events: PresentationEvent[] = [];
const openInAppTargets: OutputFileTarget[] = [];
let finishOpening: ((error?: string) => void) | undefined;
const liveRunId = 'run-a-live';
const outputVersions = new NativeOutputDisplayVersions();
let liveDelivery = false;
let failedOutputRead = false;
const pending = new Map<PresentationPhase, (() => void)[]>();
const released = new Set<PresentationPhase>();
const gate = async (sessionId: string, phase: PresentationPhase) => {
  if (
    (sessionId !== target && phase !== 'liveOutputs' && phase !== 'historicalOutputs') ||
    released.has(phase)
  )
    return;
  await new Promise<void>((resolve) => {
    const queue = pending.get(phase) ?? [];
    queue.push(resolve);
    pending.set(phase, queue);
  });
};
const sessionFor = (request: Extract<NativeRequest, { method: 'messages' }>) => request.sessionId;
const bridge: NativeBridge = {
  ...control.bridge,
  async request(request) {
    if (turnOutputs && request.method === 'outputs.openInApp') {
      openInAppTargets.push(request.target);
      return new Promise<null>((resolve, reject) => {
        finishOpening = (error) => {
          finishOpening = undefined;
          if (error) reject(Error(error));
          else resolve(null);
        };
      });
    }
    if (turnOutputs && request.method === 'outputs.sources') {
      outputVersions.sources(request.scope.sessionId, []);
      return { kind: 'outputs.sources', scope: request.scope, sources: [] };
    }
    if (turnOutputs && request.method === 'outputs.query') {
      const { scope, runId } = request;
      const sessionId = scope.sessionId;
      const live = sessionId === 'a' && runId === liveRunId;
      const ownerRunId = live ? liveRunId : `run-${sessionId}-1`;
      const hasFile = runId === ownerRunId;
      if (hasFile) {
        const phase = live ? 'liveOutputs' : liveDelivery ? 'historicalOutputs' : 'outputs';
        events.push({
          kind: 'request',
          phase,
          sessionId,
          time: performance.now(),
        });
        if (params.has('failOutputs') && !failedOutputRead) {
          failedOutputRead = true;
          throw Error('fixture_outputs_unavailable');
        }
        if (live || liveDelivery) await gate(sessionId, phase);
        else if (sessionId === target) await gate(sessionId, 'outputs');
        else await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return {
        kind: 'outputs.page',
        page: {
          scope,
          revision: '1',
          collections: [],
          items: hasFile
            ? [
                {
                  ...scope,
                  ownerRunId,
                  fileId: live ? 'live-presentation' : 'presentation',
                  locator: {
                    kind: 'delivery',
                    key: live ? 'delivery/2/job/presentation' : 'delivery/1/job/presentation',
                  },
                  name: live ? 'Output-live.pptx' : `Output-${sessionId}.pptx`,
                  size: '12',
                  mediaType:
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  publishedAt: '2026-11-24T00:00:00Z',
                },
              ]
            : [],
        },
      };
    }
    if (request.method === 'messages') {
      const sessionId = sessionFor(request);
      const remaining = histories
        .get(sessionId)!
        .filter(
          (message) =>
            BigInt(message.seq) > BigInt(request.afterSeq ?? '0') &&
            BigInt(message.seq) <= BigInt(request.upperSeq!),
        );
      const messages = remaining.slice(0, Math.min(request.limit ?? 32, 32));
      events.push({
        kind: 'request',
        phase: 'history',
        sessionId,
        time: performance.now(),
        afterSeq: request.afterSeq,
        limit: request.limit,
        returned: messages.length,
      });
      await gate(sessionId, 'history');
      return structuredClone({
        messages,
        highWaterSeq: request.upperSeq!,
        nextAfterSeq: remaining.length > messages.length ? messages.at(-1)!.seq : null,
      });
    }
    const result = await control.bridge.request(request);
    if (
      (request.method === 'attach' || request.method === 'state' || request.method === 'select') &&
      result &&
      'selection' in result &&
      result.selection
    ) {
      const sessionId = result.selection.session.id;
      if (request.method === 'select') {
        events.push({ kind: 'request', phase: 'selection', sessionId, time: performance.now() });
        await gate(sessionId, 'selection');
      }
      return structuredClone({
        ...result,
        ...(turnOutputs
          ? {
              outputFilesDisplay: outputVersions.snapshot('store', 'fixture-subject', sessionId),
            }
          : {}),
        selection: {
          ...result.selection,
          session: {
            ...result.selection.session,
            nextSeq: String(histories.get(sessionId)!.length + 1),
          },
          runs: turnOutputs
            ? runLists.get(sessionId)!.map((run) => ({
                ...run,
                configuration: result.selection!.runs[0]?.configuration,
              }))
            : viewAll
              ? runLists.get(sessionId)!
              : runLists.get(sessionId)!.slice(-1),
        },
      });
    }
    if (request.method === 'directory' && result && 'sessions' in result)
      return {
        ...result,
        sessions: result.sessions.map((session) => ({
          ...session,
          nextSeq: String(histories.get(session.id)!.length + 1),
        })),
      };
    if (
      request.method === 'toolMessages.runs' &&
      result &&
      'kind' in result &&
      result.kind === 'toolMessages.runs' &&
      'scope' in result
    ) {
      const sessionId = result.scope.sessionId;
      events.push({
        kind: 'request',
        phase: 'runs',
        sessionId,
        time: performance.now(),
        messageIds: request.messageIds,
      });
      await gate(sessionId, 'runs');
      // Only return facts asked for by this read. An unrelated active Run would
      // violate the real bridge's identity contract and hide the rendering case.
      const ids = new Set(
        histories
          .get(sessionId)!
          .filter((message) => request.messageIds.includes(message.id))
          .map((message) => message.runId),
      );
      return {
        ...result,
        runs: runLists
          .get(sessionId)!
          .filter((run) => ids.has(run.id))
          .map(nativeRunFact),
      };
    }
    if (
      request.method === 'toolMessages.list' &&
      result &&
      'kind' in result &&
      result.kind === 'toolMessages.page' &&
      'scope' in result
    ) {
      const sessionId = result.scope.sessionId;
      events.push({
        kind: 'request',
        phase: 'tools',
        sessionId,
        time: performance.now(),
        messageIds: request.messageIds,
      });
      await gate(sessionId, 'tools');
      return {
        ...result,
        entries: request.messageIds.flatMap((id) => (tools.has(id) ? [tools.get(id)!] : [])),
      };
    }
    if (
      request.method === 'toolMessages.usage' &&
      result &&
      'kind' in result &&
      result.kind === 'toolMessages.usage'
    )
      return { ...result, entries: [] };
    return result;
  },
};
window.historyPresentationFixture = {
  events,
  openInAppTargets,
  finishOpenInApp(error) {
    if (!finishOpening) throw Error('fixture_output_open_not_pending');
    finishOpening(error);
  },
  startLiveTurn() {
    const messages = histories.get('a')!;
    const runs = runLists.get('a')!;
    const prior = runs.at(-1)!;
    runs.push({
      ...prior,
      id: liveRunId,
      originCommandId: 'command-a-live',
      rootWorkCommandId: 'command-a-live',
      rootWorkSeq: String(count + 1),
      createdAt: prior.finishedAt! + 1,
      isActive: true,
      status: 'running',
      finishedAt: null,
    });
    for (const [role, content] of [
      ['user', 'Create an output in the current conversation'],
      ['assistant', 'LIVE-STREAM-a'],
    ] as const) {
      messages.push({
        id: `a-live-${role}`,
        sessionId: 'a',
        runId: liveRunId,
        seq: String(messages.length + 1),
        role,
        status: role === 'assistant' ? 'incomplete' : 'complete',
        content,
      });
    }
    outputVersions.changed({ ...sessionChange('a'), objectId: liveRunId, type: 'run.started' });
    control.publish();
  },
  appendLiveReply(text) {
    const message = histories.get('a')!.at(-1)!;
    message.content += text;
    control.publish();
  },
  publishLiveOutput() {
    liveDelivery = true;
    outputVersions.changed({
      ...sessionChange('a'),
      objectId: 'builtin.files/delivery/00000000000000000003/producer/live-presentation',
      type: 'extension.record_updated',
    });
    control.publish();
  },
  finishLiveTurn() {
    const run = runLists.get('a')!.at(-1)!;
    run.finishedAt = run.createdAt + 1;
    run.status = 'completed';
    run.isActive = false;
    const message = histories.get('a')!.at(-1)!;
    message.status = 'complete';
    message.content = 'LIVE-REPLY-a';
    outputVersions.changed({ ...sessionChange('a'), objectId: liveRunId, type: 'run.finished' });
    control.publish();
  },
  release(phase) {
    events.push({ kind: 'release', phase, time: performance.now() });
    released.add(phase);
    for (const resolve of pending.get(phase) ?? []) resolve();
    pending.delete(phase);
  },
  pending: () => Object.fromEntries([...pending].map(([phase, queue]) => [phase, queue.length])),
};
Object.defineProperty(window, 'kiteNative', { value: bridge });
document.documentElement.dataset.nativeWindow = 'true';
document.documentElement.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<NativeDesktop nativeWindow />);
