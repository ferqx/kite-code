import { Button, type Message, SessionPage } from '@kite-ai/kite-client-ui';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import appIcon from '../app-icon.svg';
import { CommandResultUnknown, type DesktopClient } from './client';
import { Interaction } from './Interaction';
import { isActiveRun } from './presentation';
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
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectingSession, setSelectingSession] = useState<string>();
  const [newConversationPermission, setNewConversationPermission] = useState<
    'accept_edits' | 'auto' | 'full'
  >('auto');
  const [startup, setStartup] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [startupError, setStartupError] = useState('');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const busyRef = useRef(false);
  const submittingRef = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newConversation, setNewConversation] = useState(!selected);
  const [firstSubmission, setFirstSubmission] = useState<FirstSubmission>();
  const [workbenchView, setWorkbenchView] = useState(false);
  const [navigation] = useState(readNavigation);
  const navigationRevision = useRef(0);
  const preparing = newConversation || !selected;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<'vscode' | 'zed' | 'textedit'>('vscode');
  const [stopRequest, setStopRequest] = useState<{ key: string; runId: string }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const selectedSession = (directorySnapshot ?? view.sessions).find(
    (session) => session.sessionId === selected,
  );
  const selectedWorkspace =
    selectedSession?.workspace ??
    (projection?.workspaceDigest === view.trust?.workspace.workspaceDigest ? workspace : undefined);
  const readingWorkspace = selectedWorkspace ?? selectedSession?.workspaceId ?? workspace;
  const draftKey = preparing ? 'new-conversation' : `${readingWorkspace}\0${selected}`;
  const draft = drafts[draftKey] ?? '';
  const stopping =
    isActiveRun(projection) &&
    stopRequest?.key === draftKey &&
    stopRequest.runId === projection?.currentRun?.runId;
  const workspaceName =
    (preparing ? workspace : (selectedWorkspace ?? '')).split('/').filter(Boolean).pop() ||
    selectedSession?.workspaceName ||
    '本地空间';
  const interaction =
    !preparing &&
    projection?.interactionQueue.interactions.find(
      (item) => item.interactionId === projection?.interactionQueue.activeInteractionId,
    );
  const interactionDraftKey = `${draftKey}\0interaction:${interaction ? interaction.interactionId : ''}`;
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      client.clearError();
      try {
        await action();
      } catch (error) {
        client.report(error);
      } finally {
        busyRef.current = false;
        setBusy(false);
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
    const revision = ++navigationRevision.current;
    setWorkbenchView(false);
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
  const newSession = () => {
    if (!busyRef.current) {
      navigationRevision.current++;
      setWorkbenchView(false);
      setNewConversation(true);
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
    const current = client.getSnapshot();
    if (target !== current.workspace && (current.connected || client.hasNativeConnection())) {
      if (
        (await client.hasActiveTasks()) &&
        !(await client.confirm({
          message: '切换执行项目将停止当前服务中的任务，已有修改不会撤销。',
          title: '切换执行项目？',
          kind: 'warning',
          okLabel: '停止并继续',
          cancelLabel: '保留当前任务',
        }))
      )
        return false;
      await client.disconnect();
    }
    await client.activateProject(target);
    return true;
  };
  const chooseProject = (path?: string) =>
    void act(async () => {
      const revision = navigationRevision.current;
      const target = path ?? (await client.pickProject());
      if (!target || !(await activateForWork(target))) return;
      if (navigationRevision.current !== revision) return;
      navigationRevision.current++;
      setNewConversation(true);
      rememberNavigation(target);
    });
  const openProject = () => chooseProject();
  useEffect(() => {
    if (settingsOpen) dialog.current?.showModal();
  }, [settingsOpen]);
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
  const model =
    !preparing && selectedWorkspace !== workspace
      ? projection?.model
      : active
        ? (projection?.model ?? view.models?.selected)
        : (view.models?.selected ?? projection?.model);
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
    (preparing
      ? !!workspace && !!view.models?.selected && view.trust?.status === 'trusted'
      : ready && !loadingSession && !!selected && !!selectedWorkspace);
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
  const displayedMessages = optimisticMessage
    ? preparing
      ? [optimisticMessage]
      : optimisticRuntimeIndex < 0
        ? [...view.messages, optimisticMessage]
        : view.messages.map((message, index) =>
            index === optimisticRuntimeIndex ? optimisticMessage : message,
          )
    : workbenchView || preparing
      ? []
      : view.messages;
  const liveSessions = new Map(view.sessions.map((session) => [session.sessionId, session]));
  const directory = (directorySnapshot ?? view.sessions).map((session) => {
    const current = liveSessions.get(session.sessionId);
    if (!current || (current.revision ?? 0) < (session.revision ?? 0)) return session;
    return {
      ...session,
      revision: current.revision,
      lifecycle: current.lifecycle,
      currentRun: current.currentRun,
      interactionQueue: current.interactionQueue,
      updatedAt: current.updatedAt ?? session.updatedAt,
    };
  });
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
            <p role="status">正在准备你的工作空间…</p>
          ) : (
            <>
              <p role="alert">启动未完成：{startupError}</p>
              <Button
                onClick={() => {
                  setStartup('loading');
                  setStartupError('');
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
      selected={workbenchView || preparing ? undefined : selected}
      workspaceLabel={workspaceName}
      sessionLabel={selectedSession?.displayName || (selected ? '新会话' : '开始一项工作')}
      readingKey={draftKey}
      messages={displayedMessages}
      loading={
        !optimisticMessage &&
        !workbenchView &&
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
      onOpen={connected ? openSession : undefined}
      actions={{
        newSession,
        newWorkspaceSession: (id) => chooseProject(id),
        workbench: () => {
          navigationRevision.current++;
          setWorkbenchView(true);
        },
        settings: () => setSettingsOpen(true),
        openFile: connected && selectedWorkspace === workspace ? openFile : undefined,
      }}
      fileChanges={
        !workbenchView && !preparing && selected
          ? view.messages.filter((message) => message.changeConfirmed)
          : undefined
      }
      newConversation={
        !workbenchView && preparing
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
              workspace: workspace,
              branch: view.branch
                ? {
                    current: view.branch.current ?? undefined,
                    repository: view.branch.repository,
                    branches: view.branch.canSwitch ? view.branch.branches : [],
                    label: !view.branch.repository
                      ? '非 Git 项目'
                      : (view.branch.current ??
                        `分离 HEAD · ${view.branch.head?.slice(0, 7) ?? '未知'}`),
                  }
                : undefined,
              busy: busy || submitting,
              onProject: chooseProject,
              onAddProject: openProject,
              onBranch: (name) => void act(() => client.switchBranch(name)),
              onRefreshBranch: () => void act(() => client.refreshBranch()),
            }
          : undefined
      }
      notices={
        <>
          {(view.commandError || (connected && view.error)) && (
            <div className="notice error" role="alert">
              <span>{view.commandError || view.error}</span>
              {!preparing && connected && selected && !loadingSession && !ready && (
                <Button disabled={busy} onClick={() => openSession(selected!)}>
                  重新加载会话
                </Button>
              )}
            </div>
          )}
          {view.trust && view.trust.status !== 'trusted' && (
            <section className="notice trust-notice">
              <strong>
                {view.trust.externalReadScope.roots.length
                  ? '允许读取项目关联目录？'
                  : '项目授权未完成'}
              </strong>
              <p>
                {view.trust.externalReadScope.roots.length
                  ? '此项目还需要读取以下工作区外目录，请确认访问范围。'
                  : '添加项目即授权工作区访问，但本次授权尚未生效，请重试。'}
              </p>
              <code>{view.trust.workspace.canonicalPath}</code>
              {!!view.trust.externalReadScope.roots.length && (
                <p>关联外部只读目录：{view.trust.externalReadScope.roots.join('、')}</p>
              )}
              <div className="actions">
                <Button
                  className="primary"
                  disabled={busy || !view.trust.canDecide}
                  onClick={() => void act(() => client.trustProject())}
                >
                  {view.trust.externalReadScope.roots.length ? '允许并继续' : '重新授权'}
                </Button>
              </div>
            </section>
          )}
        </>
      }
      interaction={
        !workbenchView && interaction && interaction.kind === 'approval' && selected ? (
          <section className="notice" aria-label="工具审批">
            <strong>{interaction.title || '工具需要你的批准'}</strong>
            <p>{interaction.summary}</p>
            {interaction.command && <pre className="interaction-text">{interaction.command}</pre>}
            <div className="actions">
              <Button
                disabled={busy || !ready || loadingSession || stopping}
                onClick={() =>
                  void act(() => client.respondApproval(selected!, interaction, 'reject'))
                }
              >
                拒绝本次
              </Button>
              <Button
                className="primary"
                disabled={
                  busy ||
                  !ready ||
                  loadingSession ||
                  stopping ||
                  !interaction.grants.includes('approve_once')
                }
                onClick={() =>
                  void act(() => client.respondApproval(selected!, interaction, 'approve_once'))
                }
              >
                仅批准这一次
              </Button>
            </div>
          </section>
        ) : !workbenchView &&
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
            act={(action) =>
              act(async () => {
                await action();
                setDrafts((values) => {
                  const next = { ...values };
                  delete next[interactionDraftKey];
                  return next;
                });
              })
            }
          />
        ) : (
          !workbenchView &&
          !preparing &&
          projection?.currentRun?.status === 'waiting' && (
            <p className="notice">任务正在等待尚未支持的扩展或验证交互，可以停止任务并检查结果。</p>
          )
        )
      }
      composer={
        workbenchView
          ? undefined
          : {
              draft,
              disabled: false,
              active,
              stopping: !!stopping,
              cancelDisabled: busy || !ready || loadingSession,
              model: model ? `${model.provider} / ${model.name}` : undefined,
              models: view.models?.providers.flatMap((provider) =>
                provider.models.map((item) => ({ provider: provider.provider, name: item.name })),
              ),
              modelDisabled: busy || !connected || !view.models,
              onModelChange: (provider, name) => void act(() => client.selectModel(provider, name)),
              permission: preparing ? newConversationPermission : (view.interactionMode ?? 'auto'),
              permissionDisabled:
                busy || submitting || (!preparing && (!selected || !ready || loadingSession)),
              onPermissionChange: (permission) => {
                if (preparing) {
                  setNewConversationPermission(permission);
                  return;
                }
                if (selected)
                  void act(async () => {
                    await client.setInteractionMode(selected, permission);
                  });
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
                        try {
                          if (preparing) {
                            await client.prepareNewConversation();
                            targetSession = await client.newSession();
                            sessionCreated = true;
                            await client.setInteractionMode(
                              targetSession,
                              newConversationPermission,
                            );
                            setFirstSubmission({
                              phase: 'sending',
                              text: submitted,
                              visibleUntil: Date.now() + 300,
                              navigation: submittedNavigation,
                              baselineUserIds,
                              sessionId: targetSession,
                            });
                            const current = client.getSnapshot();
                            submittedKey = `${current.workspace}\0${targetSession}`;
                            setDrafts((values) => ({
                              ...values,
                              [submittedKey]: values[draftKey] ?? '',
                              [draftKey]: '',
                            }));
                            if (navigationRevision.current === submittedNavigation) {
                              const selection = client.selectSession(targetSession);
                              setNewConversation(false);
                              rememberNavigation(current.workspace, targetSession);
                              await selection;
                            }
                          }
                          if (!preparing) {
                            targetSession = selected;
                            if (selectedWorkspace !== client.getSnapshot().workspace) {
                              if (
                                !selectedWorkspace ||
                                !(await activateForWork(selectedWorkspace))
                              ) {
                                abandonPendingSend();
                                return;
                              }
                              if (navigationRevision.current !== submittedNavigation) {
                                abandonPendingSend();
                                return;
                              }
                              await client.selectSession(selected!);
                            }
                          }
                          await client.send(submitted, targetSession);
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
                            const current = client.getSnapshot();
                            targetSession = sessionCreated ? targetSession : error.sessionId;
                            if (targetSession) {
                              submittedKey = `${current.workspace}\0${targetSession}`;
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
      overlays={
        settingsOpen && (
          <dialog
            ref={dialog}
            className="utility-dialog"
            aria-label="设置"
            onClose={() => setSettingsOpen(false)}
          >
            <div className="dialog-heading">
              <strong>设置</strong>
              <Button onClick={() => dialog.current?.close()}>关闭</Button>
            </div>
            <Settings
              key={workspace}
              client={client}
              view={view}
              busy={busy}
              act={act}
              editor={editor}
              onEditorChange={setEditor}
            />
          </dialog>
        )
      }
    />
  );
}
