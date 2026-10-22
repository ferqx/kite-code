import type { Execution, Message } from '@kite-ai/client';
import { type Message as DesktopMessage, ToolActivity, ToolRow } from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import type {
  NativeRunFact,
  NativeToolExecution,
  NativeToolMessageFact,
} from './tool-messages-bridge';

const labels: Record<string, readonly [readonly string[], string]> = {
  'files.read': [['2', '3', '4'], '读取'],
  'files.read_path': [['1', '2'], '读取'],
  'files.write': [['2'], '写入'],
  'files.edit': [['2'], '修改'],
  'files.glob': [['2'], '查找文件'],
  'files.search': [['2'], '搜索内容'],
  'files.list': [['1'], '列出目录'],
  'shell.launch': [['1'], '启动后台 Shell'],
  'shell.read': [['1'], '读取后台 Shell'],
  'shell.wait': [['1'], '等待后台 Shell'],
  'shell.stop': [['1'], '请求停止后台 Shell'],
  ask_user: [['1'], '询问用户'],
  'task.spawn': [['1'], '创建子 Agent'],
  'task.follow_up': [['1'], '继续子 Agent'],
  'task.message': [['1'], '发送 Agent 消息'],
  'task.events': [['1'], '等待 Agent 事件'],
  'task.list': [['1'], '列出子 Agent'],
  'task.interrupt': [['1'], '中断子 Agent'],
};
const exploration = new Set([
  'files.read',
  'files.read_path',
  'files.glob',
  'files.search',
  'files.list',
]);

/** Classification is display-only and requires an exact supported definition version. */
export function desktopToolPresentation(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion'>,
): Pick<DesktopMessage, 'toolName' | 'title' | 'presentation'> {
  const label = labels[fact.definitionId];
  const known = label?.[0].includes(fact.definitionVersion);
  return {
    toolName: known
      ? ((
          {
            'files.read': 'read_file',
            'files.read_path': 'read_file',
            'files.write': 'write_file',
            'files.edit': 'edit_file',
            'task.spawn': 'spawn_agent',
            'task.follow_up': 'follow_up_agent',
            'task.message': 'send_agent_message',
            'task.events': 'wait_agent_events',
            'task.list': 'list_agents',
            'task.interrupt': 'interrupt_agent',
          } as Record<string, string>
        )[fact.definitionId] ?? fact.definitionId)
      : undefined,
    title: known ? label![1] : `${fact.definitionId} · ${fact.definitionVersion}`,
    ...(known && exploration.has(fact.definitionId)
      ? { presentation: 'exploration' as const }
      : {}),
  };
}

/** A readable boundary, rather than the first arriving receipt, owns an exploration block. */
export function groupNativeToolMessages(messages: readonly DesktopMessage[]): DesktopMessage[] {
  let boundary: string | undefined;
  return messages.map((message) => {
    if (message.role === 'tool' && message.presentation === 'exploration' && message.turnId)
      return {
        ...message,
        presentationGroupId: JSON.stringify(['native-exploration', message.turnId, boundary]),
      };
    if (
      message.role !== 'thinking' &&
      message.systemKind !== 'turn_timing' &&
      message.systemKind !== 'turn_terminal' &&
      message.presentation !== 'hidden' &&
      !(message.role === 'assistant' && message.settled && !message.text)
    )
      boundary = message.id;
    return message;
  });
}
const sameReceipt = (left: Message, right: Message) =>
  left.sessionId === right.sessionId &&
  left.seq === right.seq &&
  left.content === right.content &&
  left.runId === right.runId &&
  left.status === right.status &&
  left.contentFormat === right.contentFormat &&
  left.toolCallId === right.toolCallId &&
  left.sourceIds?.[0] === right.sourceIds?.[0] &&
  left.sourceIds?.length === right.sourceIds?.length &&
  JSON.stringify(left.originMessage) === JSON.stringify(right.originMessage);
export function authorizationApproval(
  authorization: Execution['authorization'],
): DesktopMessage['approval'] {
  const human = authorization?.human;
  if (human) {
    const state =
      human.state === 'cancelled'
        ? 'cancelled'
        : human.state === 'pending'
          ? 'awaiting_user'
          : human.decision === 'deny'
            ? 'rejected'
            : human.decision === 'approve'
              ? human.accepted && human.acceptedDecisionRevision === human.revision
                ? 'approved'
                : 'submitted'
              : undefined;
    if (state)
      return {
        source: 'user',
        state,
        interactionId: human.interactionId,
        grant: human.grant,
        ...(state === 'awaiting_user' && authorization?.review?.reason
          ? { reason: authorization.review.reason }
          : {}),
      };
  }
  const review = authorization?.review;
  if (!review) return;
  return {
    source: 'auto',
    state: ['planned', 'dispatching', 'running'].includes(review.status)
      ? 'reviewing'
      : review.status === 'cancelled' && !authorization?.dispatched
        ? 'cancelled'
        : review.decision === 'approve_once'
          ? 'approved'
          : review.decision === 'reject'
            ? 'rejected'
            : 'unavailable',
    reason: review.reason,
  };
}

export function desktopToolMessage(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion' | 'status' | 'target'> &
    Pick<Partial<NativeToolMessageFact>, 'ask' | 'authorization' | 'decisionRefresh'>,
  id: string,
  text: string,
): DesktopMessage {
  return {
    id,
    role: 'tool',
    text,
    settled: !['planned', 'dispatching', 'running'].includes(fact.status),
    ...desktopToolPresentation(fact),
    target: fact.target,
    ...(fact.ask ? { ask: fact.ask } : {}),
    ...(fact.status === 'failed' && fact.decisionRefresh
      ? { decisionRefresh: fact.decisionRefresh }
      : {}),
    ...(fact.authorization
      ? {
          approval: authorizationApproval(fact.authorization),
          dispatchCommitted: fact.authorization.dispatched,
        }
      : {}),
    status:
      fact.status === 'failed' && fact.decisionRefresh
        ? 'not_executed'
        : fact.status === 'succeeded'
          ? 'completed'
          : fact.status === 'outcome_unknown'
            ? 'unknown'
            : fact.status === 'planned'
              ? 'queued'
              : fact.status === 'dispatching'
                ? 'running'
                : fact.status,
  };
}
export function NativeToolMessage({ message }: { message: DesktopMessage }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolActivity
      messages={[message]}
      expanded={expanded}
      onToggle={setExpanded}
      renderChildren={() => null}
    />
  );
}
export function liveToolMessages(
  selection:
    | {
        storeId: string;
        session: { id: string };
        runs: readonly NativeRunFact[];
        executions: readonly NativeToolExecution[];
        interactions?: NativeSelection['interactions'];
      }
    | undefined,
  messages: readonly Message[],
  executionUnconfirmed = false,
): { message: DesktopMessage; execution: NativeToolExecution }[] {
  if (!selection) return [];
  const runIds = new Set(selection.runs.filter((run) => run.isActive).map((run) => run.id));
  const results = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'tool' &&
          message.status === 'complete' &&
          message.sessionId === selection.session.id &&
          message.sourceIds?.length === 1 &&
          (!message.originMessage || message.originMessage.storeId === selection.storeId),
      )
      .map((message) =>
        JSON.stringify([
          message.sourceIds![0],
          message.originMessage ? message.originMessage.runId : message.runId,
        ]),
      ),
  );
  return selection.executions
    .filter(
      (execution) =>
        execution.kind === 'tool' &&
        execution.originStoreId === selection.storeId &&
        execution.sessionId === selection.session.id &&
        !!execution.runId &&
        runIds.has(execution.runId) &&
        !results.has(JSON.stringify([execution.id, execution.runId])),
    )
    .map((execution) => {
      const run = selection.runs.find(
        (run) =>
          run.id === execution.runId &&
          run.isActive &&
          run.originStoreId === selection.storeId &&
          run.sessionId === selection.session.id,
      );
      const approvals =
        selection.interactions?.filter(
          (card) =>
            card.kind === 'approval' &&
            card.state === 'pending' &&
            card.originStoreId === selection.storeId &&
            card.sessionId === execution.sessionId &&
            card.runId === execution.runId &&
            card.executionId === execution.id &&
            card.definitionId === execution.definitionId &&
            card.definitionVersion === execution.definitionVersion,
        ) ?? [];
      return {
        execution,
        message: {
          ...desktopToolMessage(execution, `native-execution:${execution.id}`, ''),
          executionUnconfirmed,
          ...(run
            ? {
                turnId: JSON.stringify([
                  'native-run',
                  selection.storeId,
                  selection.session.id,
                  run.id,
                ]),
              }
            : {}),
          ...(approvals.length === 1
            ? {
                approval: {
                  state: 'awaiting_user' as const,
                  source: 'user' as const,
                  interactionId: approvals[0]!.id,
                  reason: execution.authorization?.review?.reason ?? undefined,
                },
              }
            : {}),
        },
      };
    });
}
export function NativeLiveToolMessage({
  message,
  execution,
  unavailable,
}: {
  message: DesktopMessage;
  execution: NativeToolExecution;
  unavailable: boolean;
}) {
  return (
    <>
      <ToolRow message={message} />
      {unavailable ? (
        <p role="status">上次确认状态</p>
      ) : execution.cancelRequestedAt !== null ? (
        <p role="status">已请求停止，等待执行结果。</p>
      ) : null}
    </>
  );
}

/** Exact history metadata, including receipts beyond the bounded current View. */
export function useNativeToolMessages({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  observationRevision,
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  observationRevision: number;
  suspended?: boolean;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId;
  const viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([generation, storeId, sessionId, viewSelection, historyEpoch]);
  const unavailable =
    suspended || !selection || selection.viewLoading || selection.permissionUnavailable;
  const eligible = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role === 'tool' &&
          message.status === 'complete' &&
          message.sourceIds?.length === 1 &&
          message.contentFormat !== 'unsupported',
      ),
    [messages],
  );
  const [retryRevision, setRetryRevision] = useState(0);
  const cache = useRef({
    scope,
    retryRevision,
    read: new Map<
      string,
      { message: Message; fact?: NativeToolMessageFact; observationRevision: number }
    >(),
  });
  const [state, setState] = useState<{
    scope: string;
    entries: NativeToolMessageFact[];
    error?: string;
  }>({ scope, entries: [] });
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
      cache.current = { scope, retryRevision, read: new Map() };
    const current = cache.current;
    let active = true,
      readId: string | undefined;
    const publish = (error?: string) =>
      setState({
        scope,
        entries: [...current.read.values()].flatMap((item) => (item.fact ? [item.fact] : [])),
        error,
      });
    if (
      !bridge ||
      !storeId ||
      !sessionId ||
      !workspaceId ||
      viewSelection === undefined ||
      unavailable
    )
      return;
    // A terminal receipt is immutable. An unknown result is rechecked on a new observation.
    const pending = eligible.filter((message) => {
      const previous = current.read.get(message.id);
      return (
        !previous ||
        (previous.fact?.status === 'outcome_unknown' &&
          previous.observationRevision !== observationRevision) ||
        !sameReceipt(previous.message, message)
      );
    });
    // Mark the new read as pending now; retaining the last error would report
    // loading=false and let background recovery restart this in-flight request.
    publish();
    void (async () => {
      for (let index = 0; index < pending.length; index += 32) {
        const batch = pending.slice(index, index + 32);
        readId = crypto.randomUUID();
        const page = await bridge.request({
          method: 'toolMessages.list',
          generation,
          viewSelection,
          historyEpoch,
          readId,
          messageIds: batch.map((message) => message.id),
        });
        if (!active) return;
        if (
          !page ||
          !('entries' in page) ||
          !('kind' in page) ||
          page.kind !== 'toolMessages.page' ||
          page.readId !== readId ||
          page.scope.generation !== generation ||
          page.scope.storeId !== storeId ||
          page.scope.sessionId !== sessionId ||
          page.scope.workspaceId !== workspaceId ||
          page.scope.viewSelection !== viewSelection ||
          page.scope.historyEpoch !== historyEpoch ||
          page.entries.some(
            (entry) =>
              !batch.some(
                (message) =>
                  message.id === entry.messageId && message.sourceIds?.[0] === entry.executionId,
              ),
          )
        )
          throw Error('tool_message_identity_mismatch');
        for (const message of batch)
          current.read.set(message.id, {
            message,
            fact: page.entries.find((entry) => entry.messageId === message.id),
            observationRevision,
          });
        publish();
      }
    })().catch(() => {
      if (active) publish('部分工具状态尚无法核实，保留原始结果。');
    });
    return () => {
      active = false;
      if (readId)
        void bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    scope,
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    historyEpoch,
    retryRevision,
    unavailable,
    observationRevision,
    eligible,
  ]);
  const error = state.scope === scope ? state.error : undefined;
  return {
    entries: useMemo(() => {
      if (state.scope !== scope) return [];
      const messagesById = new Map(messages.map((message) => [message.id, message]));
      return state.entries.filter((fact) => {
        const original = cache.current.read.get(fact.messageId)?.message;
        const current = messagesById.get(fact.messageId);
        return original && current && sameReceipt(original, current);
      });
    }, [state, scope, messages]),
    loading:
      !error &&
      eligible.some((message) => {
        if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
          return true;
        const previous = cache.current.read.get(message.id);
        return !previous || !sameReceipt(previous.message, message);
      }),
    error,
    retry: () => setRetryRevision((value) => value + 1),
  };
}
