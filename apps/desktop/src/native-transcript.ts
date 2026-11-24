import type { Message } from '@kite-ai/client';
import { completeRunReplies } from '@kite-ai/ui';
import type { Message as DesktopMessage, TurnActivity } from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeResult, NativeSelection } from './native-bridge';
import { nativeImageFailure } from './native-image-failure';
import { nativeModelConnections } from './native-model-connections';
import {
  COMPRESSION_RUNNING_TITLE,
  desktopMessages,
  nativeReasoningSource,
} from './native-presentation';
import { nativeReadDeadline } from './native-read-deadline';
import {
  desktopToolMessage,
  desktopToolPresentation,
  nativeShellInputPresentation,
  nativeToolPresentationKey,
  PLAN_PROGRESS_TOOL,
} from './native-tool-messages';
import {
  type NativeRunFact,
  type NativeToolExecution,
  type NativeToolMessageFact,
  nativeRunFact,
  nativeShellJobSettlement,
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
  executionRuns,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  observationRevision: number;
  suspended?: boolean;
  /** Independently observed bounded execution facts; never enables the body reader. */
  executionRuns?: NativeSelection['runs'];
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
        (executionRuns ?? selection?.runs ?? [])
          .filter((run) => storeId && sessionId && presentableRun(run, storeId, sessionId))
          .map(nativeRunFact) ?? [],
      ),
    [executionRuns, selection?.runs, storeId, sessionId],
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
        const page: NativeResult = await nativeReadDeadline(
          bridge.request({
            method: 'toolMessages.runs',
            generation,
            viewSelection,
            historyEpoch,
            readId,
            messageIds: batch.map(([, id]) => id),
          }),
        );
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

function indexEntry<T>(groups: Map<string, T[]>, key: string, value: T) {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

/** Original Conversation presentation from exact public Run ownership and confirmed tool receipts. */
function nativeRunFailure(reason: string | null, interrupted: boolean) {
  switch (reason) {
    case 'context_source_unavailable':
      return {
        summary: '工作区上下文读取失败',
        text: '无法读取工作区的项目说明。请检查工作区路径及 AGENTS.md、CLAUDE.md 的访问权限后重试。',
      };
    case 'necessary_condition_unsatisfied':
      return {
        summary: '本轮完成条件未满足',
        text: '本轮尚未满足必要完成条件，无法确认为完成。已保存的回复和工具执行结果保留；请先核对尚未完成的要求与实际结果，再决定如何继续。',
      };
    case 'service_shutdown':
      return {
        summary: 'Kite 服务已退出',
        text: 'Kite 服务退出时停止了本轮执行。请先核对已保存的回复和工具执行结果，再决定是否重新发送。',
      };
    case 'model_authentication_failed':
      return {
        summary: '模型服务认证失败',
        text: '模型服务拒绝了当前连接的凭据。请检查或更新模型连接的凭据后重新发送。已保存的工具执行结果仍可核对。',
      };
    case 'model_permission_denied':
      return {
        summary: '模型服务拒绝访问',
        text: '当前模型连接没有这次请求所需的权限。请检查该连接对所选模型的访问权限，再决定是否重新发送。',
      };
    default:
      return interrupted
        ? {
            summary: '本轮执行已中断',
            text: '本轮执行已中断，未生成最终回复。请先核对本轮工具执行结果，再决定是否重新发送。',
          }
        : {
            summary: '本轮异常结束',
            text: '本轮未能生成最终回复，当前记录未提供可核实的错误原因。请检查模型连接和配置；重新发送前，先核对本轮工具执行结果，避免重复操作。',
          };
  }
}

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
  traceTurns = false,
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
  traceTurns?: boolean;
}): { messages: DesktopMessage[]; turnActivity?: TurnActivity } {
  const observed = new Map(
    runs.filter((run) => presentableRun(run, storeId, sessionId)).map((run) => [run.id, run]),
  );
  const runsByCommand = new Map<string, string | null>();
  for (const run of observed.values()) {
    if (run.originStoreId !== storeId || !run.originCommandId) continue;
    runsByCommand.set(run.originCommandId, runsByCommand.has(run.originCommandId) ? null : run.id);
  }
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
  const toolsByMessage = new Map<string, NativeToolMessageFact[]>();
  const progressMessages = new Set<string>();
  for (const fact of tools) indexEntry(toolsByMessage, fact.messageId, fact);
  const executionsById = new Map<string, NativeToolExecution[]>();
  for (const execution of executions) indexEntry(executionsById, execution.id, execution);
  const callsById = new Map<
    string,
    {
      call: NonNullable<Message['toolCalls']>[number];
      message: Message;
    }[]
  >();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.sessionId !== sessionId) continue;
    for (const call of message.toolCalls ?? []) {
      const key = JSON.stringify([message.runId, call.id]);
      indexEntry(callsById, key, { call, message });
    }
  }
  const modeled = desktopMessages(messages, true).map((model, index) => {
    const message = messages[index]!,
      run =
        !message.originMessage && message.sessionId === sessionId && message.runId
          ? observed.get(message.runId)
          : undefined;
    // A local submission and its saved user record keep one DOM identity.
    // Never correlate equal text or borrow an ancestor's input identity.
    const inputCommandId =
      message.role === 'user' && !message.originMessage && message.sessionId === sessionId
        ? (message.humanInput?.publicCommandId ?? message.originCommandId)
        : undefined;
    const fact = toolsByMessage
      .get(message.id)
      ?.find(
        (entry) => message.sourceIds?.length === 1 && entry.executionId === message.sourceIds[0],
      );
    // The current View can establish a tool's display classification before
    // the receipt metadata GET returns. It does not establish its result.
    const execution =
      !fact && run && message.role === 'tool' && message.sourceIds?.length === 1
        ? executionsById
            .get(message.sourceIds[0]!)
            ?.find(
              (entry) =>
                entry.kind === 'tool' &&
                entry.originStoreId === storeId &&
                entry.sessionId === sessionId &&
                entry.runId === run.id,
            )
        : undefined;
    if (message.role === 'tool' && (fact ?? execution)?.definitionId === PLAN_PROGRESS_TOOL)
      progressMessages.add(message.id);
    const liveInput =
      run && message.role === 'tool' && message.sourceIds?.length === 1
        ? toolsByMessage
            .get(`native-execution:${message.sourceIds[0]}`)
            ?.find(
              (entry) =>
                entry.executionId === message.sourceIds![0] &&
                entry.inputSource?.storeId === storeId &&
                entry.inputSource.sessionId === sessionId &&
                entry.inputSource.runId === run.id &&
                entry.inputSource.toolCallId === message.toolCallId &&
                (!execution ||
                  (execution.definitionId === entry.definitionId &&
                    execution.definitionVersion === entry.definitionVersion)) &&
                (!fact ||
                  (fact.definitionId === entry.definitionId &&
                    fact.definitionVersion === entry.definitionVersion)),
            )
        : undefined;
    const originalCalls =
      liveInput ||
      (!fact &&
        !execution &&
        message.role === 'tool' &&
        message.sessionId === sessionId &&
        message.sourceIds?.length === 1)
        ? (callsById
            .get(JSON.stringify([message.runId, message.toolCallId]))
            ?.filter(
              ({ message: source }) =>
                source.originMessage?.storeId === message.originMessage?.storeId &&
                source.originMessage?.sessionId === message.originMessage?.sessionId &&
                source.originMessage?.runId === message.originMessage?.runId &&
                BigInt(source.seq) < BigInt(message.seq),
            ) ?? [])
        : [];
    const originalCall = originalCalls.length === 1 ? originalCalls[0] : undefined;
    const planReadCall =
      !fact &&
      !execution &&
      originalCall?.call.name === 'planning.read' &&
      originalCall.message.status === 'complete' &&
      originalCall.message.contentFormat !== 'unsupported';
    const displayTool =
      execution ??
      (planReadCall ? { definitionId: 'planning.read', definitionVersion: '1' } : undefined);
    let inputCompatible = originalCalls.length === 0;
    const inputPresentation = liveInput ? nativeShellInputPresentation(liveInput) : undefined;
    if (
      originalCalls.length === 1 &&
      originalCalls[0]!.message.status === 'complete' &&
      originalCalls[0]!.message.contentFormat !== 'unsupported' &&
      originalCalls[0]!.call.name === liveInput?.definitionId
    ) {
      try {
        const args = JSON.parse(originalCalls[0]!.call.arguments);
        const input = liveInput!.shellInput;
        inputCompatible =
          input?.command !== undefined
            ? args.command === input.command && args.key === input.shellId
            : args.shellId === input?.shellId;
      } catch {
        /* Preserve the original unverified record on a conflicting call. */
      }
    }
    const factMessage = fact
      ? desktopToolMessage(
          fact,
          message.id,
          fact.shellInput && message.deferredText ? '' : message.content,
        )
      : undefined;
    const shell = factMessage?.shell;
    const jobSettlement =
      shell?.jobExecutionId && fact && run && !message.originMessage
        ? executionsById
            .get(shell.jobExecutionId)
            ?.map((job) =>
              nativeShellJobSettlement(job, {
                executionId: fact.executionId,
                originStoreId: run.originStoreId,
                sessionId,
                runId: run.id,
                jobExecutionId: shell.jobExecutionId!,
              }),
            )
            .find(Boolean)
        : undefined;
    const result: DesktopMessage = {
      ...(factMessage ?? model),
      ...(displayTool
        ? desktopToolPresentation({
            ...displayTool,
            ...(liveInput?.label ? { label: liveInput.label } : {}),
          })
        : {}),
      ...(displayTool?.definitionId === 'planning.read' && displayTool.definitionVersion === '1'
        ? { text: '' }
        : {}),
      ...(inputPresentation && inputCompatible && (!fact || fact.shellInput?.command === undefined)
        ? {
            shell: {
              ...factMessage?.shell,
              ...inputPresentation,
            },
          }
        : {}),
      ...(jobSettlement && shell
        ? {
            shell: {
              ...shell,
              ...(inputCompatible ? inputPresentation : undefined),
              ...jobSettlement,
            },
          }
        : {}),
      ...(run && !model.agentResult ? { turnId: identity(run.id) } : {}),
      ...(inputCommandId ? { presentationKey: inputCommandId } : {}),
      ...(run && message.role === 'tool' && message.sourceIds?.length === 1
        ? {
            presentationKey: nativeToolPresentationKey(
              storeId,
              sessionId,
              run.id,
              message.sourceIds[0]!,
            ),
          }
        : {}),
      ...(run && message.compression && message.sourceIds?.length === 1
        ? { presentationKey: compressionIdentity(run.id, message.sourceIds[0]!) }
        : {}),
      ...(run &&
      run.originStoreId === storeId &&
      message.role === 'user' &&
      (message.inputKind === 'input.steer' || message.inputKind === 'interaction.answer')
        ? { inputKind: message.inputKind }
        : {}),
      ...(!model.agentResult && !model.agentMessage && replies.has(message.id)
        ? {
            finalReply: true,
            copyText: replies.get(message.id)?.text ?? null,
          }
        : {}),
      ...(message.deferredText ? { copyText: null } : {}),
    };
    if (run && result.role === 'tool')
      return {
        ...result,
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
          title: COMPRESSION_RUNNING_TITLE,
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
        title: COMPRESSION_RUNNING_TITLE,
        text: '',
        status: 'running',
        settled: false,
      });
  }
  const active = [...observed.values()].find((run) => run.isActive);
  if (traceTurns) {
    const byId = new Map(executions.map((execution) => [execution.id, execution]));
    const activeTurn = active && identity(active.id);
    const reasoningKey = (turnId: string, executionId: string) =>
      JSON.stringify(['native-reasoning', turnId, executionId]);
    const lastModel =
      active &&
      executions
        .filter(
          (execution) =>
            execution.kind === 'model' &&
            execution.parentExecutionId == null &&
            execution.runId === active.id &&
            execution.sessionId === sessionId &&
            execution.originStoreId === active.originStoreId &&
            execution.id !== compressionProgress?.executionId,
        )
        .at(-1);
    const currentModel =
      lastModel && ['dispatching', 'running'].includes(lastModel.status) ? lastModel : undefined;
    let lastModelSeen = false;
    const lastAction =
      active &&
      messages
        .filter(
          (message) =>
            !message.originMessage &&
            !message.compression &&
            !message.agentMessage &&
            !message.agentResult &&
            message.sessionId === sessionId &&
            message.runId === active.id,
        )
        .at(-1);
    const projected = modeled.flatMap((model, index): DesktopMessage[] => {
      const message = messages[index];
      if (!message || model.systemKind || message.role !== 'assistant' || !model.turnId)
        return [model];
      const source = message.sourceIds?.length === 1 ? message.sourceIds[0] : undefined;
      const running = !!currentModel && currentModel.id === source && model.turnId === activeTurn;
      const execution = source && byId.get(source);
      const visibleText =
        !!message.content || !!(message.outputBody && message.outputBody.contentBytes !== '0');
      const toolRequested =
        message.firstOutput === 'tool_calls' ||
        !!message.toolCalls?.length ||
        !!message.outputBody?.toolCallCount;
      if (lastModel?.id === source && model.turnId === activeTurn) lastModelSeen = true;
      const reasoning = nativeReasoningSource(message);
      const thought: DesktopMessage | undefined = reasoning
        ? {
            id: `${message.id}:reasoning`,
            presentationKey: reasoningKey(model.turnId, reasoning),
            turnId: model.turnId,
            role: 'thinking',
            text: '',
            reasoningSource: message.id,
            reasoningActive: running && !visibleText && !toolRequested && !model.settled,
            settled:
              visibleText ||
              toolRequested ||
              model.settled ||
              (!running && (model.turnId !== activeTurn || !!execution || !!currentModel)),
          }
        : undefined;
      if (!visibleText && model.role === 'thinking') return thought ? [thought] : [];
      if (model.presentation === 'hidden' || (!visibleText && model.settled && !model.finalReply))
        return thought ? [thought] : [model];
      if (
        !visibleText &&
        !model.hasAttachments &&
        !model.finalReply &&
        message.contentFormat !== 'unsupported' &&
        message.outputBody?.readAvailability !== 'unsupported'
      )
        return thought ? [thought] : [];
      const streaming = !!visibleText && !model.settled && running;
      return [...(thought ? [thought] : []), { ...model, streaming }];
    });
    const lastCalls = lastAction?.toolCalls;
    const progressOnly =
      lastAction?.status === 'complete' &&
      !!lastCalls?.length &&
      (!lastAction.outputBody || lastCalls.length === lastAction.outputBody.toolCallCount) &&
      lastCalls.every((call) => call.name === PLAN_PROGRESS_TOOL);
    const waitingForTool =
      lastAction?.role === 'assistant' &&
      !progressOnly &&
      (lastAction.firstOutput === 'tool_calls' ||
        !!lastAction.toolCalls?.length ||
        !!lastAction.outputBody?.toolCallCount);
    const waitingForModelMessage =
      lastModel && !lastModelSeen && (currentModel || lastModel.status === 'succeeded');
    if (activeTurn && (waitingForModelMessage || waitingForTool)) {
      const source =
        (waitingForModelMessage ? lastModel?.id : lastAction?.sourceIds?.[0]) ?? activeTurn;
      projected.push({
        id: `${source}:trace-pending`,
        presentationKey: reasoningKey(activeTurn, source),
        turnId: activeTurn,
        role: 'thinking',
        text: '',
        settled: false,
        tracePending: waitingForModelMessage ? 'reasoning' : 'tool',
      });
    }
    modeled.splice(0, modeled.length, ...projected);
  }
  for (const run of observed.values()) {
    const turnId = identity(run.id);
    const stoppedByService = run.status === 'cancelled' && run.reason === 'service_shutdown';
    modeled.push({
      id: `native-run-timing:${turnId}`,
      presentationKey:
        run.originStoreId === storeId &&
        run.originCommandId &&
        runsByCommand.get(run.originCommandId) === run.id
          ? run.originCommandId
          : undefined,
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
          run.status === 'interrupted' || stoppedByService
            ? 'aborted'
            : (run.status as 'completed' | 'failed' | 'cancelled'),
      });
    if (
      !run.isActive &&
      (run.status === 'failed' || run.status === 'interrupted' || stoppedByService)
    ) {
      const failure =
        nativeImageFailure(run.reason) ??
        nativeRunFailure(run.reason, run.status === 'interrupted');
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
        text: failure.text,
        settled: true,
        status: 'failed',
        failure: {
          summary: failure.summary,
          ...(run.reason ? { reasonCode: run.reason } : {}),
        },
      });
    }
  }
  nativeModelConnections(modeled, messages, executions, observed, storeId, sessionId, identity);
  const failedConnections = new Set(
    modeled.filter((message) => message.modelConnectionFailure).map((message) => message.turnId),
  );
  return {
    // An old SQL running record cannot establish current execution. Only the
    // matching hot observation above may make that attempt a visible live row.
    messages: modeled.filter(
      (model) =>
        !progressMessages.has(model.id) &&
        !(model.systemKind === 'turn_failure' && failedConnections.has(model.turnId)) &&
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
