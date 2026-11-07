import type {
  NativeBridge,
  NativeDirectory,
  NativeEvent,
  NativeReasoningEffort,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../src/native-bridge';
import { backgroundShellItem } from './background-item.fixture';

/** Explicit fixture port, shared by real Native DOM and browser tests. */
export function sessionSwitchBridge(
  options: {
    active?: boolean;
    drafts?: Record<string, string>;
    sameModel?: boolean;
    unselectedModel?: boolean;
    withoutPermissions?: boolean;
    modelEfforts?: Record<string, NativeReasoningEffort>;
    modelErrors?: Record<string, string>;
    modelNames?: Record<string, string>;
    replyParagraphs?: number;
    protocol?: 'chat-completions' | 'responses';
    turnNotifications?: boolean;
    readTurns?: Map<string, string>;
    cacheMetrics?: boolean;
    contextUsage?: boolean;
    initialSelection?: boolean;
    holdDraft?: boolean;
    worktreeNavigation?: boolean;
  } = {},
) {
  const base = backgroundShellItem();
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
  let hasSelection = options.initialSelection !== false;
  const pending = new Map<string, (() => void)[]>();
  const listeners = new Set<(event: NativeEvent) => void>();
  const requests: NativeRequest[] = [];
  const readTurns = options.readTurns ?? new Map<string, string>();
  const createdWorktrees = new Set<string>();
  const pendingInteractions = new Map<string, number>();
  let receiptFailure = false;
  let navigationSource = true;
  let heldDirectory = false;
  const unavailableWorkspaces = new Set<string>();
  let releaseDirectory: (() => void) | undefined;
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
  const turns = new Map<
    string,
    {
      id: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
      isActive: boolean;
    }
  >(
    sessions.map((session) => [
      session.id,
      { id: `run-${session.id}`, status: 'running', isActive: true },
    ]),
  );
  const directory = (): NativeDirectory => ({
    storeId: 'store',
    ...(options.turnNotifications ? { readTurns: [...readTurns] } : {}),
    sessions: sessions.map((session) => ({
      ...session,
      ...(options.worktreeNavigation && session.id === 'b'
        ? {
            workspaceId: 'worktree',
            ...(navigationSource ? { worktreeSource: { sessionId: 'a', workspaceId: 'w' } } : {}),
          }
        : {}),
      ...(options.turnNotifications || options.worktreeNavigation
        ? {
            activity: {
              updatedAt: null,
              run: turns.get(session.id)!,
              queued: false,
              pendingInteractions: pendingInteractions.get(session.id) ?? 0,
              ...(createdWorktrees.has(session.id) ||
              (options.worktreeNavigation && session.id === 'a')
                ? { hasCreatedWorktree: true }
                : {}),
            },
          }
        : {}),
    })),
    workspaces: [
      { id: 'w', name: 'Workspace', rootUri: 'file:///workspace' },
      ...(options.worktreeNavigation
        ? [{ id: 'worktree', name: 'Worktree project', rootUri: 'file:///worktree' }]
        : []),
    ],
  });
  const protocol = options.protocol;
  const run = () => ({
    ...base.run!,
    id: `run-${selected}`,
    sessionId: selected,
    isActive: options.active ?? true,
    ...(options.turnNotifications ? turns.get(selected) : {}),
    configuration: {
      modelId: `model-${options.sameModel ? 'a' : selected}`,
      snapshot: {
        version: 1,
        digest: 'a'.repeat(64),
        configuration: {
          models: ['a', 'b'].map((id) => ({
            id: `model-${id}`,
            provider: 'compatible',
            protocol: protocol ?? 'chat-completions',
          })),
        },
      },
    },
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
    ...(options.turnNotifications || options.worktreeNavigation ? { directory: directory() } : {}),
    selection:
      selecting || withdrawn || !hasSelection
        ? undefined
        : {
            storeId: 'store',
            viewGeneration: revision,
            viewSelection: view,
            session: {
              ...session(),
              workspaceId: options.worktreeNavigation && selected === 'b' ? 'worktree' : 'w',
            },
            ...(unavailableWorkspaces.has(selected) ? { workspaceUnavailable: true } : {}),
            runs: [run()],
            executions: [],
            interactions: [],
            interactionsAfterId: null,
            canReadModelOutput: false,
            viewLoading: refreshing,
            permissionUnavailable: refreshing || failed,
            ...(!options.withoutPermissions &&
            !refreshing &&
            !failed &&
            !unavailableWorkspaces.has(selected)
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
                      workspaceId:
                        options.worktreeNavigation && selected === 'b' ? 'worktree' : 'w',
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
    workspaceId: options.worktreeNavigation && selected === 'b' ? 'worktree' : 'w',
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
        case 'scheduled.list':
          return { kind: 'scheduled.tasks', tasks: [], runs: [] };
        case 'session.markRead':
          if (receiptFailure) throw Error('turn_read_storage_unavailable');
          return wait('receipt', () => {
            readTurns.set(request.sessionId, JSON.stringify([request.runId, request.status]));
            send();
            return state();
          });
        case 'attach':
        case 'state':
          return state();
        case 'directory': {
          const result = directory();
          if (heldDirectory) {
            heldDirectory = false;
            await new Promise<void>((resolve) => {
              releaseDirectory = resolve;
            });
          }
          return result;
        }
        case 'select': {
          hasSelection = true;
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
        case 'draft.read': {
          const draft = {
            id: selected,
            storeId: 'store',
            workspaceId: options.worktreeNavigation && selected === 'b' ? 'worktree' : 'w',
            rootSessionId: selected,
            revision: 1,
            content: options.drafts?.[selected] ?? `Draft ${selected.toUpperCase()}`,
          };
          return options.holdDraft ? wait('draft', () => draft) : draft;
        }
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
                content: [
                  `Reply ${id}`,
                  ...Array.from(
                    { length: options.replyParagraphs ?? 0 },
                    (_, index) => `第${index + 1}段历史正文，供实际滚动与阅读位置回归使用。`,
                  ),
                ].join('\n\n'),
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
                ? {
                    selectedModelId: options.unselectedModel
                      ? undefined
                      : `model-${options.sameModel ? 'a' : id}`,
                  }
                : {}),
              models: ['a', 'b'].map((model) => ({
                id: `model-${model}`,
                provider: 'compatible',
                ...(protocol ? { protocol } : {}),
                model: options.modelNames?.[model] ?? `Model ${model.toUpperCase()}`,
                configured: true,
                enabled: true,
                diagnostics: [],
                reasoningEffort: options.modelEfforts?.[model] ?? 'medium',
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
        case 'toolMessages.usage': {
          const id = selected;
          const result = {
            kind: 'toolMessages.usage',
            readId: request.readId,
            scope: scope(request),
            entries: (options.cacheMetrics === false ? [] : request.messageIds).map(
              (messageId) => ({
                messageId,
                executionId: `model-${id}`,
                originStoreId: 'store',
                cacheHitTokens: id === 'a' ? 70 : 30,
                cacheMissTokens: id === 'a' ? 30 : 70,
              }),
            ),
          } as const;
          return options.contextUsage ? wait('usage', () => result) : result;
        }
        case 'toolMessages.contextUsage': {
          if (!options.contextUsage) return null;
          const id = selected;
          const reading = scope(request);
          const contextSelectionId = session().contextSelectionId;
          return wait('context', () => ({
            kind: 'toolMessages.contextUsage',
            readId: request.readId,
            scope: reading,
            context: {
              modelId: `model-${id}`,
              contextSelectionId,
              totalInputTokens: id === 'a' ? 5700 : 12000,
              contextWindowTokens: 272000,
            },
          }));
        }
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
    setTurn(
      sessionId: string,
      status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
      id = `run-${sessionId}`,
    ) {
      turns.set(sessionId, { id, status, isActive: status === 'running' });
      revision++;
      send();
    },
    createdWorktree(sessionId: string) {
      createdWorktrees.add(sessionId);
      revision++;
      send();
    },
    setPendingInteractions(sessionId: string, count: number) {
      pendingInteractions.set(sessionId, count);
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
    modelFailure(sessionId: string, code?: string) {
      options.modelErrors ??= {};
      if (code) options.modelErrors[sessionId] = code;
      else delete options.modelErrors[sessionId];
    },
    failReceipt(value: boolean) {
      receiptFailure = value;
      revision++;
      send();
    },
    navigationSource(value: boolean) {
      navigationSource = value;
    },
    unavailableWorkspace(sessionId: string, value: boolean) {
      if (value) unavailableWorkspaces.add(sessionId);
      else unavailableWorkspaces.delete(sessionId);
      revision++;
      send();
    },
    holdNavigationDirectory() {
      heldDirectory = true;
    },
    navigationDirectoryHeld: () => !!releaseDirectory,
    releaseNavigationDirectory() {
      releaseDirectory?.();
      releaseDirectory = undefined;
    },
  };
}
