// Standalone acceptance fixture. This bridge, paint marker and control surface
// are never imported by a development or production application entrypoint.
import type { Message, Run } from '@kite-ai/client';
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type {
  NativeBridge,
  NativeDirectory,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

const base = backgroundItem();
const turns = 20;
const workspaces = Array.from({ length: 20 }, (_, index) => ({
  id: `w-${index}`,
  name: `Workspace ${String(index + 1).padStart(2, '0')}`,
  rootUri: `file:///fixture/workspace-${index}`,
}));
const sessions = Array.from({ length: 100 }, (_, index) => ({
  ...base.session,
  id: `s-${index}`,
  workspaceId: workspaces[Math.floor(index / 5)]!.id,
  rootSessionId: `s-${index}`,
  title: `Cache ${String(index + 1).padStart(2, '0')}`,
  nextSeq: String(turns * 2 + 1),
}));
const directory: NativeDirectory = { storeId: 'store', sessions, workspaces };
const histories = new Map<string, Message[]>();
const runLists = new Map<string, Run[]>();
for (const session of sessions) {
  const runs: Run[] = [];
  const messages: Message[] = [];
  for (let index = 0; index < turns; index++) {
    const runId = `run-${session.id}-${index}`;
    runs.push({
      ...base.run!,
      id: runId,
      sessionId: session.id,
      status: 'completed',
      isActive: false,
      waitingForResults: [],
      reason: null,
      originCommandId: `command-${session.id}-${index}`,
      rootWorkCommandId: `command-${session.id}-${index}`,
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
    });
    messages.push(
      {
        id: `u-${session.id}-${index}`,
        sessionId: session.id,
        runId,
        role: 'user',
        status: 'complete',
        seq: String(index * 2 + 1),
        content: `Question ${session.id} turn ${index + 1}`,
      },
      {
        id: `m-${session.id}-${index}`,
        sessionId: session.id,
        runId,
        role: 'assistant',
        status: 'complete',
        seq: String(index * 2 + 2),
        content:
          `SESSION-${session.id} reply ${index + 1}. 中文与 emoji🙂 保留阅读位置。` +
          (index === turns - 1
            ? '\n\n| State | Result |\n| --- | --- |\n| Saved | Stable |\n\n```ts\nconst cache = "original DOM";\nconsole.log(cache);\n```'
            : ''),
        sourceIds: [`model-${session.id}-${index}`],
      },
    );
  }
  histories.set(session.id, messages);
  runLists.set(session.id, runs);
}

let selected = 's-0';
let view = 1;
let revision = 1;
let selectionDelay = 0;
let holdNext = false;
const held = new Map<string, () => void>();
const listeners = new Set<(event: NativeEvent) => void>();
const requests: { method: NativeRequest['method']; sessionId?: string; at: number }[] = [];
const selections: { sessionId: string; view: number; startedAt: number; settledAt?: number }[] = [];
const state = (): NativeState => ({
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
    session: sessions.find((session) => session.id === selected)!,
    runs: runLists.get(selected)!,
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
        workspaceId: sessions.find((session) => session.id === selected)!.workspaceId,
        status: 'trusted',
        trusted: true,
        revision: '1',
        canonicalIdentity: 'a'.repeat(64),
        externalReadScopeDigest: 'b'.repeat(64),
        readScopes: [{ kind: 'workspace', description: 'Workspace' }],
      },
    },
  },
});
const scope = (request: Extract<NativeRequest, { readId: string }>) => ({
  generation: 1,
  storeId: 'store',
  sessionId: selected,
  workspaceId: sessions.find((session) => session.id === selected)!.workspaceId,
  viewSelection: 'viewSelection' in request ? request.viewSelection : view,
  historyEpoch: 0,
});
const bridge: NativeBridge = {
  watch(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async request(request): Promise<NativeResult> {
    requests.push({
      method: request.method,
      sessionId: 'sessionId' in request ? request.sessionId : undefined,
      at: performance.timeOrigin + performance.now(),
    });
    switch (request.method) {
      case 'attach':
      case 'state':
        return state();
      case 'directory':
        return directory;
      case 'select': {
        selected = request.sessionId;
        view++;
        revision++;
        const result = state();
        const selection = {
          sessionId: request.sessionId,
          view,
          startedAt: performance.timeOrigin + performance.now(),
          settledAt: undefined as number | undefined,
        };
        selections.push(selection);
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => held.set(request.sessionId, resolve));
        } else if (selectionDelay) {
          await new Promise<void>((resolve) => setTimeout(resolve, selectionDelay));
        }
        selection.settledAt = performance.timeOrigin + performance.now();
        return result;
      }
      case 'draft.read':
        return {
          id: request.sessionId,
          storeId: 'store',
          workspaceId: sessions.find((session) => session.id === request.sessionId)!.workspaceId,
          rootSessionId: request.sessionId,
          revision: 1,
          content: `Draft ${request.sessionId}`,
        };
      case 'messages':
        return {
          messages: histories.get(request.sessionId)!,
          nextAfterSeq: null,
          highWaterSeq: request.upperSeq!,
        };
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
              model: 'Fixture Model',
              configured: true,
              enabled: true,
              diagnostics: [],
              reasoningEffort: 'medium',
              reasoningEffortChoices: ['low', 'medium', 'high'],
            },
          ],
        };
      case 'toolMessages.runs':
        return {
          kind: 'toolMessages.runs',
          readId: request.readId,
          scope: scope(request),
          runs: runLists.get(selected)!,
        };
      case 'toolMessages.list':
        return {
          kind: 'toolMessages.page',
          readId: request.readId,
          scope: scope(request),
          entries: [],
        };
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
          viewGeneration: revision,
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

const colors = [
  [220, 30, 30],
  [20, 170, 40],
  [30, 70, 220],
  [210, 160, 10],
  [180, 30, 190],
  [0, 160, 180],
  [240, 100, 20],
  [110, 50, 220],
  [40, 120, 80],
] as const;
const marker = document.createElement('div');
marker.setAttribute('data-session-cache-paint-marker', '');
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
const clicks: { index: number; target: string; at: number; trusted: boolean }[] = [];
const domFrames: {
  at: number;
  title: string;
  sessionId?: string;
  scrollTop: number;
  busy: boolean;
  complete: boolean;
}[] = [];
const scans: { at: number; root: string }[] = [];
type OriginalNodes = {
  viewport: Element;
  messages: Element[];
  table: Element | null;
  code: Element | null;
};
const identities = new Map<string, OriginalNodes>();
const scrollSamples: { at: number; sessionId: string; scrollTop: number }[] = [];
document.addEventListener(
  'scroll',
  (event) => {
    const viewport = event.target;
    if (!(viewport instanceof HTMLElement)) return;
    for (const [sessionId, original] of identities) {
      if (original.viewport !== viewport) continue;
      scrollSamples.push({
        at: performance.timeOrigin + performance.now(),
        sessionId,
        scrollTop: viewport.scrollTop,
      });
      break;
    }
  },
  true,
);
const reactCommits: {
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}[] = [];
const componentCommits: {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}[] = [];
const nativeRenders: Record<string, unknown>[] = [];
const stateUpdates: { at: number; source: string }[] = [];
const recordComponentCommit = (
  id: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
) =>
  componentCommits.push({
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime: performance.timeOrigin + startTime,
    commitTime: performance.timeOrigin + commitTime,
  });
const longTasks: { start: number; duration: number }[] = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    longTasks.push({ start: performance.timeOrigin + entry.startTime, duration: entry.duration });
}).observe({ type: 'longtask', buffered: true });
let paintedSession: string | undefined;
let lastMutation = performance.now();
const originalWalker = Document.prototype.createTreeWalker;
Document.prototype.createTreeWalker = function (...args) {
  const root = args[0];
  if (root instanceof Element && root.classList.contains('conversation-cache-container'))
    scans.push({ at: performance.timeOrigin + performance.now(), root: root.className });
  return originalWalker.apply(this, args);
};
const observe = () => {
  const viewport = document.querySelector<HTMLElement>('.conversation-viewport');
  const title = document.querySelector('.breadcrumb strong')?.textContent ?? '';
  const match = viewport?.textContent?.match(/SESSION-(s-\d+) reply/);
  const sessionId = match?.[1];
  const session = sessions.find((session) => session.id === sessionId);
  const expected = sessionId ? histories.get(sessionId) : undefined;
  const messages = viewport
    ? [...viewport.querySelectorAll<HTMLElement>('.message[data-message-id]')]
    : [];
  const complete = !!(
    session &&
    sessionId &&
    title === session.title &&
    expected &&
    messages.length === expected.length &&
    messages.every(
      (message, index) =>
        message.dataset.messageId === expected[index]!.id &&
        message.textContent?.includes(expected[index]!.content!.split('\n')[0]!),
    ) &&
    viewport?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    viewport.querySelector('table') &&
    viewport.querySelector('pre')
  );
  if (complete && sessionId && sessionId !== paintedSession) {
    paintedSession = sessionId;
    const index = Number(sessionId.slice(2));
    marker.style.background = `rgb(${colors[index % colors.length]!.join(',')})`;
    marker.dataset.sessionId = sessionId;
  } else if (!complete) {
    paintedSession = undefined;
    marker.style.background = 'rgb(0,0,0)';
    delete marker.dataset.sessionId;
  }
  domFrames.push({
    at: performance.timeOrigin + performance.now(),
    title,
    sessionId,
    scrollTop: viewport?.scrollTop ?? 0,
    complete,
    busy:
      document.querySelector('fieldset.conversation-cache-entry')?.getAttribute('aria-busy') ===
      'true',
  });
};
new MutationObserver((records) => {
  if (records.every((record) => record.target === marker)) return;
  lastMutation = performance.now();
  observe();
}).observe(document.getElementById('root')!, {
  subtree: true,
  childList: true,
  characterData: true,
});
document.addEventListener(
  'click',
  (event) => {
    const target = event.target instanceof Element ? event.target.closest('.session-row') : null;
    const title = target?.getAttribute('aria-label');
    const session = sessions.find((session) => session.title === title);
    if (!session) return;
    const click = {
      index: clicks.length,
      target: session.id,
      at: performance.timeOrigin + event.timeStamp,
      trusted: event.isTrusted,
    };
    clicks.push(click);
    performance.mark(`session-cache-click-${click.index}`);
  },
  true,
);
const control = {
  colors,
  markerSession: () => marker.dataset.sessionId,
  requests,
  selections,
  clicks,
  domFrames,
  scans,
  identities,
  scrollSamples,
  reactCommits,
  componentCommits,
  nativeRenders,
  stateUpdates,
  recordComponentCommit,
  longTasks,
  settled: () => performance.now() - lastMutation >= 80,
  setSelectionDelay(milliseconds: number) {
    selectionDelay = milliseconds;
  },
  holdNextSelection() {
    holdNext = true;
  },
  pending: (id: string) => held.has(id),
  release(id: string) {
    const resolve = held.get(id);
    held.delete(id);
    resolve?.();
  },
  remember(id: string) {
    const viewport = document.querySelector('.conversation-viewport')!;
    identities.set(id, {
      viewport,
      messages: [...viewport.querySelectorAll('.message[data-message-id]')],
      table: viewport.querySelector('table'),
      code: viewport.querySelector('pre'),
    });
  },
  same(id: string) {
    const previous = identities.get(id);
    const viewport = document.querySelector('.conversation-viewport');
    const messages = viewport ? [...viewport.querySelectorAll('.message[data-message-id]')] : [];
    return (
      !!previous &&
      previous.viewport === viewport &&
      messages.length === previous.messages.length &&
      messages.every((message, index) => message === previous.messages[index]) &&
      previous.table === viewport?.querySelector('table') &&
      previous.code === viewport?.querySelector('pre')
    );
  },
  selected: () => selected,
};
declare global {
  interface Window {
    sessionCachePerformanceFixture: typeof control;
  }
}
Object.defineProperty(window, 'kiteNative', { value: bridge });
window.sessionCachePerformanceFixture = control;
const native = <NativeDesktop />;
createRoot(document.getElementById('root')!).render(
  new URL(location.href).searchParams.has('profile') ? (
    <Profiler
      id="cache-performance"
      onRender={(_id, phase, actualDuration, baseDuration, startTime, commitTime) =>
        reactCommits.push({
          phase,
          actualDuration,
          baseDuration,
          startTime: performance.timeOrigin + startTime,
          commitTime: performance.timeOrigin + commitTime,
        })
      }
    >
      {native}
    </Profiler>
  ) : (
    native
  ),
);
