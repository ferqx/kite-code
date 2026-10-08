import type { Message } from '@kite-ai/client';
import type { Message as DesktopMessage, TurnActivity } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { desktopMessages } from './native-presentation';
import { desktopToolMessage } from './native-tool-messages';
import {
  type NativeRunFact,
  type NativeToolMessageFact,
  presentableRun,
} from './tool-messages-bridge';

const runFact = (run: NativeRunFact): NativeRunFact => ({
  id: run.id,
  originStoreId: run.originStoreId,
  sessionId: run.sessionId,
  status: run.status,
  isActive: run.isActive,
  createdAt: run.createdAt,
  finishedAt: run.finishedAt,
  reason: run.reason,
});

/** Read admitted Run facts without replacing a sealed Fork/Include boundary with later source state. */
export function useNativeRuns({
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
    workspaceId = selection?.session.workspaceId,
    viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([generation, storeId, sessionId, viewSelection, historyEpoch]);
  const available = !!selection && !selection.viewLoading && !selection.permissionUnavailable;
  const representatives = new Map<string, string>();
  for (const message of messages)
    if (!message.originMessage && message.sessionId === sessionId && message.runId)
      representatives.set(message.runId, message.id);
  const ids = JSON.stringify([...representatives]);
  const view = JSON.stringify(
    selection?.runs
      .filter((run) => storeId && sessionId && presentableRun(run, storeId, sessionId))
      .map(runFact) ?? [],
  );
  const [retryRevision, setRetryRevision] = useState(0);
  const cache = useRef({
    scope,
    retryRevision,
    read: new Map<string, { run?: NativeRunFact; revision: number }>(),
  });
  const [state, setState] = useState<{ scope: string; runs: NativeRunFact[]; error?: string }>({
    scope,
    runs: [],
  });
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
      cache.current = { scope, retryRevision, read: new Map() };
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
        setState({
          scope,
          runs: [...current.read.values()].flatMap((entry) => (entry.run ? [entry.run] : [])),
        });
      }
    })().catch(() => {
      if (active)
        setState({
          scope,
          runs: [...current.read.values()].flatMap((entry) => (entry.run ? [entry.run] : [])),
          error: '无法核对本轮状态，已保留原消息。',
        });
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
    available,
    ids,
    view,
    observationRevision,
    retryRevision,
  ]);
  const runs = new Map((state.scope === scope ? state.runs : []).map((run) => [run.id, run]));
  // The newer verified View wins over an older metadata response, including explicit recovery.
  for (const run of JSON.parse(view) as NativeRunFact[]) runs.set(run.id, run);
  return {
    runs: [...runs.values()],
    error: state.scope === scope ? state.error : undefined,
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
  messages,
  runs,
  tools,
  storeId,
  sessionId,
  fullReply,
}: {
  messages: readonly Message[];
  runs: readonly NativeRunFact[];
  tools: readonly NativeToolMessageFact[];
  storeId: string;
  sessionId: string;
  fullReply?: (message: Message) => string | undefined;
}): { messages: DesktopMessage[]; turnActivity?: TurnActivity } {
  const observed = new Map(
    runs.filter((run) => presentableRun(run, storeId, sessionId)).map((run) => [run.id, run]),
  );
  const identity = (runId: string) => JSON.stringify(['native-run', storeId, sessionId, runId]);
  const finals = new Set<string>();
  for (const run of observed.values()) {
    if (run.status !== 'completed' || run.isActive) continue;
    const own = messages.filter(
      (message) =>
        !message.originMessage && message.sessionId === sessionId && message.runId === run.id,
    );
    const last = own.filter((message) => message.role === 'assistant').at(-1);
    if (
      last &&
      last.status === 'complete' &&
      last.contentFormat !== 'unsupported' &&
      !last.toolCalls?.length &&
      (!last.outputBody || (last.outputBody.complete && last.outputBody.toolCallCount === 0)) &&
      !own.some((message) => message.role === 'tool' && BigInt(message.seq) > BigInt(last.seq))
    )
      finals.add(last.id);
  }
  const modeled = desktopMessages(messages).map((model, index) => {
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
    const result: DesktopMessage = {
      ...(fact ? desktopToolMessage(fact, message.id, message.content) : model),
      ...(run ? { turnId: identity(run.id) } : {}),
      ...(finals.has(message.id)
        ? {
            finalReply: true,
            copyText: message.outputBody ? (fullReply?.(message) ?? null) : message.content,
          }
        : {}),
    };
    if (
      fact &&
      run &&
      ((fact.definitionId === 'files.read' && ['2', '3'].includes(fact.definitionVersion)) ||
        (['files.glob', 'files.search'].includes(fact.definitionId) &&
          fact.definitionVersion === '2') ||
        (fact.definitionId === 'files.list' && fact.definitionVersion === '1'))
    )
      return {
        ...result,
        presentation: 'exploration' as const,
        presentationGroupId: identity(run.id),
      };
    return result;
  });
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
        text: run.reason ?? '',
        settled: true,
        status: 'failed',
        failure: { summary: run.reason ?? '本轮未完成。' },
      });
    }
  }
  const active = [...observed.values()].find((run) => run.isActive);
  return {
    messages: modeled,
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
