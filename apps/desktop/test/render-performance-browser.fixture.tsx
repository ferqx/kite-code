// Isolated production-renderer experiment. Never imported by application entrypoints.
import type { Message } from '@kite-ai/client';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type { NativeBridge } from '../src/native-bridge';
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
        selection: {
          ...result.selection,
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
      const remaining = histories
        .get(request.sessionId)!
        .filter(
          (message) =>
            BigInt(message.seq) > BigInt(request.afterSeq ?? '0') &&
            BigInt(message.seq) <= BigInt(request.upperSeq!),
        );
      const messages = remaining.slice(0, request.limit);
      return structuredClone({
        messages,
        highWaterSeq: request.upperSeq!,
        nextAfterSeq: remaining.length > messages.length ? messages.at(-1)!.seq : null,
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
const api = {
  stream(id = 'a') {
    const messages = histories.get(id)!;
    chunk++;
    messages[messages.length - 1] = {
      ...messages.at(-1)!,
      content: `${messages.at(-1)!.content}\n\n新增流式片段 ${chunk}。TAIL-${id.toUpperCase()}-${chunk}`,
    };
    control.publish();
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
    control.publish();
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
createRoot(document.getElementById('root')!).render(<NativeDesktop nativeWindow />);
