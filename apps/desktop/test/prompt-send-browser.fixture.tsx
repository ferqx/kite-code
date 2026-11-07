// Isolated Native renderer artifact. Transport barriers and controls are test-only.
import type { Message, Run } from '@kite-ai/client';
import { createRoot } from 'react-dom/client';
import type { InputMetadata } from '../src/input';
import { NativeDesktop } from '../src/native';
import type {
  NativeBridge,
  NativeConversationResult,
  NativeRequest,
  NativeState,
} from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

const transport = sessionSwitchBridge({ active: false, sameModel: true, cacheMetrics: false });
const sample =
  '# 标题\n\n**说明：**后续中文与 *斜体*、`code`。\n\n| 名称 | 值 |\n| :--- | ---: |\n| 表格 | 12 |\n\n> [!NOTE]\n> 共享公式 $E=mc^2$\n\n- 第一项\n- 第二项\n\n```typescript\nconst text = "雪🙂";\n```\n\n```mermaid\ngraph LR\nA --> B\n```\n\n[本地文件](src/a.ts)';
const persisted = JSON.parse(sessionStorage.getItem('prompt-fixture-history') ?? 'null') as {
  epoch: number;
  sequence: number;
  histories: [string, Message[]][];
  runs: [string, Run[]][];
  submissions: InputMetadata[];
  drafts: [string, string][];
  posts: NativeRequest[];
} | null;
let epoch = persisted?.epoch ?? 0;
let sequence = persisted?.sequence ?? 0;
let pending: Extract<NativeRequest, { method: 'submit' | 'conversation.send' }> | undefined;
let acknowledge: ((value: InputMetadata) => void) | undefined;
let acknowledgeFirst: ((value: NativeConversationResult) => void) | undefined;
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
const submissions: InputMetadata[] = persisted?.submissions ?? [];
const drafts = new Map(
  persisted?.drafts ?? [
    ['a', sample],
    ['b', '另一会话草稿'],
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
    if (request.method === 'submit') {
      posts.push(request);
      persist();
      pending = request;
      return new Promise<InputMetadata>((resolve) => {
        acknowledge = resolve;
      });
    }
    if (request.method === 'conversation.send') {
      posts.push(request);
      pending = request;
      histories.set(request.creation.sessionId, []);
      runs.set(request.creation.sessionId, []);
      drafts.set(request.creation.sessionId, request.intent.content);
      persist();
      return new Promise<NativeConversationResult>((resolve) => {
        acknowledgeFirst = resolve;
      });
    }
    if (request.method === 'lookupInput')
      return submissions.find((entry) => entry.intent.commandId === request.commandId) ?? null;
    if (request.method === 'draft.read' || request.method === 'draft.write') {
      if (request.method === 'draft.write') drafts.set(request.sessionId, request.content);
      if (request.method === 'draft.write') persist();
      return {
        id: request.sessionId,
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: request.sessionId,
        revision: request.method === 'draft.write' ? request.revision + 1 : 1,
        content: drafts.get(request.sessionId) ?? '',
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
        historyEpoch: epoch,
        inputSubmissions: [...submissions],
        selection: {
          ...result.selection,
          runs: runs.get(id)!,
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
    drafts.set(pendingSessionId(), '');
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
    histories.get(id)!.push({
      id: `saved-${sequence}`,
      sessionId: id,
      runId: run.id,
      role: 'user',
      status: 'complete',
      seq: String(histories.get(id)!.length + 1),
      content: pending.intent.content,
      humanInput: {
        inputCommandId: `business-${sequence}`,
        publicCommandId: pending.intent.commandId,
      },
    });
    epoch++;
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
