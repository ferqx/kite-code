import type { Message } from '@kite-ai/client';
import { completeRunReplies } from '@kite-ai/ui';
import type { Message as DesktopMessage, TurnActivity } from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { desktopMessages } from './native-presentation';
import { desktopToolMessage, desktopToolPresentation } from './native-tool-messages';
import {
  type NativeRunFact,
  type NativeToolExecution,
  type NativeToolMessageFact,
  nativeRunFact,
  presentableRun,
} from './tool-messages-bridge';

export function nativeInputTurnId(
  commandId: string,
  scope: { storeId: string; sessionId: string; targetRunId?: string },
  selection: NativeSelection | undefined,
) {
  if (selection?.storeId !== scope.storeId || selection.session.id !== scope.sessionId)
    return undefined;
  const run = selection.runs.find(
    (run) =>
      run.originStoreId === scope.storeId &&
      run.sessionId === scope.sessionId &&
      (run.originCommandId === commandId || run.id === scope.targetRunId),
  );
  return run ? JSON.stringify(['native-run', scope.storeId, scope.sessionId, run.id]) : undefined;
}

/** Preserve the submitted intent until its exact persisted Message takes over. */
export function nativePendingInputMessage(
  id: string,
  input: { storeId: string; sessionId: string; targetRunId?: string; kind: string; text: string },
  phase: 'sending' | 'accepted' | 'failed' | 'unknown',
  selection: NativeSelection | undefined,
): DesktopMessage {
  const turnId = nativeInputTurnId(id, input, selection);
  return {
    id,
    ...(turnId ? { turnId } : {}),
    ...(turnId && input.kind === 'input.steer' && phase !== 'failed' && phase !== 'unknown'
      ? { inputKind: 'input.steer' as const }
      : {}),
    role: 'user',
    text: input.text,
    settled: phase === 'accepted',
    copyText: null,
    delivery: phase === 'accepted' ? undefined : phase,
  };
}

/** Read admitted Run facts without replacing a sealed Fork/Include boundary with later source state. */
export function useNativeRuns({
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
    workspaceId = selection?.session.workspaceId,
    viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([generation, storeId, sessionId, viewSelection, historyEpoch]);
  const presentationIdentity = JSON.stringify([
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
  ]);
  const available =
    !suspended && !!selection && !selection.viewLoading && !selection.permissionUnavailable;
  const representatives = useMemo(() => {
    const entries = new Map<string, string>();
    for (const message of messages)
      if (!message.originMessage && message.sessionId === sessionId && message.runId)
        entries.set(message.runId, message.id);
    return entries;
  }, [messages, sessionId]);
  const ids = useMemo(() => JSON.stringify([...representatives]), [representatives]);
  const view = useMemo(
    () =>
      JSON.stringify(
        selection?.runs
          .filter((run) => storeId && sessionId && presentableRun(run, storeId, sessionId))
          .map(nativeRunFact) ?? [],
      ),
    [selection?.runs, storeId, sessionId],
  );
  const [retryRevision, setRetryRevision] = useState(0);
  const cache = useRef({
    scope,
    presentationIdentity,
    bridge,
    retryRevision,
    read: new Map<string, { run?: NativeRunFact; revision: number }>(),
  });
  const [state, setState] = useState<{
    scope: string;
    presentationIdentity: string;
    bridge?: NativeBridge;
    terminal: NativeRunFact[];
    runs: NativeRunFact[];
    error?: string;
  }>({
    scope,
    presentationIdentity,
    bridge,
    terminal: [],
    runs: [],
  });
  useEffect(() => {
    if (
      cache.current.scope !== scope ||
      cache.current.presentationIdentity !== presentationIdentity ||
      cache.current.bridge !== bridge ||
      cache.current.retryRevision !== retryRevision
    )
      cache.current = { scope, presentationIdentity, bridge, retryRevision, read: new Map() };
    if (
      !bridge ||
      !storeId ||
      !sessionId ||
      !workspaceId ||
      viewSelection === undefined ||
      !available
    )
      return;
    const current = cache.current,
      observed = new Map((JSON.parse(view) as NativeRunFact[]).map((run) => [run.id, run]));
    // A verified View supersedes this scope's older metadata even after leaving its bounded page.
    for (const [id, run] of observed) current.read.set(id, { run, revision: observationRevision });
    const publish = (error?: string) =>
      setState((previous) => {
        const terminal = new Map(
          (previous.presentationIdentity === presentationIdentity && previous.bridge === bridge
            ? previous.terminal
            : []
          ).map((run) => [run.id, run]),
        );
        // Keep display only, never seed the fresh read cache or its request eligibility.
        for (const [id, run] of [
          ...[...current.read].map(([id, entry]) => [id, entry.run] as const),
          ...observed,
        ]) {
          terminal.delete(id);
          if (run && !run.isActive && ['completed', 'failed', 'cancelled'].includes(run.status))
            terminal.set(id, run);
        }
        return {
          scope,
          presentationIdentity,
          bridge,
          terminal: [...terminal.values()],
          runs: [...current.read.values()].flatMap((entry) => (entry.run ? [entry.run] : [])),
          error,
        };
      });
    publish();
    const pending = (JSON.parse(ids) as [string, string][]).filter(([id]) => {
      const previous = current.read.get(id);
      return (
        !observed.has(id) &&
        (!previous ||
          ((previous.run?.isActive || previous.run?.status === 'interrupted' || !previous.run) &&
            previous.revision !== observationRevision))
      );
    });
    let active = true,
      readId: string | undefined;
    void (async () => {
      for (let index = 0; index < pending.length; index += 32) {
        const batch = pending.slice(index, index + 32);
        readId = crypto.randomUUID();
        const page = await bridge.request({
          method: 'toolMessages.runs',
          generation,
          viewSelection,
          historyEpoch,
          readId,
          messageIds: batch.map(([, id]) => id),
        });
        if (!active) return;
        if (
          !page ||
          !('runs' in page) ||
          !('kind' in page) ||
          page.kind !== 'toolMessages.runs' ||
          page.readId !== readId ||
          page.scope.generation !== generation ||
          page.scope.storeId !== storeId ||
          page.scope.sessionId !== sessionId ||
          page.scope.workspaceId !== workspaceId ||
          page.scope.viewSelection !== viewSelection ||
          page.scope.historyEpoch !== historyEpoch ||
          page.runs.some(
            (run) =>
              !presentableRun(run, storeId, sessionId) || !batch.some(([id]) => id === run.id),
          ) ||
          new Set(page.runs.map((run) => run.id)).size !== page.runs.length
        )
          throw Error('run_message_identity_mismatch');
        for (const [id] of batch)
          current.read.set(id, {
            run: page.runs.find((run) => run.id === id),
            revision: observationRevision,
          });
        publish();
      }
    })().catch(() => {
      if (active) publish('无法核对本轮状态，已保留原消息。');
    });
    return () => {
      active = false;
      if (readId)
        void bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    historyEpoch,
    scope,
    presentationIdentity,
    available,
    ids,
    view,
    observationRevision,
    retryRevision,
  ]);
  const runs = useMemo(() => {
    const values = new Map(
      (state.presentationIdentity === presentationIdentity && state.bridge === bridge
        ? state.terminal.filter((run) => representatives.has(run.id))
        : []
      ).map((run) => [run.id, run]),
    );
    if (
      state.scope === scope &&
      state.presentationIdentity === presentationIdentity &&
      state.bridge === bridge
    )
      for (const run of state.runs) values.set(run.id, run);
    // The newer verified View wins over an older metadata response, including explicit recovery.
    for (const run of JSON.parse(view) as NativeRunFact[]) values.set(run.id, run);
    return [...values.values()];
  }, [state, scope, presentationIdentity, bridge, representatives, view]);
  const error =
    state.scope === scope &&
    state.presentationIdentity === presentationIdentity &&
    state.bridge === bridge
      ? state.error
      : undefined;
  return {
    runs,
    loading:
      !error &&
      [...representatives.keys()].some(
        (id) =>
          !runs.some((run) => run.id === id) &&
          (cache.current.scope !== scope ||
            cache.current.retryRevision !== retryRevision ||
            !cache.current.read.has(id)),
      ),
    error,
    retry: () => setRetryRevision((value) => value + 1),
  };
}

export function nativeReplyKey(scope: string, message: Message) {
  return JSON.stringify([
    scope,
    message.id,
    message.sessionId,
    message.runId,
    message.seq,
    message.status,
    message.contentFormat,
    message.originMessage,
    message.outputBody,
    message.content,
  ]);
}

/** Original Conversation presentation from exact public Run ownership and confirmed tool receipts. */
export function desktopTranscript({
  messages: history,
  runs,
  tools,
  executions = [],
  storeId,
  sessionId,
  fullReply,
  compressionProgress,
  compressionMessages = [],
}: {
  messages: readonly Message[];
  runs: readonly NativeRunFact[];
  tools: readonly NativeToolMessageFact[];
  executions?: readonly NativeToolExecution[];
  storeId: string;
  sessionId: string;
  fullReply?: (message: Message) => string | undefined;
  compressionProgress?: NativeSelection['compressionProgress'];
  compressionMessages?: NativeSelection['compressionMessages'];
}): { messages: DesktopMessage[]; turnActivity?: TurnActivity } {
  const observed = new Map(
    runs.filter((run) => presentableRun(run, storeId, sessionId)).map((run) => [run.id, run]),
  );
  const identity = (runId: string) => JSON.stringify(['native-run', storeId, sessionId, runId]);
  const compressionIdentity = (runId: string, executionId: string) =>
    JSON.stringify(['native-compression', storeId, sessionId, runId, executionId]);
  // The View and complete history have independent readers. Only same-scope
  // compression metadata may fill that handoff; the bounded View never replaces
  // history or supplies summary bytes. A confirmed history terminal wins.
  const merged = new Map(history.map((message) => [message.id, message]));
  const additions = new Set<string>();
  for (const fact of compressionMessages) {
    if (
      !fact.compression ||
      fact.originMessage ||
      fact.sessionId !== sessionId ||
      !fact.runId ||
      !observed.has(fact.runId)
    )
      continue;
    const previous = merged.get(fact.id);
    if (!previous) {
      merged.set(fact.id, { ...fact, content: '' });
      additions.add(fact.id);
    } else if (
      previous.compression?.id === fact.compression.id &&
      previous.sessionId === fact.sessionId &&
      previous.runId === fact.runId &&
      previous.sourceIds?.length === 1 &&
      fact.sourceIds?.length === 1 &&
      previous.sourceIds[0] === fact.sourceIds[0] &&
      !['completed', 'failed', 'cancelled'].includes(previous.compression.status)
    )
      merged.set(fact.id, { ...previous, compression: fact.compression });
  }
  // History already places verified input replacements at their original display
  // position. Its immutable physical sequences may therefore be out of order.
  const messages = [...merged.values()].filter((message) => !additions.has(message.id));
  const added = [...additions]
    .map((id) => merged.get(id)!)
    .sort((left, right) => {
      const a = BigInt(left.seq),
        b = BigInt(right.seq);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  for (const fact of added) {
    const index = messages.findIndex((message) => BigInt(message.seq) > BigInt(fact.seq));
    messages.splice(index === -1 ? messages.length : index, 0, fact);
  }
  const replies = completeRunReplies({
    messages,
    runs: [...observed.values()],
    sessionId,
    fullContent: fullReply,
    copyScope: 'final',
  });
  const modeled = desktopMessages(messages, true).map((model, index) => {
    const message = messages[index]!,
      run =
        !message.originMessage && message.sessionId === sessionId && message.runId
          ? observed.get(message.runId)
          : undefined;
    const fact = tools.find(
      (entry) =>
        entry.messageId === message.id &&
        message.sourceIds?.length === 1 &&
        entry.executionId === message.sourceIds[0],
    );
    // The current View can establish a tool's display classification before
    // the receipt metadata GET returns. It does not establish its result.
    const execution =
      !fact && run && message.role === 'tool' && message.sourceIds?.length === 1
        ? executions.find(
            (entry) =>
              entry.id === message.sourceIds![0] &&
              entry.kind === 'tool' &&
              entry.originStoreId === storeId &&
              entry.sessionId === sessionId &&
              entry.runId === run.id,
          )
        : undefined;
    const result: DesktopMessage = {
      ...(fact ? desktopToolMessage(fact, message.id, message.content) : model),
      ...(execution ? desktopToolPresentation(execution) : {}),
      ...(run && !model.agentResult ? { turnId: identity(run.id) } : {}),
      ...(run && message.compression && message.sourceIds?.length === 1
        ? { presentationKey: compressionIdentity(run.id, message.sourceIds[0]!) }
        : {}),
      ...(run &&
      run.originStoreId === storeId &&
      message.role === 'user' &&
      message.inputKind === 'input.steer'
        ? { inputKind: 'input.steer' as const }
        : {}),
      ...(!model.agentResult && !model.agentMessage && replies.has(message.id)
        ? {
            finalReply: true,
            copyText: replies.get(message.id)?.text ?? null,
          }
        : {}),
    };
    if (run && result.presentation === 'exploration')
      return {
        ...result,
        presentation: 'exploration' as const,
        presentationGroupId: identity(run.id),
      };
    return result;
  });
  const compressing = compressionProgress && observed.get(compressionProgress.runId);
  const progressMessage =
    compressionProgress?.executionId &&
    messages.find(
      (message) =>
        message.runId === compressionProgress.runId &&
        !message.originMessage &&
        message.compression &&
        message.sourceIds?.length === 1 &&
        message.sourceIds[0] === compressionProgress.executionId,
    );
  if (compressing?.isActive && compressing.originStoreId === compressionProgress?.originStoreId) {
    if (progressMessage) {
      // A published or failed SQL fact wins over an older hot phase observation.
      if (['running', 'unpublished'].includes(progressMessage.compression!.status)) {
        const index = messages.indexOf(progressMessage);
        modeled[index] = {
          ...modeled[index]!,
          title: '正在压缩上下文',
          status: 'running',
          settled: false,
        };
      }
    } else
      modeled.push({
        id: `native-compression:${identity(compressing.id)}`,
        presentationKey: compressionProgress.executionId
          ? compressionIdentity(compressing.id, compressionProgress.executionId)
          : undefined,
        turnId: identity(compressing.id),
        role: 'system',
        systemKind: 'compaction',
        title: '正在压缩上下文',
        text: '',
        status: 'running',
        settled: false,
      });
  }
  for (const run of observed.values()) {
    const turnId = identity(run.id);
    modeled.push({
      id: `native-run-timing:${turnId}`,
      turnId,
      role: 'system',
      systemKind: 'turn_timing',
      text: '',
      settled: !run.isActive,
      turnStartedAtMs: run.createdAt,
      ...(run.finishedAt !== null ? { turnFinishedAtMs: run.finishedAt } : {}),
    });
    if (!run.isActive && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))
      modeled.push({
        id: `native-run-terminal:${turnId}`,
        turnId,
        role: 'system',
        systemKind: 'turn_terminal',
        text: '',
        settled: true,
        turnTerminalStatus:
          run.status === 'interrupted'
            ? 'aborted'
            : (run.status as 'completed' | 'failed' | 'cancelled'),
      });
    if (!run.isActive && run.status === 'failed') {
      let last = -1;
      for (let index = 0; index < modeled.length; index++) {
        const message = modeled[index]!;
        if (
          message.turnId === turnId &&
          message.systemKind !== 'turn_timing' &&
          message.systemKind !== 'turn_terminal'
        )
          last = index;
      }
      modeled.splice(last < 0 ? modeled.length : last + 1, 0, {
        id: `failure:${turnId}`,
        turnId,
        role: 'system',
        systemKind: 'turn_failure',
        text:
          run.reason === 'context_source_unavailable'
            ? '无法读取工作区的项目说明。请检查工作区路径及 AGENTS.md、CLAUDE.md 的访问权限后重试。'
            : '本轮执行未完成。原消息已保留，请核对任务状态后重新发送。',
        settled: true,
        status: 'failed',
        failure: {
          summary:
            run.reason === 'context_source_unavailable' ? '工作区上下文读取失败' : '本轮回复未完成',
          ...(run.reason ? { reasonCode: run.reason } : {}),
        },
      });
    }
  }
  const active = [...observed.values()].find((run) => run.isActive);
  return {
    // An old SQL running record cannot establish current execution. Only the
    // matching hot observation above may make that attempt a visible live row.
    messages: modeled.filter(
      (model) =>
        !(
          model.systemKind === 'compaction' &&
          model.status === 'unknown' &&
          merged.get(model.id)?.compression?.status === 'running'
        ),
    ),
    ...(active
      ? {
          turnActivity: {
            turnId: identity(active.id),
            status:
              active.status === 'cancelling'
                ? ('cancelling' as const)
                : active.status.startsWith('waiting_')
                  ? ('waiting' as const)
                  : ('running' as const),
          },
        }
      : {}),
  };
}
