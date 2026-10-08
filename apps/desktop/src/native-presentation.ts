import type { Message, Session, Workspace } from '@kite-ai/client';
import type { Message as DesktopMessage, WorkspaceSummary } from '@kite-ai/ui/desktop';
import type { NativeSelection } from './native-bridge';

/** Adapt public facts to the retained desktop view model; missing facts stay missing. */
export function desktopDirectory(
  directory: { storeId: string; workspaces: readonly Workspace[]; sessions: readonly Session[] },
  selection?: NativeSelection,
): WorkspaceSummary[] {
  const sessions = directory.sessions.filter((session) => !session.deletedAt);
  const summary = (session: Session) => {
    const observed =
      selection?.storeId === directory.storeId && selection.session.id === session.id;
    const active = observed ? selection.runs.find((run) => run.isActive) : undefined;
    return {
      sessionId: session.id,
      displayName: session.title,
      status: !observed
        ? '状态待读取'
        : selection.viewLoading || selection.permissionUnavailable
          ? '上次确认状态'
          : active?.status === 'waiting_interaction'
            ? 'waiting'
            : active?.status === 'waiting_execution'
              ? '等待执行结果'
              : active?.status === 'cancelling'
                ? '正在停止'
                : (active?.status ?? 'idle'),
      ...(observed
        ? {
            pendingInteractions: selection.interactions.filter((card) => card.state === 'pending')
              .length,
          }
        : {}),
    };
  };
  const workspaces: WorkspaceSummary[] = directory.workspaces.map((workspace) => {
    const items = sessions.filter((session) => session.workspaceId === workspace.id).map(summary);
    return {
      id: workspace.id,
      label: workspace.name,
      sessions: items,
      sessionCount: items.length,
      state: 'loaded',
    };
  });
  // The two complete reads can straddle a newly registered Workspace. Keep its original Session visible.
  for (const workspaceId of new Set(sessions.map((session) => session.workspaceId))) {
    if (directory.workspaces.some((workspace) => workspace.id === workspaceId)) continue;
    const items = sessions.filter((session) => session.workspaceId === workspaceId).map(summary);
    workspaces.push({
      id: workspaceId,
      label: '项目待读取的会话',
      sessions: items,
      sessionCount: items.length,
      state: 'unavailable',
    });
  }
  return workspaces;
}

export function desktopMessages(messages: readonly Message[]): DesktopMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content,
    settled: message.status === 'complete',
    // Public Message completion does not establish a final Run reply or legacy tool presentation.
  }));
}
