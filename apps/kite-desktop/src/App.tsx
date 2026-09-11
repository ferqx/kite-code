import { Button, SessionPage } from '@kite-ai/kite-client-ui';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import appIcon from '../app-icon.svg';
import type { DesktopClient } from './client';
import { Interaction } from './Interaction';
import { isActiveRun } from './presentation';
import { Settings } from './Settings';
import './startup.css';

const navigationKey = 'kite.desktop.navigation';
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
  const [busy, setBusy] = useState(false);
  const [startup, setStartup] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [startupError, setStartupError] = useState('');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const busyRef = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newConversation, setNewConversation] = useState(!view.selected);
  const [workbenchView, setWorkbenchView] = useState(false);
  const [navigation] = useState(readNavigation);
  const navigationRevision = useRef(0);
  const preparing = newConversation || !view.selected;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<'vscode' | 'zed' | 'textedit'>('vscode');
  const [stopRequest, setStopRequest] = useState<{ key: string; runId: string }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const selectedSession = (view.directory ?? view.sessions).find(
    (session) => session.sessionId === view.selected,
  );
  const selectedWorkspace =
    selectedSession?.workspace ??
    (view.projection?.workspaceDigest === view.trust?.workspace.workspaceDigest
      ? view.workspace
      : undefined);
  const draftKey = preparing
    ? 'new-conversation'
    : `${selectedWorkspace ?? selectedSession?.workspaceId ?? ''}\0${view.selected}`;
  const draft = drafts[draftKey] ?? '';
  const stopping =
    isActiveRun(view.projection) &&
    stopRequest?.key === draftKey &&
    stopRequest.runId === view.projection?.currentRun?.runId;
  const workspaceName =
    (preparing ? view.workspace : (selectedWorkspace ?? '')).split('/').filter(Boolean).pop() ||
    selectedSession?.workspaceName ||
    '本地空间';
  const interaction =
    !preparing &&
    view.projection?.interactionQueue.interactions.find(
      (item) => item.interactionId === view.projection?.interactionQueue.activeInteractionId,
    );
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
    navigationRevision.current++;
    setWorkbenchView(false);
    setNewConversation(false);
    // Selection has its own abort/generation owner; a second selection may supersede it.
    void client
      .selectSession(id)
      .then(() => {
        const current = client.getSnapshot();
        rememberNavigation(
          current.directory?.find((session) => session.sessionId === current.selected)?.workspace ??
            current.workspace,
          current.selected,
        );
      })
      .catch((error) => client.report(error));
  };
  const newSession = () => {
    if (!busyRef.current) {
      navigationRevision.current++;
      setWorkbenchView(false);
      setNewConversation(true);
      rememberNavigation(view.workspace);
    }
  };
  const activateForWork = async (target: string) => {
    await client.checkProject(target);
    const current = client.getSnapshot();
    if (target !== current.workspace && (current.connected || client.hasNativeConnection())) {
      if (
        (await client.hasActiveTasks()) &&
        !(await confirm('切换执行项目将停止当前服务中的任务，已有修改不会撤销。', {
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
      const target = path ?? (await client.pickProject());
      if (!target || !(await activateForWork(target))) return;
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
    if (!view.connected) setStopRequest(undefined);
  }, [view.connected]);
  const active = !preparing && isActiveRun(view.projection);
  const model =
    !preparing && selectedWorkspace !== view.workspace
      ? view.projection?.model
      : active
        ? (view.projection?.model ?? view.models?.selected)
        : (view.models?.selected ?? view.projection?.model);
  const canSubmit =
    !busy &&
    view.connected &&
    (preparing
      ? !!view.workspace && !!view.models?.selected && view.trust?.status === 'trusted'
      : view.ready && !view.loadingSession && !!view.selected && !!selectedWorkspace);
  const liveSessions = new Map(view.sessions.map((session) => [session.sessionId, session]));
  const directory = (view.directory ?? view.sessions).map((session) => {
    const current = liveSessions.get(session.sessionId);
    if (!current || (current.revision ?? 0) < (session.revision ?? 0)) return session;
    return {
      ...session,
      revision: current.revision,
      lifecycle: current.lifecycle,
      currentRun: current.currentRun,
      interactionQueue: current.interactionQueue,
      updatedAt: current.updatedAt,
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
          ...(view.projects ?? []).map((project) => project.path),
          ...(view.workspace ? [view.workspace] : []),
          ...directory
            .map((session) => session.workspace ?? session.workspaceId)
            .filter((id): id is string => !!id),
        ]),
      ].map((path) => ({
        id: path,
        muted: view.projects?.find((project) => project.path === path)?.directoryMissing,
        label:
          directory.find((session) => session.workspaceId === path)?.workspaceName ??
          (path.split('/').filter(Boolean).pop() || path),
        state: view.directoryErrors?.[path]
          ? 'unavailable'
          : view.directory !== undefined
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
      onLoadMore={
        Object.keys(view.directoryCursors ?? {}).length
          ? () => void act(() => client.refreshDirectory(true))
          : undefined
      }
      onExpand={() => void act(() => client.refreshSessions())}
      selected={workbenchView || preparing ? undefined : view.selected}
      workspaceLabel={workspaceName}
      sessionLabel={selectedSession?.displayName || (view.selected ? '新会话' : '开始一项工作')}
      readingKey={draftKey}
      messages={workbenchView || preparing ? [] : view.messages}
      loading={!workbenchView && !preparing && view.loadingSession && view.messages.length === 0}
      connected={view.connected}
      connectionLabel=""
      busy={busy}
      onHeaderMouseDown={(clickCount) =>
        void client.handleHeaderMouseDown(clickCount).catch((error) => client.report(error))
      }
      onOpen={view.connected ? openSession : undefined}
      actions={{
        newSession,
        newWorkspaceSession: (id) => chooseProject(id),
        workbench: () => {
          navigationRevision.current++;
          setWorkbenchView(true);
        },
        settings: () => setSettingsOpen(true),
        openFile: view.connected && selectedWorkspace === view.workspace ? openFile : undefined,
      }}
      fileChanges={
        !workbenchView && !preparing && view.selected
          ? view.messages.filter((message) => message.changeConfirmed)
          : undefined
      }
      newConversation={
        !workbenchView && preparing
          ? {
              projects: [
                ...(view.projects ?? []),
                ...(view.workspace &&
                !view.projects?.some((project) => project.path === view.workspace)
                  ? [{ path: view.workspace, lastOpenedAt: 0 }]
                  : []),
              ].map((project) => ({
                path: project.path,
                label: project.path.split('/').filter(Boolean).pop() || project.path,
              })),
              workspace: view.workspace,
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
              busy,
              onProject: chooseProject,
              onAddProject: openProject,
              onBranch: (name) => void act(() => client.switchBranch(name)),
              onRefreshBranch: () => void act(() => client.refreshBranch()),
            }
          : undefined
      }
      notices={
        <>
          {(view.commandError || (view.connected && view.error)) && (
            <div className="notice error" role="alert">
              <span>{view.commandError || view.error}</span>
              {!preparing &&
                view.connected &&
                view.selected &&
                !view.loadingSession &&
                !view.ready && (
                  <Button disabled={busy} onClick={() => openSession(view.selected!)}>
                    重新加载会话
                  </Button>
                )}
            </div>
          )}
          {!busy && view.trust && view.trust.status !== 'trusted' && (
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
        !workbenchView && interaction && interaction.kind === 'approval' && view.selected ? (
          <section className="notice" aria-label="工具审批">
            <strong>{interaction.title || '工具需要你的批准'}</strong>
            <p>{interaction.summary}</p>
            {interaction.command && <pre className="interaction-text">{interaction.command}</pre>}
            <div className="actions">
              <Button
                disabled={busy || !view.ready || view.loadingSession || stopping}
                onClick={() =>
                  void act(() => client.respondApproval(view.selected!, interaction, 'reject'))
                }
              >
                拒绝本次
              </Button>
              <Button
                className="primary"
                disabled={
                  busy ||
                  !view.ready ||
                  view.loadingSession ||
                  stopping ||
                  !interaction.grants.includes('approve_once')
                }
                onClick={() =>
                  void act(() =>
                    client.respondApproval(view.selected!, interaction, 'approve_once'),
                  )
                }
              >
                仅批准这一次
              </Button>
            </div>
          </section>
        ) : !workbenchView &&
          interaction &&
          (interaction.kind === 'input' || interaction.kind === 'plan_review') &&
          view.selected ? (
          <Interaction
            key={`${draftKey}:${interaction.interactionId}`}
            client={client}
            sessionId={view.selected}
            interaction={interaction}
            disabled={busy || !view.ready || view.loadingSession || stopping}
            act={act}
          />
        ) : (
          !workbenchView &&
          !preparing &&
          view.projection?.currentRun?.status === 'waiting' && (
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
              cancelDisabled: busy || !view.ready || view.loadingSession,
              model: model ? `${model.provider} / ${model.name}` : undefined,
              onSettings: () => setSettingsOpen(true),
              onChange: (value) => setDrafts((values) => ({ ...values, [draftKey]: value })),
              onSend:
                canSubmit && !active
                  ? () => {
                      const submitted = draft;
                      const submittedNavigation = navigationRevision.current;
                      void act(async () => {
                        let submittedKey = draftKey;
                        let targetSession = view.selected;
                        if (preparing) {
                          await client.prepareNewConversation();
                          targetSession = await client.newSession();
                          const current = client.getSnapshot();
                          submittedKey = `${current.workspace}\0${targetSession}`;
                          setDrafts((values) => ({
                            ...values,
                            [submittedKey]: values[draftKey] ?? submitted,
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
                          targetSession = view.selected;
                          if (selectedWorkspace !== client.getSnapshot().workspace) {
                            if (!selectedWorkspace || !(await activateForWork(selectedWorkspace)))
                              return;
                            await client.selectSession(view.selected!);
                          }
                        }
                        try {
                          await client.send(submitted, targetSession);
                        } finally {
                          if (preparing)
                            void client.refreshSessions().catch((error) => client.report(error));
                        }
                        setDrafts((values) => ({
                          ...values,
                          [submittedKey]:
                            values[submittedKey] === submitted ? '' : (values[submittedKey] ?? ''),
                        }));
                      });
                    }
                  : undefined,
              onCancel: () =>
                void act(async () => {
                  if (busy || !view.ready || view.loadingSession || stopping) return;
                  const runId = view.projection?.currentRun?.runId;
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
              key={view.workspace}
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
