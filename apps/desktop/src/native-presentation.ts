import type { Message } from '@kite-ai/client';
import type { Message as DesktopMessage, WorkspaceSummary } from '@kite-ai/ui/desktop';
import type { NativeDirectory, NativeSelection } from './native-bridge';

/** Adapt public facts to the retained desktop view model; missing facts stay missing. */
export function desktopDirectory(
  directory: NativeDirectory,
  selection?: NativeSelection,
): WorkspaceSummary[] {
  const sessions = directory.sessions.filter((session) => !session.deletedAt);
  const summary = (session: NativeDirectory['sessions'][number]) => {
    if (session.activity) {
      const { run, queued, pendingInteractions, updatedAt } = session.activity;
      const unconfirmed =
        session.activity.executionOwner === 'unheld' ||
        session.activity.executionOwner === 'unknown';
      const waiting =
        !unconfirmed &&
        run?.isActive &&
        run.status === 'waiting_execution' &&
        run.waitingForResults;
      return {
        sessionId: session.id,
        displayName: session.title || '新对话',
        status: directory.unavailable
          ? '上次确认状态'
          : unconfirmed
            ? '执行状态待核实'
            : run?.isActive
              ? run.status === 'waiting_interaction' || waiting
                ? 'waiting'
                : run.status === 'waiting_execution'
                  ? '等待执行结果'
                  : run.status === 'cancelling'
                    ? '正在停止'
                    : run.status
              : queued
                ? 'queued'
                : (run?.status ?? 'idle'),
        ...(updatedAt !== null ? { updatedAt: new Date(updatedAt).toISOString() } : {}),
        ...(!directory.unavailable && !unconfirmed ? { pendingInteractions } : {}),
        ...(!directory.unavailable && waiting
          ? { waitingReason: 'required_background' as const }
          : {}),
      };
    }
    const observed =
      selection?.storeId === directory.storeId && selection.session.id === session.id;
    const active = observed ? selection.runs.find((run) => run.isActive) : undefined;
    return {
      sessionId: session.id,
      displayName: session.title || '新对话',
      status: !observed
        ? '状态待读取'
        : directory.unavailable || (selection.permissionUnavailable && !selection.viewLoading)
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

/** Keep one complete business message at the original input's position in this reading. */
export function desktopConversationMessages(messages: readonly Message[]): Message[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const replacements = new Map<string, Message>();
  const relocated = new Set<string>();
  for (const message of messages) {
    const input = message.humanInput;
    if (
      message.role !== 'user' ||
      !input?.duplicateOfMessageId ||
      input.duplicateOfMessageId === message.id
    )
      continue;
    const replacement = byId.get(input.duplicateOfMessageId);
    if (
      replacement?.role === 'user' &&
      replacement.sessionId === message.sessionId &&
      replacement.originMessage?.storeId === message.originMessage?.storeId &&
      replacement.originMessage?.sessionId === message.originMessage?.sessionId &&
      replacement.humanInput?.inputCommandId === input.inputCommandId &&
      replacement.humanInput.publicCommandId === input.publicCommandId &&
      !replacement.humanInput.duplicateOfMessageId
    ) {
      replacements.set(message.id, replacement);
      relocated.add(replacement.id);
    }
  }
  const emitted = new Set<string>();
  return messages.flatMap((message) => {
    const replacement = replacements.get(message.id);
    if (!replacement) return relocated.has(message.id) ? [] : [message];
    if (emitted.has(replacement.id)) return [];
    emitted.add(replacement.id);
    // Preserve the business identity, Run, seq and attachments. Only its display
    // position moves before the interpretation reply caused by this same input.
    return [replacement];
  });
}

export function desktopMessages(
  messages: readonly Message[],
  includeRunningCompression = false,
): DesktopMessage[] {
  const visible = includeRunningCompression
    ? messages
    : messages.filter((message) => message.compression?.status !== 'running');
  return visible.map((message) => {
    const agentMessage = message.agentMessage;
    if (agentMessage)
      return {
        id: message.id,
        role: 'system',
        systemKind: 'agent_message',
        agentMessage,
        text: message.content,
        settled: true,
      };
    const agentResult = message.agentResult;
    if (agentResult)
      return {
        id: message.id,
        role: 'system',
        systemKind: 'agent_result',
        agentResult,
        text: message.content,
        settled: true,
      };
    // firstOutput identifies the first channel, not the current phase. A
    // reasoning-first response starts rendering as soon as it has actual text.
    const thinking =
      message.role === 'assistant' &&
      message.status === 'incomplete' &&
      message.contentFormat !== 'unsupported' &&
      message.outputBody?.readAvailability !== 'unsupported' &&
      message.content.length === 0 &&
      (!message.outputBody || message.outputBody.contentBytes === '0') &&
      (message.firstOutput === 'reasoning' ||
        (message.firstOutput === undefined &&
          message.outputBody !== undefined &&
          message.outputBody.reasoningBytes !== '0' &&
          message.outputBody.toolCallCount === 0));
    return {
      id: message.id,
      role: message.compression ? 'system' : thinking ? 'thinking' : message.role,
      ...(message.compression
        ? {
            systemKind: 'compaction' as const,
            title:
              message.compression.status === 'completed'
                ? '上下文压缩完成'
                : message.compression.status === 'failed'
                  ? '上下文压缩失败'
                  : message.compression.status === 'cancelled'
                    ? '上下文压缩已取消'
                    : message.compression.status === 'running'
                      ? '正在压缩上下文'
                      : '上下文压缩未发布',
            status:
              message.compression.status === 'unpublished' ||
              message.compression.status === 'running'
                ? ('unknown' as const)
                : message.compression.status,
          }
        : {}),
      text: message.compression || thinking ? '' : message.content,
      settled: message.compression ? true : message.status === 'complete',
      // Public Message completion does not establish a final Run reply or legacy tool presentation.
    };
  });
}
