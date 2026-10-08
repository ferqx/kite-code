import type { Execution, Message } from '@kite-ai/client';
import { type Message as DesktopMessage, ToolActivity, ToolRow } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import type { NativeToolMessageFact } from './tool-messages-bridge';

const labels: Record<string, readonly [readonly string[], string]> = {
  'files.read': [['2', '3'], '读取'],
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
};
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
export function desktopToolMessage(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion' | 'status' | 'target'> &
    Pick<Partial<NativeToolMessageFact>, 'ask'>,
  id: string,
  text: string,
): DesktopMessage {
  const label = labels[fact.definitionId];
  const known = label?.[0].includes(fact.definitionVersion);
  return {
    id,
    role: 'tool',
    text,
    settled: !['planned', 'dispatching', 'running'].includes(fact.status),
    toolName: known
      ? ((
          {
            'files.read': 'read_file',
            'files.write': 'write_file',
            'files.edit': 'edit_file',
          } as Record<string, string>
        )[fact.definitionId] ?? fact.definitionId)
      : undefined,
    title: known ? label![1] : `${fact.definitionId} · ${fact.definitionVersion}`,
    target: fact.target,
    ...(fact.ask ? { ask: fact.ask } : {}),
    status:
      fact.status === 'succeeded'
        ? 'completed'
        : fact.status === 'outcome_unknown'
          ? 'unknown'
          : fact.status === 'planned' || fact.status === 'dispatching'
            ? 'queued'
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
  selection: NativeSelection | undefined,
  messages: readonly Message[],
): { message: DesktopMessage; execution: Execution }[] {
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
        ['planned', 'dispatching', 'running'].includes(execution.status) &&
        !results.has(JSON.stringify([execution.id, execution.runId])),
    )
    .map((execution) => ({
      execution,
      message: desktopToolMessage(execution, `native-execution:${execution.id}`, ''),
    }));
}
export function NativeLiveToolMessage({
  message,
  execution,
  unavailable,
}: {
  message: DesktopMessage;
  execution: Execution;
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
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  observationRevision: number;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId;
  const viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([generation, storeId, sessionId, viewSelection, historyEpoch]);
  const unavailable = !selection || selection.viewLoading || selection.permissionUnavailable;
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
    const eligible = messages.filter(
      (message) =>
        message.role === 'tool' &&
        message.status === 'complete' &&
        message.sourceIds?.length === 1 &&
        message.contentFormat !== 'unsupported',
    );
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
    messages,
    retryRevision,
    unavailable,
    observationRevision,
  ]);
  return {
    entries:
      state.scope === scope
        ? state.entries.filter((fact) => {
            const original = cache.current.read.get(fact.messageId)?.message;
            const current = messages.find((message) => message.id === fact.messageId);
            return original && current && sameReceipt(original, current);
          })
        : [],
    error: state.scope === scope ? state.error : undefined,
    retry: () => setRetryRevision((value) => value + 1),
  };
}
