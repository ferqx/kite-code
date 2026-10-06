import type { Message, Session, Workspace } from '@kite-ai/client';
import {
  InteractionCard,
  ModelInputs,
  ModelOutputMessage,
  PermissionGrantsPanel,
  PermissionPanel,
  PermissionSubmissionStatus,
  type PlanReviewDraft,
  type QuestionAnswerDraft,
  questionDraftKey,
} from '@kite-ai/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeBackgroundPanel } from './native-background-panel';
import type { NativeDraft, NativeGrantFacts, NativeResult, NativeState } from './native-bridge';
import { NativeCallerView } from './native-caller';
import { NativeContextView } from './native-context';
import { NativeFileRecoveryPanel } from './native-file-recovery';
import { type HistoryState, NativeHistory } from './native-history';
import { nativeTextIntent } from './native-input';
import { readNativeInteractionAttachment } from './native-interaction-attachment';
import { NativeJobOutputPanel } from './native-job-output-panel';
import { NativeMcpSettings } from './native-mcp-settings';
import { createNativeModelInputPort } from './native-model-input';
import { readNativeModelOutput } from './native-model-output';
import { type NativeModelChoice, NativeModelPicker } from './native-model-picker';
import { NativeModelSettings } from './native-model-settings';
import { NativeProviderSettings } from './native-provider-settings';
import { NativeRecoveryView } from './native-recovery';
import { NativeSessionPanel } from './native-sessions';
import { NativeSkillsSettings } from './native-skills-settings';

/** The renderer owns only public presentation; all I/O is the named preload bridge. */
export function NativeDesktop() {
  const bridge = window.kiteNative;
  const [state, setState] = useState<NativeState>();
  const [directory, setDirectory] = useState<{
    storeId: string;
    workspaces: Workspace[];
    sessions: Session[];
  }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyState, setHistoryState] = useState<HistoryState>({
    messages: [],
    phase: 'loading',
  });
  const history = useRef<NativeHistory | undefined>(undefined);
  if (bridge && !history.current)
    history.current = new NativeHistory(bridge, (value) => {
      setMessages(value.messages);
      setHistoryState(value);
    });
  const [savedDrafts, setSavedDrafts] = useState<{
    drafts: Omit<NativeDraft, 'content'>[];
    nextId: string | null;
  }>();
  const [originalDraft, setOriginalDraft] = useState<NativeDraft>();
  const [grantFacts, setGrantFacts] = useState<NativeGrantFacts>();
  const [draft, setDraft] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [settingsPage, setSettingsPage] = useState<'models' | 'providers' | 'mcp' | 'skills'>(
    'models',
  );
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [, choiceChanged] = useState(0);
  const modelChoices = useRef(new Map<string, NativeModelChoice>());
  const [resolvedChoice, setResolvedChoice] = useState<{
    identity: string;
    choice?: NativeModelChoice;
    ready: boolean;
  }>();
  const planModes = useRef(new Map<string, boolean>());
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [expandedExecutions, setExpandedExecutions] = useState<{
    identity: string;
    ids: Set<string>;
  }>({ identity: '', ids: new Set() });
  const generation = useRef(0),
    historyEpoch = useRef<number | undefined>(undefined),
    viewIntent = useRef(0),
    draftRevision = useRef(0),
    writing = useRef(false);
  const selected = useRef<string | undefined>(undefined);
  const questionDrafts = useRef(
    new Map<
      string,
      {
        storeId: string;
        sourceSessionId: string;
        presentationSessionId: string;
        cardId: string;
        draft: QuestionAnswerDraft;
      }
    >(),
  );
  const planDrafts = useRef(
    new Map<
      string,
      {
        storeId: string;
        sourceSessionId: string;
        presentationSessionId: string;
        cardId: string;
        draft: PlanReviewDraft;
        runId: string | null;
      }
    >(),
  );
  function apply(value: NativeResult) {
    if (value && 'generation' in value && value.generation === generation.current) {
      historyEpoch.current = value.historyEpoch;
      // Main has verified the exact answer_saved receipt. Promise resolution and
      // omission from a bounded pending page are not confirmation of an answer.
      for (const drafts of [questionDrafts.current, planDrafts.current]) {
        for (const submission of value.interactionSubmissions)
          if (submission.phase === 'accepted' && submission.receipt)
            drafts.delete(questionDraftKey(submission.interaction));
        for (const card of value.selection?.interactions ?? []) {
          const currentKey = questionDraftKey(card);
          for (const [key, saved] of drafts)
            if (
              saved.storeId === card.originStoreId &&
              saved.sourceSessionId === card.sessionId &&
              saved.presentationSessionId === card.presentationSessionId &&
              saved.cardId === card.id &&
              (key !== currentKey || card.state !== 'pending')
            )
              drafts.delete(key);
        }
      }
      for (const [key, saved] of planDrafts.current)
        if (
          saved.storeId === value.selection?.storeId &&
          saved.sourceSessionId === value.selection.session.id &&
          value.selection.runs.some(
            (run) =>
              run.id === saved.runId &&
              run.originStoreId === saved.storeId &&
              run.status === 'cancelled' &&
              !run.isActive,
          )
        )
          planDrafts.current.delete(key);
      if (value.selection)
        setPlanMode(
          planModes.current.get(
            JSON.stringify([
              value.selection.storeId,
              value.selection.session.workspaceId,
              value.selection.session.id,
            ]),
          ) ?? false,
        );
      setState(value);
    }
  }
  async function report(action: () => Promise<unknown>) {
    try {
      setError('');
      return await action();
    } catch (cause) {
      const code =
        (cause as { code?: string; message?: string }).code ??
        (cause as { message?: string }).message;
      setError(code && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : '结果待核实；请查询原命令。');
      return undefined;
    }
  }
  async function refresh() {
    if (!bridge || !generation.current) return;
    const nonce = viewIntent.current,
      current = generation.current;
    const value = await bridge.request({ method: 'state', generation: current });
    if (nonce !== viewIntent.current || current !== generation.current) return;
    apply(value);
    if (
      value &&
      'generation' in value &&
      value.selection &&
      selected.current === value.selection.session.id
    )
      history.current?.select(current, value.selection, value.historyEpoch);
  }
  async function readDirectory() {
    if (!bridge) return;
    const current = generation.current;
    const value = await bridge.request({ method: 'directory', generation: current });
    if (current === generation.current && value && 'workspaces' in value) setDirectory(value);
  }
  async function readGrants(nextPage = false) {
    const scope = state?.selection;
    if (!bridge || !scope?.canReadPermissionGrants) return;
    const current = generation.current,
      nonce = viewIntent.current;
    const previous = nextPage ? grantFacts?.page : undefined;
    setGrantFacts(undefined);
    const value = await bridge.request({
      method: 'grants.read',
      generation: current,
      sessionId: scope.session.id,
      ...(previous
        ? {
            afterSeq: previous.nextAfterSeq!,
            upperSeq: previous.upperSeq,
            revision: previous.revision,
          }
        : {}),
    });
    if (
      current !== generation.current ||
      nonce !== viewIntent.current ||
      selected.current !== scope.session.id
    )
      return;
    if (value && 'observationId' in value && 'page' in value && 'items' in value.page)
      setGrantFacts({ observationId: value.observationId, page: value.page });
  }
  async function select(sessionId: string) {
    if (!bridge) return;
    const nonce = ++viewIntent.current,
      current = generation.current;
    selected.current = sessionId;
    history.current?.preview(sessionId);
    setModelInputTarget(undefined);
    setGrantFacts(undefined);
    setDraft('');
    const value = await bridge.request({ method: 'select', generation: current, sessionId });
    if (nonce !== viewIntent.current || current !== generation.current) return;
    apply(value);
    if (value && 'generation' in value && value.selection)
      history.current?.select(current, value.selection, value.historyEpoch);
    if (value && 'generation' in value && !value.selection?.session.parentSessionId) {
      const saved = await bridge.request({ method: 'draft.read', generation: current, sessionId });
      if (nonce !== viewIntent.current || current !== generation.current) return;
      if (saved && 'content' in saved) {
        setDraft(saved.content);
        draftRevision.current = saved.revision;
      }
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: One bridge lifetime; generation and message facts are read through refs.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const unwatch = bridge.watch((event) => {
      if (alive && event.generation === generation.current) void report(refresh);
    });
    void report(async () => {
      const value = await bridge.request({ method: 'attach' });
      if (!alive || !value || !('generation' in value)) return;
      generation.current = value.generation;
      apply(value);
      await readDirectory();
    });
    return () => {
      alive = false;
      unwatch();
      history.current?.close();
      if (generation.current)
        void bridge.request({ method: 'detach', generation: generation.current }).catch(() => {});
    };
  }, []);
  const selection = state?.selection
    ? {
        ...state.selection,
        permissionUnavailable:
          state.selection.permissionUnavailable || historyState.phase !== 'complete',
        viewLoading: state.selection.viewLoading || historyState.phase === 'loading',
        permissions: historyState.phase === 'complete' ? state.selection.permissions : undefined,
      }
    : undefined;
  const choiceKey = JSON.stringify([
    selection?.storeId,
    selection?.session.workspaceId,
    selection?.session.id,
  ]);
  const choiceIdentity = JSON.stringify([
    state?.generation,
    selection?.storeId,
    selection?.session.id,
    selection?.viewSelection,
  ]);
  const activeInputRun = selection?.runs.find((run) => run.isActive);
  const needsNextModel =
    !activeInputRun ||
    planMode ||
    ['context.compress', 'context.compression.reset'].includes(
      selection?.activeCommand?.kind ?? '',
    );
  const nextModelReady = resolvedChoice?.identity === choiceIdentity && resolvedChoice.ready;
  const attachmentGeneration = state?.generation,
    attachmentSessionId = selection?.session.id,
    attachmentView = selection?.viewSelection,
    attachmentEpoch = state?.historyEpoch;
  const attachmentReader = useMemo(() => {
    if (!bridge || !attachmentGeneration || !attachmentSessionId || !attachmentView)
      return undefined;
    const current = attachmentGeneration,
      nonce = viewIntent.current,
      sessionId = attachmentSessionId,
      epoch = attachmentEpoch;
    return (
      attachment: import('@kite-ai/client').InteractionAttachment,
      options: { signal: AbortSignal },
    ) =>
      readNativeInteractionAttachment({
        bridge,
        generation: current,
        viewSelection: attachmentView,
        attachment,
        signal: options.signal,
        isCurrent: () =>
          current === generation.current &&
          epoch === historyEpoch.current &&
          nonce === viewIntent.current &&
          selected.current === sessionId,
      });
  }, [attachmentGeneration, attachmentSessionId, attachmentView, attachmentEpoch]);
  useEffect(() => {
    if (selection?.permissionUnavailable && !selection.viewLoading) setGrantFacts(undefined);
  }, [selection?.permissionUnavailable, selection?.viewLoading]);
  const [modelInputTarget, setModelInputTarget] = useState<{
    executionId: string;
    revision: number;
  }>();
  const inputStore = selection?.storeId,
    inputSession = selection?.session.id,
    inputEnabled = selection?.canReadModelInput === true,
    inputGeneration = state?.generation ?? 0,
    inputView = selection?.viewSelection ?? 0;
  const modelInputPort = useMemo(() => {
    if (!bridge || !inputStore || !inputSession || !inputView) return undefined;
    const nonce = viewIntent.current;
    return createNativeModelInputPort({
      bridge,
      generation: inputGeneration,
      storeId: inputStore,
      sessionId: inputSession,
      enabled: inputEnabled,
      isCurrent: () =>
        generation.current === inputGeneration &&
        viewIntent.current === nonce &&
        selected.current === inputSession,
    });
  }, [inputStore, inputSession, inputEnabled, inputGeneration, inputView]);
  if (!bridge) return <p>原生桥不可用。此页面不连接替代服务器。</p>;
  async function write(action: () => Promise<unknown>) {
    if (writing.current || (state?.selection && historyState.phase !== 'complete')) return;
    writing.current = true;
    setPending(true);
    try {
      await report(action);
    } finally {
      writing.current = false;
      setPending(false);
      await report(refresh);
    }
  }
  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: 'auto', fontFamily: 'system-ui' }}>
      <h1>kite</h1>
      <p>原生调用者迁移切片。完整设置、资料与发行能力仍在迁移中。</p>
      {generation.current > 0 && (
        <section aria-label="设置">
          <nav aria-label="设置分类">
            <button
              type="button"
              aria-pressed={settingsPage === 'providers'}
              onClick={() => setSettingsPage('providers')}
            >
              提供商
            </button>
            <button
              type="button"
              aria-pressed={settingsPage === 'models'}
              onClick={() => setSettingsPage('models')}
            >
              模型
            </button>
            <button
              type="button"
              aria-pressed={settingsPage === 'mcp'}
              onClick={() => setSettingsPage('mcp')}
            >
              MCP
            </button>
            <button
              type="button"
              aria-pressed={settingsPage === 'skills'}
              onClick={() => setSettingsPage('skills')}
            >
              Skills
            </button>
          </nav>
          {settingsPage === 'skills' ? (
            <NativeSkillsSettings
              bridge={bridge}
              generation={generation.current}
              selection={selection}
              historyEpoch={state?.historyEpoch ?? 0}
            />
          ) : settingsPage === 'mcp' ? (
            <NativeMcpSettings
              bridge={bridge}
              generation={generation.current}
              selection={selection}
              submissions={state?.mcpSubmissions ?? []}
            />
          ) : settingsPage === 'providers' ? (
            <NativeProviderSettings
              bridge={bridge}
              generation={generation.current}
              selection={selection}
              submissions={state?.providerSettingsSubmissions ?? []}
              onSaved={() => setSettingsRevision((value) => value + 1)}
            />
          ) : (
            <NativeModelSettings
              bridge={bridge}
              generation={generation.current}
              selection={selection}
              submissions={state?.modelSettingsSubmissions ?? []}
              onSaved={() => setSettingsRevision((value) => value + 1)}
            />
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <section aria-label="工作区与会话">
        <h2>已读取的工作区与会话</h2>
        <button
          type="button"
          onClick={() =>
            void write(async () => {
              await bridge.request({ method: 'workspace.pick', generation: generation.current });
              await readDirectory();
            })
          }
        >
          选择本地项目
        </button>
        <button type="button" onClick={() => void report(readDirectory)}>
          重新读取目录
        </button>
        <button
          type="button"
          onClick={() =>
            void report(async () => {
              const value = await bridge.request({
                method: 'draft.list',
                generation: generation.current,
              });
              if (value && 'drafts' in value) setSavedDrafts(value);
            })
          }
        >
          读取已保存草稿
        </button>
        {savedDrafts?.drafts.map((saved) => (
          <button
            type="button"
            key={saved.id}
            onClick={() =>
              void report(async () => {
                const value = await bridge.request({
                  method: 'draft.original',
                  generation: generation.current,
                  draftId: saved.id,
                });
                if (value && 'content' in value) setOriginalDraft(value);
              })
            }
          >
            草稿 {saved.rootSessionId} · 修订 {saved.revision}
          </button>
        ))}
        {savedDrafts?.nextId && (
          <button
            type="button"
            onClick={() =>
              void report(async () => {
                const value = await bridge.request({
                  method: 'draft.list',
                  generation: generation.current,
                  afterId: savedDrafts.nextId!,
                });
                if (value && 'drafts' in value) setSavedDrafts(value);
              })
            }
          >
            下一页草稿
          </button>
        )}
        {originalDraft && (
          <section aria-label="原关联草稿">
            <p>
              {originalDraft.association === 'current'
                ? '原关联仍有效；此处仅阅读已保存文本。'
                : '原关联不可用，文本已保留，没有绑定当前会话。'}
            </p>
            <p>
              原会话 {originalDraft.rootSessionId} · 修订 {originalDraft.revision}
            </p>
            <textarea aria-label="保留的原关联草稿" value={originalDraft.content} readOnly />
            <button type="button" onClick={() => setOriginalDraft(undefined)}>
              关闭草稿阅读
            </button>
          </section>
        )}
        {state?.creationSubmissions.map((submission) => (
          <section key={submission.input.commandId} aria-label="会话创建意图">
            <p>
              原会话 {submission.input.sessionId} · 创建
              {submission.phase === 'pending'
                ? '正在提交'
                : submission.phase === 'unknown'
                  ? '结果待核实'
                  : submission.phase === 'created'
                    ? '已确认'
                    : '被拒绝'}
            </p>
            <p>
              原创建命令 {submission.input.commandId} · 原工作区 {submission.input.workspaceId}
            </p>
            <p>{submission.code}</p>
            {(submission.phase === 'unknown' || submission.phase === 'pending') && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void write(async () => {
                    await bridge.request({
                      method: 'lookupCreation',
                      generation: generation.current,
                      commandId: submission.input.commandId,
                    });
                    apply(
                      await bridge.request({ method: 'state', generation: generation.current }),
                    );
                    await readDirectory();
                  })
                }
              >
                核实原创建命令
              </button>
            )}
          </section>
        ))}
        {(directory?.workspaces ?? []).map((workspace) => (
          <div key={workspace.id}>
            <strong>{workspace.name}</strong>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void write(async () => {
                  const sessionId = crypto.randomUUID(),
                    commandId = crypto.randomUUID(),
                    current = generation.current,
                    selectionAtClick = viewIntent.current;
                  const value = await bridge.request({
                    method: 'createSession',
                    generation: current,
                    workspaceId: workspace.id,
                    sessionId,
                    commandId,
                    title: '新对话',
                    expectedStoreId: (
                      (await bridge.request({ method: 'directory', generation: current })) as {
                        storeId: string;
                      }
                    ).storeId,
                  });
                  apply(await bridge.request({ method: 'state', generation: current }));
                  if (!value || !('phase' in value) || value.phase !== 'created')
                    throw Error('session_receipt_unknown');
                  await readDirectory();
                  if (generation.current === current && viewIntent.current === selectionAtClick)
                    await select(sessionId);
                })
              }
            >
              新建会话
            </button>
          </div>
        ))}
        {(directory?.sessions ?? []).map((session) => (
          <button
            type="button"
            key={session.id}
            onClick={() => void report(() => select(session.id))}
          >
            {session.title}
          </button>
        ))}
      </section>
      {state && directory && (
        <NativeBackgroundPanel
          bridge={bridge}
          generation={state.generation}
          storeId={directory.storeId}
          unavailable={state.backgroundUnavailable ?? false}
          onChanged={refresh}
        />
      )}
      {selection && state && (
        <section aria-label="当前会话">
          <h2>{selection.session.title}</h2>
          {messages.map((message) => (
            <article key={message.id}>
              <small>
                {message.role} · {message.seq}
              </small>
              <ModelOutputMessage
                message={message}
                storeId={selection.storeId}
                onRead={
                  selection.canReadModelOutput
                    ? async ({ sessionId, executionId, signal }) => {
                        const current = state?.generation ?? 0,
                          nonce = viewIntent.current;
                        return readNativeModelOutput({
                          bridge,
                          generation: current,
                          expectedStoreId: selection.storeId,
                          sessionId,
                          viewSessionId: selection.session.id,
                          messageId: message.id,
                          executionId,
                          signal,
                          isCurrent: () =>
                            generation.current === current &&
                            viewIntent.current === nonce &&
                            selected.current === selection.session.id,
                        });
                      }
                    : undefined
                }
              />
            </article>
          ))}
          <p role="status">
            {historyState.phase === 'complete'
              ? '历史已完整读取至固定高水位；当前执行事实仍须核实。'
              : historyState.phase === 'loading'
                ? '正在完整校准历史；已有正文仍可阅读。'
                : '历史尚未完整校准；已有正文仍可阅读，当前执行事实不可用。'}
          </p>
          {historyState.phase === 'unavailable' && (
            <button type="button" onClick={() => void report(refresh)}>
              重新加载会话
            </button>
          )}
          {selection.runs.map((run) => (
            <p key={run.id}>轮次：{run.status}</p>
          ))}
          {modelInputPort && (
            <ModelInputs
              key={`${state.generation}/${selection.storeId}/${selection.session.id}/${modelInputTarget?.revision ?? 0}`}
              client={modelInputPort}
              storeId={selection.storeId}
              sessionId={selection.session.id}
              window={window}
              initialExecutionId={modelInputTarget?.executionId}
            />
          )}
          <section aria-label="Runtime logs">
            <h2>Runtime logs · 已保存执行</h2>
            <p>此处是已保存执行的有限投影，不是全部 Runtime 事件。</p>
            {selection.executions.map((execution) => (
              <details
                key={`${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${selection.storeId}/${selection.session.id}/${execution.id}`}
                onToggle={(event) => {
                  const identity = `${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${selection.storeId}/${selection.session.id}`,
                    open = event.currentTarget.open;
                  setExpandedExecutions((old) => {
                    const ids = new Set(old.identity === identity ? old.ids : []);
                    if (open) ids.add(execution.id);
                    else ids.delete(execution.id);
                    return { identity, ids };
                  });
                }}
              >
                <summary>
                  {execution.definitionId} · {execution.status}
                </summary>
                <p>
                  原执行 {execution.id} · kind {execution.kind}
                </p>
                {execution.kind === 'model' && selection.canReadModelInput && (
                  <button
                    type="button"
                    onClick={() =>
                      setModelInputTarget((previous) => ({
                        executionId: execution.id,
                        revision: (previous?.revision ?? 0) + 1,
                      }))
                    }
                  >
                    检查原 Model 输入 · {execution.id}
                  </button>
                )}
                {execution.kind === 'job' &&
                  !selection.session.parentSessionId &&
                  !selection.interactions.some(
                    (card) => card.kind === 'question' && card.state === 'pending',
                  ) &&
                  ['planned', 'dispatching', 'running'].includes(execution.status) && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void report(async () => {
                          const commandId = crypto.randomUUID();
                          await bridge.request({
                            method: 'caller.prepare',
                            generation: generation.current,
                            sessionId: selection.session.id,
                            intent: {
                              kind: 'execution.cancel',
                              expectedStoreId: selection.storeId,
                              commandId,
                              executionId: execution.id,
                            },
                          });
                          await bridge.request({
                            method: 'caller.submit',
                            generation: generation.current,
                            commandId,
                          });
                          await refresh();
                        })
                      }
                    >
                      停止原 Job · {execution.id}
                    </button>
                  )}
                {execution.kind === 'job' &&
                  expandedExecutions.identity ===
                    `${state.generation}/${selection.viewSelection}/${state.historyEpoch}/${selection.storeId}/${selection.session.id}` &&
                  expandedExecutions.ids.has(execution.id) && (
                    <NativeJobOutputPanel
                      bridge={bridge}
                      generation={state.generation}
                      selection={selection}
                      historyEpoch={state.historyEpoch ?? 0}
                      executionId={execution.id}
                    />
                  )}
                <pre>{JSON.stringify(execution.result, null, 2)}</pre>
              </details>
            ))}
          </section>
          {!selection.session.parentSessionId &&
            !selection.interactions.some(
              (card) =>
                ['approval', 'question', 'plan_review'].includes(card.kind) &&
                card.state === 'pending',
            ) && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void write(async () => {
                    const current = state?.generation ?? 0,
                      nonce = viewIntent.current,
                      sessionId = selection.session.id,
                      commandId = crypto.randomUUID(),
                      submittedText = draft,
                      submittedRevision = draftRevision.current;
                    const intent = nativeTextIntent(
                      selection,
                      commandId,
                      draft,
                      planMode,
                      resolvedChoice?.identity === choiceIdentity
                        ? resolvedChoice.choice
                        : undefined,
                    );
                    if (intent.kind !== 'input.steer' && !nextModelReady)
                      throw Error('model_selection_unavailable');
                    const value = await bridge.request({
                      method: 'submit',
                      generation: current,
                      sessionId,
                      intent,
                    });
                    if (
                      nonce === viewIntent.current &&
                      current === generation.current &&
                      draftRevision.current === submittedRevision &&
                      value &&
                      'phase' in value &&
                      !['unknown', 'failed', 'rejected'].includes(value.phase)
                    ) {
                      setDraft((current) => (current === submittedText ? '' : current));
                      setPlanMode(false);
                      planModes.current.delete(
                        JSON.stringify([
                          selection.storeId,
                          selection.session.workspaceId,
                          sessionId,
                        ]),
                      );
                    }
                  });
                }}
              >
                <NativeModelPicker
                  bridge={bridge}
                  generation={state.generation}
                  selection={selection}
                  revision={String(settingsRevision)}
                  value={modelChoices.current.get(choiceKey) ?? {}}
                  onChange={(choice) => {
                    modelChoices.current.set(choiceKey, choice);
                    choiceChanged((value) => value + 1);
                  }}
                  onReady={(ready, choice) =>
                    setResolvedChoice((previous) => {
                      const value = { identity: choiceIdentity, choice, ready };
                      return JSON.stringify(previous) === JSON.stringify(value) ? previous : value;
                    })
                  }
                />
                <label>
                  当前会话私有草稿
                  <textarea
                    value={draft}
                    disabled={pending}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label="先审核计划"
                    checked={planMode}
                    disabled={pending}
                    onChange={(event) => {
                      setPlanMode(event.target.checked);
                      planModes.current.set(
                        JSON.stringify([
                          selection.storeId,
                          selection.session.workspaceId,
                          selection.session.id,
                        ]),
                        event.target.checked,
                      );
                    }}
                  />
                  先审核计划
                </label>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void write(async () => {
                      const original = {
                        generation: generation.current,
                        view: viewIntent.current,
                        sessionId: selection.session.id,
                      };
                      const saved = await bridge.request({
                        method: 'draft.write',
                        generation: original.generation,
                        sessionId: original.sessionId,
                        revision: draftRevision.current,
                        content: draft,
                      });
                      if (
                        saved &&
                        'content' in saved &&
                        generation.current === original.generation &&
                        viewIntent.current === original.view &&
                        selected.current === original.sessionId
                      )
                        draftRevision.current = saved.revision;
                    })
                  }
                >
                  保留草稿
                </button>
                <button
                  type="submit"
                  disabled={
                    pending ||
                    !draft.trim() ||
                    historyState.phase !== 'complete' ||
                    selection.permissionUnavailable ||
                    (needsNextModel && !nextModelReady)
                  }
                >
                  {selection.runs.some((run) => run.isActive)
                    ? planMode
                      ? '排队新的计划任务'
                      : ['context.compress', 'context.compression.reset'].includes(
                            selection.activeCommand?.kind ?? '',
                          )
                        ? '排队压缩后的输入'
                        : '引导当前轮次'
                    : planMode
                      ? '发送计划任务'
                      : '发送明确的新轮次'}
                </button>
              </form>
            )}
          {selection.interactions.map((interaction) => {
            const draftKey = questionDraftKey(interaction);
            const saved = state?.answerSubmissions?.find(
              (row) =>
                row.scope.storeId === interaction.originStoreId &&
                row.scope.sessionId === interaction.presentationSessionId &&
                row.interaction.id === interaction.id &&
                row.interaction.revision === interaction.revision,
            );
            const currentSubmission = state?.interactionSubmissions.find(
              (row) => questionDraftKey(row.interaction) === draftKey,
            );
            return (
              <InteractionCard
                key={draftKey}
                interaction={interaction}
                onReadAttachment={attachmentReader}
                submission={
                  saved
                    ? { phase: saved.phase, commandId: saved.request.commandId }
                    : currentSubmission
                      ? {
                          phase: currentSubmission.phase,
                          commandId: currentSubmission.intent.commandId,
                          error: currentSubmission.error,
                        }
                      : undefined
                }
                initialQuestionDraft={questionDrafts.current.get(draftKey)?.draft}
                onQuestionDraftChange={(draft) =>
                  questionDrafts.current.set(draftKey, {
                    storeId: interaction.originStoreId,
                    sourceSessionId: interaction.sessionId,
                    presentationSessionId: interaction.presentationSessionId,
                    cardId: interaction.id,
                    draft,
                  })
                }
                initialPlanDraft={planDrafts.current.get(draftKey)?.draft}
                onPlanDraftChange={(draft) =>
                  planDrafts.current.set(draftKey, {
                    storeId: interaction.originStoreId,
                    sourceSessionId: interaction.sessionId,
                    presentationSessionId: interaction.presentationSessionId,
                    cardId: interaction.id,
                    runId: interaction.runId,
                    draft,
                  })
                }
                onAnswer={async (_card, answer) => {
                  await bridge.request({
                    method: 'interaction.answer',
                    generation: generation.current,
                    interactionId: interaction.id,
                    revision: interaction.revision,
                    answer,
                  });
                  await refresh();
                }}
              />
            );
          })}
          {selection.interactionsAfterId !== null && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const original = selection,
                  nonce = viewIntent.current,
                  current = generation.current;
                void report(async () => {
                  let value: NativeResult;
                  try {
                    value = await bridge.request({
                      method: 'interactions.next',
                      generation: current,
                      viewGeneration: original.viewGeneration,
                      afterId: original.interactionsAfterId!,
                    });
                  } catch (error) {
                    if (
                      nonce === viewIntent.current &&
                      current === generation.current &&
                      selected.current === original.session.id
                    )
                      throw error;
                    return;
                  }
                  if (
                    nonce === viewIntent.current &&
                    current === generation.current &&
                    selected.current === original.session.id
                  )
                    apply(value);
                });
              }}
            >
              下一页待决请求（替换当前窗口）
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void report(() =>
                bridge.request({
                  method: 'interactions.close',
                  generation: generation.current,
                  viewGeneration: selection.viewGeneration,
                }),
              )
            }
          >
            停止读取待决后页
          </button>
          {selection.permissionUnavailable && (
            <p role="status">权限事实暂不可核实。权限操作只读；已有选择仍按原身份保留。</p>
          )}
          {selection.permissionUnavailable && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void report(async () => {
                  apply(
                    await bridge.request({
                      method: 'permission.refresh',
                      generation: generation.current,
                    }),
                  );
                })
              }
            >
              重新核实权限事实
            </button>
          )}
          <PermissionPanel
            facts={selection.permissions}
            busy={
              pending ||
              state.permissionSubmissions.some((value) =>
                ['saved', 'submitting', 'unknown'].includes(value.phase),
              )
            }
            onSetMode={
              selection.permissions
                ? async (mode, makeDefault) => {
                    await bridge.request({
                      method: 'permission.mode',
                      generation: generation.current,
                      observationId: selection.permissions!.observationId,
                      mode,
                      makeDefault,
                    });
                    await refresh();
                  }
                : undefined
            }
            onSetTrust={
              selection.permissions
                ? async (trusted) => {
                    await bridge.request({
                      method: 'permission.trust',
                      generation: generation.current,
                      observationId: selection.permissions!.observationId,
                      trusted,
                    });
                    await refresh();
                  }
                : undefined
            }
            onRefresh={async () => {
              apply(
                await bridge.request({
                  method: 'permission.refresh',
                  generation: generation.current,
                }),
              );
            }}
          />
          <NativeRecoveryView
            bridge={bridge}
            generation={state.generation}
            selection={selection}
            submissions={state.recoverySubmissions}
            onRefresh={refresh}
          />
          <NativeContextView
            bridge={bridge}
            generation={state.generation}
            selection={selection}
            submissions={state.contextSubmissions}
            compressionSubmissions={state.compressionSubmissions}
            onInspectModel={(executionId) =>
              setModelInputTarget({ executionId, revision: Date.now() })
            }
            onRefresh={refresh}
          />
          <PermissionGrantsPanel
            facts={
              grantFacts?.page.sessionId === selection.session.id &&
              grantFacts.page.storeId === selection.storeId
                ? grantFacts
                : undefined
            }
            busy={(state.grantSubmissions ?? []).some((value) =>
              ['saved', 'submitting', 'unknown'].includes(value.phase),
            )}
            onRead={selection.canReadPermissionGrants ? () => readGrants() : undefined}
            onNext={
              grantFacts?.page.nextAfterSeq !== null && grantFacts
                ? () => readGrants(true)
                : undefined
            }
            onClear={
              selection.canReadPermissionGrants && grantFacts
                ? async (observationId) => {
                    const current = generation.current,
                      nonce = viewIntent.current;
                    try {
                      await bridge.request({
                        method: 'grants.clear',
                        generation: current,
                        observationId,
                      });
                    } finally {
                      if (current === generation.current && nonce === viewIntent.current)
                        setGrantFacts(undefined);
                    }
                    await refresh();
                  }
                : undefined
            }
          />
        </section>
      )}
      {bridge && state && <NativeCallerView bridge={bridge} state={state} onRefresh={refresh} />}
      {(state?.inputSubmissions ?? []).map((submission) => (
        <div key={submission.intent.commandId}>
          <p>
            原命令 {submission.intent.commandId}：{submission.phase}
          </p>
          <button
            type="button"
            onClick={() =>
              void report(async () => {
                await bridge.request({
                  method: 'lookupInput',
                  generation: generation.current,
                  commandId: submission.intent.commandId,
                });
                await refresh();
              })
            }
          >
            查询原命令
          </button>
          {submission.intent.kind !== 'command.cancel' &&
            !(
              selection?.storeId === submission.intent.expectedStoreId &&
              selection.session.id === submission.sessionId &&
              selection.interactions.some(
                (card) => card.kind === 'question' && card.state === 'pending',
              )
            ) && (
              <button
                type="button"
                onClick={() =>
                  void report(async () => {
                    await bridge.request({
                      method: 'cancelInput',
                      generation: generation.current,
                      commandId: submission.intent.commandId,
                    });
                    await refresh();
                  })
                }
              >
                停止原命令
              </button>
            )}
        </div>
      ))}
      {state?.answerUnavailable && <p role="status">原答复私有记录不可用；不发送新的答复。</p>}
      {(state?.answerSubmissions ?? []).map((submission) => (
        <div key={submission.request.commandId}>
          <p>
            持久原答复 {submission.request.commandId}：{submission.phase} · Store{' '}
            {submission.scope.storeId} · Session {submission.scope.sessionId} · Interaction{' '}
            {submission.interaction.id} · revision {submission.request.expectedRevision} ·{' '}
            {submission.association}
          </p>
          <button
            type="button"
            onClick={() =>
              void report(async () => {
                try {
                  await bridge.request({
                    method: 'lookupInteraction',
                    generation: generation.current,
                    commandId: submission.request.commandId,
                  });
                } finally {
                  await refresh();
                }
              })
            }
          >
            只查原答复 · {submission.request.commandId}
          </button>
        </div>
      ))}
      {(state?.interactionSubmissions ?? [])
        .filter(
          (submission) =>
            !state?.answerSubmissions?.some(
              (row) => row.request.commandId === submission.intent.commandId,
            ),
        )
        .map((submission) => (
          <div key={submission.intent.commandId}>
            <p>
              答复原命令 {submission.intent.commandId}：{submission.phase}
            </p>
            {submission.phase === 'unknown' && (
              <button
                type="button"
                onClick={() =>
                  void report(async () => {
                    await bridge.request({
                      method: 'lookupInteraction',
                      generation: generation.current,
                      commandId: submission.intent.commandId,
                    });
                    await refresh();
                  })
                }
              >
                查询原答复
              </button>
            )}
          </div>
        ))}
      {(state?.permissionSubmissions ?? []).map((submission) => (
        <div key={submission.intent.commandId}>
          <p>
            权限原会话 {submission.sessionId} · 根范围 {submission.rootSessionId} · 工作区{' '}
            {submission.workspaceId} · Store {submission.intent.expectedStoreId}
          </p>
          <PermissionSubmissionStatus
            submission={{
              commandId: submission.intent.commandId,
              phase: submission.phase,
              error: submission.error,
            }}
          />
          {submission.phase === 'unknown' && (
            <button
              type="button"
              onClick={() =>
                void report(async () => {
                  await bridge.request({
                    method: 'lookupPermission',
                    generation: generation.current,
                    commandId: submission.intent.commandId,
                  });
                  await refresh();
                })
              }
            >
              查询原权限选择
            </button>
          )}
        </div>
      ))}
      {(state?.grantSubmissions ?? []).map((submission) => (
        <section key={submission.intent.commandId} aria-label="原授权清除选择">
          <p>
            原会话 {submission.sessionId} · 工作区 {submission.workspaceId} · 原存储{' '}
            {submission.intent.expectedStoreId} · 授权版本 {submission.intent.ifRevision}
          </p>
          <PermissionSubmissionStatus
            submission={{
              commandId: submission.intent.commandId,
              phase: submission.phase,
              error: submission.error,
            }}
          />
          {submission.phase === 'unknown' && (
            <button
              type="button"
              onClick={() =>
                void report(async () => {
                  await bridge.request({
                    method: 'lookupGrant',
                    generation: generation.current,
                    commandId: submission.intent.commandId,
                  });
                  await refresh();
                })
              }
            >
              查询原授权清除选择
            </button>
          )}
        </section>
      ))}
      <NativeFileRecoveryPanel
        bridge={bridge}
        generation={state?.generation ?? generation.current}
        selection={selection}
        submissions={state?.fileRecoverySubmissions ?? []}
        onRefresh={refresh}
        onSelect={select}
      />
      <NativeSessionPanel
        bridge={bridge}
        generation={state?.generation ?? generation.current}
        selection={selection}
        submissions={state?.sessionSubmissions ?? []}
        onRefresh={async () => {
          await readDirectory();
          await refresh();
        }}
        onSelect={select}
      />
    </main>
  );
}
if (typeof document !== 'undefined')
  createRoot(document.getElementById('root')!).render(<NativeDesktop />);
