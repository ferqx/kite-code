import type { Execution, Message, ModelOutputSnapshot } from '@kite-ai/client';
import type { TuiSnapshot } from './controller';
import {
  frozenBuiltin,
  inkExecutionScope,
  inkReadOnlyExecution,
  inkShellCarrier,
  projectInkThought,
  projectInkTool,
} from './execution-projection';
import { buildToolSummaryLine } from './ink/tool-summary-line';
import type { ConsolidatedToolEntry, OutputBlock } from './ink/types';

export interface InkExplorationFact {
  readonly originStoreId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  /** Supplied by the effect producer, never inferred from a command string by the UI. */
  readonly presentation: 'exploration' | 'standalone';
}
export interface InkExplorationPhase {
  readonly key: string;
  /** Insert this phase at this original message's position. */
  readonly messageId: string;
  readonly messageIds: readonly string[];
  readonly executionIds: readonly string[];
  readonly block: Extract<OutputBlock, { kind: 'tool_summary' }>;
}
export interface InkExplorationProjection {
  readonly phases: readonly InkExplorationPhase[];
  /** Tool-bearing progress captions remain stored, but are not answers. */
  readonly suppressedNarrationMessageIds: ReadonlySet<string>;
  /** These messages already contribute their Thinking label to the phase. */
  readonly thoughtConsumedMessageIds: ReadonlySet<string>;
  /** A phase owns this invocation until its final tool classification arrives. */
  readonly bufferedAnswerMessageIds: ReadonlySet<string>;
}
const live = (execution: Execution) =>
  ['planned', 'dispatching', 'running'].includes(execution.status);
function original(message: Message, snapshot: TuiSnapshot): boolean {
  return (
    message.role === 'assistant' &&
    message.sessionId === snapshot.view.session.id &&
    (!message.originMessage ||
      (message.originMessage.storeId === snapshot.storeId &&
        message.originMessage.sessionId === message.sessionId &&
        message.originMessage.runId === message.runId))
  );
}
/** The frozen registration or original effect producer must prove exploration eligibility. */
function exploration(
  tool: Execution,
  snapshot: TuiSnapshot,
  facts: readonly InkExplorationFact[],
): boolean {
  if (!inkExecutionScope(tool, snapshot)) return false;
  const matches = facts.filter(
    (fact) =>
      fact.originStoreId === tool.originStoreId &&
      fact.sessionId === tool.sessionId &&
      fact.runId === tool.runId &&
      fact.executionId === tool.id &&
      fact.definitionId === tool.definitionId &&
      fact.definitionVersion === tool.definitionVersion,
  );
  if (matches.length) return matches.length === 1 && matches[0]!.presentation === 'exploration';
  if (inkReadOnlyExecution(tool, snapshot)) return true;
  // Only the registered Shell producer can classify its original request.
  // Its saved receipt must still point at the one actual same-scope carrier;
  // a custom Tool's presentation string or a command spelling is not proof.
  if (
    tool.kind !== 'tool' ||
    tool.definitionVersion !== '1' ||
    !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(tool.status) ||
    !/^[1-9][0-9]*$/.test(tool.resultRevision) ||
    !(
      frozenBuiltin(tool, snapshot, 'builtin.shell', 'shell.execute') ||
      frozenBuiltin(tool, snapshot, 'builtin.shell', 'shell.launch')
    )
  )
    return false;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const result = record(tool.result),
    details = record(result?.details),
    ref = record(details?.ref);
  const carrier = inkShellCarrier(tool, snapshot);
  return (
    !!carrier &&
    result?.outcome === tool.status &&
    details?.presentation === 'exploration' &&
    ref?.executionId === carrier.id &&
    ref.sessionId === carrier.sessionId &&
    ref.originStoreId === carrier.originStoreId &&
    ref.extensionId === 'builtin.shell' &&
    typeof ref.commandId === 'string' &&
    ref.commandId.length > 0 &&
    typeof ref.key === 'string' &&
    ref.key.length > 0
  );
}
/** Rebuild the original UI's exploration lifecycle solely from qualified source order. */
export function projectInkExplorationPhases(
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
  facts: readonly InkExplorationFact[] = [],
): InkExplorationProjection {
  const phases: InkExplorationPhase[] = [];
  const suppressedNarrationMessageIds = new Set<string>();
  const thoughtConsumedMessageIds = new Set<string>();
  const bufferedAnswerMessageIds = new Set<string>();
  const messages = snapshot.messages
    .filter((message) => original(message, snapshot))
    .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
  const count = new Map<string, number>();
  const callKey = (message: Message, id: string) => JSON.stringify([message.runId, id]);
  for (const message of messages)
    for (const call of loadedOutputs.get(message.id)?.toolCalls ?? message.toolCalls ?? [])
      count.set(callKey(message, call.id), (count.get(callKey(message, call.id)) ?? 0) + 1);
  type MutablePhase = {
    key: string;
    messageId: string;
    messageIds: Set<string>;
    narrationMessageIds: Set<string>;
    executionIds: Set<string>;
    models: Map<string, Execution>;
    timedModels: Map<string, Execution>;
    tools: ConsolidatedToolEntry[];
    hasThinking: boolean;
    latestActivity?: Extract<OutputBlock, { kind: 'tool_summary' }>['latestActivity'];
  };
  let phase: MutablePhase | undefined;
  let runId: string | null | undefined;
  let phaseIndex = 0;
  const flush = (keepOpen = false) => {
    if (!phase) return;
    // A single content-first read is still ordinary narration. Only a real Thought
    // or consecutive tool-bearing Models owns progress captions as one exploration.
    if (phase.hasThinking || phase.narrationMessageIds.size > 1)
      for (const id of phase.narrationMessageIds) suppressedNarrationMessageIds.add(id);
    const sources = [...phase.models.values()];
    const timedSources = [...phase.timedModels.values()];
    const timings = timedSources.map((model) => snapshot.executionTimings?.[model.id]);
    const completeTimings =
      timings.length > 0 &&
      timings.every(
        (timing) =>
          timing?.availability === 'recorded_dispatch' &&
          timing.startedAt !== undefined &&
          timing.finishedAt !== undefined &&
          timing.finishedAt >= timing.startedAt,
      );
    const activeModels = sources.filter(live);
    const activeTiming =
      activeModels.length === 1 ? snapshot.executionTimings?.[activeModels[0]!.id] : undefined;
    const activeRun = snapshot.view.runs.some(
      (run) =>
        run.id === runId &&
        run.sessionId === snapshot.view.session.id &&
        run.originStoreId === snapshot.storeId &&
        run.isActive,
    );
    const active =
      (keepOpen && activeRun) ||
      activeModels.length > 0 ||
      [...phase.executionIds].some((id) =>
        snapshot.view.executions.some((execution) => execution.id === id && live(execution)),
      );
    const completed = timings.filter(
      (timing) =>
        timing?.availability === 'recorded_dispatch' &&
        timing.startedAt !== undefined &&
        timing.finishedAt !== undefined &&
        timing.finishedAt >= timing.startedAt,
    );
    const elapsed =
      completeTimings ||
      (activeModels.length === 1 &&
        phase.timedModels.has(activeModels[0]!.id) &&
        activeTiming?.availability === 'recorded_dispatch' &&
        activeTiming.startedAt !== undefined &&
        completed.length === timings.length - 1)
        ? completed.reduce((total, timing) => total + timing!.finishedAt! - timing!.startedAt!, 0)
        : undefined;
    phases.push({
      key: phase.key,
      messageId: phase.messageId,
      messageIds: [...phase.messageIds],
      executionIds: [...phase.executionIds],
      block: {
        id: 0,
        kind: 'tool_summary',
        createdAt: 0,
        tools: phase.tools,
        summaryLine: buildToolSummaryLine(phase.tools),
        active,
        hasThought: true,
        hasThinking: phase.hasThinking,
        ...(elapsed === undefined ? {} : { totalElapsedMs: elapsed }),
        ...(activeModels.length === 1 &&
        phase.timedModels.has(activeModels[0]!.id) &&
        activeTiming?.availability === 'recorded_dispatch' &&
        activeTiming.startedAt !== undefined
          ? { liveModelStartedAt: activeTiming.startedAt }
          : {}),
        ...(active && phase.latestActivity ? { latestActivity: phase.latestActivity } : {}),
      },
    });
    phase = undefined;
  };
  for (const message of messages) {
    if (runId !== message.runId) {
      flush();
      runId = message.runId;
      phaseIndex = 0;
    }
    const models = snapshot.view.executions.filter(
      (model) =>
        model.kind === 'model' &&
        inkExecutionScope(model, snapshot) &&
        model.runId === message.runId &&
        ((message.sourceIds ?? []).includes(model.id) ||
          message.outputBody?.executionId === model.id),
    );
    if (models.length !== 1) {
      flush();
      continue;
    }
    const model = models[0]!;
    const body = loadedOutputs.get(message.id);
    const calls = body?.toolCalls ?? message.toolCalls ?? [];
    const thought = projectInkThought(message, snapshot, loadedOutputs);
    const classified =
      (body?.complete ?? message.outputBody?.complete ?? message.status === 'complete') &&
      (message.outputBody?.toolCallCount ?? calls.length) <= calls.length;
    const start = (suffix: string) => {
      phase ??= {
        key: JSON.stringify([
          snapshot.storeId,
          message.sessionId,
          message.runId,
          message.id,
          suffix,
          phaseIndex++,
        ]),
        messageId: message.id,
        messageIds: new Set(),
        narrationMessageIds: new Set(),
        executionIds: new Set(),
        models: new Map(),
        timedModels: new Map(),
        tools: [],
        hasThinking: false,
      };
    };
    const contribute = (consumeThinking: boolean) => {
      if (!phase) return;
      phase.messageIds.add(message.id);
      phase.models.set(model.id, model);
      if (consumeThinking) {
        phase.timedModels.set(model.id, model);
        phase.hasThinking ||= thought.hasThinking === true;
        thoughtConsumedMessageIds.add(message.id);
        if (thought.latestActivity) phase.latestActivity = thought.latestActivity;
      }
    };
    if (!calls.length) {
      if (phase) {
        contribute(true);
        if (!classified) bufferedAnswerMessageIds.add(message.id);
        else flush();
      }
      // A pure Thought without a preceding exploration stays with its answer;
      // the stream visibility helper owns the reason-first classification window.
      continue;
    }
    const explorationNarration = calls.every((call) => {
      if (count.get(callKey(message, call.id)) !== 1) return false;
      const owners = snapshot.view.executions.filter(
        (tool) =>
          tool.kind === 'tool' &&
          inkExecutionScope(tool, snapshot) &&
          tool.runId === message.runId &&
          tool.toolCallId === call.id,
      );
      return owners.length === 1 && exploration(owners[0]!, snapshot, facts);
    });
    let thinkingConsumed = false;
    for (const call of calls) {
      const tools =
        count.get(callKey(message, call.id)) === 1
          ? snapshot.view.executions.filter(
              (tool) =>
                tool.kind === 'tool' &&
                inkExecutionScope(tool, snapshot) &&
                tool.runId === message.runId &&
                tool.toolCallId === call.id,
            )
          : [];
      const tool = tools.length === 1 ? tools[0] : undefined;
      if (!tool && count.get(callKey(message, call.id)) === 1 && tools.length === 0) {
        // An original Model call can precede its Execution reader material. Missing facts
        // do not prove a write boundary and cannot seal the partial read aggregate.
        continue;
      }
      if (!tool || !exploration(tool, snapshot, facts)) {
        flush();
        thinkingConsumed = true;
        continue;
      }
      start(call.id);
      if (explorationNarration) phase!.narrationMessageIds.add(message.id);
      contribute(!thinkingConsumed);
      thinkingConsumed = true;
      phase!.executionIds.add(tool.id);
      let source = tool;
      const carrier = inkShellCarrier(tool, snapshot);
      if (carrier) {
        source = carrier;
        phase!.executionIds.add(source.id);
      }
      const card = projectInkTool(source, snapshot, loadedOutputs);
      phase!.tools.push({
        callId: call.id,
        name: card.name,
        args: card.args,
        status: card.status,
        ok: source.status === 'succeeded',
        summary: card.summary,
        ...(card.liveTotalLines === undefined ? {} : { totalLines: card.liveTotalLines }),
      });
      if (live(source)) phase!.latestActivity = { kind: 'tool', callId: call.id };
    }
  }
  flush(true);
  return {
    phases,
    suppressedNarrationMessageIds,
    thoughtConsumedMessageIds,
    bufferedAnswerMessageIds,
  };
}
