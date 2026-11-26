// Isolated Native renderer artifact. Transport barriers and controls are test-only.
import type { Message, Run } from '@kite-ai/client';
import { createRoot } from 'react-dom/client';
import type { InputMetadata } from '../src/input';
import { NativeDesktop } from '../src/native';
import type {
  NativeBridge,
  NativeConversationResult,
  NativeDraft,
  NativeRequest,
  NativeState,
} from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';
import { historyIsolationFixture } from './history-isolation.fixture';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

const transport = sessionSwitchBridge({ active: false, sameModel: true, cacheMetrics: false });
const sample =
  '# 标题\n\n**说明：**后续中文与 *斜体*、`code`。\n\n| 名称 | 值 |\n| :--- | ---: |\n| 表格 | 12 |\n\n> [!NOTE]\n> 共享公式 $E=mc^2$\n\n- 第一项\n- 第二项\n\n```typescript\nconst text = "雪🙂";\n```\n\n```mermaid\ngraph LR\nA --> B\n```\n\n[本地文件](src/a.ts)';
type FixtureDraft = Pick<NativeDraft, 'content' | 'revision' | 'consumedFrom'>;
const persisted = JSON.parse(sessionStorage.getItem('prompt-fixture-history') ?? 'null') as {
  epoch: number;
  sequence: number;
  histories: [string, Message[]][];
  runs: [string, Run[]][];
  submissions: InputMetadata[];
  drafts: [string, FixtureDraft][];
  posts: NativeRequest[];
} | null;
let epoch = persisted?.epoch ?? 0;
let sequence = persisted?.sequence ?? 0;
let pending: Extract<NativeRequest, { method: 'submit' | 'conversation.send' }> | undefined;
let pendingDraft: FixtureDraft | undefined;
let acknowledge: ((value: InputMetadata) => void) | undefined;
let acknowledgeFirst: ((value: NativeConversationResult) => void) | undefined;
let heldFirstSession: string | undefined;
let resumeFirstSelection: (() => void) | undefined;
let fileReadRevoked = false;
const histories = new Map<string, Message[]>(
  persisted?.histories ?? [
    ['a', []],
    ['b', []],
  ],
);
const runs = new Map<string, Run[]>(
  persisted?.runs ?? [
    ['a', []],
    ['b', []],
  ],
);
const historyIsolation = new URLSearchParams(location.search).has('history-isolation')
  ? historyIsolationFixture(histories, runs)
  : undefined;
const submissions: InputMetadata[] = persisted?.submissions ?? [];
const drafts = new Map<string, FixtureDraft>(
  persisted?.drafts ?? [
    ['a', { content: sample, revision: 1 }],
    ['b', { content: '另一会话草稿', revision: 1 }],
  ],
);
const posts: NativeRequest[] = persisted?.posts ?? [];
for (const id of histories.keys()) if (!['a', 'b'].includes(id)) transport.registerSession(id);
const pendingSessionId = () => {
  if (!pending) throw Error('no_pending_prompt');
  return pending.method === 'conversation.send' ? pending.creation.sessionId : pending.sessionId;
};
function persist() {
  sessionStorage.setItem(
    'prompt-fixture-history',
    JSON.stringify({
      epoch,
      sequence,
      histories: [...histories],
      runs: [...runs],
      submissions,
      drafts: [...drafts],
      posts,
    }),
  );
}
const bridge: NativeBridge = {
  ...transport.bridge,
  async request(request) {
    if (historyIsolation) {
      if (request.method === 'select') historyIsolation.activate();
      if (request.method === 'messages') return historyIsolation.readMessages(request);
      if (request.method === 'outputs.sources')
        return { kind: 'outputs.sources', scope: request.scope, sources: [] };
      if (request.method === 'outputs.query') return historyIsolation.readOutputs(request);
      if (request.method === 'fileTargets.list') {
        const observation = await historyIsolation.readFileTargets();
        const result = await transport.bridge.request(request);
        if (result && 'kind' in result && result.kind === 'fileTargets.page' && 'entries' in result)
          return {
            ...result,
            entries: request.messageIds
              .filter((id) => id.startsWith('old-tool-'))
              .map((id) => ({
                messageId: id,
                changeId: observation ? `target-${id}-${observation}` : `target-${id}`,
                path: `原档-${id.slice('old-tool-'.length)}.md`,
                operation: 'read' as const,
                preview: 'unavailable' as const,
                openable: true,
              })),
          };
        return result;
      }
      if (request.method === 'fileChanges.open') {
        historyIsolation.targetOpens.push(request.changeId);
        return null;
      }
      if (request.method === 'toolMessages.list') {
        const result = await transport.bridge.request(request);
        if (
          result &&
          'kind' in result &&
          result.kind === 'toolMessages.page' &&
          'entries' in result
        )
          return {
            ...result,
            entries: request.messageIds
              .filter((id) => id.startsWith('old-tool-'))
              .map((messageId) => ({
                messageId,
                executionId: messageId.replace('old-tool', 'old-exe'),
                definitionId: 'files.read',
                definitionVersion: '4',
                status: 'succeeded' as const,
                resultRevision: '1',
                target: `原档-${messageId.slice('old-tool-'.length)}.md`,
              })),
          };
        return result;
      }
    }
    if (request.method === 'select' && request.sessionId === heldFirstSession)
      await new Promise<void>((resolve) => {
        resumeFirstSelection = resolve;
      });
    if (request.method === 'submit') {
      posts.push(request);
      persist();
      pending = request;
      pendingDraft = drafts.get(request.sessionId);
      return new Promise<InputMetadata>((resolve) => {
        acknowledge = resolve;
      });
    }
    if (request.method === 'conversation.send') {
      posts.push(request);
      pending = request;
      histories.set(request.creation.sessionId, []);
      runs.set(request.creation.sessionId, []);
      pendingDraft = { content: request.intent.content, revision: 1 };
      drafts.set(request.creation.sessionId, pendingDraft);
      persist();
      return new Promise<NativeConversationResult>((resolve) => {
        acknowledgeFirst = resolve;
      });
    }
    if (request.method === 'lookupInput')
      return submissions.find((entry) => entry.intent.commandId === request.commandId) ?? null;
    if (request.method === 'draft.read' || request.method === 'draft.write') {
      let saved = drafts.get(request.sessionId) ?? { content: '', revision: 1 };
      if (request.method === 'draft.write') {
        if (saved.revision !== request.revision) throw Error('draft_revision_conflict');
        saved = { content: request.content, revision: saved.revision + 1 };
        drafts.set(request.sessionId, saved);
        persist();
      }
      return {
        id: request.sessionId,
        storeId: 'store',
        workspaceId: request.sessionId === 'new-conversation' ? 'new-conversation' : 'w',
        rootSessionId: request.sessionId,
        ...saved,
      };
    }
    if (request.method === 'messages')
      return {
        messages: histories
          .get(request.sessionId)!
          .filter(
            (message) =>
              BigInt(message.seq) > BigInt(request.afterSeq ?? '0') &&
              BigInt(message.seq) <= BigInt(request.upperSeq!),
          ),
        nextAfterSeq: null,
        highWaterSeq: request.upperSeq!,
      };
    if (request.method === 'background.open') return null;
    const result = await transport.bridge.request(request);
    if (
      (request.method === 'attach' || request.method === 'state' || request.method === 'select') &&
      result &&
      'generation' in result &&
      result.selection
    ) {
      const id = result.selection.session.id;
      return {
        ...result,
        historyEpoch: historyIsolation ? 0 : epoch,
        ...(historyIsolation && { outputFilesDisplay: historyIsolation.display(id) }),
        inputSubmissions: [...submissions],
        selection: {
          ...result.selection,
          ...(historyIsolation && {
            viewSelection:
              (result.selection.viewSelection ?? result.selection.viewGeneration) +
              historyIsolation.selectionOffset(),
          }),
          ...(historyIsolation && fileReadRevoked && { permissionUnavailable: true }),
          runs: historyIsolation ? structuredClone(runs.get(id)!) : runs.get(id)!,
          ...historyIsolation?.cursor(),
          session: {
            ...result.selection.session,
            nextSeq: String(
              (histories.get(id)!.at(-1)?.seq ? Number(histories.get(id)!.at(-1)!.seq) : 0) + 1,
            ),
          },
        },
      } satisfies NativeState;
    }
    return result;
  },
};
function metadata(phase: InputMetadata['phase']): InputMetadata {
  if (!pending) throw Error('no_pending_prompt');
  return {
    sessionId: pendingSessionId(),
    intent: {
      kind: pending.intent.kind,
      expectedStoreId: 'store',
      commandId: pending.intent.commandId,
    },
    phase,
  };
}
const root = createRoot(document.getElementById('root')!);
Object.defineProperty(window, 'kiteNative', { value: bridge });
document.documentElement.dataset.platform = 'windows';
document.documentElement.dataset.nativeWindow = 'true';
const mount = () => root.render(<NativeDesktop nativeWindow />);
const control = {
  sample,
  posts,
  phase: () => (acknowledge || acknowledgeFirst ? 'sending' : submissions.at(-1)?.phase),
  accept() {
    const value = metadata('accepted');
    submissions.push(value);
    if (pendingDraft && drafts.get(value.sessionId) === pendingDraft)
      drafts.set(value.sessionId, {
        content: '',
        revision: pendingDraft.revision + 1,
        consumedFrom: { revision: pendingDraft.revision, commandId: value.intent.commandId },
      });
    if (pending?.method === 'conversation.send') {
      transport.registerSession(pending.creation.sessionId);
      acknowledgeFirst?.({
        kind: 'conversation',
        commandId: pending.intent.commandId,
        phase: 'accepted',
        stage: 'input',
        creation: { input: pending.creation, phase: 'created' },
        input: value,
      });
      acknowledgeFirst = undefined;
    }
    acknowledge?.(value);
    acknowledge = undefined;
    persist();
    transport.publish();
  },
  unknown() {
    acknowledge?.(metadata('unknown'));
    acknowledge = undefined;
    transport.publish();
  },
  reject() {
    if (!acknowledge) throw Error('send_not_pending');
    acknowledge(metadata('rejected'));
    acknowledge = undefined;
    transport.publish();
  },
  rejectFirst() {
    if (pending?.method !== 'conversation.send' || !acknowledgeFirst)
      throw Error('first_send_not_pending');
    heldFirstSession = pending.creation.sessionId;
    transport.registerSession(heldFirstSession);
    acknowledgeFirst({
      kind: 'conversation',
      commandId: pending.intent.commandId,
      phase: 'failed',
      stage: 'input',
      creation: { input: pending.creation, phase: 'created' },
      code: 'native_asset_unavailable',
    });
    acknowledgeFirst = undefined;
    transport.publish();
  },
  releaseFirstSelection() {
    heldFirstSession = undefined;
    resumeFirstSelection?.();
    resumeFirstSelection = undefined;
  },
  save() {
    if (!pending || !('content' in pending.intent)) throw Error('prompt_missing');
    const id = pendingSessionId();
    const run: Run = {
      ...backgroundItem().run!,
      id: `prompt-run-${++sequence}`,
      sessionId: id,
      originCommandId: pending.intent.commandId,
      status: 'running',
      isActive: true,
      createdAt: Date.now(),
      finishedAt: null,
      reason: null,
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
    };
    runs.get(id)!.push(run);
    const message: Message = {
      id: `saved-${sequence}`,
      sessionId: id,
      runId: run.id,
      role: 'user',
      status: 'complete',
      seq: String(histories.get(id)!.length + 1),
      content: pending.intent.content,
      createdAt: Date.now(),
      humanInput: {
        inputCommandId: `business-${sequence}`,
        publicCommandId: pending.intent.commandId,
      },
    };
    histories.get(id)!.push(message);
    if (historyIsolation) {
      historyIsolation.changed(message);
      historyIsolation.start(run.id);
    } else epoch++;
    persist();
    transport.publish();
  },
  reply() {
    const id = pendingSessionId();
    const run = runs.get(id)!.at(-1)!;
    Object.assign(run, { status: 'completed', isActive: false, finishedAt: Date.now() });
    histories.get(id)!.push({
      id: `reply-${sequence}`,
      sessionId: id,
      runId: run.id,
      role: 'assistant',
      status: 'complete',
      seq: String(histories.get(id)!.length + 1),
      content: histories
        .get(id)!
        .find((message) => message.runId === run.id && message.role === 'user')!.content,
    });
    epoch++;
    persist();
    transport.publish();
  },
  stream(text: string) {
    if (!historyIsolation) throw Error('history_fixture_unavailable');
    const id = pendingSessionId();
    const run = runs.get(id)!.at(-1)!;
    const history = histories.get(id)!;
    const previous = history.at(-1);
    const message: Message =
      previous?.id === `reply-${sequence}`
        ? { ...previous, content: previous.content + text }
        : {
            id: `reply-${sequence}`,
            sessionId: id,
            role: 'assistant',
            runId: run.id,
            seq: String(history.length + 1),
            status: 'incomplete',
            content: text,
          };
    if (previous?.id === message.id) history[history.length - 1] = message;
    else history.push(message);
    historyIsolation.changed(message);
    transport.publish();
  },
  finishStream() {
    if (!historyIsolation) throw Error('history_fixture_unavailable');
    const id = pendingSessionId();
    const run = runs.get(id)!.at(-1)!;
    const history = histories.get(id)!;
    Object.assign(run, { status: 'completed', isActive: false, finishedAt: Date.now() });
    const message: Message = { ...history.at(-1)!, status: 'complete' };
    history[history.length - 1] = message;
    historyIsolation.addFile(run.id, '新轮次产出.pdf');
    historyIsolation.changed(message);
    transport.publish();
  },
  publishLateOutput() {
    historyIsolation?.addFile('old-run-1', '旧轮晚到.pdf');
    transport.publish();
  },
  outputQueries: historyIsolation?.queries,
  targetOpens: historyIsolation?.targetOpens,
  holdNextRescan: historyIsolation?.holdNextRescan,
  rescanStarted: historyIsolation?.rescanStarted,
  releaseRescan: historyIsolation?.releaseRescan,
  fileTargetsPending: historyIsolation?.fileTargetsPending,
  releaseFileTargets: historyIsolation?.releaseFileTargets,
  setHistoricalFileReadRevoked(revoked: boolean) {
    fileReadRevoked = revoked;
    transport.publish();
  },
  refresh: transport.publish,
};
Object.assign(window, { promptSendFixture: control });
mount();
// Explicit artifact controls; never reachable from a dev/prod application entry.
const controls = document.createElement('nav');
controls.setAttribute('aria-label', '隔离测试步骤');
controls.style.cssText =
  'position:fixed;top:8px;left:350px;z-index:9999;display:flex;gap:8px;background:#eee;color:#111;padding:6px';
for (const [label, action] of [
  ['确认受理', control.accept],
  ['保存用户消息', control.save],
  ['完成回复', control.reply],
  ['结果未知', control.unknown],
  ['刷新核对', control.refresh],
] as const) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  controls.append(button);
}
document.body.append(controls);

declare global {
  interface Window {
    promptSendFixture: typeof control;
  }
}
