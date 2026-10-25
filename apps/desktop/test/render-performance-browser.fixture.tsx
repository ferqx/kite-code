// Isolated production-renderer experiment. Never imported by application entrypoints.
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../../packages/ui/src/desktop/Conversation';
import { NativeDesktop } from '../src/native';
import type { NativeBridge } from '../src/native-bridge';
import { NativeModelOutputMessage } from '../src/native-model-output-message';
import { backgroundItem } from './background-item.fixture';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

const count = Number(new URL(location.href).searchParams.get('turns') ?? 60);
const control = sessionSwitchBridge({ active: true });
const base = backgroundItem();
const startedAt = Date.now() - count * 5000;
const settled = new Set<string>();
const histories = new Map<string, Message[]>();
let chunk = 0;
let historyDelay = 0;
let historyEpoch = 0,
  metadataRevision = 1;
const versions = new Map([
  ['a', 1],
  ['b', 1],
]);
const baselines = new Map(versions);
const updates: { cursor: number; sessionId: string; id: string }[] = [];
const reads: { kind: string; sessionId: string; count: number; cursor?: string }[] = [];
function updated(id: string) {
  const cursor = versions.get(id)! + 1;
  versions.set(id, cursor);
  updates.push({ cursor, sessionId: id, id: histories.get(id)!.at(-1)!.id });
  control.publish();
}
for (const id of ['a', 'b']) {
  const messages: Message[] = [];
  for (let index = 0; index < count; index++) {
    const content =
      `## ${id.toUpperCase()} 第 ${index + 1} 轮\n\n` +
      '这是用于检查初始化、流式更新与切换的完整历史。**保留文字与阅读位置**，包含中文和 emoji🙂。\n\n'.repeat(
        3,
      ) +
      '- 第一项\n- 第二项含有 `inline code`\n\n' +
      '| 状态 | 结果 |\n| --- | --- |\n| 完整 | 已核对 |\n\n' +
      '```ts\nconst message = "stable history";\nconsole.log(message);\n```\n\n';
    messages.push(
      {
        id: `u-${id}-${index}`,
        sessionId: id,
        runId: `run-${id}-${index}`,
        role: 'user',
        status: 'complete',
        seq: String(index * 2 + 1),
        content: `Question ${id} ${index + 1}`,
      },
      {
        id: `m-${id}-${index}`,
        sessionId: id,
        runId: `run-${id}-${index}`,
        role: 'assistant',
        status: index === count - 1 ? 'incomplete' : 'complete',
        seq: String(index * 2 + 2),
        content: `${content}TAIL-${id.toUpperCase()}-0`,
        sourceIds: [`model-${id}-${index}`],
      },
    );
  }
  histories.set(id, messages);
}
const modelSources = new Map(
  [...histories.values()].flatMap((messages) =>
    messages
      .filter((message) => message.sourceIds?.length)
      .map((message) => [message.id, message.sourceIds![0]!] as const),
  ),
);
const runs = (id: string) =>
  Array.from({ length: count }, (_, index) => ({
    ...base.run!,
    id: `run-${id}-${index}`,
    sessionId: id,
    configuration: {
      modelId: id,
      snapshot: {
        version: 1,
        digest: 'a'.repeat(64),
        configuration: {
          models: [{ id, provider: 'compatible', model: id, protocol: 'chat-completions' }],
        },
      },
    },
    originCommandId: `command-${id}-${index}`,
    rootWorkCommandId: `command-${id}-${index}`,
    rootWorkSeq: String(index + 1),
    createdAt: startedAt + index * 5000,
    isActive: index === count - 1 && !settled.has(id),
    status: index === count - 1 && !settled.has(id) ? ('running' as const) : ('completed' as const),
    finishedAt: index === count - 1 && !settled.has(id) ? null : startedAt + index * 5000 + 3000,
    reason: null,
    waitingForResults: [],
  }));
const bridge: NativeBridge = {
  ...control.bridge,
  async request(request) {
    if (request.method === 'select') {
      baselines.set(request.sessionId, versions.get(request.sessionId)!);
      metadataRevision++;
    }
    if (request.method === 'messages' && historyDelay)
      await new Promise<void>((resolve) => setTimeout(resolve, historyDelay));
    const result = await control.bridge.request(request);
    if (
      (request.method === 'attach' || request.method === 'state' || request.method === 'select') &&
      result &&
      'generation' in result &&
      result.selection
    ) {
      const id = result.selection.session.id;
      return structuredClone({
        ...result,
        historyEpoch,
        selection: {
          ...result.selection,
          viewGeneration: metadataRevision,
          historyCursor: String(baselines.get(id)),
          historyTargetCursor: String(versions.get(id)),
          session: { ...result.selection.session, nextSeq: String(count * 2 + 1) },
          runs: runs(id),
        },
      });
    }
    if (request.method === 'directory' && result && 'sessions' in result)
      return {
        ...result,
        sessions: result.sessions.map((session) => ({
          ...session,
          nextSeq: String(count * 2 + 1),
        })),
      };
    if (request.method === 'messages') {
      const changedIds = request.changes
        ? new Set(
            updates
              .filter(
                (update) =>
                  update.sessionId === request.sessionId &&
                  BigInt(update.cursor) > BigInt(request.changes!.afterCursor) &&
                  BigInt(update.cursor) <= BigInt(request.changes!.upperCursor),
              )
              .map((update) => update.id),
          )
        : undefined;
      const remaining = histories
        .get(request.sessionId)!
        .filter(
          (message) =>
            BigInt(message.seq) > BigInt(request.afterSeq ?? '0') &&
            BigInt(message.seq) <= BigInt(request.upperSeq ?? String(count * 2 + 1)) &&
            (!changedIds || changedIds.has(message.id)),
        );
      const messages = remaining.slice(0, request.limit);
      reads.push({
        kind: request.changes ? 'incremental' : 'full',
        sessionId: request.sessionId,
        count: messages.length,
        cursor: request.changes?.afterCursor,
      });
      return structuredClone({
        messages,
        highWaterSeq: request.upperSeq ?? String(count * 2 + 1),
        nextAfterSeq: remaining.length > messages.length ? messages.at(-1)!.seq : null,
        ...(request.changes
          ? {
              changes: {
                ...request.changes,
                nextCursor: request.changes.upperCursor,
                removedIds: [],
              },
            }
          : {}),
      });
    }
    if (
      request.method === 'toolMessages.usage' &&
      result &&
      'kind' in result &&
      'entries' in result &&
      result.kind === 'toolMessages.usage'
    )
      return {
        ...result,
        entries: result.entries.map((entry) => ({
          ...entry,
          executionId: modelSources.get(entry.messageId)!,
        })),
      };
    return result;
  },
};
const automaticFirst = '初始预览，已经保存的完整正文。';
const automaticSecond = `${automaticFirst}，逐字新增🙂`;
const automaticBytes = (text: string) => String(new TextEncoder().encode(text).length);
let automaticMessage: Message;
let automaticResolve: ((snapshot: ModelOutputSnapshot) => void) | undefined;
let automaticCopied: string | undefined;
const automaticSnapshot = (text: string): ModelOutputSnapshot => ({
  storeId: 'store',
  sessionId: 'a',
  rootSessionId: 'a',
  runId: 'r-auto',
  executionId: 'model-auto',
  originCommandId: 'c-auto',
  rootWorkCommandId: 'c-auto',
  rootWorkSeq: '1',
  attempt: 1,
  status: 'running',
  bodyHash: 'a'.repeat(64),
  bodyBytes: '1',
  contentBytes: automaticBytes(text),
  reasoningBytes: '0',
  snapshotCursor: text === automaticFirst ? '1' : '2',
  output: { content: text, reasoning: '', toolCalls: [], complete: false },
});
function renderAutomatic() {
  root.render(
    <div className="kite-client">
      <div className="conversation-viewport" style={{ height: 800, padding: 24 }}>
        <NativeModelOutputMessage
          message={automaticMessage}
          storeId="store"
          onRead={() =>
            new Promise((resolve) => {
              automaticResolve = resolve;
            })
          }
          onContent={(text) => {
            automaticCopied = text;
          }}
        />
      </div>
    </div>,
  );
}
const api = {
  firstReply(stage: 'thinking' | 'body') {
    root.render(
      <div
        className="kite-client"
        style={{ height: 680, display: 'flex', flexDirection: 'column' }}
      >
        <Conversation
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'first-reply', status: 'running' }}
          messages={[
            {
              id: 'old',
              role: 'assistant',
              text: 'Earlier conversation.\n\n'.repeat(60),
              settled: true,
            },
            {
              id: 'input',
              role: 'user',
              text: 'Ordinary conversation without tools.',
              settled: true,
            },
            stage === 'thinking'
              ? {
                  id: 'thinking',
                  turnId: 'first-reply',
                  role: 'thinking',
                  text: '',
                  settled: false,
                }
              : {
                  id: 'first-body',
                  turnId: 'first-reply',
                  role: 'assistant',
                  settled: false,
                  text: 'Weekend coffee feels like a quiet hug after a busy week at the office. '.repeat(
                    4,
                  ),
                },
          ]}
        />
      </div>,
    );
  },
  automaticState: () => ({
    pending: !!automaticResolve,
    copied: automaticCopied,
    first: automaticFirst,
    second: automaticSecond,
  }),
  automaticBody(stage: 'mount' | 'first' | 'pending' | 'second' | 'seal' | 'sealed') {
    if (stage === 'sealed') {
      const resolve = automaticResolve;
      automaticResolve = undefined;
      const snapshot = automaticSnapshot(automaticSecond);
      resolve!({
        ...snapshot,
        status: 'succeeded',
        output: { ...snapshot.output, complete: true },
      });
      return;
    }
    if (stage === 'first' || stage === 'second') {
      const resolve = automaticResolve;
      automaticResolve = undefined;
      resolve!(automaticSnapshot(stage === 'first' ? automaticFirst : automaticSecond));
      return;
    }
    automaticMessage = {
      id: 'auto',
      sessionId: 'a',
      runId: 'r-auto',
      seq: '1',
      role: 'assistant',
      status: stage === 'seal' ? 'complete' : 'incomplete',
      content: stage === 'seal' ? automaticSecond : '初始预览',
      outputBody: {
        kind: 'model_output',
        executionId: 'model-auto',
        complete: stage === 'seal',
        contentBytes: automaticBytes(stage === 'mount' ? automaticFirst : automaticSecond),
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    };
    renderAutomatic();
  },
  reads: () => structuredClone(reads),
  reconnect() {
    historyEpoch++;
    for (const [id, version] of versions) baselines.set(id, version);
    metadataRevision++;
    control.publish();
  },
  delayHistory(milliseconds: number) {
    historyDelay = milliseconds;
  },
  append(text: string, id = 'a') {
    const messages = histories.get(id)!;
    messages[messages.length - 1] = {
      ...messages.at(-1)!,
      content: messages.at(-1)!.content + text,
    };
    updated(id);
  },
  stream(id = 'a') {
    const messages = histories.get(id)!;
    chunk++;
    messages[messages.length - 1] = {
      ...messages.at(-1)!,
      content: `${messages.at(-1)!.content}\n\n新增流式片段 ${chunk}。TAIL-${id.toUpperCase()}-${chunk}`,
    };
    updated(id);
    return `TAIL-${id.toUpperCase()}-${chunk}`;
  },
  hold: control.hold,
  release: control.release,
  resume: control.resume,
  pending: control.pending,
  settle(id = 'a') {
    settled.add(id);
    const messages = histories.get(id)!;
    messages[messages.length - 1] = { ...messages.at(-1)!, status: 'complete' };
    updated(id);
  },
};
declare global {
  interface Window {
    renderPerformanceFixture: typeof api;
  }
}
window.renderPerformanceFixture = api;
Object.defineProperty(window, 'kiteNative', { value: bridge });
document.documentElement.dataset.nativeWindow = 'true';
document.documentElement.dataset.platform = 'windows';
const root = createRoot(document.getElementById('root')!);
root.render(<NativeDesktop nativeWindow />);
