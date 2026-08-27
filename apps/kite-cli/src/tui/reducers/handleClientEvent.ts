import type {
  RuntimeClientEvent,
  RuntimeClientInteraction,
  RuntimeToolPresentation,
} from '@kite-ai/runtime-contract';
import {
  formatToolResultForDisplay,
  getToolDetail,
  getToolPreview,
} from '../components/render-utils';
import type { OutputBlock, TuiPendingApproval, TuiState } from '../types';
import { projectToolCancelled, projectUserCancelledTurn } from './cancellation-projection';
import { buildToolSummaryLine } from './consolidateTools';
import { handleEventAction } from './handleEvent';
import { appendBlock, appendUserMessage, findBlock, replaceBlockById } from './helpers';

/** Client-safe presentation reducer. It accepts no Runtime/Kernel event shape. */
export function handleClientEventAction(state: TuiState, event: RuntimeClientEvent): TuiState {
  switch (event.type) {
    case 'user.message': {
      // Runtime message identity, rather than text, is the display authority.
      // A subscription may replay the durable notification after reconnect;
      // retaining the first projection keeps live and replay rendering
      // idempotent without collapsing distinct prompts with equal text.
      if (
        findBlock(state, (block) => block.kind === 'user' && block.messageId === event.messageId)
      ) {
        return state;
      }
      return appendUserMessage(state, {
        id: state.nextBlockId,
        kind: 'user',
        content: event.text,
        messageId: event.messageId,
      });
    }
    case 'model.requested':
      return {
        ...state,
        currentModelRequestId: event.requestId,
        toolBearingModelRequestId: undefined,
        currentModelReasoningSegmentId: undefined,
        currentModelReasoningText: undefined,
        currentModelReasoningRequestId: undefined,
        running: true,
      };
    case 'reasoning.activity':
      return projectReasoningActivity(state, event);
    case 'model.text_delta':
      return projectModelTextDelta(state, event);
    case 'model.responded':
      return projectModelResponded(state, event);
    case 'model.retry':
      return {
        ...settleCurrentThought(state),
        status: {
          ...state.status,
          retryState: {
            attempt: event.attempt,
            maxAttempts: event.attempt,
            error: 'Model retry requested.',
            delayMs: event.delayMs ?? 0,
          },
        },
      };
    case 'model.cache':
      return {
        ...state,
        status: {
          ...state.status,
          cacheHitTokens: event.cacheHitTokens,
          cacheMissTokens: event.cacheMissTokens,
          totalTokens: event.inputTokens + (event.outputTokens ?? 0),
          cacheHitRate: event.inputTokens === 0 ? 0 : event.cacheHitTokens / event.inputTokens,
        },
      };
    case 'tool.queued':
      return queueSafeClientTool(state, event);
    case 'tool.started':
      return startSafeClientTool(state, event.toolId, event.summary ?? 'Running tool.');
    case 'tool.progress':
      return updateSafeToolProgress(state, event);
    case 'tool.finished':
      return finishSafeClientTool(state, event, terminalToolStatus(event));
    case 'tool.failed':
    case 'tool.rejected':
      return finishSafeClientTool(state, event, 'error');
    case 'tool.cancelled':
      return projectToolCancelled(state, event.toolId);
    case 'tool.file_changed':
      return appendNotice(
        settleCurrentThought(state),
        event.summary ?? `Tool ${event.toolId} ${event.change} a file.`,
      );
    case 'interaction.available':
      return projectInteraction(settleCurrentThought(state), event.interaction);
    case 'interaction.settled':
      return settleInteraction(state, event.interactionId, event.outcome);
    case 'approval.queued':
      return projectApproval(settleCurrentThought(state), event.interaction, event.queueSequence);
    case 'approval.granted':
      return settleApproval(state, event.interactionId, 'authorized');
    case 'approval.rejected':
      return settleApproval(state, event.interactionId, 'rejected', event.summary);
    case 'input.requested':
      return projectInteraction(settleCurrentThought(state), event.interaction);
    case 'input.answered':
      return settleInteraction(state, event.interactionId, 'completed', event.summary);
    case 'input.cancelled':
      return settleInteraction(state, event.interactionId, 'cancelled');
    case 'plan.review_requested':
      return projectInteraction(settleCurrentThought(state), event.interaction);
    case 'plan.progress':
      return appendNotice(
        settleCurrentThought(state),
        event.summary ?? `Plan ${event.planId} is ${event.status}.`,
      );
    case 'plan.completed':
      return appendNotice(
        settleCurrentThought(state),
        event.summary ?? `Plan ${event.planId} completed.`,
      );
    case 'plan.approved': {
      const settled = settleInteraction(state, event.interactionId, 'completed');
      return {
        ...settled,
        interactionMode: event.mode,
        status: { ...settled.status, phase: 'building' },
      };
    }
    case 'planning.entered':
      return { ...state, status: { ...state.status, phase: 'planning' } };
    case 'planning.exited':
      return { ...state, status: { ...state.status, phase: 'building' } };
    case 'interaction_mode.changed':
      return { ...state, interactionMode: event.mode };
    case 'provider.action':
      return event.status === 'required'
        ? projectInteraction(settleCurrentThought(state), event.interaction)
        : appendNotice(
            settleCurrentThought(state),
            event.summary ?? `Provider action is ${event.status}.`,
          );
    case 'verification.status':
      return event.status === 'pending' || event.status === 'failed'
        ? projectInteraction(settleCurrentThought(state), event.interaction)
        : appendNotice(
            settleCurrentThought(state),
            event.summary ?? `Verification is ${event.status}.`,
          );
    case 'subagent.started':
      if (
        findBlock(
          state,
          (block) => block.kind === 'subagent' && block.subagentId === event.subagentId,
        )
      ) {
        return state;
      }
      return appendBlock(settleCurrentThought(state), {
        id: state.nextBlockId,
        kind: 'subagent',
        subagentId: event.subagentId,
        role: event.role,
        task: event.name,
        status: 'running',
        summary: '',
        toolCallCount: 0,
        durationMs: 0,
        steps: [],
      });
    case 'subagent.step':
      return projectSubagentStep(state, event);
    case 'subagent.completed':
      return settleSubagent(state, event.subagentId, 'done', event.summary);
    case 'subagent.failed':
      return settleSubagent(state, event.subagentId, 'error', event.summary);
    case 'context.compaction':
      return appendNotice(
        settleCurrentThought(state),
        event.summary ?? `Context compaction ${event.status}.`,
      );
    case 'task.terminal':
      return settleTerminal(state, event.summary, false);
    case 'turn.terminal':
      return event.status === 'cancelled' && event.cause === 'user'
        ? settleUserCancelledTerminal(state)
        : settleTerminal(state, event.summary, false);
    case 'run.terminal':
      return settleTerminal(state, event.summary, true);
    case 'run.failure':
      return {
        ...appendNotice(
          settleCurrentThought(state),
          event.retryable
            ? `MODEL_ATTEMPT_RETRYABLE_FAILURE:${event.code}`
            : `RUN_FAILURE:${event.code}`,
        ),
        running: false,
        exited: true,
        currentModelRequestId: undefined,
        toolBearingModelRequestId: undefined,
        currentModelReasoningRequestId: undefined,
      };
    case 'rewind.terminal':
      return event.status === 'failed'
        ? appendNotice(
            settleCurrentThought(state),
            `Rewind failed: ${event.failureCode ?? 'execution_failed'}.`,
          )
        : state;
    case 'session.notice':
      return appendNotice(settleCurrentThought(state), event.message ?? event.code);
    case 'unavailable':
      return appendNotice(
        settleCurrentThought(state),
        `Runtime update unavailable: ${event.reason}.`,
      );
  }
}

function appendFinalOnce(state: TuiState, summary: string): TuiState {
  const last = state.turns.at(-1)?.blocks.at(-1);
  if (last?.kind === 'text') {
    if (last.streaming) {
      return replaceBlockById(state, last.id, { ...last, content: summary, streaming: false });
    }
    if (last.content === summary) return state;
  }
  return handleEventAction(state, { type: 'final', data: summary });
}

type ModelTextBlock = Extract<OutputBlock, { kind: 'text' }>;

function findModelAnswerText(state: TuiState, requestId: string): ModelTextBlock | undefined {
  const blocks = state.turns.at(-1)?.blocks;
  if (!blocks) return undefined;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'text' && block.modelRequestId === requestId) return block;
  }
  return undefined;
}

function precedingToolSummary(
  state: TuiState,
  followingBlockId: number,
): Extract<OutputBlock, { kind: 'tool_summary' }> | undefined {
  const blocks = state.turns.at(-1)?.blocks;
  const index = blocks?.findIndex((block) => block.id === followingBlockId) ?? -1;
  const previous = index > 0 ? blocks?.[index - 1] : undefined;
  return previous?.kind === 'tool_summary' && previous.tools.length > 0 ? previous : undefined;
}

function appendCompletedReasoning(
  summary: Extract<OutputBlock, { kind: 'tool_summary' }>,
  text: string,
): Pick<Extract<OutputBlock, { kind: 'tool_summary' }>, 'timeline' | 'nextTimelineSeq'> {
  const timeline = summary.timeline ?? [];
  const last = timeline.at(-1);
  if (last?.kind === 'thinking' && last.text === text) return {};
  return {
    timeline: [
      ...timeline,
      { seq: summary.nextTimelineSeq ?? timeline.length, kind: 'thinking' as const, text },
    ],
    nextTimelineSeq: (summary.nextTimelineSeq ?? timeline.length) + 1,
  };
}

function removeBlockById(state: TuiState, blockId: number): TuiState {
  const turns = state.turns.map((turn) => ({
    blocks: turn.blocks.filter((block) => block.id !== blockId),
  }));
  return { ...state, turns };
}

function annotateModelAnswer(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'model.responded' }>,
): TuiState {
  const last = state.turns.at(-1)?.blocks.at(-1);
  const answer =
    findModelAnswerText(state, event.requestId) ??
    (last?.kind === 'text' &&
    last.modelRequestId === undefined &&
    event.summary !== undefined &&
    (last.content.startsWith(event.summary) || event.summary.startsWith(last.content))
      ? last
      : undefined);
  if (!answer) return state;
  const reasoningOwnedByToolSummary = findBlock(
    state,
    (block) =>
      block.kind === 'tool_summary' &&
      block.modelRequestId === event.requestId &&
      block.tools.length > 0,
  );
  const ownsReasoning =
    state.currentModelReasoningRequestId === event.requestId &&
    reasoningOwnedByToolSummary === undefined;
  return replaceBlockById(state, answer.id, {
    ...answer,
    ...(event.summary && /\S/u.test(event.summary) ? { content: event.summary } : {}),
    streaming: false,
    modelRequestId: event.requestId,
    ...(event.durationMs === undefined ? {} : { modelDurationMs: event.durationMs }),
    ...(ownsReasoning && state.currentModelReasoningText
      ? {
          thoughtContent: state.currentModelReasoningText,
          ...(event.durationMs === undefined ? {} : { thoughtElapsedMs: event.durationMs }),
        }
      : {}),
  });
}

function mergeCumulativeText(previous: string | undefined, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  return `${previous}${next}`;
}

function projectReasoningActivity(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'reasoning.activity' }>,
): TuiState {
  const segmentText =
    state.currentModelReasoningRequestId === event.requestId &&
    state.currentModelReasoningSegmentId === event.segmentId
      ? mergeCumulativeText(state.currentModelReasoningText, event.text)
      : event.text;
  const cached = {
    ...state,
    currentModelReasoningStreamed: event.state === 'streaming',
    currentModelReasoningRequestId: event.requestId,
    currentModelReasoningSegmentId: event.segmentId,
    currentModelReasoningText: segmentText,
  };
  const answer = findModelAnswerText(cached, event.requestId);
  if (answer) {
    if (event.state !== 'completed') return cached;
    // The durable final response can overtake the provider's completed
    // reasoning packet during reconnect/replay. When it immediately follows
    // an exploration summary, that reasoning owns the same visual phase—not
    // a second, text-attached Thinking header.
    const preceding = precedingToolSummary(cached, answer.id);
    if (preceding) {
      const durationMs = answer.modelDurationMs;
      return replaceBlockById(cached, preceding.id, {
        ...preceding,
        ...(durationMs === undefined ? {} : { modelMs: durationMs, totalElapsedMs: durationMs }),
        modelRequestId: event.requestId,
        hasThought: true,
        hasThinking: true,
        ...appendCompletedReasoning(preceding, segmentText),
      });
    }
    // A durable final answer is sufficient ownership even when another
    // terminal projection has subsequently appended a visible block. Late
    // reasoning belongs to that answer's closed invocation; it must never
    // reopen a live Thought (which would replay the reasoning payload until
    // the following terminal arrives).
    return replaceBlockById(cached, answer.id, {
      ...answer,
      thoughtContent: segmentText,
      ...(answer.modelDurationMs === undefined ? {} : { thoughtElapsedMs: answer.modelDurationMs }),
    });
  }
  // A streamed answer has already made the phase visually terminal. Late
  // provider packets may update the cache but must not create a second Thought.
  if (state.thoughtPhaseStatus === 'awaiting_terminal') {
    return cached;
  }
  const next = ensureContentFreeThought(cached, event.requestId);
  if (event.state !== 'completed') return next;
  const summary = findSummaryById(next, next.currentThoughtSummaryId);
  if (!summary) return next;
  const text = next.currentModelReasoningText ?? event.text;
  return replaceBlockById(next, summary.id, {
    ...summary,
    hasThought: true,
    hasThinking: true,
    latestActivity: { kind: 'thinking', text },
    ...appendCompletedReasoning(summary, text),
  });
}

function projectModelTextDelta(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'model.text_delta' }>,
): TuiState {
  const { text } = event;
  if (!/\S/u.test(text)) return state;
  const ownedAnswer = findModelAnswerText(state, event.requestId);
  if (ownedAnswer) {
    if (!ownedAnswer.streaming) return state;
    const next = replaceBlockById(state, ownedAnswer.id, {
      ...ownedAnswer,
      content: mergeCumulativeText(ownedAnswer.content, text),
    });
    return { ...next, thoughtPhaseStatus: 'awaiting_terminal' };
  }
  const last = state.turns.at(-1)?.blocks.at(-1);
  // Ephemeral delivery may cross a durable terminal at the Client pump. A
  // cumulative delta identical to the already-finalized tail is the same
  // model fact, not a second assistant paragraph.
  if (last?.kind === 'text' && !last.streaming && last.content === text) return state;
  // ADR-0036: streamed assistant text is a sibling block after Thought. It
  // never becomes a caption, including when durable model.responded has
  // already declared tools. Completed reasoning owns the `└─` activity
  // window; a following exploration tool may replace that window, but normal
  // assistant text remains on the message timeline.
  const next = handleEventAction(awaitSafeThoughtTerminal(state), {
    type: 'text',
    data: { text, streamingDelta: true },
  });
  const answer = next.turns.at(-1)?.blocks.at(-1);
  if (answer?.kind !== 'text') return next;
  return {
    ...replaceBlockById(next, answer.id, {
      ...answer,
      modelRequestId: event.requestId,
    }),
    thoughtPhaseStatus: 'awaiting_terminal',
  };
}

function settledSummary(
  block: Extract<OutputBlock, { kind: 'tool_summary' }>,
): Extract<OutputBlock, { kind: 'tool_summary' }> {
  const hasError = block.tools.some(
    (tool) => tool.status === 'error' || tool.status === 'timeout' || tool.status === 'exhausted',
  );
  const hasPending = block.tools.some(
    (tool) => tool.status === 'queued' || tool.status === 'running' || tool.status === 'cancelled',
  );
  return {
    ...block,
    active: false,
    responsePending: false,
    latestActivity: undefined,
    totalElapsedMs: block.modelMs ?? Date.now() - block.createdAt,
    pendingCaption: undefined,
    result: hasError ? 'error' : hasPending ? 'cancelled' : 'done',
  };
}

function detachFinalCaption(state: TuiState, caption: string): TuiState {
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary) return appendFinalOnce(state, caption);
  if (summary.tools.length === 0) {
    const turnIndex = state.turns.length - 1;
    const turns = state.turns.slice();
    const turn = turns[turnIndex]!;
    turns[turnIndex] = { blocks: turn.blocks.filter((block) => block.id !== summary.id) };
    return appendBlock(
      {
        ...state,
        turns,
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
      },
      {
        id: state.nextBlockId,
        kind: 'text',
        content: caption,
        streaming: false,
        ...(summary.modelRequestId === undefined ? {} : { modelRequestId: summary.modelRequestId }),
        thoughtElapsedMs: summary.modelMs ?? summary.totalElapsedMs,
        ...(state.currentModelReasoningRequestId === summary.modelRequestId &&
        state.currentModelReasoningText
          ? { thoughtContent: state.currentModelReasoningText }
          : {}),
      },
    );
  }
  const settled = replaceBlockById(state, summary.id, settledSummary(summary));
  const appended = appendFinalOnce(
    { ...settled, currentThoughtSummaryId: undefined, thoughtPhaseStatus: undefined },
    caption,
  );
  const answer = appended.turns.at(-1)?.blocks.at(-1);
  return answer?.kind === 'text' && summary.modelRequestId !== undefined
    ? replaceBlockById(appended, answer.id, {
        ...answer,
        modelRequestId: summary.modelRequestId,
      })
    : appended;
}

function clearCompletedModelState(state: TuiState, requestId: string): TuiState {
  const ownsCurrentRequest = state.currentModelRequestId === requestId;
  const ownsReasoning = state.currentModelReasoningRequestId === requestId;
  return {
    ...state,
    thoughtPhaseStatus: undefined,
    ...(ownsCurrentRequest ? { currentModelRequestId: undefined } : {}),
    ...(state.toolBearingModelRequestId === requestId
      ? { toolBearingModelRequestId: undefined }
      : {}),
    ...(ownsReasoning
      ? {
          currentModelReasoningRequestId: undefined,
          currentModelReasoningSegmentId: undefined,
          currentModelReasoningStreamed: false,
          currentModelReasoningText: undefined,
        }
      : {}),
  };
}

function projectModelResponded(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'model.responded' }>,
): TuiState {
  const existingAnswer = findModelAnswerText(state, event.requestId);
  const activeSummary = findSummaryById(state, state.currentThoughtSummaryId);
  if (
    state.currentModelRequestId !== undefined &&
    state.currentModelRequestId !== event.requestId &&
    state.toolBearingModelRequestId !== event.requestId &&
    activeSummary?.modelRequestId !== event.requestId &&
    existingAnswer === undefined
  ) {
    return state;
  }
  let next = addSafeThoughtDuration(state, event.durationMs);
  const streamedAnswer = existingAnswer ?? findModelAnswerText(next, event.requestId);
  if (streamedAnswer && event.toolCallCount === 0) {
    const current = findSummaryById(next, next.currentThoughtSummaryId);
    if (current?.tools.length === 0) {
      next = {
        ...removeBlockById(next, current.id),
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
      };
    }
    return clearCompletedModelState(annotateModelAnswer(next, event), event.requestId);
  }
  if (event.toolCallCount > 0) {
    const hasNarration = event.summary !== undefined && /\S/u.test(event.summary);
    if (streamedAnswer || hasNarration) {
      next = settleCurrentThought(next);
      if (streamedAnswer) {
        next = replaceBlockById(next, streamedAnswer.id, {
          ...streamedAnswer,
          ...(hasNarration ? { content: event.summary! } : {}),
          streaming: false,
          modelRequestId: event.requestId,
          ...(event.durationMs === undefined ? {} : { modelDurationMs: event.durationMs }),
        });
      } else {
        next = appendBlock(next, {
          id: next.nextBlockId,
          kind: 'text',
          content: event.summary!,
          streaming: false,
          modelRequestId: event.requestId,
          ...(event.durationMs === undefined ? {} : { modelDurationMs: event.durationMs }),
        });
      }
    }
    const current = findSummaryById(next, next.currentThoughtSummaryId);
    const resumed = current
      ? replaceBlockById(next, current.id, {
          ...current,
          modelRequestId: event.requestId,
          active: true,
          responsePending: false,
        })
      : next;
    return {
      ...resumed,
      currentModelRequestId: undefined,
      toolBearingModelRequestId: event.requestId,
      thoughtPhaseStatus: 'running',
    };
  }
  const summary = findSummaryById(next, next.currentThoughtSummaryId);
  if (
    summary &&
    (summary.active || summary.responsePending) &&
    event.summary &&
    /\S/u.test(event.summary)
  ) {
    next = replaceBlockById(next, summary.id, {
      ...summary,
      modelRequestId: event.requestId,
      pendingCaption: mergeCumulativeText(summary.pendingCaption, event.summary),
    });
  }
  const current = findSummaryById(next, next.currentThoughtSummaryId);
  const finalText = current?.pendingCaption ?? event.summary;
  const completed =
    finalText && /\S/u.test(finalText)
      ? detachFinalCaption(next, finalText)
      : settleCurrentThought(next);
  return clearCompletedModelState(annotateModelAnswer(completed, event), event.requestId);
}

function settleUserCancelledTerminal(state: TuiState): TuiState {
  const cancelled = projectUserCancelledTurn(state);
  const settled = settleCurrentThought(cancelled);
  return {
    ...settled,
    interrupt: null,
    pendingToolCalls: {},
    pendingApprovals: new Map(),
    activeApprovalId: null,
    running: false,
    exited: false,
    currentModelRequestId: undefined,
    toolBearingModelRequestId: undefined,
    currentModelReasoningSegmentId: undefined,
    currentModelReasoningStreamed: false,
    currentModelReasoningText: undefined,
    currentModelReasoningRequestId: undefined,
  };
}

function settleTerminal(state: TuiState, summary: string | undefined, finalRun: boolean): TuiState {
  const current = findSummaryById(state, state.currentThoughtSummaryId);
  const terminalRequestId = current?.modelRequestId ?? state.currentModelRequestId;
  const pendingCaption = current?.pendingCaption;
  const sameCumulativeAnswer =
    pendingCaption !== undefined &&
    summary !== undefined &&
    (pendingCaption.startsWith(summary) || summary.startsWith(pendingCaption));
  const settled = pendingCaption
    ? detachFinalCaption(
        state,
        sameCumulativeAnswer ? mergeCumulativeText(pendingCaption, summary!) : pendingCaption,
      )
    : settleCurrentThought(state);
  let next = summary === undefined ? settled : appendFinalOnce(settled, summary);
  const answer = next.turns.at(-1)?.blocks.at(-1);
  if (answer?.kind === 'text' && terminalRequestId !== undefined) {
    next = replaceBlockById(next, answer.id, {
      ...answer,
      modelRequestId: terminalRequestId,
    });
  }
  return finalRun
    ? {
        ...next,
        running: false,
        exited: true,
        currentModelRequestId: undefined,
        toolBearingModelRequestId: undefined,
      }
    : next;
}

function settleCurrentThought(state: TuiState): TuiState {
  const turnIndex = state.turns.length - 1;
  const turn = state.turns[turnIndex];
  if (!turn) {
    return {
      ...state,
      currentThoughtSummaryId: undefined,
      thoughtPhaseStatus: undefined,
    };
  }
  let changed = false;
  const blocks = turn.blocks.map((block) => {
    if (block.kind !== 'tool_summary' || (!block.active && !block.responsePending)) return block;
    changed = true;
    return { ...block, active: false, responsePending: false };
  });
  if (
    !changed &&
    state.currentThoughtSummaryId === undefined &&
    state.thoughtPhaseStatus === undefined
  ) {
    return state;
  }
  const turns = state.turns.slice();
  turns[turnIndex] = { blocks };
  return { ...state, turns, currentThoughtSummaryId: undefined, thoughtPhaseStatus: undefined };
}

function awaitSafeThoughtTerminal(state: TuiState): TuiState {
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary?.active) return state;
  return {
    ...replaceBlockById(state, summary.id, {
      ...summary,
      active: false,
      responsePending: true,
    }),
    thoughtPhaseStatus: 'awaiting_terminal',
  };
}

function ensureContentFreeThought(state: TuiState, requestId?: string): TuiState {
  const current = findSummaryById(state, state.currentThoughtSummaryId);
  if (current?.active) {
    return replaceBlockById(state, current.id, {
      ...current,
      ...(requestId === undefined ? {} : { modelRequestId: requestId }),
      hasThought: true,
      hasThinking: true,
    });
  }
  const block: Extract<OutputBlock, { kind: 'tool_summary' }> = {
    id: state.nextBlockId,
    kind: 'tool_summary',
    tools: [],
    totalElapsedMs: 0,
    createdAt: Date.now(),
    summaryLine: '',
    active: true,
    ...(requestId === undefined ? {} : { modelRequestId: requestId }),
    hasThought: true,
    hasThinking: true,
  };
  const next = appendBlock(state, block);
  return {
    ...next,
    currentThoughtSummaryId: block.id,
    thoughtPhaseStatus: 'running',
  };
}

function addSafeThoughtDuration(state: TuiState, durationMs: number | undefined): TuiState {
  if (durationMs === undefined || durationMs < 0) return state;
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary) return state;
  const modelMs = (summary.modelMs ?? 0) + durationMs;
  return replaceBlockById(state, summary.id, { ...summary, modelMs, totalElapsedMs: modelMs });
}

function appendSafeTool(
  state: TuiState,
  toolId: string,
  toolName: string | undefined,
  status: Extract<OutputBlock, { kind: 'tool_card' }>['status'],
  summary: string,
  args: Record<string, unknown> = {},
): TuiState {
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === toolId,
  );
  if (existing?.kind === 'tool_card')
    return updateSafeTool(state, toolId, toolName, status, summary, args);
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'tool_card',
    callId: toolId,
    name: toolName ?? 'other',
    args,
    status,
    summary,
    preview: getToolPreview(toolName ?? 'other', args),
    detail: getToolDetail(toolName ?? 'other', args),
  });
}

function updateSafeTool(
  state: TuiState,
  toolId: string,
  toolName: string | undefined,
  status: Extract<OutputBlock, { kind: 'tool_card' }>['status'],
  summary: string,
  args?: Record<string, unknown>,
): TuiState {
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === toolId,
  );
  return existing?.kind === 'tool_card'
    ? replaceBlockById(state, existing.id, {
        ...existing,
        ...(toolName === undefined ? {} : { name: toolName }),
        ...(args === undefined
          ? {}
          : {
              args,
              preview: getToolPreview(toolName ?? existing.name, args),
              detail: getToolDetail(toolName ?? existing.name, args),
            }),
        status,
        summary,
      })
    : appendSafeTool(state, toolId, toolName, status, summary);
}

type SafeToolStatus = Extract<OutputBlock, { kind: 'tool_card' }>['status'];
type ClientToolPresentation = RuntimeToolPresentation;

function isSubagentTool(toolId: string): boolean {
  return toolId.startsWith('subagent-tool:');
}

function removePendingTool(state: TuiState, toolId: string): TuiState {
  if (state.pendingToolCalls[toolId] === undefined) return state;
  const { [toolId]: _removed, ...pendingToolCalls } = state.pendingToolCalls;
  return { ...state, pendingToolCalls };
}

function queuedToolPresentation(
  event: Extract<RuntimeClientEvent, { type: 'tool.queued' }>,
): ClientToolPresentation {
  return event.presentation;
}

function terminalToolPresentation(
  event: Extract<
    RuntimeClientEvent,
    { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
  >,
): ClientToolPresentation | undefined {
  return event.type === 'tool.finished' ? event.presentation : undefined;
}

function terminalToolStatus(
  event: Extract<RuntimeClientEvent, { type: 'tool.finished' }>,
): Extract<SafeToolStatus, 'done' | 'error' | 'exhausted'> {
  if (event.result.ok) return 'done';
  return event.result.status === 'exhausted' ? 'exhausted' : 'error';
}

function pendingPresentation(
  pending: TuiState['pendingToolCalls'][string] | undefined,
): ClientToolPresentation | undefined {
  return pending?.presentation;
}

function queueSafeClientTool(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'tool.queued' }>,
): TuiState {
  if (isSubagentTool(event.toolId)) return state;
  if (state.pendingToolCalls[event.toolId] !== undefined) return state;
  return {
    ...state,
    pendingToolCalls: {
      ...state.pendingToolCalls,
      [event.toolId]: {
        name: event.toolName ?? 'other',
        ...(event.displayLabel === undefined ? {} : { displayName: event.displayLabel }),
        args: { ...event.arguments },
        presentation: queuedToolPresentation(event),
      },
    },
  };
}

function findSummaryById(
  state: TuiState,
  summaryId: number | undefined,
): Extract<OutputBlock, { kind: 'tool_summary' }> | undefined {
  if (summaryId === undefined) return undefined;
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'tool_summary' && candidate.id === summaryId,
  );
  return block?.kind === 'tool_summary' ? block : undefined;
}

function standaloneStartedBeforeCurrentThought(state: TuiState, toolId: string): boolean {
  const current = findSummaryById(state, state.currentThoughtSummaryId);
  const standalone = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === toolId,
  );
  return current !== undefined && standalone?.kind === 'tool_card' && standalone.id < current.id;
}

function updateSafeSummaryEntry(
  state: TuiState,
  summary: Extract<OutputBlock, { kind: 'tool_summary' }>,
  toolId: string,
  status: SafeToolStatus,
  toolSummary: string,
  totalLines?: number,
): TuiState {
  const tools = summary.tools.map((tool) =>
    tool.callId === toolId
      ? {
          ...tool,
          status,
          ok: status === 'done',
          summary: toolSummary,
          ...(totalLines === undefined ? {} : { totalLines }),
        }
      : tool,
  );
  return replaceBlockById(state, summary.id, {
    ...summary,
    tools,
    summaryLine: buildToolSummaryLine(tools),
    latestActivity: { kind: 'tool', callId: toolId },
  });
}

function materializeSafeClientTool(
  state: TuiState,
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
  status: SafeToolStatus,
  toolSummary: string,
  totalLines?: number,
): TuiState {
  const withoutPending = removePendingTool(state, toolId);
  const existing = findSummaryById(withoutPending, withoutPending.explorationSummaryIds[toolId]);
  if (existing)
    return updateSafeSummaryEntry(
      withoutPending,
      existing,
      toolId,
      status,
      toolSummary,
      totalLines,
    );

  const active = findSummaryById(withoutPending, withoutPending.currentThoughtSummaryId);
  if (active?.active) {
    const pendingCaption = active.pendingCaption;
    const tools = [
      ...active.tools,
      {
        callId: toolId,
        name: toolName,
        args,
        ok: status === 'done',
        status,
        summary: toolSummary,
        ...(totalLines === undefined ? {} : { totalLines }),
      },
    ];
    return {
      ...replaceBlockById(withoutPending, active.id, {
        ...active,
        tools,
        summaryLine: buildToolSummaryLine(tools),
        latestActivity: { kind: 'tool', callId: toolId },
        ...(pendingCaption === undefined
          ? {}
          : {
              captions: [...(active.captions ?? []), pendingCaption],
              pendingCaption: undefined,
            }),
      }),
      explorationSummaryIds: {
        ...withoutPending.explorationSummaryIds,
        [toolId]: active.id,
      },
    };
  }

  const block: Extract<OutputBlock, { kind: 'tool_summary' }> = {
    id: withoutPending.nextBlockId,
    kind: 'tool_summary',
    tools: [
      {
        callId: toolId,
        name: toolName,
        args,
        ok: status === 'done',
        status,
        summary: toolSummary,
        ...(totalLines === undefined ? {} : { totalLines }),
      },
    ],
    totalElapsedMs: 0,
    createdAt: Date.now(),
    summaryLine: buildToolSummaryLine([
      {
        callId: toolId,
        name: toolName,
        args,
        ok: status === 'done',
        status,
        summary: toolSummary,
      },
    ]),
    active: true,
    hasThought: false,
    latestActivity: { kind: 'tool', callId: toolId },
  };
  const next = appendBlock(withoutPending, block);
  return {
    ...next,
    explorationSummaryIds: { ...withoutPending.explorationSummaryIds, [toolId]: block.id },
    currentThoughtSummaryId: block.id,
    thoughtPhaseStatus: 'running',
  };
}

function startSafeClientTool(state: TuiState, toolId: string, summary: string): TuiState {
  if (isSubagentTool(toolId)) return state;
  const pending = state.pendingToolCalls[toolId];
  // A started fact has no tool identity of its own. If the matching queued
  // projection was outside this client's retained window, do not invent a
  // generic `Tool` card; a named terminal fact can still materialize the exact
  // card later, while an unnamed cancellation remains invisible.
  if (!pending) return state;
  if (pendingPresentation(pending) === 'hidden') return removePendingTool(state, toolId);
  if (pendingPresentation(pending) === 'exploration') {
    return materializeSafeClientTool(
      state,
      toolId,
      pending.displayName ?? pending.name,
      pending.args,
      'running',
      summary,
    );
  }
  return appendSafeTool(
    settleCurrentThought(removePendingTool(state, toolId)),
    toolId,
    pending.displayName ?? pending.name,
    'running',
    summary,
    pending.args,
  );
}

function finishSafeClientTool(
  state: TuiState,
  event: Extract<
    RuntimeClientEvent,
    { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
  >,
  status: Extract<SafeToolStatus, 'done' | 'error' | 'cancelled' | 'exhausted'>,
): TuiState {
  const toolId = event.toolId;
  const toolName = 'toolName' in event ? event.toolName : undefined;
  const displayName = 'displayLabel' in event ? event.displayLabel : undefined;
  const pending = state.pendingToolCalls[toolId];
  const result = event.type === 'tool.finished' ? event.result : undefined;
  const resultName = toolName ?? pending?.name ?? 'other';
  const summary =
    result === undefined
      ? (event.summary ?? (status === 'cancelled' ? 'Cancelled.' : 'Tool execution failed.'))
      : formatToolResultForDisplay(resultName, result.stdout, result.stderr);
  if (isSubagentTool(toolId)) return state;
  const presentation = terminalToolPresentation(event);
  if (
    pendingPresentation(pending) === 'hidden' ||
    presentation === 'hidden' ||
    toolName === 'task'
  ) {
    return removePendingTool(state, toolId);
  }
  const existing = findSummaryById(state, state.explorationSummaryIds[toolId]);
  if (existing)
    return updateSafeSummaryEntry(
      removePendingTool(state, toolId),
      existing,
      toolId,
      status,
      summary,
      result?.totalLines,
    );
  if (pending && pendingPresentation(pending) === 'exploration') {
    // An unstarted cancellation is invisible by policy. Other terminal states
    // materialize one neutral diagnostic entry using the pending safe category.
    if (status === 'cancelled') return removePendingTool(state, toolId);
    return materializeSafeClientTool(
      state,
      toolId,
      pending.displayName ?? pending.name,
      pending.args,
      status,
      summary,
      result?.totalLines,
    );
  }
  if (pending) {
    // A user-rejected or cancelled approval never reached tool.started and
    // therefore has no visible execution card. The durable interaction notice
    // is sufficient; materializing `Write ()` here would invent work.
    if (status === 'cancelled' || event.type === 'tool.rejected') {
      return removePendingTool(state, toolId);
    }
    return updateSafeTool(
      settleCurrentThought(removePendingTool(state, toolId)),
      toolId,
      pending.displayName ?? pending.name,
      status,
      summary,
      pending.args,
    );
  }
  if (toolName !== undefined && presentation === 'exploration' && status !== 'cancelled') {
    return materializeSafeClientTool(
      state,
      toolId,
      displayName ?? toolName,
      {},
      status,
      summary,
      result?.totalLines,
    );
  }
  const shouldSettleCurrentThought =
    presentation === 'standalone' && !standaloneStartedBeforeCurrentThought(state, toolId);
  return updateSafeTool(
    shouldSettleCurrentThought ? settleCurrentThought(state) : state,
    toolId,
    displayName ?? toolName,
    status,
    summary,
  );
}

const MAX_SAFE_TOOL_PROGRESS_LINES = 5;

function updateSafeToolProgress(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { readonly type: 'tool.progress' }>,
): TuiState {
  const summary = findSummaryById(state, state.explorationSummaryIds[event.toolId]);
  if (summary) {
    return updateSafeSummaryEntry(state, summary, event.toolId, 'running', event.summary);
  }
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === event.toolId,
  );
  if (existing?.kind !== 'tool_card') {
    // Ephemeral progress is intentionally not replayed. A client that joins
    // after the durable queued/started facts may therefore see only this safe,
    // App-projected text. Materialize an anonymous standalone card so a later
    // exact cancellation can settle it; no tool kind, arguments, or authority
    // are inferred from the progress payload.
    const queued = queueSafeClientTool(state, {
      type: 'tool.queued',
      toolId: event.toolId,
      presentation: 'standalone',
      arguments: {},
      summary: 'Tool output available.',
    });
    const started = startSafeClientTool(queued, event.toolId, 'Running tool.');
    return updateSafeToolProgress(started, event);
  }
  if (existing.status !== 'running') return state;
  const previous = existing.liveOutput;
  const combined = previous === undefined ? event.summary : `${previous}\n${event.summary}`;
  const lines = combined.split('\n');
  const liveOutput =
    lines.length > MAX_SAFE_TOOL_PROGRESS_LINES
      ? lines.slice(-MAX_SAFE_TOOL_PROGRESS_LINES).join('\n')
      : combined;
  return replaceBlockById(state, existing.id, {
    ...existing,
    summary: event.summary,
    liveOutput,
    liveTotalLines:
      (existing.liveTotalLines ?? 0) + (event.lineCount ?? event.summary.split('\n').length),
  });
}

function projectInteraction(state: TuiState, interaction: RuntimeClientInteraction): TuiState {
  switch (interaction.kind) {
    case 'approval':
      return projectApproval(state, interaction, state.nextBlockId);
    case 'input': {
      return projectQuestionInteraction(state, interaction.interactionId, {
        question: interaction.question,
        options: (interaction.options ?? []).map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        allow_free_text: interaction.allowFreeText,
      });
    }
    case 'plan_review': // The closed Runtime interaction intentionally carries only a safe plan
      // title/summary plus durable identity, not the State plan artifact. The
      // Footer needs an AgentPlan-shaped local presentation model, while the
      // visible notice preserves the reviewed title after that Footer closes.
      // Neither object becomes a Runtime settlement authority.
      {
        const plan = {
          name: interaction.title ?? 'Plan review',
          description: interaction.summary ?? '',
          status: 'pending' as const,
          steps: [],
        };
        const next = appendNotice(state, plan.name);
        return {
          ...next,
          interrupt: {
            kind: 'plan_review',
            interactionId: interaction.interactionId,
            planId: interaction.plan.planId,
            version: interaction.plan.version,
            structuralDigest: interaction.plan.structuralDigest,
            plan,
          },
        };
      }
    case 'provider_action': {
      const providerId = interaction.provider.providerId;
      const admission = interaction.title === 'Provider admission required';
      return projectQuestionInteraction(
        state,
        interaction.interactionId,
        admission
          ? {
              question: `Required MCP provider '${providerId}' requires a decision.`,
              options: [
                ...(interaction.action === 'retry'
                  ? [
                      {
                        id: 'retry',
                        label: 'Retry',
                        description: 'Retry the provider connection before starting the model.',
                      },
                    ]
                  : []),
                {
                  id: 'waive',
                  label: 'Session Waive',
                  description: 'Continue this session while provider capabilities remain hidden.',
                },
                {
                  id: 'cancel',
                  label: 'Cancel Run',
                  description: 'Cancel this task without calling the model.',
                },
              ],
              allow_free_text: false,
              recommended: interaction.action === 'retry' ? 'retry' : 'waive',
            }
          : {
              question: `MCP provider '${providerId}' requires ${interaction.action}.`,
              options: [
                {
                  id: 'recover',
                  label: `Run ${interaction.action}`,
                  description: 'Perform provider recovery and continue.',
                },
                {
                  id: 'defer',
                  label: 'Later',
                  description: 'Keep the failed Tool Call terminal without replaying it.',
                },
              ],
              allow_free_text: false,
              recommended: 'recover',
            },
      );
    }
    case 'verification':
      return projectQuestionInteraction(state, interaction.interactionId, {
        question: interaction.title ?? 'Verification requires attention.',
        options: [
          { id: 'replan', label: 'Replan', description: 'Return to planning.' },
          { id: 'waive', label: 'Waive', description: 'Accept the recorded verification risk.' },
          {
            id: 'compensate',
            label: 'Compensate',
            description: 'Run the authorized compensation path.',
          },
        ],
        allow_free_text: false,
        recommended: 'replan',
      });
  }
}

function projectQuestionInteraction(
  state: TuiState,
  interactionId: string,
  question: Extract<OutputBlock, { kind: 'question' }>['question'],
): TuiState {
  if (state.interrupt?.kind === 'input' && state.interrupt.interactionId === interactionId) {
    return state;
  }
  const block: OutputBlock = { id: state.nextBlockId, kind: 'question', question };
  return {
    ...appendBlock(state, block),
    interrupt: { kind: 'input', blockId: block.id, interactionId },
  };
}

function projectApproval(
  state: TuiState,
  interaction: Extract<RuntimeClientInteraction, { kind: 'approval' }>,
  sequence: number,
): TuiState {
  const queue = new Map(state.pendingApprovals ?? []);
  const existing = queue.get(interaction.interactionId);
  const pending: TuiPendingApproval = {
    interactionId: interaction.interactionId,
    toolCallId: existing?.toolCallId ?? interaction.interactionId,
    route: existing?.route ?? 'user',
    status: existing?.status ?? 'awaiting_user',
    sequence: existing?.sequence ?? sequence,
    generation: interaction.generation,
    clientInteraction: interaction,
    ...(existing?.result === undefined ? {} : { result: existing.result }),
  };
  queue.set(interaction.interactionId, pending);
  const focusable = pending.status === 'queued_user' || pending.status === 'awaiting_user';
  return {
    ...state,
    pendingApprovals: queue,
    ...(focusable
      ? {
          activeApprovalId: interaction.interactionId,
          interrupt: {
            kind: 'approval' as const,
            interactionId: interaction.interactionId,
            toolCallId: pending.toolCallId,
          },
        }
      : {}),
  };
}

function settleApproval(
  state: TuiState,
  interactionId: string,
  result: 'authorized' | 'rejected',
  summary?: string,
): TuiState {
  const queue = new Map(state.pendingApprovals ?? []);
  const pending = queue.get(interactionId);
  if (pending)
    queue.set(interactionId, {
      ...pending,
      status: result === 'authorized' ? 'authorized_queued' : 'rejected',
      result,
    });
  const next = {
    ...state,
    pendingApprovals: queue,
    ...(state.activeApprovalId === interactionId
      ? { activeApprovalId: null, interrupt: null }
      : {}),
  };
  return summary ? appendNotice(next, summary) : next;
}

function settleInteraction(
  state: TuiState,
  interactionId: string,
  outcome: 'completed' | 'rejected' | 'cancelled' | 'expired',
  summary?: string,
): TuiState {
  const cleared =
    state.interrupt?.interactionId === interactionId ? { ...state, interrupt: null } : state;
  return summary
    ? appendNotice(cleared, summary)
    : outcome === 'rejected'
      ? appendNotice(cleared, 'Interaction rejected.')
      : cleared;
}

function projectSubagentStep(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'subagent.step' }>,
): TuiState {
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'subagent' && candidate.subagentId === event.subagentId,
  );
  if (block?.kind !== 'subagent') return state;
  const stepStatus =
    event.status === 'started'
      ? ('pending' as const)
      : event.status === 'completed'
        ? ('success' as const)
        : ('error' as const);
  const visibleToolName = event.displayLabel ?? event.toolName;
  const pendingIndex = [...block.steps]
    .map((step, index) => ({ step, index }))
    .reverse()
    .find(({ step }) => step.toolName === visibleToolName && step.status === 'pending')?.index;
  const steps =
    pendingIndex === undefined
      ? [
          ...block.steps,
          {
            toolName: visibleToolName,
            toolArgs: { ...(event.arguments ?? {}) },
            status: stepStatus,
            ...(event.status === 'completed'
              ? { ok: true }
              : event.status === 'failed'
                ? { ok: false }
                : {}),
            ...(event.totalLines === undefined ? {} : { totalLines: event.totalLines }),
            ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
            ...(event.summary === undefined ? {} : { summary: event.summary }),
          },
        ]
      : block.steps.map((step, index) =>
          index === pendingIndex
            ? {
                ...step,
                status: stepStatus,
                ...(event.arguments === undefined ? {} : { toolArgs: { ...event.arguments } }),
                ...(event.status === 'completed'
                  ? { ok: true }
                  : event.status === 'failed'
                    ? { ok: false }
                    : {}),
                ...(event.totalLines === undefined ? {} : { totalLines: event.totalLines }),
                ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
                ...(event.summary === undefined ? {} : { summary: event.summary }),
              }
            : step,
        );
  return replaceBlockById(state, block.id, {
    ...block,
    steps,
    toolCallCount: steps.length,
  });
}

function settleSubagent(
  state: TuiState,
  subagentId: string,
  status: 'done' | 'error',
  summary: string,
): TuiState {
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'subagent' && candidate.subagentId === subagentId,
  );
  return block?.kind === 'subagent'
    ? replaceBlockById(state, block.id, {
        ...block,
        status,
        summary,
        ...(status === 'error' ? { error: summary } : {}),
      })
    : appendNotice(state, summary);
}

function appendNotice(state: TuiState, text: string): TuiState {
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'text',
    content: text,
    streaming: false,
  });
}
