import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Approval,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type Message,
  SessionPage,
} from '@kite-ai/kite-client-ui';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import appIcon from '../app-icon.svg';
import { CommandResultUnknown, type DesktopClient } from './client';
import { Interaction } from './Interaction';
import { OperationToast } from './OperationToast';
import { isActiveRun, projectEvent } from './presentation';
import { Settings } from './Settings';
import './startup.css';

const navigationKey = 'kite.desktop.navigation';
type FirstSubmission = {
  phase: 'preparing' | 'sending' | 'failed' | 'unknown';
  text: string;
  visibleUntil: number;
  navigation: number;
  baselineUserIds: readonly string[];
  sessionId?: string;
  uncertainty?: 'create' | 'turn';
  permissionRequired?: boolean;
};
function readNavigation(): { workspace: string; sessionId?: string } | undefined {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(navigationKey) ?? 'null');
    if (
      value &&
      typeof value.workspace === 'string' &&
      (value.sessionId === undefined || typeof value.sessionId === 'string')
    )
      return value;
  } catch {
    /* Navigation storage is optional; it never grants project access. */
  }
  return undefined;
}
function rememberNavigation(workspace: string, sessionId?: string) {
  try {
    window.sessionStorage.setItem(navigationKey, JSON.stringify({ workspace, sessionId }));
  } catch {
    /* A storage failure must not interrupt the active conversation. */
  }
}

export function App({ client }: { client: DesktopClient }) {
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  // Do not retain message histories in long-lived navigation callbacks.
  const {
    selected,
    projection,
    workspace,
    connected,
    ready,
    loadingSession,
    projects,
    directoryErrors,
    directory: directorySnapshot,
  } = view;
  const [operation, setOperation] = useState<'foreground' | 'background'>();
  const busy = operation === 'foreground';
  const [pendingPermission, setPendingPermission] = useState<{
    sessionId: string;
    mode: 'accept_edits' | 'auto' | 'full';
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [selectingSession, setSelectingSession] = useState<string>();
  const [newConversationPermission, setNewConversationPermission] = useState<
    'accept_edits' | 'auto' | 'full'
  >('auto');
  const [startup, setStartup] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [startupError, setStartupError] = useState('');
  const [startupMessage, setStartupMessage] = useState<string | null>(null);
  const [diagnosticAvailable, setDiagnosticAvailable] = useState(false);
  const [diagnosticSaveError, setDiagnosticSaveError] = useState('');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const busyRef = useRef(false);
  const submittingRef = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newConversation, setNewConversation] = useState(!selected);
  const [newConversationWorkspace, setNewConversationWorkspace] = useState<string>();
  const [newConversationBranch, setNewConversationBranch] = useState(view.branch);
  const [newConversationTargetBranch, setNewConversationTargetBranch] = useState<string>();
  const [newConversationModel, setNewConversationModel] = useState<{
    provider: string;
    name: string;
  }>();
  const [sessionModels, setSessionModels] = useState<
    Record<string, { provider: string; name: string }>
  >({});
  const [firstSubmission, setFirstSubmission] = useState<FirstSubmission>();
  const [workbenchView, setWorkbenchView] = useState(false);
  const [scheduledTasksView, setScheduledTasksView] = useState(false);
  const [navigation] = useState(readNavigation);
  const navigationRevision = useRef(0);
  const preparing = newConversation || !selected;
  const conversationWorkspace = newConversationWorkspace ?? workspace;
  const conversationBranch =
    newConversationBranch?.workspace === conversationWorkspace
      ? newConversationBranch
      : view.branch;
  const preparingActiveWorkspace = !preparing || conversationWorkspace === workspace;

  useEffect(() => {
    if (startup === 'ready') return;
    let active = true;
    const refresh = () => {
      void client.readStartupStatus().then(
        (status) => {
          if (active) {
            setStartupMessage(status?.message ?? null);
            setDiagnosticAvailable(status?.diagnosticAvailable ?? false);
          }
        },
        () => undefined,
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, startup]);
  const operationError =
    view.commandError ||
    view.projectError ||
    view.branchError ||
    (connected ? view.error : undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<'vscode' | 'zed' | 'textedit'>('vscode');
  const [stopRequest, setStopRequest] = useState<{ key: string; runId: string }>();
  const selectedSession = (directorySnapshot ?? view.sessions).find(
    (session) => session.sessionId === selected,
  );
  const selectedWorkspace =
    selectedSession?.workspace ??
    (projection?.workspaceDigest === view.trust?.workspace.workspaceDigest ? workspace : undefined);
  const draftKey = preparing ? 'new-conversation' : `session:${selected}`;
  const draft = drafts[draftKey] ?? '';
  const stopping =
    isActiveRun(projection) &&
    stopRequest?.key === draftKey &&
    stopRequest.runId === projection?.currentRun?.runId;
  const interaction =
    !preparing &&
    projection?.interactionQueue.interactions.find(
      (item) => item.interactionId === projection?.interactionQueue.activeInteractionId,
    );
  const interactionDraftKey = `${draftKey}\0interaction:${interaction ? interaction.interactionId : ''}`;
  const act = useCallback(
    async (action: () => Promise<unknown>, showBusy = true) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setOperation(showBusy ? 'foreground' : 'background');
      client.clearError();
      try {
        await action();
      } catch (error) {
        client.report(error);
      } finally {
        busyRef.current = false;
        setOperation(undefined);
      }
    },
    [client],
  );
  const openFile = useCallback(
    (path: string) => {
      void act(() => client.openFile(path, editor));
    },
    [act, client, editor],
  );
  const openSession = (id: string) => {
    if (busyRef.current || !client.getSnapshot().connected) return;
    const revision = ++navigationRevision.current;
    setWorkbenchView(false);
    setScheduledTasksView(false);
    setNewConversation(false);
    setSelectingSession(id);
    // Selection has its own abort/generation owner; a second selection may supersede it.
    void client
      .selectSession(id)
      .then(() => {
        const current = client.getSnapshot();
        if (navigationRevision.current !== revision || current.selected !== id || !current.ready)
          return;
        setFirstSubmission((submission) =>
          submission?.phase === 'unknown' &&
          submission.uncertainty === 'create' &&
          submission.sessionId === id
            ? { ...submission, phase: 'failed', uncertainty: undefined }
            : submission,
        );
        rememberNavigation(
          current.directory?.find((session) => session.sessionId === current.selected)?.workspace ??
            current.workspace,
          current.selected,
        );
      })
      .catch((error) => client.report(error))
      .finally(() => setSelectingSession((current) => (current === id ? undefined : current)));
  };
  const dismissOperationError = () => {
    client.clearError();
    if (!preparing && connected && selected && !loadingSession && !ready) openSession(selected);
  };
  const newSession = () => {
    if (!busyRef.current) {
      navigationRevision.current++;
      setWorkbenchView(false);
      setScheduledTasksView(false);
      setNewConversation(true);
      setNewConversationWorkspace(undefined);
      setNewConversationBranch(view.branch);
      setFirstSubmission((submission) =>
        submission?.phase === 'unknown' ? submission : undefined,
      );
      rememberNavigation(workspace);
    }
  };
  useEffect(() => {
    const pending = firstSubmission;
    if (!pending || pending.sessionId !== selected) return;
    if (
      !view.messages.some(
        (message) =>
          message.role === 'user' &&
          message.text === pending.text &&
          !pending.baselineUserIds.includes(message.id),
      )
    )
      return;
    const delay = pending.phase === 'failed' ? 0 : Math.max(0, pending.visibleUntil - Date.now());
    const timer = window.setTimeout(() => {
      client.clearError();
      setFirstSubmission(undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [client, firstSubmission, selected, view.messages]);
  const activateForWork = async (target: string) => {
    await client.checkProject(target);
    await client.activateProject(target);
    return true;
  };
  const chooseProject = (path?: string) =>
    void act(async () => {
      const revision = navigationRevision.current;
      const target = path ?? (await client.pickProject());
      if (!target) return;
      const branch = await client.queryProjectBranch(target);
      if (navigationRevision.current !== revision) return;
      navigationRevision.current++;
      setWorkbenchView(false);
      setScheduledTasksView(false);
      setNewConversation(true);
      setNewConversationWorkspace(target);
      setNewConversationBranch(branch);
      setNewConversationTargetBranch(undefined);
      rememberNavigation(target);
    });
  const openProject = () => chooseProject();
  useEffect(() => {
    void startupAttempt;
    let cancelled = false;
    void (async () => {
      await client.refreshProjects().catch((error) => client.report(error));
      const wasConnected = client.getSnapshot().connected;
      await client.restoreWorkspace();
      if (wasConnected && client.getSnapshot().directory === undefined)
        await client.refreshDirectory();
      const current = client.getSnapshot();
      if (current.directory === undefined && Object.keys(current.directoryErrors ?? {}).length)
        throw new Error('会话列表暂时无法读取，请重试。');
      if (
        !wasConnected &&
        navigationRevision.current === 0 &&
        current.connected &&
        navigation?.sessionId
      ) {
        await client.selectSession(navigation.sessionId).catch((error) => client.report(error));
        if (!cancelled) setNewConversation(false);
      }
      if (!cancelled) setStartup('ready');
    })().catch((error) => {
      if (cancelled) return;
      setStartupError(error instanceof Error ? error.message : String(error));
      setStartup('failed');
    });
    return () => {
      cancelled = true;
    };
  }, [client, navigation, startupAttempt]);
  useEffect(() => {
    if (startup !== 'ready') return;
    const refresh = () => {
      if (document.visibilityState === 'hidden' || busyRef.current) return;
      void client.refreshProjects().catch((error) => client.report(error));
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [client, startup]);
  useEffect(() => {
    if (!connected) setStopRequest(undefined);
  }, [connected]);
  const active = !preparing && isActiveRun(projection);
  const model = preparing
    ? (newConversationModel ?? view.models?.selected)
    : selected
      ? (sessionModels[selected] ??
        (projection?.sessionId === selected ? projection.model : undefined) ??
        selectedSession?.model)
      : undefined;
  const submissionInFlight =
    !!firstSubmission &&
    firstSubmission.phase !== 'failed' &&
    (firstSubmission.sessionId
      ? !preparing && firstSubmission.sessionId === selected
      : preparing && firstSubmission.navigation === navigationRevision.current);
  const canSubmit =
    !busy &&
    !submitting &&
    !submissionInFlight &&
    (preparing || selectingSession === undefined) &&
    connected &&
    (preparing ? !!conversationWorkspace : ready && !loadingSession && !!selected);
  const submissionVisible =
    !!firstSubmission &&
    (firstSubmission.sessionId
      ? !preparing && firstSubmission.sessionId === selected
      : preparing && firstSubmission.navigation === navigationRevision.current);
  const optimisticMessage: Message | undefined = submissionVisible
    ? {
        id: 'client:first-submission',
        role: 'user',
        text: firstSubmission.text,
        settled: firstSubmission.phase === 'failed' || firstSubmission.phase === 'unknown',
        delivery:
          firstSubmission.phase === 'failed'
            ? 'failed'
            : firstSubmission.phase === 'unknown'
              ? 'unknown'
              : 'sending',
      }
    : undefined;
  const optimisticRuntimeIndex = optimisticMessage
    ? view.messages.findIndex(
        (message) =>
          message.role === 'user' &&
          message.text === optimisticMessage.text &&
          !firstSubmission?.baselineUserIds.includes(message.id),
      )
    : -1;
  const pendingAskMessages =
    interaction &&
    interaction.kind === 'input' &&
    !view.messages.some((message) => message.id === `interaction:${interaction.interactionId}`)
      ? projectEvent(view.messages, { type: 'interaction.available', interaction })
      : view.messages;
  const displayedMessages = optimisticMessage
    ? preparing
      ? [optimisticMessage]
      : optimisticRuntimeIndex < 0
        ? [...pendingAskMessages, optimisticMessage]
        : pendingAskMessages.map((message, index) =>
            index === optimisticRuntimeIndex ? optimisticMessage : message,
          )
    : workbenchView || scheduledTasksView || preparing
      ? []
      : pendingAskMessages;
  const directory = directorySnapshot ?? view.sessions;
  if (startup !== 'ready')
    return (
      <main
        className="kite-client desktop-startup"
        aria-label="kite 启动页"
        aria-busy={startup === 'loading'}
      >
        <div className="desktop-startup-content">
          <img src={appIcon} width="56" height="56" alt="" />
          <h1>kite</h1>
          {startup === 'loading' ? (
            <p role="status">{startupMessage ?? '正在准备你的工作空间…'}</p>
          ) : (
            <>
              <p role="alert">启动未完成：{startupError}</p>
              {diagnosticAvailable && (
                <Button
                  onClick={() => {
                    void client.saveStartupDiagnostic().catch((error: unknown) => {
                      setDiagnosticSaveError(error instanceof Error ? error.message : '保存失败。');
                    });
                  }}
                >
                  保存诊断
                </Button>
              )}
              {diagnosticSaveError && <p role="alert">{diagnosticSaveError}</p>}
              <Button
                onClick={() => {
                  setStartup('loading');
                  setStartupError('');
                  setStartupMessage(null);
                  setDiagnosticAvailable(false);
                  setDiagnosticSaveError('');
                  client.clearError();
                  setStartupAttempt((attempt) => attempt + 1);
                }}
              >
                重新尝试
              </Button>
            </>
          )}
        </div>
      </main>
    );
  return (
    <SessionPage
      workspaces={[
        ...new Set([
          ...(projects ?? []).map((project) => project.path),
          ...(workspace ? [workspace] : []),
          ...directory
            .map((session) => session.workspace ?? session.workspaceId)
            .filter((id): id is string => !!id),
        ]),
      ].map((path) => ({
        id: path,
        muted: projects?.find((project) => project.path === path)?.directoryMissing,
        label:
          directory.find((session) => session.workspaceId === path)?.workspaceName ??
          (path.split('/').filter(Boolean).pop() || path),
        state: directoryErrors?.[path]
          ? 'unavailable'
          : directorySnapshot !== undefined
            ? 'loaded'
            : 'loading',
        sessionCount: directory.filter(
          (session) => (session.workspace ?? session.workspaceId) === path,
        ).length,
        sessions: directory
          .filter((session) => (session.workspace ?? session.workspaceId) === path)
          .map((session) => ({
            sessionId: session.sessionId,
            displayName: session.displayName || '新会话',
            status:
              session.lifecycle === 'unavailable'
                ? 'unavailable'
                : (session.currentRun?.status ?? 'idle'),
            updatedAt: session.updatedAt,
            pendingInteractions: session.interactionQueue?.interactions.length ?? 0,
          })),
      }))}
      defaultExpanded
      onExpand={() => void act(() => client.refreshSessions())}
      selected={workbenchView || scheduledTasksView || preparing ? undefined : selected}
      sessionLabel={selectedSession?.displayName || (selected ? '新会话' : '开始一项工作')}
      readingKey={draftKey}
      messages={displayedMessages}
      loading={
        !optimisticMessage &&
        !workbenchView &&
        !scheduledTasksView &&
        !preparing &&
        loadingSession &&
        !view.hasLoadedHistory
      }
      connected={connected}
      connectionLabel=""
      busy={busy || (submitting && !preparing && selectedWorkspace !== workspace)}
      mutationBusy={submitting || firstSubmission?.phase === 'unknown'}
      onHeaderMouseDown={(clickCount) =>
        void client.handleHeaderMouseDown(clickCount).catch((error) => client.report(error))
      }
      onOpen={connected || busyRef.current ? openSession : undefined}
      actions={{
        newSession,
        newWorkspaceSession: (id) => chooseProject(id),
        workbench: () => {
          navigationRevision.current++;
          setScheduledTasksView(false);
          setWorkbenchView(true);
        },
        scheduledTasks: () => {
          navigationRevision.current++;
          setWorkbenchView(false);
          setScheduledTasksView(true);
        },
        settings: () => setSettingsOpen(true),
        openFile: connected && selectedWorkspace === workspace ? openFile : undefined,
      }}
      writeClipboardText={(text) => client.copyText(text)}
      fileChanges={
        !workbenchView && !scheduledTasksView && !preparing && selected
          ? view.messages.filter((message) => message.changeConfirmed)
          : undefined
      }
      newConversation={
        !workbenchView && !scheduledTasksView && preparing
          ? {
              projects: [
                ...(projects ?? []),
                ...(workspace && !projects?.some((project) => project.path === workspace)
                  ? [{ path: workspace, lastOpenedAt: 0 }]
                  : []),
              ].map((project) => ({
                path: project.path,
                label: project.path.split('/').filter(Boolean).pop() || project.path,
              })),
              workspace: conversationWorkspace,
              branch: conversationBranch?.repository
                ? {
                    current: newConversationTargetBranch ?? conversationBranch.current ?? undefined,
                    repository: true,
                    branches: conversationBranch.canSwitch ? conversationBranch.branches : [],
                    label:
                      newConversationTargetBranch ??
                      conversationBranch.current ??
                      `分离 HEAD · ${conversationBranch.head?.slice(0, 7) ?? '未知'}`,
                  }
                : undefined,
              busy: busy || submitting,
              onProject: chooseProject,
              onAddProject: openProject,
              onBranch: (name) => setNewConversationTargetBranch(name),
              onRefreshBranch: () =>
                void act(async () => {
                  setNewConversationBranch(await client.queryProjectBranch(conversationWorkspace));
                }),
            }
          : undefined
      }
      notices={
        <>
          <OperationToast
            message={operationError}
            recovery={operationError === view.error && !!view.recoverySessionId}
            busy={busy}
            onDismiss={dismissOperationError}
            onRecover={() => void act(() => client.checkSessionRecovery())}
          />
          {view.trust &&
            preparingActiveWorkspace &&
            view.trust.status !== 'trusted' &&
            !!view.trust.externalReadScope.roots.length && (
              <section className="notice trust-notice">
                <strong>允许读取项目关联目录？</strong>
                <p>此项目还需要读取以下工作区外目录，请确认访问范围。</p>
                <code>{view.trust.workspace.canonicalPath}</code>
                <p>关联外部只读目录：{view.trust.externalReadScope.roots.join('、')}</p>
                <div className="actions">
                  <Button
                    className="primary"
                    disabled={busy || !view.trust.canDecide}
                    onClick={() => void act(() => client.trustProject())}
                  >
                    允许并继续
                  </Button>
                </div>
              </section>
            )}
        </>
      }
      interaction={
        !workbenchView &&
        !scheduledTasksView &&
        interaction &&
        interaction.kind === 'approval' &&
        selected ? (
          <Approval
            command={interaction.command}
            summary={interaction.summary}
            grants={interaction.grants}
            disabled={busy || !ready || loadingSession || stopping}
            onDecide={(decision) =>
              void act(() => client.respondApproval(selected!, interaction, decision))
            }
          />
        ) : !workbenchView &&
          !scheduledTasksView &&
          interaction &&
          (interaction.kind === 'input' || interaction.kind === 'plan_review') &&
          selected ? (
          <Interaction
            key={`${draftKey}:${interaction.interactionId}`}
            client={client}
            sessionId={selected}
            interaction={interaction}
            disabled={busy || !ready || loadingSession || stopping}
            text={drafts[interactionDraftKey] ?? ''}
            onTextChange={(text) =>
              setDrafts((values) => ({ ...values, [interactionDraftKey]: text }))
            }
            answers={
              interaction.kind === 'input' && interaction.questions
                ? Object.fromEntries(
                    interaction.questions.map((question) => [
                      question.id,
                      drafts[`${interactionDraftKey}\0answer:${question.id}`] ?? '',
                    ]),
                  )
                : undefined
            }
            onAnswerChange={(questionId, value) =>
              setDrafts((values) => ({
                ...values,
                [`${interactionDraftKey}\0answer:${questionId}`]: value,
              }))
            }
            act={(action) =>
              act(async () => {
                await action();
                setDrafts((values) => {
                  const next = { ...values };
                  delete next[interactionDraftKey];
                  for (const key of Object.keys(next)) {
                    if (key.startsWith(`${interactionDraftKey}\0answer:`)) delete next[key];
                  }
                  return next;
                });
              })
            }
          />
        ) : (
          !workbenchView &&
          !scheduledTasksView &&
          !preparing &&
          projection?.currentRun?.status === 'waiting' && (
            <p className="notice">任务正在等待尚未支持的扩展或验证交互，可以停止任务并检查结果。</p>
          )
        )
      }
      composer={
        workbenchView || scheduledTasksView
          ? undefined
          : {
              draft,
              disabled: false,
              active,
              stopping: !!stopping,
              cancelDisabled: busy || !ready || loadingSession,
              model,
              models: view.models?.providers.flatMap((provider) =>
                provider.models
                  .filter((item) => item.enabled !== false)
                  .map((item) => ({
                    provider: provider.provider,
                    name: item.name,
                  })),
              ),
              modelDisabled: (!preparing && busy) || !connected || !view.models,
              onModelChange: (provider, name) => {
                if (preparing) setNewConversationModel({ provider, name });
                else if (selected)
                  setSessionModels((current) => ({
                    ...current,
                    [selected]: { provider, name },
                  }));
              },
              permission: preparing
                ? newConversationPermission
                : pendingPermission?.sessionId === selected
                  ? pendingPermission.mode
                  : (view.interactionMode ?? 'auto'),
              fullPermissionScope: preparing
                ? `new:${navigationRevision.current}`
                : `session:${selected}`,
              permissionDisabled:
                (!preparing && busy) ||
                submitting ||
                (!preparing && (!selected || !ready || loadingSession)),
              permissionPending: pendingPermission?.sessionId === selected,
              sessionLoading: !preparing && (loadingSession || selectingSession !== undefined),
              onPermissionChange: (permission) => {
                if (preparing) {
                  setNewConversationPermission(permission);
                  return;
                }
                if (selected) {
                  setPendingPermission({ sessionId: selected, mode: permission });
                  void act(() => client.setInteractionMode(selected, permission)).finally(() => {
                    setPendingPermission(undefined);
                  });
                }
              },
              submitStatus:
                (loadingSession || (!preparing && selectingSession !== undefined)) &&
                view.hasLoadedHistory
                  ? '正在校准会话，暂时无法发送'
                  : submissionVisible && firstSubmission.phase === 'unknown'
                    ? '发送结果待确认，请检查会话状态'
                    : submissionVisible && firstSubmission.phase !== 'failed'
                      ? '正在发送消息'
                      : undefined,
              onSettings: () => setSettingsOpen(true),
              onChange: (value) => setDrafts((values) => ({ ...values, [draftKey]: value })),
              onSend:
                canSubmit && !active
                  ? () => {
                      if (submittingRef.current) return;
                      submittingRef.current = true;
                      setSubmitting(true);
                      const submitted = draft;
                      const submittedNavigation = navigationRevision.current;
                      const baselineUserIds = view.messages
                        .filter((message) => message.role === 'user')
                        .map((message) => message.id);
                      const restoreDraft = (key: string) =>
                        setDrafts((values) => ({
                          ...values,
                          [key]: values[key] ? `${submitted}\n${values[key]}` : submitted,
                        }));
                      const retryingFirst =
                        firstSubmission?.phase === 'failed' &&
                        firstSubmission.sessionId === selected;
                      const abandonPendingSend = () => {
                        restoreDraft(draftKey);
                        if (retryingFirst)
                          setFirstSubmission({
                            ...firstSubmission,
                            phase: 'failed',
                            text: submitted,
                          });
                        else setFirstSubmission(undefined);
                      };
                      if (preparing) {
                        setFirstSubmission({
                          phase: 'preparing',
                          text: submitted,
                          visibleUntil: Date.now() + 300,
                          navigation: submittedNavigation,
                          baselineUserIds,
                        });
                        setDrafts((values) => ({ ...values, [draftKey]: '' }));
                      } else if (retryingFirst) {
                        setFirstSubmission({
                          ...firstSubmission,
                          phase: 'sending',
                          text: submitted,
                          visibleUntil: Date.now() + 300,
                          baselineUserIds,
                        });
                        setDrafts((values) => ({ ...values, [draftKey]: '' }));
                      } else {
                        setDrafts((values) => ({ ...values, [draftKey]: '' }));
                      }
                      client.clearError();
                      void (async () => {
                        let submittedKey = draftKey;
                        let targetSession = selected;
                        let sessionCreated = !preparing;
                        let permissionApplied = !preparing;
                        try {
                          if (preparing) {
                            if (conversationWorkspace !== client.getSnapshot().workspace) {
                              if (!(await activateForWork(conversationWorkspace))) {
                                abandonPendingSend();
                                return;
                              }
                              setNewConversationBranch(client.getSnapshot().branch);
                            }
                            if (
                              newConversationTargetBranch &&
                              client.getSnapshot().branch?.current !== newConversationTargetBranch
                            ) {
                              await client.switchBranch(newConversationTargetBranch);
                              setNewConversationBranch(client.getSnapshot().branch);
                            }
                            await client.prepareNewConversation();
                            targetSession = await client.newSession(model);
                            sessionCreated = true;
                            setFirstSubmission({
                              phase: 'sending',
                              text: submitted,
                              visibleUntil: Date.now() + 300,
                              navigation: submittedNavigation,
                              baselineUserIds,
                              sessionId: targetSession,
                            });
                            const current = client.getSnapshot();
                            submittedKey = `session:${targetSession}`;
                            setDrafts((values) => ({
                              ...values,
                              [submittedKey]: values[draftKey] ?? '',
                              [draftKey]: '',
                            }));
                            if (navigationRevision.current === submittedNavigation) {
                              setNewConversation(false);
                              rememberNavigation(current.workspace, targetSession);
                              await client.selectSession(targetSession);
                            }
                            await client.setInteractionMode(
                              targetSession,
                              newConversationPermission,
                            );
                            permissionApplied = true;
                          }
                          if (!preparing) {
                            targetSession = selected;
                            if (retryingFirst && firstSubmission.permissionRequired) {
                              await client.setInteractionMode(
                                targetSession!,
                                newConversationPermission,
                              );
                              permissionApplied = true;
                              setFirstSubmission({
                                ...firstSubmission,
                                phase: 'sending',
                                permissionRequired: false,
                              });
                            }
                          }
                          await client.send(submitted, targetSession, model);
                        } catch (error) {
                          if (error instanceof CommandResultUnknown) {
                            if (error.commandType === 'resume_session') {
                              restoreDraft(draftKey);
                              if (retryingFirst)
                                setFirstSubmission({
                                  ...firstSubmission,
                                  phase: 'failed',
                                  text: submitted,
                                  uncertainty: undefined,
                                });
                              client.report(error);
                              return;
                            }
                            if (
                              error.commandType === 'set_interaction_mode' &&
                              sessionCreated &&
                              targetSession
                            ) {
                              const current = client.getSnapshot();
                              submittedKey = `session:${targetSession}`;
                              const permissionRequired =
                                current.selected !== targetSession ||
                                current.interactionMode !== newConversationPermission;
                              setFirstSubmission({
                                phase: 'failed',
                                text: submitted,
                                visibleUntil: Date.now(),
                                navigation: submittedNavigation,
                                baselineUserIds,
                                sessionId: targetSession,
                                permissionRequired,
                              });
                              restoreDraft(submittedKey);
                              client.report(error);
                              return;
                            }
                            const current = client.getSnapshot();
                            targetSession = sessionCreated ? targetSession : error.sessionId;
                            if (targetSession) {
                              submittedKey = `session:${targetSession}`;
                              if (navigationRevision.current === submittedNavigation) {
                                setNewConversation(false);
                                rememberNavigation(current.workspace, targetSession);
                              }
                            }
                            setFirstSubmission({
                              phase: 'unknown',
                              text: submitted,
                              visibleUntil: Date.now(),
                              navigation: submittedNavigation,
                              baselineUserIds,
                              sessionId: targetSession,
                              uncertainty: sessionCreated ? 'turn' : 'create',
                            });
                            if (!sessionCreated && targetSession)
                              setDrafts((values) => ({
                                ...values,
                                [submittedKey]: values[draftKey]
                                  ? `${submitted}\n${values[draftKey]}`
                                  : submitted,
                                [draftKey]: '',
                              }));
                            client.report(error);
                            return;
                          }
                          if (preparing || retryingFirst) {
                            setFirstSubmission({
                              phase: 'failed',
                              text: submitted,
                              visibleUntil: Date.now(),
                              navigation: submittedNavigation,
                              baselineUserIds,
                              sessionId: sessionCreated ? targetSession : undefined,
                              permissionRequired: sessionCreated && !permissionApplied,
                            });
                          }
                          restoreDraft(sessionCreated && targetSession ? submittedKey : draftKey);
                          client.report(error);
                        } finally {
                          submittingRef.current = false;
                          setSubmitting(false);
                          if (preparing)
                            void client.refreshSessions().catch((error) => client.report(error));
                        }
                      })();
                    }
                  : undefined,
              onCancel: () =>
                void act(async () => {
                  if (busy || !ready || loadingSession || stopping) return;
                  const runId = projection?.currentRun?.runId;
                  if (!runId) return;
                  setStopRequest({ key: draftKey, runId });
                  try {
                    await client.cancel();
                  } catch (error) {
                    setStopRequest(undefined);
                    throw error;
                  }
                }),
            }
      }
      workbench={workbenchView || undefined}
      scheduledTasks={
        scheduledTasksView
          ? {
              tasks: [],
              workspaces: [
                ...new Set([
                  ...(projects ?? []).map((project) => project.path),
                  ...(workspace ? [workspace] : []),
                ]),
              ].map((path) => ({
                id: path,
                label: path.split('/').filter(Boolean).pop() || path,
                state: 'loaded' as const,
                sessionCount: 0,
                sessions: [],
              })),
            }
          : undefined
      }
      overlays={
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent
            portalled={false}
            className="desktop-settings-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="desktop-settings-header">
              <DialogTitle>设置</DialogTitle>
              <DialogDescription className="sr-only">配置编辑器与扩展能力</DialogDescription>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                <HugeiconsIcon icon={ArrowLeft01Icon} aria-hidden="true" />
                返回应用
              </button>
            </DialogHeader>
            <Settings
              client={client}
              view={view}
              busy={busy}
              actionPending={operation !== undefined}
              act={act}
              editor={editor}
              onEditorChange={setEditor}
            />
          </DialogContent>
        </Dialog>
      }
    />
  );
}
