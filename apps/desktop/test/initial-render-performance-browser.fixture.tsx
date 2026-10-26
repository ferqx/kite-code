// Standalone renderer experiment; never imported by an ordinary client entrypoint.
import type { Message, Run } from '@kite-ai/client';
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

const params = new URL(location.href).searchParams;
const turns = Number(params.get('turns') ?? 180);
const blocks = Number(params.get('blocks') ?? 1);
const toolsPerTurn = Number(params.get('tools') ?? 0);
const now = () => performance.timeOrigin + performance.now();
const base = backgroundItem();
let liveTurns = turns;
const count = (id: string) => (id === 'large' ? liveTurns : 1);
const INITIAL_ENTRY_THRESHOLD = 100;
const INITIAL_ENTRY_WINDOW = 40;
const sessions = ['large', 'small'].map((id) => ({
  ...base.session,
  id,
  workspaceId: 'workspace',
  rootSessionId: id,
  title: id === 'large' ? 'Large history' : 'Small target',
  nextSeq: String(count(id) * (id === 'large' ? toolsPerTurn + 2 : 2) + 1),
}));
const histories = new Map<string, Message[]>();
const runLists = new Map<string, Run[]>();
function fixtureTurn(sessionId: string, index: number) {
  const runId = `run-${sessionId}-${index}`;
  const tools = sessionId === 'large' ? toolsPerTurn : 0;
  const firstSeq = index * (tools + 2) + 1;
  const run: Run = {
    ...base.run!,
    id: runId,
    sessionId,
    status: 'completed',
    isActive: false,
    waitingForResults: [],
    reason: null,
    originCommandId: `command-${runId}`,
    rootWorkCommandId: `command-${runId}`,
    rootWorkSeq: String(index + 1),
    createdAt: 1000 + index * 5000,
    finishedAt: 4000 + index * 5000,
    configuration: {
      modelId: 'model-a',
      snapshot: {
        version: 1,
        digest: 'a'.repeat(64),
        configuration: {
          models: [{ id: 'model-a', provider: 'compatible', protocol: 'chat-completions' }],
        },
      },
    },
  };
  const markdown = Array.from(
    { length: sessionId === 'large' ? blocks : 1 },
    (_, block) =>
      `## ${sessionId} 第 ${index + 1} 轮，第 ${block + 1} 节\n\n` +
      '这是完整已保存历史，**保留正文与阅读位置**，包含中文与 emoji🙂。\n\n'.repeat(3) +
      '- 第一项\n- 第二项含有 `inline code`\n\n' +
      '| State | Result |\n| --- | --- |\n| Saved | Stable |\n\n' +
      '```ts\nconst history = "complete source";\nconsole.log(history);\n```\n\n',
  ).join('');
  const messages: Message[] = [
    {
      id: `u-${sessionId}-${index}`,
      sessionId,
      runId,
      role: 'user',
      status: 'complete',
      seq: String(firstSeq),
      content: `Question ${sessionId} ${index + 1}`,
    },
    {
      id: `m-${sessionId}-${index}`,
      sessionId,
      runId,
      role: 'assistant',
      status: 'complete',
      seq: String(firstSeq + tools + 1),
      content: `${markdown}END-${sessionId}-${index}`,
      sourceIds: [`model-${sessionId}-${index}`],
    },
  ];
  if (tools)
    messages.splice(
      1,
      0,
      ...Array.from(
        { length: tools },
        (_, tool): Message => ({
          id: `tool-${sessionId}-${index}-${tool}`,
          sessionId,
          runId,
          role: 'tool',
          status: 'complete',
          seq: String(firstSeq + tool + 1),
          content: `Tool result ${index}-${tool}`,
          sourceIds: [`execution-${sessionId}-${index}-${tool}`],
          toolCallId: `tool-${sessionId}-${index}-${tool}`,
        }),
      ),
    );
  return { run, messages };
}
for (const session of sessions) {
  const turns = Array.from({ length: count(session.id) }, (_, index) =>
    fixtureTurn(session.id, index),
  );
  histories.set(
    session.id,
    turns.flatMap((turn) => turn.messages),
  );
  runLists.set(
    session.id,
    turns.map((turn) => turn.run),
  );
}
const messageRuns = new Map(
  [...histories.values()].flatMap((messages) =>
    messages.map((message) => [message.id, message.runId] as const),
  ),
);

const toolEntryFor = (message: Message) => ({
  messageId: message.id,
  executionId: message.sourceIds![0]!,
  definitionId: 'files.read',
  definitionVersion: '4',
  status: 'succeeded' as const,
  resultRevision: '1',
  target: `file-${message.id}.ts`,
});
const toolEntries = new Map(
  [...histories.values()].flatMap((messages) =>
    messages
      .filter((message) => message.role === 'tool')
      .map(
        (message) =>
          [message.id, { sessionId: message.sessionId, entry: toolEntryFor(message) }] as const,
      ),
  ),
);
let selected = 'small';
let view = 1;
let revision = 1;
let historyVersion = 1;
let historyBaseline = 1;
const historySnapshots = new Map<number, readonly Message[]>([[1, histories.get('large')!]]);
const historyChanges = new Map<number, readonly string[]>();
let holdLargeHistory = false;
const heldHistory: (() => void)[] = [];
let streamBase: string | undefined;
let churnTimer: ReturnType<typeof setInterval> | undefined;
let churnTick = 0;
let committedVersion = 0;
let committedTailId = `m-large-${turns - 1}`;
const listeners = new Set<(event: NativeEvent) => void>();
type Event = {
  kind: string;
  at: number;
  sessionId?: string;
  count?: number;
  version?: number;
  messageIds?: string[];
  readKind?: 'baseline' | 'incremental';
};
const events: Event[] = [];
const state = (): NativeState =>
  structuredClone({
    generation: 1,
    historyEpoch: 0,
    environmentRevision: revision,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: revision,
      viewSelection: view,
      historyCursor: String(selected === 'large' ? historyBaseline : 1),
      historyTargetCursor: String(selected === 'large' ? historyVersion : 1),
      session: sessions.find((entry) => entry.id === selected)!,
      runs: runLists
        .get(selected)!
        .filter((_, index, list) => index === 0 || index === list.length - 1),
      executions: [],
      interactions: [],
      interactionsAfterId: null,
      canReadModelOutput: false,
      viewLoading: false,
      permissionUnavailable: false,
      permissions: {
        observationId: view,
        mode: {
          storeId: 'store',
          sessionId: selected,
          scopeSessionId: selected,
          mode: 'auto',
          revision: '1',
          defaultMode: 'auto',
          defaultRevision: '1',
        },
        trust: {
          storeId: 'store',
          workspaceId: 'workspace',
          status: 'trusted',
          trusted: true,
          revision: '1',
          canonicalIdentity: 'a'.repeat(64),
          externalReadScopeDigest: 'b'.repeat(64),
          readScopes: [{ kind: 'workspace', description: 'Fixture workspace' }],
        },
      },
    },
  });
const scope = (request: Extract<NativeRequest, { readId: string }>) => ({
  generation: 1,
  storeId: 'store',
  sessionId: selected,
  workspaceId: 'workspace',
  viewSelection: 'viewSelection' in request ? request.viewSelection : view,
  historyEpoch: 0,
});
const bridge: NativeBridge = {
  watch(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async request(request): Promise<NativeResult> {
    events.push({
      kind: request.method,
      at: now(),
      sessionId: 'sessionId' in request ? request.sessionId : selected,
    });
    if (
      toolsPerTurn &&
      /(?:input|output|body|source)/i.test(request.method) &&
      request.method !== 'input.models.read' &&
      !request.method.endsWith('.close')
    ) {
      events.push({ kind: `cold-reader:${request.method}`, at: now(), sessionId: selected });
      throw new Error(`unexpected closed toolchain reader ${request.method}`);
    }
    switch (request.method) {
      case 'attach':
      case 'state':
        return state();
      case 'directory':
        return {
          storeId: 'store',
          sessions,
          workspaces: [{ id: 'workspace', name: 'Fixture workspace', rootUri: 'file:///fixture' }],
        };
      case 'select':
        selected = request.sessionId;
        if (selected === 'large') historyBaseline = historyVersion;
        view++;
        revision++;
        return state();
      case 'draft.read':
        return {
          id: request.sessionId,
          storeId: 'store',
          workspaceId: 'workspace',
          rootSessionId: request.sessionId,
          revision: 1,
          content: `Draft ${request.sessionId}`,
        };
      case 'messages': {
        const version = request.changes ? Number(request.changes.upperCursor) : historyBaseline;
        const snapshot =
          request.sessionId === 'large'
            ? historySnapshots.get(version)!
            : histories.get(request.sessionId)!;
        if (!snapshot) throw new Error(`missing fixture snapshot ${version}`);
        const highWaterSeq = request.upperSeq ?? String(BigInt(snapshot.at(-1)?.seq ?? '0') + 1n);
        const changedIds = request.changes
          ? new Set(
              [...historyChanges]
                .filter(([at]) => at > Number(request.changes!.afterCursor) && at <= version)
                .flatMap(([, ids]) => [...ids]),
            )
          : undefined;
        const remaining = snapshot.filter(
          (message) =>
            BigInt(message.seq) > BigInt(request.afterSeq ?? '0') &&
            BigInt(message.seq) <= BigInt(highWaterSeq) &&
            (!changedIds || changedIds.has(message.id)),
        );
        const messages = remaining.slice(0, request.limit);
        const nextAfterSeq = remaining.length > messages.length ? messages.at(-1)!.seq : null;
        if (request.changes)
          events.push({ kind: 'history:incremental', at: now(), version, count: messages.length });
        events.push({
          kind: nextAfterSeq === null ? 'history:eof' : 'history:page',
          at: now(),
          sessionId: request.sessionId,
          count: messages.length,
          messageIds: messages.map((message) => message.id),
          readKind: request.changes ? 'incremental' : 'baseline',
        });
        const result = structuredClone({
          messages,
          nextAfterSeq,
          highWaterSeq,
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
        if (holdLargeHistory && request.sessionId === 'large') {
          events.push({ kind: 'history:held', at: now(), sessionId: request.sessionId, version });
          await new Promise<void>((resolve) => heldHistory.push(resolve));
          events.push({
            kind: 'history:released',
            at: now(),
            sessionId: request.sessionId,
            version,
          });
        }
        return result;
      }
      case 'conversation.branch':
        return {
          kind: 'conversation.branch',
          storeId: 'store',
          workspaceId: request.workspaceId,
          repository: false,
          branches: [],
          label: 'Fixture',
        };
      case 'conversation.models.read':
      case 'input.models.read':
        return {
          kind: 'settings.models',
          storeId: 'store',
          scope: 'user',
          observationId: view,
          canWrite: false,
          errors: [],
          defaultModelId: 'model-a',
          selectedModelId: 'model-a',
          models: [
            {
              id: 'model-a',
              provider: 'compatible',
              protocol: 'chat-completions',
              model: 'Fixture model',
              configured: true,
              enabled: true,
              diagnostics: [],
              reasoningEffort: 'medium',
              reasoningEffortChoices: ['low', 'medium', 'high'],
            },
          ],
        };
      case 'toolMessages.runs': {
        const requested = new Set(request.messageIds.map((id) => messageRuns.get(id)));
        return {
          kind: 'toolMessages.runs',
          readId: request.readId,
          scope: scope(request),
          runs: runLists.get(selected)!.filter((run) => requested.has(run.id)),
        };
      }
      case 'toolMessages.list': {
        const entries = request.messageIds.flatMap((id) => {
          const observed = toolEntries.get(id);
          return observed?.sessionId === selected ? [observed.entry] : [];
        });
        events.push({
          kind: 'tools:metadata',
          at: now(),
          sessionId: selected,
          count: entries.length,
          messageIds: entries.map((entry) => entry.messageId),
        });
        return {
          kind: 'toolMessages.page',
          readId: request.readId,
          scope: scope(request),
          entries,
        };
      }
      case 'toolMessages.usage':
        return {
          kind: 'toolMessages.usage',
          readId: request.readId,
          scope: scope(request),
          entries: [],
        };
      case 'fileTargets.list':
      case 'fileChanges.list':
        return {
          kind: request.method === 'fileTargets.list' ? 'fileTargets.page' : 'fileChanges.page',
          readId: request.readId,
          scope: scope(request),
          entries: [],
        };
      case 'background.open':
        return {
          kind: 'background.page',
          viewGeneration: 1,
          viewSelection: view,
          rootSessionId: selected,
          storeId: 'store',
          readId: request.readId,
          observationId: revision,
          startIndex: 0,
          nextIndex: 0,
          total: 0,
          complete: true,
          entries: [],
        };
      default:
        return null;
    }
  },
};

const versionOf = (text: string) =>
  Number(text.match(/FIXTURE-VERSION-(\d+)/)?.[1] ?? text.match(/CHURN-(\d+)/)?.[1] ?? 0);
const publishLarge = (next: readonly Message[], changed: readonly Message[], kind: string) => {
  historyVersion++;
  const changedIds = new Set(changed.map((message) => message.id));
  const snapshot = next.map((message) =>
    changedIds.has(message.id) && message.role === 'assistant'
      ? {
          ...message,
          content: `${message.content.replace(/\n\n(?:FIXTURE-VERSION|CHURN)-\d+/g, '')}\n\nFIXTURE-VERSION-${historyVersion}`,
        }
      : message,
  );
  for (const message of snapshot)
    if (changedIds.has(message.id) && message.role === 'tool')
      toolEntries.set(message.id, { sessionId: message.sessionId, entry: toolEntryFor(message) });
  histories.set('large', snapshot);
  historySnapshots.set(historyVersion, snapshot);
  historyChanges.set(historyVersion, [...changedIds]);
  for (const message of snapshot)
    if (changedIds.has(message.id)) messageRuns.set(message.id, message.runId);
  sessions.find((session) => session.id === 'large')!.nextSeq = String(
    BigInt(snapshot.at(-1)!.seq) + 1n,
  );
  revision++;
  events.push({ kind, at: now(), version: historyVersion, count: changed.length });
  for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
};
const updateTail = (content: string, status: Message['status'], kind: string) => {
  const current = histories.get('large')!;
  const message = { ...current.at(-1)!, content, status };
  const runs = runLists.get('large')!;
  runLists.set(
    'large',
    runs.map((run, index) =>
      index === runs.length - 1
        ? {
            ...run,
            status: status === 'complete' ? 'completed' : 'running',
            isActive: status !== 'complete',
            finishedAt: status === 'complete' ? 4000 + (liveTurns - 1) * 5000 : null,
          }
        : run,
    ),
  );
  publishLarge([...current.slice(0, -1), message], [message], kind);
};

const colors = [
  [0, 0, 0],
  [220, 30, 30],
  [30, 70, 220],
  [20, 170, 40],
] as const;
const marker = document.createElement('div');
Object.assign(marker.style, {
  position: 'fixed',
  right: '0px',
  top: '0px',
  width: '32px',
  height: '32px',
  zIndex: '2147483647',
  pointerEvents: 'none',
  background: 'rgb(0,0,0)',
});
document.body.append(marker);
const input = document.createElement('button');
input.textContent = 'Input probe';
Object.assign(input.style, {
  position: 'fixed',
  right: '0px',
  bottom: '0px',
  width: '100px',
  height: '28px',
  zIndex: '2147483647',
});
document.body.append(input);
const clicks: { at: number; processedAt: number; target: string; trusted: boolean }[] = [];
const probes: { at: number; trusted: boolean }[] = [];
input.addEventListener('click', (event) => probes.push({ at: now(), trusted: event.isTrusted }));
document.addEventListener(
  'click',
  (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>('.session-row');
    if (!target) return;
    clicks.push({
      at: performance.timeOrigin + event.timeStamp,
      processedAt: now(),
      target: target.getAttribute('aria-label')!,
      trusted: event.isTrusted,
    });
  },
  true,
);
const frames: {
  at: number;
  stage: number;
  messages: number;
  messageIds: string[];
  entryKeys: string[];
  entryKinds: string[];
  height: number;
  top: number;
  busy: boolean;
  loader: boolean;
  hidden: boolean;
  inert: boolean;
  opacity: number;
  geometrySampled: boolean;
  domVersion: number;
  committedVersion: number;
  staleVisible: boolean;
}[] = [];
type AnchorFrame = {
  at: number;
  top: number;
  viewportTop: number;
  scrollTop: number;
  entries: number;
  firstKey?: string;
  connected: boolean;
  sameNode: boolean;
};
let rememberedWindow = new Map<string, HTMLElement>();
let anchorWatch:
  | { node: HTMLElement; key: string; baseline: number; frames: AnchorFrame[] }
  | undefined;
const readWindow = () => {
  const viewport = document.querySelector<HTMLElement>('.conversation-viewport')!;
  const entries = [...viewport.querySelectorAll<HTMLElement>('.conversation-entry')];
  const messageIds = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].map(
    (message) => message.dataset.messageId!,
  );
  return { viewport, entries, messageIds };
};
const observeAnchor = () => {
  if (!anchorWatch) return;
  const { viewport, entries } = readWindow();
  anchorWatch.frames.push({
    at: now(),
    top: anchorWatch.node.getBoundingClientRect().top,
    viewportTop: viewport.getBoundingClientRect().top,
    scrollTop: viewport.scrollTop,
    entries: entries.length,
    firstKey: entries[0]?.dataset.conversationEntryKey,
    connected: anchorWatch.node.isConnected,
    sameNode:
      entries.find((entry) => entry.dataset.conversationEntryKey === anchorWatch!.key) ===
      anchorWatch.node,
  });
};
const longTasks: { at: number; duration: number }[] = [];
const heartbeats: { at: number; delay: number }[] = [];
const commits: {
  phase: string;
  duration: number;
  baseDuration: number;
  startAt: number;
  at: number;
  observedAt: number;
}[] = [];
let enabled = false;
let calibration: number | undefined;
let previousHeight = 0;
let previousEntries = '';
let stable = 0;
let currentStage = 0;
const sample = (frameTick = false) => {
  const viewport = document.querySelector<HTMLElement>('.conversation-viewport');
  const heading = document.querySelector('.breadcrumb strong');
  const title = heading?.getAttribute('title') ?? heading?.textContent;
  const id = title === 'Large history' ? 'large' : title === 'Small target' ? 'small' : undefined;
  const tail = id
    ? viewport?.querySelector<HTMLElement>(
        `[data-message-id="${id === 'large' ? committedTailId : 'm-small-0'}"]`,
      )
    : undefined;
  let stage = 0;
  const messageIds = [...(viewport?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].map(
    (message) => message.dataset.messageId!,
  );
  const messages = messageIds.length;
  const column = viewport?.querySelector<HTMLElement>('.reading-column');
  const entryNodes = [...(column?.querySelectorAll<HTMLElement>('.conversation-entry') ?? [])];
  const entryKeys = entryNodes.map((entry) => entry.dataset.conversationEntryKey!);
  const entryKinds = entryNodes.map((entry) => entry.dataset.entryKind!);
  const entrySignature = entryKeys.join('\u0000');
  const expectedInitialEntries =
    turns * 2 > INITIAL_ENTRY_THRESHOLD ? INITIAL_ENTRY_WINDOW : turns * 2;
  const loader = !!document.querySelector('.conversation-loading');
  const hidden = column?.getAttribute('aria-hidden') === 'true';
  const inert = !!column && (column.inert || column.hasAttribute('inert'));
  // Hidden staging must not be pre-laid-out by the measurement observer.
  const blocked = loader || hidden || inert || !column || column.style.opacity === '0';
  const opacity = blocked ? 0 : Number.parseFloat(getComputedStyle(column).opacity);
  const readable = !loader && !hidden && !inert && opacity > 0;
  const domVersion = versionOf(tail?.textContent ?? '');
  if (
    readable &&
    viewport &&
    tail?.textContent?.includes(
      id === 'large' ? `END-large-${committedTailId.slice('m-large-'.length)}` : 'END-small-0',
    )
  ) {
    const bounds = viewport.getBoundingClientRect();
    const tailBounds = (
      tail.querySelector('.typeset-chat')?.lastElementChild ?? tail
    ).getBoundingClientRect();
    if (tailBounds.bottom > bounds.top && tailBounds.top < bounds.bottom) {
      if (id === 'small') stage = 3;
      else {
        stage = 1;
        const height = viewport.scrollHeight;
        if (frameTick)
          stable =
            entryKeys.length === expectedInitialEntries &&
            entrySignature === previousEntries &&
            height === previousHeight
              ? stable + 1
              : 0;
        previousHeight = height;
        previousEntries = entrySignature;
        if (stable >= 2) stage = 2;
      }
    }
  }
  if (!stage) {
    stable = 0;
    previousHeight = 0;
  }
  currentStage = stage;
  marker.style.background = `rgb(${colors[calibration ?? stage]!.join(',')})`;
  if (enabled)
    frames.push({
      at: now(),
      stage,
      messages,
      messageIds,
      entryKeys,
      entryKinds,
      height: readable ? (viewport?.scrollHeight ?? 0) : 0,
      top: readable ? (viewport?.scrollTop ?? 0) : 0,
      geometrySampled: readable,
      domVersion,
      committedVersion,
      staleVisible: readable && id === 'large' && !!tail && domVersion !== committedVersion,
      busy: viewport?.getAttribute('aria-busy') === 'true',
      loader,
      hidden,
      inert,
      opacity,
    });
};
new MutationObserver(() => sample()).observe(document.getElementById('root')!, {
  childList: true,
  subtree: true,
});
const frame = () => {
  sample(true);
  observeAnchor();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
new PerformanceObserver((list) => {
  if (enabled)
    for (const entry of list.getEntries())
      longTasks.push({ at: performance.timeOrigin + entry.startTime, duration: entry.duration });
}).observe({ type: 'longtask', buffered: true });
let expected = performance.now() + 10;
setInterval(() => {
  const at = performance.now();
  if (enabled)
    heartbeats.push({ at: performance.timeOrigin + at, delay: Math.max(0, at - expected) });
  expected = at + 10;
}, 10);
const api = {
  turns,
  blocks,
  toolsPerTurn,
  initialEntryThreshold: INITIAL_ENTRY_THRESHOLD,
  initialEntryWindow: INITIAL_ENTRY_WINDOW,
  currentTurns: () => liveTurns,
  sourceMessages: () => histories.get('large')!.map((message) => message.id),
  currentVersion: () => historyVersion,
  events,
  clicks,
  frames,
  probes,
  commits,
  longTasks,
  heartbeats,
  stage: () => currentStage,
  observeCommittedMessages(messages: readonly { id: string; text: string }[]) {
    let tail: { id: string; text: string } | undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (!messages[index]!.id.startsWith('m-large-')) continue;
      tail = messages[index];
      break;
    }
    if (!tail) return;
    committedTailId = tail.id;
    committedVersion = versionOf(tail.text);
    if (enabled) events.push({ kind: 'props:committed', at: now(), version: committedVersion });
  },
  windowSnapshot() {
    const { viewport, entries, messageIds } = readWindow();
    const bounds = viewport.getBoundingClientRect();
    return {
      entryKeys: entries.map((entry) => entry.dataset.conversationEntryKey!),
      entryKinds: entries.map((entry) => entry.dataset.entryKind!),
      messageIds,
      top: viewport.scrollTop,
      height: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      tailId: committedTailId,
      domVersion: versionOf(
        viewport.querySelector(`[data-message-id="${committedTailId}"]`)?.textContent ?? '',
      ),
      committedVersion,
      visibleEntries: entries
        .filter((entry) => {
          const box = entry.getBoundingClientRect();
          return box.bottom > bounds.top && box.top < bounds.bottom;
        })
        .map((entry) => ({
          key: entry.dataset.conversationEntryKey!,
          top: entry.getBoundingClientRect().top,
        })),
    };
  },
  rememberWindow() {
    rememberedWindow = new Map(
      readWindow().entries.map((entry) => [entry.dataset.conversationEntryKey!, entry]),
    );
    return [...rememberedWindow.keys()];
  },
  retainedWindow() {
    const nodes = new Map(
      readWindow().entries.map((entry) => [entry.dataset.conversationEntryKey!, entry]),
    );
    return [...rememberedWindow].map(([key, node]) => ({
      key,
      connected: node.isConnected,
      sameNode: nodes.get(key) === node,
    }));
  },
  beginManualWatch() {
    if (anchorWatch) throw new Error('an anchor observation is already active');
    const { viewport, entries } = readWindow();
    const bounds = viewport.getBoundingClientRect();
    const node = entries.find((entry) => {
      const box = entry.getBoundingClientRect();
      return box.bottom > bounds.top && box.top < bounds.bottom;
    })!;
    anchorWatch = {
      node,
      key: node.dataset.conversationEntryKey!,
      baseline: node.getBoundingClientRect().top,
      frames: [],
    };
    observeAnchor();
    return { key: anchorWatch.key, baseline: anchorWatch.baseline, entries: entries.length };
  },
  beginEarlierWatch() {
    if (anchorWatch) throw new Error('an anchor observation is already active');
    const { viewport, entries } = readWindow();
    const node = entries[0]!;
    viewport.scrollTop = 0;
    anchorWatch = {
      node,
      key: node.dataset.conversationEntryKey!,
      baseline: node.getBoundingClientRect().top,
      frames: [],
    };
    observeAnchor();
    return { key: anchorWatch.key, baseline: anchorWatch.baseline, entries: entries.length };
  },
  endEarlierWatch() {
    if (!anchorWatch) throw new Error('no anchor observation');
    observeAnchor();
    const result = {
      key: anchorWatch.key,
      baseline: anchorWatch.baseline,
      frames: anchorWatch.frames,
    };
    anchorWatch = undefined;
    return result;
  },
  appendTurn() {
    if (selected !== 'large') throw new Error('append requires the current large conversation');
    const turn = fixtureTurn('large', liveTurns++);
    runLists.set('large', [...runLists.get('large')!, turn.run]);
    publishLarge([...histories.get('large')!, ...turn.messages], turn.messages, 'history:append');
    return { tailId: turn.messages.at(-1)!.id, version: historyVersion };
  },
  beginStream() {
    if (selected !== 'large') throw new Error('stream requires the current large conversation');
    const turn = fixtureTurn('large', liveTurns++);
    streamBase = turn.messages.at(-1)!.content;
    turn.run = { ...turn.run, status: 'running', isActive: true, finishedAt: null };
    turn.messages[turn.messages.length - 1] = {
      ...turn.messages.at(-1)!,
      status: 'incomplete',
      content: `${streamBase}\n\nSTREAM-START`,
    };
    runLists.set('large', [...runLists.get('large')!, turn.run]);
    publishLarge([...histories.get('large')!, ...turn.messages], turn.messages, 'stream:start');
    return { tailId: turn.messages.at(-1)!.id, version: historyVersion };
  },
  stream(step: number, complete = false) {
    if (!streamBase) throw new Error('no current fixture stream');
    updateTail(
      `${streamBase}\n\nSTREAM-STEP-${step}${complete ? '-COMPLETE' : ''}`,
      complete ? 'complete' : 'incomplete',
      complete ? 'stream:complete' : 'stream:append',
    );
    if (complete) streamBase = undefined;
    return historyVersion;
  },
  holdHistory() {
    if (heldHistory.length) throw new Error('an old history response is still held');
    holdLargeHistory = true;
  },
  pendingHistory: () => heldHistory.length,
  releaseHistory() {
    holdLargeHistory = false;
    const pending = heldHistory.splice(0);
    for (const resolve of pending) resolve();
    return pending.length;
  },
  startChurn() {
    if (churnTimer) throw new Error('churn already running');
    events.push({ kind: 'churn:start', at: now() });
    churnTimer = setInterval(() => {
      if (selected !== 'large') return;
      churnTick++;
      if (churnTick % 2 === 0) {
        const current = histories.get('large')!;
        const message = current.at(-1)!;
        publishLarge(current, [message], 'churn:message');
      } else {
        revision++;
        for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
      }
      events.push({ kind: 'churn:tick', at: now(), version: historyVersion });
    }, 40);
  },
  stopChurn() {
    clearInterval(churnTimer);
    churnTimer = undefined;
    events.push({ kind: 'churn:stop', at: now(), version: historyVersion });
  },
  structuralReady<T>(sessionId: string | undefined, phase: string, pending: T): T {
    if (sessionId === 'large' && phase === 'complete' && !pending)
      events.push({ kind: 'structural:ready', at: now(), sessionId });
    return pending;
  },
  calibrate(value?: number) {
    calibration = value;
    sample();
  },
  begin() {
    enabled = true;
    expected = performance.now() + 10;
    frames.length = 0;
    longTasks.length = 0;
    heartbeats.length = 0;
    commits.length = 0;
    previousHeight = 0;
    previousEntries = '';
    stable = 0;
  },
  end() {
    enabled = false;
    return { events, clicks, frames, probes, commits, longTasks, heartbeats };
  },
};
declare global {
  interface Window {
    initialRenderFixture: typeof api;
  }
}
window.initialRenderFixture = api;
Object.defineProperty(window, 'kiteNative', { value: bridge });
document.documentElement.dataset.nativeWindow = 'true';
document.documentElement.dataset.platform = 'macos';
createRoot(document.getElementById('root')!).render(
  <Profiler
    id="initial-render"
    onRender={(_id, phase, duration, baseDuration, startTime, commitTime) => {
      if (enabled)
        commits.push({
          phase,
          duration,
          baseDuration,
          startAt: performance.timeOrigin + startTime,
          at: performance.timeOrigin + commitTime,
          observedAt: now(),
        });
    }}
  >
    <NativeDesktop nativeWindow />
  </Profiler>,
);
