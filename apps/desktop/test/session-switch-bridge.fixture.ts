import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../src/native-bridge';
import { backgroundItem } from './background-item.fixture';

/** Explicit fixture port, shared by real Native DOM and browser tests. */
export function sessionSwitchBridge(
  options: {
    active?: boolean;
    drafts?: Record<string, string>;
    sameModel?: boolean;
    modelErrors?: Record<string, string>;
    modelNames?: Record<string, string>;
  } = {},
) {
  const base = backgroundItem();
  const sessions = ['a', 'b'].map((id) => ({
    ...base.rootSession,
    id,
    rootSessionId: id,
    title: `Session ${id.toUpperCase()}`,
    nextSeq: '3',
  }));
  let selected = 'a',
    view = 1,
    revision = 1,
    selecting = false,
    withdrawn = false,
    refreshing = false,
    failed = false;
  let held = false;
  const pending = new Map<string, (() => void)[]>();
  const listeners = new Set<(event: NativeEvent) => void>();
  const requests: NativeRequest[] = [];
  const send = () => {
    for (const listener of listeners) listener({ kind: 'changed', generation: 1 });
  };
  const wait = (phase: string, result: () => NativeResult) =>
    !held
      ? Promise.resolve(result())
      : new Promise<NativeResult>((resolve, reject) => {
          const queue = pending.get(phase) ?? [];
          queue.push(() => {
            try {
              resolve(result());
            } catch (cause) {
              reject(cause);
            }
          });
          pending.set(phase, queue);
        });
  const session = () => sessions.find((value) => value.id === selected)!;
  const run = () => ({
    ...base.run!,
    id: `run-${selected}`,
    sessionId: selected,
    isActive: options.active ?? true,
  });
  const state = (): NativeState => ({
    generation: 1,
    historyEpoch: 0,
    environmentRevision: revision,
    environmentReadUnavailable: selecting || failed || withdrawn,
    backgroundUnavailable: withdrawn || undefined,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection:
      selecting || withdrawn
        ? undefined
        : {
            storeId: 'store',
            viewGeneration: revision,
            viewSelection: view,
            session: session(),
            runs: [run()],
            executions: [],
            interactions: [],
            interactionsAfterId: null,
            canReadModelOutput: false,
            viewLoading: refreshing,
            permissionUnavailable: refreshing || failed,
            ...(!refreshing && !failed
              ? {
                  permissions: {
                    observationId: view,
                    mode: {
                      storeId: 'store',
                      sessionId: selected,
                      scopeSessionId: selected,
                      mode: selected === 'a' ? ('auto' as const) : ('full' as const),
                      revision: '1',
                      defaultMode: 'auto' as const,
                      defaultRevision: '1',
                    },
                    trust: {
                      storeId: 'store',
                      workspaceId: 'w',
                      status: 'trusted' as const,
                      trusted: true,
                      revision: '1',
                      canonicalIdentity: 'a'.repeat(64),
                      externalReadScopeDigest: 'b'.repeat(64),
                      readScopes: [{ kind: 'workspace' as const, description: 'Workspace' }],
                    },
                  },
                }
              : {}),
          },
  });
  const scope = (request: Extract<NativeRequest, { readId: string }>) => ({
    generation: 1,
    storeId: 'store',
    sessionId: selected,
    workspaceId: 'w',
    viewSelection: 'viewSelection' in request ? request.viewSelection : view,
    historyEpoch: 0,
  });
  const bridge: NativeBridge = {
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async request(request) {
      requests.push(request);
      switch (request.method) {
        case 'attach':
        case 'state':
          return state();
        case 'directory':
          return {
            storeId: 'store',
            sessions,
            workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
          };
        case 'select': {
          selected = request.sessionId;
          view++;
          revision++;
          selecting = held;
          if (held) {
            queueMicrotask(send);
            await wait('selection', () => {
              selecting = false;
              return null;
            });
          }
          return state();
        }
        case 'draft.read':
          return {
            id: selected,
            storeId: 'store',
            workspaceId: 'w',
            rootSessionId: selected,
            revision: 1,
            content: options.drafts?.[selected] ?? `Draft ${selected.toUpperCase()}`,
          };
        case 'messages': {
          if (withdrawn) throw Error('native_view_unavailable');
          const id = selected;
          return wait('history', () => ({
            messages: [
              {
                id: `u-${id}`,
                sessionId: id,
                runId: `run-${id}`,
                role: 'user',
                status: 'complete',
                seq: '1',
                content: `Question ${id}`,
              },
              {
                id: `m-${id}`,
                sessionId: id,
                runId: `run-${id}`,
                role: 'assistant',
                status: 'complete',
                seq: '2',
                content: `Reply ${id}`,
                sourceIds: [`model-${id}`],
              },
            ],
            nextAfterSeq: null,
            highWaterSeq: request.upperSeq!,
          }));
        }
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
        case 'input.models.read': {
          const id = selected;
          return wait('models', () => {
            if (options.modelErrors?.[id]) throw Error(options.modelErrors[id]);
            return {
              kind: 'settings.models',
              storeId: 'store',
              scope: 'user',
              observationId: view,
              canWrite: false,
              errors: [],
              defaultModelId: 'model-a',
              ...(request.method === 'input.models.read'
                ? { selectedModelId: `model-${options.sameModel ? 'a' : id}` }
                : {}),
              models: ['a', 'b'].map((model) => ({
                id: `model-${model}`,
                provider: 'fixture',
                model: options.modelNames?.[model] ?? `Model ${model.toUpperCase()}`,
                configured: true,
                enabled: true,
                diagnostics: [],
                reasoningEffort: 'medium',
                reasoningEffortChoices: ['low', 'medium', 'high'],
              })),
            };
          });
        }
        case 'fileTargets.list':
        case 'fileChanges.list':
          return {
            kind: request.method === 'fileTargets.list' ? 'fileTargets.page' : 'fileChanges.page',
            readId: request.readId,
            scope: scope(request),
            entries: [],
          };
        case 'toolMessages.list':
          return {
            kind: 'toolMessages.page',
            readId: request.readId,
            scope: scope(request),
            entries: [],
          };
        case 'toolMessages.runs':
          return {
            kind: 'toolMessages.runs',
            readId: request.readId,
            scope: scope(request),
            runs: [{ ...run(), status: 'running', finishedAt: null }],
          };
        case 'toolMessages.usage':
          return {
            kind: 'toolMessages.usage',
            readId: request.readId,
            scope: scope(request),
            entries: request.messageIds.map((id) => ({
              messageId: id,
              executionId: `model-${selected}`,
              originStoreId: 'store',
              cacheHitTokens: selected === 'a' ? 70 : 30,
              cacheMissTokens: selected === 'a' ? 30 : 70,
            })),
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
            nextIndex: 1,
            total: 1,
            complete: true,
            entries: [
              {
                ...base,
                session: session(),
                rootSession: session(),
                run: run(),
                execution: { ...base.execution, sessionId: selected, rootSessionId: selected },
              },
            ],
          };
        default:
          return null;
      }
    },
  };
  return {
    bridge,
    requests,
    hold() {
      held = true;
    },
    pending: (phase: string) => pending.get(phase)?.length ?? 0,
    release(phase: string) {
      for (const resolve of pending.get(phase) ?? []) resolve();
      pending.delete(phase);
    },
    resume() {
      held = false;
      for (const queue of pending.values()) for (const resolve of queue) resolve();
      pending.clear();
    },
    withdraw() {
      withdrawn = true;
      revision++;
      send();
    },
    publish() {
      revision++;
      send();
    },
    setActive(value: boolean) {
      options.active = value;
      revision++;
      send();
    },
    refresh(value: boolean) {
      refreshing = value;
      revision++;
      send();
    },
    fail(value: boolean) {
      failed = value;
      refreshing = false;
      revision++;
      send();
    },
  };
}
