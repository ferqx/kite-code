import type {
  RuntimeClientEvent,
  RuntimeClientInteraction,
  RuntimeInteractionQueueProjection,
  RuntimeToolPresentation,
} from '@kite-ai/runtime-contract';
import { isAcceptedPresentationEnvelope } from '@kite-ai/runtime-contract';
import {
  formatToolResultForDisplay,
  getToolDetail,
  getToolPreview,
} from '../components/render-utils';
import type {
  AcceptedPresentationEnvelope,
  ConsolidatedToolEntry,
  OutputBlock,
  TuiInteractionOwner,
  TuiPendingApproval,
  TuiState,
} from '../types';
import { projectDurableUserCancelledTurn, projectToolCancelled } from './cancellation-projection';
import { buildToolSummaryLine } from './consolidateTools';
import {
  appendBlock,
  appendUserMessage,
  finalizeLastTurnStreaming,
  findBlock,
  type PresentationTerminalOutcome,
  replaceBlockById,
  sealAllPresentationBlocks,
  sealLastTurnPresentationBlocks,
} from './helpers';
import { deriveToolSummaryResult } from './tool-summary-result';

type AcceptedEventInput = AcceptedPresentationEnvelope;
type SubagentPhaseEvent = Extract<RuntimeClientEvent, { type: 'subagent.phase' }>;
type SubagentReviewEvent = Extract<RuntimeClientEvent, { type: 'subagent.review' }>;
type CoreRuntimeClientEvent = Exclude<
  RuntimeClientEvent,
  { type: 'subagent.phase' | 'subagent.review' }
>;

/**
 * Client-safe presentation reducer. Every Runtime lifecycle event arrives as
 * an AcceptedPresentationEnvelope so Session/generation/revision fencing is
 * retained all the way to the projector. Presentation-only local actions stay
 * on the separate reducer helper path.
 */
export function handleClientEventAction(state: TuiState, input: AcceptedEventInput): TuiState {
  const accepted = acceptPresentationInput(state, input);
  if (!accepted) return state;
  const nextState = expirePendingSubagentTerminals(accepted.state, accepted.envelope);
  const event = accepted.event;

  // Supplemental child lifecycle events are handled before the core switch;
  // they are ordinary contract events and carry the same envelope fences.
  if (event.type === 'subagent.phase') return projectSubagentPhase(nextState, event);
  if (event.type === 'subagent.review') return projectSubagentReview(nextState, event);
  if (
    (event.type === 'model.requested' || event.type === 'model.responded') &&
    nextState.settledModelRequestIds?.has(event.requestId)
  ) {
    return nextState;
  }

  if (
    (event.type === 'task.terminal' ||
      event.type === 'turn.terminal' ||
      event.type === 'run.terminal') &&
    !terminalMatchesCurrentAuthority(nextState, event, accepted.envelope)
  ) {
    // A predecessor or authority-less terminal is rejected before any
    // envelope fence metadata is committed. Otherwise a stale high revision
    // could poison the successor's durable stream even though its lifecycle
    // fact was never accepted.
    return state;
  }

  if (
    event.type === 'model.responded' &&
    requestPresentationIncomplete(nextState, event.requestId)
  ) {
    // Keep the exact state object for a blocked terminal.  Apart from making
    // the no-op explicit, this prevents an incomplete request from producing
    // a render epoch when its recovery path has not run yet.
    return nextState;
  }
  const coreEvent = event as CoreRuntimeClientEvent;
  const reduced = reducePresentationBlocks(nextState, coreEvent, accepted.envelope);
  // Only close an ephemeral stream after the lifecycle identity fence has
  // accepted and reduced this terminal. A predecessor terminal rejected above
  // must not poison the same run before its receipt-join establishes the
  // successor.
  return projectRequestAssemblies(
    markAcceptedRunTerminal(reduced, event, accepted.envelope),
    coreEvent,
  );
}

const MAX_PENDING_SUBAGENT_REVISION_GAP = 64;

function expirePendingSubagentTerminals(
  state: TuiState,
  envelope: AcceptedPresentationEnvelope,
): TuiState {
  if (
    envelope.durability !== 'durable' ||
    envelope.revision === undefined ||
    state.pendingSubagentTerminals === undefined ||
    state.pendingSubagentTerminals.size === 0
  ) {
    return state;
  }

  let next = state;
  const pending = new Map(state.pendingSubagentTerminals);
  let changed = false;
  for (const [subagentId, terminal] of pending) {
    if (
      terminal.revision === undefined ||
      envelope.revision <= terminal.revision + MAX_PENDING_SUBAGENT_REVISION_GAP
    ) {
      continue;
    }
    pending.delete(subagentId);
    next = appendNotice(
      next,
      'Runtime update unavailable: a subagent result exceeded the terminal recovery window before its start arrived.',
    );
    changed = true;
  }
  return changed ? { ...next, pendingSubagentTerminals: pending } : state;
}

function acceptPresentationInput(
  state: TuiState,
  input: AcceptedEventInput,
): {
  state: TuiState;
  event: RuntimeClientEvent;
  envelope: AcceptedPresentationEnvelope;
} | null {
  if (!isAcceptedPresentationEnvelope(input)) return null;

  // A Session switch must establish a new reducer state before events for the
  // target Session are accepted.  Silently dropping a foreign Session event is
  // safer than attaching its answer/tool progress to the visible transcript.
  const expectedSessionId = state.activeSessionId ?? state.acceptedSessionId;
  if (expectedSessionId !== undefined && expectedSessionId !== input.sessionId) {
    return null;
  }
  const authorityRun = state.runtimeAuthority?.currentRun;
  const authorityTask = state.runtimeAuthority?.activeTask?.taskId ?? authorityRun?.taskId;
  const authorityTurn = authorityRun?.activeTurnId ?? authorityRun?.initialTurnId;
  if (
    authorityRun?.runId !== undefined &&
    input.runId !== undefined &&
    input.runId !== authorityRun.runId
  ) {
    return null;
  }
  if (authorityTask !== undefined && input.taskId !== undefined && input.taskId !== authorityTask) {
    return null;
  }
  if (authorityTurn !== undefined && input.turnId !== undefined && input.turnId !== authorityTurn) {
    return null;
  }
  if (
    state.acceptedConnectionGeneration !== undefined &&
    input.connectionGeneration < state.acceptedConnectionGeneration
  ) {
    return null;
  }
  if (
    input.durability === 'durable' &&
    input.revision !== undefined &&
    state.acceptedDurableRevision !== undefined &&
    input.revision < state.acceptedDurableRevision
  ) {
    return null;
  }

  const runId =
    input.runId ?? (input.event.type === 'run.terminal' ? input.event.runId : undefined);
  const closedRunIds = new Set(state.closedRunIds ?? []);
  if (
    runId !== undefined &&
    closedRunIds.has(runId) &&
    (input.event.type === 'run.terminal' ||
      input.durability === 'ephemeral' ||
      state.presentationMode !== 'history')
  ) {
    // Once a live Run is durably closed, no later packet for that Run may
    // append to or reopen its presentation. History replay retains its own
    // persisted ordering so hydration can reconstruct older transcripts.
    return null;
  }
  const ephemeralSequences = new Map(state.acceptedEphemeralSequences ?? []);
  let ephemeralSequenceChanged = false;
  if (input.durability === 'ephemeral' && input.stream !== undefined) {
    const stream = input.stream;
    const streamKey = [
      input.connectionGeneration,
      stream.actorId,
      stream.attemptId,
      stream.compositionRevision,
      stream.streamId,
    ].join('\u0000');
    const previous = ephemeralSequences.get(streamKey);
    if (previous !== undefined && stream.sequence <= previous) return null;
    ephemeralSequences.set(streamKey, stream.sequence);
    ephemeralSequenceChanged = true;
    // Stream ids are untrusted external input; cap this reducer-side cache.
    while (ephemeralSequences.size > 256) {
      const first = ephemeralSequences.keys().next().value;
      if (first === undefined) break;
      ephemeralSequences.delete(first);
    }
  }
  const acceptedConnectionGeneration = Math.max(
    state.acceptedConnectionGeneration ?? input.connectionGeneration,
    input.connectionGeneration,
  );
  const acceptedDurableRevision =
    input.durability === 'durable' && input.revision !== undefined
      ? Math.max(state.acceptedDurableRevision ?? input.revision, input.revision)
      : state.acceptedDurableRevision;
  const metadataChanged =
    state.acceptedSessionId !== input.sessionId ||
    state.acceptedConnectionGeneration !== acceptedConnectionGeneration ||
    state.acceptedDurableRevision !== acceptedDurableRevision ||
    ephemeralSequenceChanged;
  return {
    state: metadataChanged
      ? {
          ...state,
          acceptedSessionId: input.sessionId,
          acceptedConnectionGeneration,
          acceptedEphemeralSequences: ephemeralSequences,
          closedRunIds,
          ...(acceptedDurableRevision === undefined ? {} : { acceptedDurableRevision }),
        }
      : state,
    event: input.event,
    envelope: input,
  };
}

function requestPresentationIncomplete(state: TuiState, requestId: string): boolean {
  return (
    state.requestAssemblyIncomplete?.has(requestId) === true ||
    state.requestAssemblies?.get(requestId)?.state === 'presentation_incomplete'
  );
}

/**
 * Lifecycle terminal events are allowed to settle only their current
 * authority and their matching envelope identity. A terminal without the
 * relevant envelope identity is not safe to project.
 */
function terminalMatchesCurrentAuthority(
  state: TuiState,
  event:
    | Extract<RuntimeClientEvent, { type: 'task.terminal' }>
    | Extract<RuntimeClientEvent, { type: 'turn.terminal' }>
    | Extract<RuntimeClientEvent, { type: 'run.terminal' }>,
  envelope: AcceptedPresentationEnvelope,
): boolean {
  const currentRun = state.runtimeAuthority?.currentRun;
  const currentTaskId = state.runtimeAuthority?.activeTask?.taskId ?? currentRun?.taskId;

  if (event.type === 'run.terminal') {
    if (envelope.runId !== event.runId) return false;
    if (currentRun?.runId !== undefined && currentRun.runId !== event.runId) return false;
    return (
      currentRun !== undefined ||
      (state.presentationMode === 'history' && envelope.durability === 'durable')
    );
  }
  if (event.type === 'task.terminal') {
    if (envelope.taskId !== event.taskId) return false;
    if (currentTaskId !== undefined && currentTaskId !== event.taskId) return false;
    return (
      currentTaskId !== undefined ||
      (state.presentationMode === 'history' && envelope.durability === 'durable')
    );
  }

  const currentTurnId = currentRun?.activeTurnId ?? currentRun?.initialTurnId;
  if (envelope.turnId !== event.turnId) return false;
  if (currentTurnId !== undefined && currentTurnId !== event.turnId) return false;
  return (
    currentTurnId !== undefined ||
    (state.presentationMode === 'history' && envelope.durability === 'durable')
  );
}

function markAcceptedRunTerminal(
  state: TuiState,
  event: RuntimeClientEvent,
  envelope: AcceptedPresentationEnvelope,
): TuiState {
  if (event.type !== 'run.terminal' || envelope.durability !== 'durable') return state;
  const closedRunIds = new Set(state.closedRunIds ?? []);
  if (closedRunIds.has(event.runId)) return state;
  closedRunIds.add(event.runId);
  while (closedRunIds.size > 256) {
    const first = closedRunIds.values().next().value;
    if (first === undefined) break;
    closedRunIds.delete(first);
  }
  return { ...state, closedRunIds };
}

function reducePresentationBlocks(
  state: TuiState,
  event: CoreRuntimeClientEvent,
  envelope: AcceptedPresentationEnvelope,
): TuiState {
  switch (event.type) {
    case 'user.message': {
      // Runtime message identity, rather than text, is the display authority.
      // A subscription may replay the durable notification after reconnect;
      // retaining the first projection keeps live and replay rendering
      // idempotent without collapsing distinct prompts with equal text.
      const pendingEcho = findBlock(
        state,
        (block) =>
          block.kind === 'user' &&
          block.pendingEcho === true &&
          (block.messageId === event.messageId || block.messageId === undefined),
      );
      if (pendingEcho?.kind === 'user') {
        return {
          ...replaceBlockById(state, pendingEcho.id, {
            ...pendingEcho,
            messageId: event.messageId,
            pendingEcho: undefined,
          }),
          runPromptPresented: true,
        };
      }
      const queuedPromptIndex = (state.queuedPrompts ?? []).findIndex(
        (prompt) => prompt.sessionId === state.activeSessionId,
      );
      const withQueuedPromptConsumed =
        queuedPromptIndex < 0
          ? state
          : {
              ...state,
              queuedPrompts: (state.queuedPrompts ?? []).filter(
                (_prompt, index) => index !== queuedPromptIndex,
              ),
            };
      if (
        findBlock(
          withQueuedPromptConsumed,
          (block) => block.kind === 'user' && block.messageId === event.messageId,
        )
      ) {
        return { ...withQueuedPromptConsumed, runPromptPresented: true };
      }
      return {
        ...appendUserMessage(withQueuedPromptConsumed, {
          id: withQueuedPromptConsumed.nextBlockId,
          kind: 'user',
          content: event.text,
          messageId: event.messageId,
          presentationState: 'live',
        }),
        runPromptPresented: true,
      };
    }
    case 'model.requested': {
      // A provider invocation is not itself a visible presentation boundary.
      // After an exploration-only tool response, the next invocation normally
      // reasons over those results and still belongs to the same Thought. Keep
      // that adjacent phase open; visible text, a standalone tool, an
      // interaction, or a terminal event remains responsible for settling it.
      const next = continueActiveThought(state, event.requestId);
      const carriesHiddenReasoning =
        next.currentThoughtSummaryId === undefined && next.currentModelReasoningText !== undefined;
      return {
        ...next,
        currentModelRequestId: event.requestId,
        currentModelTextStreamed: undefined,
        currentModelTextSource: undefined,
        toolBearingModelRequestId: undefined,
        toolBearingPresentationGroupId: undefined,
        currentModelReasoningSegmentId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: carriesHiddenReasoning
          ? next.currentModelReasoningText
          : undefined,
        currentModelReasoningRequestId: carriesHiddenReasoning ? event.requestId : undefined,
      };
    }
    case 'reasoning.activity':
      return projectReasoningActivity(state, event);
    case 'model.text_delta':
      return projectModelTextDelta(state, event);
    case 'model.responded':
      return projectModelResponded(state, event);
    case 'model.retry':
      return {
        ...settlePresentationBoundary(state),
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
      return finishSafeClientTool(state, event, 'error');
    case 'tool.rejected':
      return finishSafeClientTool(state, event, 'rejected');
    case 'tool.cancelled':
      return projectToolCancelled(state, event.toolId);
    case 'tool.file_changed':
      return appendNotice(
        settlePresentationBoundary(state),
        event.summary ?? `Tool ${event.toolId} ${event.change} a file.`,
      );
    case 'interaction.available':
      return projectInteraction(settlePresentationBoundary(state), event.interaction);
    case 'interaction.settled':
      return settleInteraction(state, event.interactionId, event.outcome);
    case 'approval.queued':
      return projectApproval(
        settlePresentationBoundary(state),
        event.interaction,
        event.queueSequence,
      );
    case 'approval.granted':
      return settleApproval(
        state,
        event.interactionId,
        'authorized',
        event.generation,
        eventOwner(event),
        undefined,
      );
    case 'approval.rejected':
      return settleApproval(
        state,
        event.interactionId,
        'rejected',
        event.generation,
        eventOwner(event),
        event.summary,
      );
    case 'input.requested':
      return projectInteraction(settlePresentationBoundary(state), event.interaction);
    case 'input.answered':
      return settleInteraction(state, event.interactionId, 'completed', event.summary);
    case 'input.cancelled':
      return settleInteraction(state, event.interactionId, 'cancelled');
    case 'plan.review_requested':
      return projectInteraction(settlePresentationBoundary(state), event.interaction);
    case 'plan.progress':
      return appendNotice(
        settlePresentationBoundary(state),
        event.summary ?? `Plan ${event.planId} is ${event.status}.`,
      );
    case 'plan.completed':
      return appendNotice(
        settlePresentationBoundary(state),
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
        ? projectInteraction(settlePresentationBoundary(state), event.interaction)
        : appendNotice(
            settlePresentationBoundary(state),
            event.summary ?? `Provider action is ${event.status}.`,
          );
    case 'verification.status':
      return event.status === 'pending' || event.status === 'failed'
        ? projectInteraction(settlePresentationBoundary(state), event.interaction)
        : appendNotice(
            settlePresentationBoundary(state),
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
      {
        const prepared = settlePresentationBoundary(state);
        const pendingTerminal = prepared.pendingSubagentTerminals?.get(event.subagentId);
        const block = {
          id: prepared.nextBlockId,
          kind: 'subagent',
          subagentId: event.subagentId,
          role: event.role,
          task: event.name,
          status: pendingTerminal?.status ?? ('running' as const),
          presentationState: pendingTerminal ? 'sealed' : 'live',
          summary: pendingTerminal?.summary ?? '',
          toolCallCount: pendingTerminal?.toolCallCount ?? 0,
          durationMs: pendingTerminal?.durationMs ?? 0,
          startedAt: Date.now(),
          steps: [],
          ...(pendingTerminal?.diagnostic === undefined
            ? {}
            : { failureDiagnostic: pendingTerminal.diagnostic }),
          ...(pendingTerminal?.status === 'error'
            ? { error: pendingTerminal.summary }
            : pendingTerminal?.status === 'cancelled'
              ? { error: 'Cancelled' }
              : {}),
          ...(event.concurrencyGroupId === undefined
            ? {}
            : { concurrencyGroupId: event.concurrencyGroupId }),
        } satisfies Extract<OutputBlock, { kind: 'subagent' }>;
        const next = appendBlock(prepared, block);
        if (!pendingTerminal) return next;
        const pendingSubagentTerminals = new Map(prepared.pendingSubagentTerminals ?? []);
        pendingSubagentTerminals.delete(event.subagentId);
        return { ...next, pendingSubagentTerminals };
      }
    case 'subagent.step':
      return projectSubagentStep(state, event);
    case 'subagent.completed':
      return settleSubagent(state, event.subagentId, 'done', event, envelope);
    case 'subagent.failed':
      return settleSubagent(state, event.subagentId, 'error', event, envelope);
    case 'context.compaction':
      return appendNotice(
        settlePresentationBoundary(state),
        event.summary ?? `Context compaction ${event.status}.`,
      );
    case 'task.terminal':
      if (!terminalMatchesCurrentAuthority(state, event, envelope)) return state;
      return settleTerminal(state, event.summary, false, terminalOutcome(event.status));
    case 'turn.terminal':
      if (!terminalMatchesCurrentAuthority(state, event, envelope)) return state;
      return event.status === 'cancelled' && event.cause === 'user'
        ? settleUserCancelledTerminal(state)
        : {
            ...settleTerminal(state, event.summary, false, terminalOutcome(event.status)),
            cancelRequestedRunId: undefined,
          };
    case 'run.terminal': {
      if (!terminalMatchesCurrentAuthority(state, event, envelope)) return state;
      const currentRun = state.runtimeAuthority?.currentRun;
      const authoritative =
        currentRun?.runId === event.runId
          ? {
              ...state,
              runtimeAuthority: {
                ...state.runtimeAuthority!,
                currentRun: {
                  ...currentRun,
                  status: event.status,
                  ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
                },
              },
            }
          : state;
      const settled = settleTerminal(
        authoritative,
        event.summary,
        true,
        terminalOutcome(event.status),
      );
      if (event.status !== 'failed' || !event.outcome) return settled;
      return appendNotice(
        settled,
        event.outcome.safeRetry
          ? `MODEL_ATTEMPT_RETRYABLE_FAILURE:${event.outcome.reasonCode}`
          : `RUN_FAILURE:${event.outcome.reasonCode}`,
      );
    }
    case 'rewind.terminal':
      return event.status === 'failed'
        ? appendNotice(
            settlePresentationBoundary(state),
            `Rewind failed: ${event.failureCode ?? 'execution_failed'}.`,
          )
        : state;
    case 'session.notice':
      return appendNotice(settlePresentationBoundary(state), event.message ?? event.code);
    case 'unavailable':
      return appendNotice(
        settlePresentationBoundary(state),
        `Runtime update unavailable: ${event.reason}.`,
      );
  }
}

const MAX_PENDING_REQUEST_ASSEMBLIES = 64;
const MAX_REQUEST_ASSEMBLY_BYTES = 1_048_576;

function projectRequestAssemblies(state: TuiState, event: CoreRuntimeClientEvent): TuiState {
  const requests = new Map(state.requestAssemblies ?? []);
  const incomplete = new Set(state.requestAssemblyIncomplete ?? []);
  if (event.type === 'model.requested') {
    if (!requests.has(event.requestId) && requests.size >= MAX_PENDING_REQUEST_ASSEMBLIES) {
      // Overflow belongs to this request only.  Do not make a full assembly
      // map poison unrelated model terminals in the same Run.
      incomplete.add(event.requestId);
      return {
        ...state,
        requestAssemblyOverflow: true,
        requestAssemblyIncomplete: incomplete,
      };
    }
    incomplete.delete(event.requestId);
    requests.set(event.requestId, {
      state: 'collecting',
      requestId: event.requestId,
      text: '',
      reasoning: '',
      ...(state.currentThoughtSummaryId === undefined
        ? {}
        : { possibleThoughtId: state.currentThoughtSummaryId }),
    });
  } else if (event.type === 'model.text_delta' || event.type === 'reasoning.activity') {
    const current = requests.get(event.requestId);
    if (current?.state === 'presentation_incomplete' || incomplete.has(event.requestId))
      return state;
    const text =
      event.type === 'model.text_delta'
        ? mergeCumulativeText(current?.text, event.text)
        : (current?.text ?? '');
    const reasoning =
      event.type === 'reasoning.activity'
        ? mergeCumulativeText(current?.reasoning, event.text)
        : (current?.reasoning ?? '');
    if (
      new TextEncoder().encode(text).byteLength + new TextEncoder().encode(reasoning).byteLength >
      MAX_REQUEST_ASSEMBLY_BYTES
    ) {
      incomplete.add(event.requestId);
      requests.set(event.requestId, {
        state: 'presentation_incomplete',
        requestId: event.requestId,
        recovery: 'history',
      });
    } else {
      requests.set(event.requestId, {
        state: 'collecting',
        requestId: event.requestId,
        text,
        reasoning,
        ...(current && 'possibleThoughtId' in current && current.possibleThoughtId !== undefined
          ? { possibleThoughtId: current.possibleThoughtId }
          : {}),
      });
    }
  } else if (event.type === 'model.responded') {
    if (
      !requestPresentationIncomplete(state, event.requestId) &&
      !incomplete.has(event.requestId)
    ) {
      requests.delete(event.requestId);
      incomplete.delete(event.requestId);
    }
  } else if (event.type === 'run.terminal') {
    for (const [requestId, request] of requests) {
      if (request.state !== 'presentation_incomplete') requests.delete(requestId);
    }
  } else {
    return state;
  }
  return {
    ...state,
    requestAssemblies: requests,
    requestAssemblyIncomplete: incomplete,
    ...(event.type === 'run.terminal' ? { requestAssemblyOverflow: undefined } : {}),
  };
}

function continueActiveThought(state: TuiState, requestId: string): TuiState {
  if (state.currentModelRequestId === requestId) return state;
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (summary?.active !== true) return state;
  return replaceBlockById(state, summary.id, {
    ...summary,
    modelRequestId: requestId,
    liveModelStartedAt: Date.now(),
  });
}

/** Replace local interaction state with one complete authoritative Runtime queue. */
export function reconcileClientInteractionQueue(
  state: TuiState,
  queue: RuntimeInteractionQueueProjection,
): TuiState {
  const previousInterrupt = state.interrupt;
  const previousApprovals = state.pendingApprovals ?? new Map();
  const pendingApprovals = new Map<string, TuiPendingApproval>();
  for (const [sequence, interaction] of queue.interactions.entries()) {
    if (interaction.kind !== 'approval') continue;
    const previous = previousApprovals.get(interaction.interactionId);
    const owner = interaction.owner;
    const sameIdentity =
      previous?.generation === interaction.generation &&
      previous?.clientInteraction !== undefined &&
      interactionProjectionIdentity(previous.clientInteraction) ===
        interactionProjectionIdentity(interaction);
    pendingApprovals.set(interaction.interactionId, {
      interactionId: interaction.interactionId,
      toolCallId: owner.toolCallId,
      owner,
      route: previous?.route ?? 'user',
      status: sameIdentity ? previous.status : 'queued_user',
      sequence,
      generation: interaction.generation,
      clientInteraction: interaction,
      ...(sameIdentity && previous.result !== undefined ? { result: previous.result } : {}),
    });
  }
  let next: TuiState = {
    ...state,
    interrupt: null,
    activeApprovalId: null,
    pendingApprovals,
  };
  const active =
    queue.activeInteractionId === undefined
      ? undefined
      : queue.interactions.find(
          (interaction) => interaction.interactionId === queue.activeInteractionId,
        );
  if (!active) return next;
  if (active.kind === 'approval') {
    const pending = pendingApprovals.get(active.interactionId);
    if (!pending) return next;
    return {
      ...next,
      activeApprovalId: active.interactionId,
      interrupt: {
        kind: 'approval',
        interactionId: active.interactionId,
        toolCallId: pending.toolCallId,
      },
    };
  }
  if (
    previousInterrupt?.interactionId === active.interactionId &&
    previousInterrupt.projectionIdentity === interactionProjectionIdentity(active)
  ) {
    return { ...next, interrupt: previousInterrupt };
  }
  next = projectInteraction(next, active);
  return next;
}

function appendFinalOnce(state: TuiState, summary: string): TuiState {
  const last = state.turns.at(-1)?.blocks.at(-1);
  if (last?.kind === 'text') {
    if (last.streaming) {
      return replaceBlockById(state, last.id, { ...last, content: summary, streaming: false });
    }
    if (last.content === summary) return state;
  }
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'text',
    content: summary,
    streaming: false,
    presentationState: 'live',
  });
}

type ModelTextBlock = Extract<OutputBlock, { kind: 'text' }>;

const TABLE_PIPE_ = /[|│]/u;

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && TABLE_PIPE_.test(trimmed) && /^[\s\-:|─━┼╿]+$/u.test(trimmed);
}

function isTableRowLike(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    TABLE_PIPE_.test(trimmed) &&
    (/^[|│]/u.test(trimmed) || /[|│]$/u.test(trimmed) || isTableSeparatorLine(trimmed))
  );
}

/**
 * ADR-0045/0046 streaming commit boundary. Ordinary text stays hidden until
 * a complete paragraph/list item is proven. Recognized code/table shells may
 * stay as the one mutable structural component, but only complete child rows
 * enter that component.
 */
function splitStreamingMarkdown(content: string): {
  committed: string;
  live?: { kind: 'code' | 'table'; content: string };
} {
  let inFence = false;
  let boundary = -1;
  let lineStart = 0;
  let previousListItemStart = -1;
  let listItemIndent = -1;

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf('\n', lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex;
    const line = content.slice(lineStart, lineEnd);
    if (/^\s*```/u.test(line)) inFence = !inFence;

    if (!inFence) {
      const listMatch = line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+\S/u);
      if (listMatch) {
        const indent = listMatch[1]!.length;
        if (previousListItemStart < 0 || indent < listItemIndent) {
          previousListItemStart = lineStart;
          listItemIndent = indent;
        } else if (indent === listItemIndent) {
          boundary = lineStart;
          previousListItemStart = lineStart;
        }
      } else if (line.trim().length === 0) {
        previousListItemStart = -1;
        listItemIndent = -1;
        if (lineEnd + 1 < content.length) boundary = lineEnd + 1;
      } else if (/^\S/u.test(line) && previousListItemStart >= 0) {
        boundary = lineStart;
        previousListItemStart = -1;
        listItemIndent = -1;
      }
    }
    if (newlineIndex < 0) break;
    lineStart = lineEnd + 1;
  }

  if (boundary > 0) return { committed: content.slice(0, boundary) };

  const lines = content.split('\n');
  if (/^\s*```/u.test(lines[0] ?? '')) {
    const closingIndex = lines.findIndex((line, index) => index > 0 && /^\s*```\s*$/u.test(line));
    if (closingIndex >= 0) {
      return { committed: lines.slice(0, closingIndex + 1).join('\n') };
    }
    const completeEnd = content.lastIndexOf('\n') + 1;
    if (completeEnd > 0) {
      return {
        committed: '',
        live: { kind: 'code', content: content.slice(0, completeEnd) },
      };
    }
  }

  const completeEnd = content.lastIndexOf('\n') + 1;
  const completeLines =
    completeEnd > 0 ? content.slice(0, completeEnd).split('\n').slice(0, -1) : [];
  if (
    completeLines.length >= 2 &&
    isTableRowLike(completeLines[0] ?? '') &&
    isTableSeparatorLine(completeLines[1] ?? '')
  ) {
    return {
      committed: '',
      live: { kind: 'table', content: content.slice(0, completeEnd) },
    };
  }

  return { committed: '' };
}

function modelTextBlocks(state: TuiState, requestId: string): ModelTextBlock[] {
  return (state.turns.at(-1)?.blocks ?? []).filter(
    (block): block is ModelTextBlock => block.kind === 'text' && block.modelRequestId === requestId,
  );
}

function renderedModelTextSource(state: TuiState, requestId: string): string {
  return modelTextBlocks(state, requestId)
    .filter((block) => block.streamingSource === undefined)
    .map((block) => block.content)
    .join('');
}

function removeStreamingModelComponent(state: TuiState, requestId: string): TuiState {
  const turn = state.turns.at(-1);
  if (!turn) return state;
  const blocks = turn.blocks.filter(
    (block) =>
      block.kind !== 'text' ||
      block.modelRequestId !== requestId ||
      block.streamingComponent === undefined,
  );
  if (blocks.length === turn.blocks.length) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks };
  return { ...state, turns };
}

function showStreamingModelComponent(
  state: TuiState,
  requestId: string,
  source: string,
  live: { kind: 'code' | 'table'; content: string },
): TuiState {
  const pending = modelTextBlocks(state, requestId).find(
    (block) => block.streamingComponent !== undefined,
  );
  if (pending) {
    if (pending.content === live.content && pending.streamingSource === source) return state;
    return replaceBlockById(state, pending.id, {
      ...pending,
      content: live.content,
      streaming: true,
      streamingComponent: live.kind,
      streamingSource: source,
    });
  }
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'text',
    content: live.content,
    streaming: true,
    presentationState: 'live',
    streamingComponent: live.kind,
    streamingSource: source,
    modelRequestId: requestId,
  });
}

function prepareThoughtForCommittedText(
  state: TuiState,
  requestId: string,
): {
  state: TuiState;
  thoughtContent?: string;
  thoughtElapsedMs?: number;
} {
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary) return { state };
  if (summary.tools.length > 0) {
    return {
      state: {
        ...replaceBlockById(state, summary.id, settledSummary(summary)),
        currentThoughtSummaryId: undefined,
      },
    };
  }
  const timelineThought = [...(summary.timeline ?? [])]
    .reverse()
    .find((entry) => entry.kind === 'thinking')?.text;
  return {
    state: {
      ...removeBlockById(state, summary.id),
      currentThoughtSummaryId: undefined,
    },
    thoughtElapsedMs: summary.modelMs ?? summary.totalElapsedMs,
    ...(state.currentModelReasoningRequestId === requestId && state.currentModelReasoningText
      ? { thoughtContent: state.currentModelReasoningText }
      : timelineThought
        ? { thoughtContent: timelineThought }
        : {}),
  };
}

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
    modelTerminal: true,
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

function removeModelTextBlocks(state: TuiState, requestId: string): TuiState {
  const turns = state.turns.map((turn) => ({
    blocks: turn.blocks.filter(
      (block) => block.kind !== 'text' || block.modelRequestId !== requestId,
    ),
  }));
  return { ...state, turns };
}

function reconcileStreamedModelText(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'model.responded' }>,
): TuiState {
  let next = removeStreamingModelComponent(state, event.requestId);
  const rendered = modelTextBlocks(next, event.requestId).map((block) => block.content);
  const summary = event.summary ?? state.currentModelTextSource;
  if (summary === undefined || !/\S/u.test(summary)) return next;
  const joined = rendered.join('');
  if (joined === summary || rendered.join('\n') === summary) return next;

  if (summary.startsWith(joined)) {
    const remainder = summary.slice(joined.length);
    if (remainder.length === 0) return next;
    return appendBlock(next, {
      id: next.nextBlockId,
      kind: 'text',
      content: remainder,
      streaming: false,
      presentationState: 'live',
      modelRequestId: event.requestId,
    });
  }

  // The model gateway normally prefix-fences retries. If a terminal response
  // still diverges, replace the mutable projection before it can be frozen;
  // never splice a new suffix onto a mismatched Markdown document.
  next = removeModelTextBlocks(next, event.requestId);
  return appendBlock(next, {
    id: next.nextBlockId,
    kind: 'text',
    content: summary,
    streaming: false,
    presentationState: 'live',
    modelRequestId: event.requestId,
  });
}

function annotateFirstModelText(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'model.responded' }>,
  input: { thoughtContent?: string; thoughtElapsedMs?: number },
): TuiState {
  const first = modelTextBlocks(state, event.requestId)[0];
  if (!first) return state;
  return replaceBlockById(state, first.id, {
    ...first,
    streaming: false,
    modelRequestId: event.requestId,
    modelTerminal: true,
    ...(event.durationMs === undefined ? {} : { modelDurationMs: event.durationMs }),
    ...(input.thoughtElapsedMs === undefined
      ? first.thoughtElapsedMs === undefined &&
        first.thoughtContent !== undefined &&
        event.durationMs !== undefined
        ? { thoughtElapsedMs: event.durationMs }
        : {}
      : { thoughtElapsedMs: input.thoughtElapsedMs }),
    ...(input.thoughtContent === undefined ? {} : { thoughtContent: input.thoughtContent }),
  });
}

function projectReasoningActivity(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'reasoning.activity' }>,
): TuiState {
  if (requestPresentationIncomplete(state, event.requestId)) return state;
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
    if (answer.presentationState === 'sealed') {
      // The assembly may retain late reasoning for recovery/history, but a
      // sealed answer is immutable and cannot acquire a new Thinking header.
      return {
        ...cached,
        currentModelReasoningRequestId: undefined,
        currentModelReasoningSegmentId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
      };
    }
    if (state.currentModelTextStreamed === true) {
      // Content-first delivery has already established the visible answer as
      // the presentation owner. Keep late reasoning in RequestAssembly for
      // recovery, but do not retroactively insert a Thinking row ahead of
      // text the user has already seen.
      return {
        ...cached,
        currentModelReasoningRequestId: undefined,
        currentModelReasoningSegmentId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
      };
    }
    // The durable final response can overtake the provider's completed
    // reasoning packet during reconnect/replay. When it immediately follows
    // an exploration summary, that reasoning owns the same visual phase—not
    // a second, text-attached Thinking header.
    const preceding = precedingToolSummary(cached, answer.id);
    if (preceding?.modelRequestId === event.requestId) {
      const durationMs = answer.modelDurationMs;
      const modelMs = preceding.modelMs ?? durationMs;
      return replaceBlockById(cached, preceding.id, {
        ...preceding,
        ...(modelMs === undefined ? {} : { modelMs, totalElapsedMs: modelMs }),
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
  const activeSummary = findSummaryById(cached, cached.currentThoughtSummaryId);
  const bridgesCompletedExploration =
    cached.currentModelRequestId === undefined &&
    activeSummary?.active === true &&
    activeSummary.tools.length > 0 &&
    activeSummary.tools.every((tool) => tool.status !== 'queued' && tool.status !== 'running');
  // Ephemeral reasoning and durable model.requested use different delivery
  // lanes. The next invocation's reasoning can therefore reach the client
  // first. A terminal exploration tail is still the current Thought owner,
  // so adopt the new request instead of settling that owner and creating a
  // visually adjacent duplicate. An already-observed model request keeps the
  // normal strict identity path below.
  const continued = bridgesCompletedExploration
    ? continueActiveThought(cached, event.requestId)
    : cached;
  const next = ensureContentFreeThought(continued, event.requestId);
  if (event.state !== 'completed') return next;
  const summary = findSummaryById(next, next.currentThoughtSummaryId);
  if (!summary) return next;
  const text = next.currentModelReasoningText ?? event.text;
  return replaceBlockById(next, summary.id, {
    ...summary,
    hasThought: true,
    hasThinking: true,
    latestActivity: { kind: 'thinking', text },
    totalElapsedMs:
      summary.modelMs ?? Math.max(summary.totalElapsedMs, Date.now() - summary.createdAt),
    ...(event.state === 'completed' ? appendCompletedReasoning(summary, text) : {}),
  });
}

function projectModelTextDelta(
  state: TuiState,
  event: Extract<RuntimeClientEvent, { type: 'model.text_delta' }>,
): TuiState {
  if (requestPresentationIncomplete(state, event.requestId)) return state;
  if (state.settledModelRequestIds?.has(event.requestId)) return state;
  if (
    state.currentModelRequestId !== undefined &&
    state.currentModelRequestId !== event.requestId &&
    modelTextBlocks(state, event.requestId).length === 0
  ) {
    return state;
  }
  if (!/\S/u.test(event.text)) return state;

  const accepted = {
    ...state,
    currentModelTextStreamed: true as const,
    currentModelTextSource: event.text,
  };
  const activeSummary = findSummaryById(accepted, accepted.currentThoughtSummaryId);
  if (activeSummary?.active === true && activeSummary.modelRequestId === event.requestId) {
    // The provider does not reveal whether a response also contains tools
    // until model.responded. While a continuous exploration Thought owns the
    // request, keep cumulative text in the existing component splitter as a
    // classification-pending sequence. A final response will settle it as the
    // answer, while a tool-bearing response will remove it and keep the
    // progress caption on this same owner. Promoting a complete paragraph here
    // would irreversibly split the Thought before that classification is known.
    return accepted;
  }
  const renderedSource = renderedModelTextSource(accepted, event.requestId);
  if (!event.text.startsWith(renderedSource)) {
    // Retry visibility is prefix-fenced by the model gateway. A stale or
    // divergent ephemeral packet cannot rewrite already committed output;
    // the durable terminal remains the authoritative reconciliation point.
    return accepted;
  }
  const unpublishedSource = event.text.slice(renderedSource.length);
  if (unpublishedSource.length === 0) return accepted;
  const { committed, live } = splitStreamingMarkdown(unpublishedSource);

  if (!committed) {
    if (!live) return accepted;
    const prepared = prepareThoughtForCommittedText(
      removeStreamingModelComponent(awaitSafeThoughtTerminal(accepted), event.requestId),
      event.requestId,
    );
    let shown = showStreamingModelComponent(
      prepared.state,
      event.requestId,
      unpublishedSource,
      live,
    );
    const answer = findModelAnswerText(shown, event.requestId);
    if (answer) {
      shown = replaceBlockById(shown, answer.id, {
        ...answer,
        ...(prepared.thoughtElapsedMs === undefined
          ? {}
          : { thoughtElapsedMs: prepared.thoughtElapsedMs }),
        ...(prepared.thoughtContent === undefined
          ? {}
          : { thoughtContent: prepared.thoughtContent }),
      });
    }
    return shown;
  }

  const withoutLive = removeStreamingModelComponent(
    awaitSafeThoughtTerminal(accepted),
    event.requestId,
  );
  const prepared = prepareThoughtForCommittedText(withoutLive, event.requestId);
  const next = appendBlock(prepared.state, {
    id: prepared.state.nextBlockId,
    kind: 'text',
    content: committed,
    streaming: false,
    presentationState: 'live',
    modelRequestId: event.requestId,
    ...(prepared.thoughtElapsedMs === undefined
      ? {}
      : { thoughtElapsedMs: prepared.thoughtElapsedMs }),
    ...(prepared.thoughtContent === undefined ? {} : { thoughtContent: prepared.thoughtContent }),
  });
  return next;
}

function settledSummary(
  block: Extract<OutputBlock, { kind: 'tool_summary' }>,
): Extract<OutputBlock, { kind: 'tool_summary' }> {
  const toolsTerminal = block.tools.every(
    (tool) => tool.status !== 'queued' && tool.status !== 'running',
  );
  return {
    ...block,
    active: false,
    presentationState: toolsTerminal ? 'sealed' : 'live',
    latestActivity: undefined,
    totalElapsedMs: block.modelMs ?? Date.now() - block.createdAt,
    pendingCaption: undefined,
    ...(toolsTerminal ? { result: deriveToolSummaryResult(block.tools) } : {}),
  };
}

function detachFinalCaption(state: TuiState, caption: string): TuiState {
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary) return appendFinalOnce(state, caption);
  if (summary.tools.length === 0) {
    const timelineThought = [...(summary.timeline ?? [])]
      .reverse()
      .find((entry) => entry.kind === 'thinking')?.text;
    const turnIndex = state.turns.length - 1;
    const turns = state.turns.slice();
    const turn = turns[turnIndex]!;
    turns[turnIndex] = { blocks: turn.blocks.filter((block) => block.id !== summary.id) };
    return appendBlock(
      {
        ...state,
        turns,
        currentThoughtSummaryId: undefined,
      },
      {
        id: state.nextBlockId,
        kind: 'text',
        content: caption,
        streaming: false,
        presentationState: 'live',
        ...(summary.modelRequestId === undefined ? {} : { modelRequestId: summary.modelRequestId }),
        thoughtElapsedMs: summary.modelMs ?? summary.totalElapsedMs,
        ...(state.currentModelReasoningRequestId === summary.modelRequestId &&
        state.currentModelReasoningText
          ? { thoughtContent: state.currentModelReasoningText }
          : timelineThought
            ? { thoughtContent: timelineThought }
            : {}),
      },
    );
  }
  const settled = replaceBlockById(state, summary.id, settledSummary(summary));
  const appended = appendFinalOnce({ ...settled, currentThoughtSummaryId: undefined }, caption);
  const answer = appended.turns.at(-1)?.blocks.at(-1);
  return answer?.kind === 'text' && summary.modelRequestId !== undefined
    ? replaceBlockById(appended, answer.id, {
        ...answer,
        modelRequestId: summary.modelRequestId,
      })
    : appended;
}

function clearCompletedModelState(state: TuiState, requestId: string): TuiState {
  // `model.responded` is the sole model lifecycle terminal.  Mark every text
  // component owned by this request in one pass, including a remainder
  // appended while reconciling cumulative streaming text.  Timeline must not
  // infer terminality from `streaming === false` or from block position.
  const turns = state.turns.map((turn) => {
    let changed = false;
    const blocks = turn.blocks.map((block) => {
      if (
        (block.kind !== 'text' && block.kind !== 'tool_summary') ||
        block.modelRequestId !== requestId
      ) {
        return block;
      }
      if (block.kind === 'tool_summary') {
        if (block.modelTerminal === true) return block;
        changed = true;
        return { ...block, modelTerminal: true };
      }
      if (
        block.modelTerminal === true &&
        block.streaming !== true &&
        block.presentationState === 'sealed'
      ) {
        return block;
      }
      changed = true;
      return {
        ...block,
        modelTerminal: true,
        streaming: false,
        presentationState: 'sealed' as const,
      };
    });
    return changed ? { blocks } : turn;
  });
  const projectionChanged = turns.some((turn, index) => turn !== state.turns[index]);
  const nextState = projectionChanged ? { ...state, turns } : state;
  const settledModelRequestIds = new Set(state.settledModelRequestIds ?? []);
  settledModelRequestIds.add(requestId);
  while (settledModelRequestIds.size > 256) {
    const first = settledModelRequestIds.values().next().value;
    if (first === undefined) break;
    settledModelRequestIds.delete(first);
  }
  const ownsCurrentRequest = state.currentModelRequestId === requestId;
  const ownsReasoning = state.currentModelReasoningRequestId === requestId;
  return {
    ...nextState,
    settledModelRequestIds,
    ...(ownsCurrentRequest
      ? {
          currentModelRequestId: undefined,
          currentModelTextStreamed: undefined,
          currentModelTextSource: undefined,
        }
      : {}),
    ...(state.toolBearingModelRequestId === requestId
      ? { toolBearingModelRequestId: undefined, toolBearingPresentationGroupId: undefined }
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
  if (state.settledModelRequestIds?.has(event.requestId)) return state;
  const hasTerminalProjection = state.turns.some((turn) =>
    turn.blocks.some(
      (block) =>
        (block.kind === 'text' || block.kind === 'tool_summary') &&
        block.modelRequestId === event.requestId &&
        block.modelTerminal === true,
    ),
  );
  if (hasTerminalProjection) return state;
  const existingAnswer = findModelAnswerText(state, event.requestId);
  const activeSummary = findSummaryById(state, state.currentThoughtSummaryId);
  const requestWasAdmitted = state.requestAssemblies?.has(event.requestId) === true;
  if (
    state.currentModelRequestId !== undefined &&
    state.currentModelRequestId !== event.requestId &&
    state.toolBearingModelRequestId !== event.requestId &&
    activeSummary?.modelRequestId !== event.requestId &&
    existingAnswer === undefined &&
    !requestWasAdmitted
  ) {
    return state;
  }
  let next = state;
  if (
    event.toolCallCount > 0 &&
    findSummaryById(next, next.currentThoughtSummaryId) === undefined &&
    next.currentModelReasoningRequestId === event.requestId &&
    modelTextBlocks(next, event.requestId).length === 0
  ) {
    next = ensureContentFreeThought(next, event.requestId);
  }
  next = addSafeThoughtDuration(next, event.durationMs);
  const bufferedToolNarration =
    state.currentModelTextStreamed === true &&
    event.toolCallCount > 0 &&
    modelTextBlocks(next, event.requestId).length === 0;
  if (state.currentModelTextStreamed === true && !bufferedToolNarration) {
    next = reconcileStreamedModelText(next, event);
    const firstAnswer = modelTextBlocks(next, event.requestId)[0];
    const preceding = firstAnswer ? precedingToolSummary(next, firstAnswer.id) : undefined;
    const precedingOwnsReasoning = preceding?.modelRequestId === event.requestId;
    const current = findSummaryById(next, next.currentThoughtSummaryId);

    if (event.toolCallCount > 0) {
      let settled = next;
      if (current?.tools.length === 0) {
        settled = {
          ...removeBlockById(settled, current.id),
          currentThoughtSummaryId: undefined,
        };
        settled = annotateFirstModelText(settled, event, {
          thoughtElapsedMs: current.modelMs ?? current.totalElapsedMs,
          ...(state.currentModelReasoningRequestId === event.requestId &&
          state.currentModelReasoningText
            ? { thoughtContent: state.currentModelReasoningText }
            : {}),
        });
      } else {
        settled = settleCurrentThought(settled);
      }
      settled = clearCompletedModelState(settled, event.requestId);
      return {
        ...settled,
        toolBearingModelRequestId: event.requestId,
        toolBearingPresentationGroupId: event.messageId,
      };
    }

    let completed = next;
    if (current?.tools.length === 0) {
      completed = {
        ...removeBlockById(completed, current.id),
        currentThoughtSummaryId: undefined,
      };
      completed = annotateFirstModelText(completed, event, {
        thoughtElapsedMs: current.modelMs ?? current.totalElapsedMs,
        ...(state.currentModelReasoningRequestId === event.requestId &&
        state.currentModelReasoningText
          ? { thoughtContent: state.currentModelReasoningText }
          : {}),
      });
    } else {
      completed = settleCurrentThought(
        current?.pendingCaption === undefined
          ? completed
          : replaceBlockById(completed, current.id, {
              ...current,
              pendingCaption: undefined,
            }),
      );
      completed = annotateFirstModelText(
        completed,
        event,
        precedingOwnsReasoning || current?.tools.length
          ? {}
          : {
              ...(state.currentModelReasoningRequestId === event.requestId &&
              state.currentModelReasoningText
                ? { thoughtContent: state.currentModelReasoningText }
                : {}),
              ...(state.currentModelReasoningRequestId === event.requestId &&
              event.durationMs !== undefined
                ? { thoughtElapsedMs: event.durationMs }
                : {}),
            },
      );
    }
    return finalizeLastTurnStreaming(clearCompletedModelState(completed, event.requestId));
  }
  const streamedAnswer = existingAnswer ?? findModelAnswerText(next, event.requestId);
  if (streamedAnswer && event.toolCallCount === 0) {
    const current = findSummaryById(next, next.currentThoughtSummaryId);
    if (current?.tools.length === 0) {
      next = {
        ...removeBlockById(next, current.id),
        currentThoughtSummaryId: undefined,
      };
    } else if (current) {
      next = settleCurrentThought(next);
    }
    return finalizeLastTurnStreaming(
      clearCompletedModelState(annotateModelAnswer(next, event), event.requestId),
    );
  }
  if (event.toolCallCount > 0) {
    const hasNarration = event.summary !== undefined && /\S/u.test(event.summary);
    if (streamedAnswer) {
      // A component already published by model.text_delta is user-visible and
      // therefore remains a real presentation boundary even when the terminal
      // response also contains tools. Never pull painted output back into the
      // Thought owner.
      const prepared = prepareThoughtForCommittedText(next, event.requestId);
      next = prepared.state;
      next = replaceBlockById(next, streamedAnswer.id, {
        ...streamedAnswer,
        ...(hasNarration ? { content: event.summary! } : {}),
        streaming: false,
        modelRequestId: event.requestId,
        ...(event.durationMs === undefined ? {} : { modelDurationMs: event.durationMs }),
        ...(prepared.thoughtElapsedMs === undefined
          ? {}
          : { thoughtElapsedMs: prepared.thoughtElapsedMs }),
        ...(prepared.thoughtContent === undefined
          ? {}
          : { thoughtContent: prepared.thoughtContent }),
      });
    } else if (hasNarration) {
      // A terminal-only tool-bearing caption has never been painted. It is
      // progress narration inside the continuous exploration phase, not a
      // user-visible answer boundary. Keep it on the current owner so the
      // matching tools and following model invocation extend one Thought.
      const owner = findSummaryById(next, next.currentThoughtSummaryId);
      if (owner) {
        next = replaceBlockById(next, owner.id, {
          ...owner,
          modelRequestId: event.requestId,
          pendingCaption: mergeCumulativeText(owner.pendingCaption, event.summary!),
        });
      } else {
        // Without a live Thought there is no exploration owner to preserve.
        // Keep the model's visible text as an ordinary boundary; the later
        // tool presentation will decide its own standalone/exploration shape.
        next = appendBlock(next, {
          id: next.nextBlockId,
          kind: 'text',
          content: event.summary!,
          streaming: false,
          presentationState: 'live',
          modelRequestId: event.requestId,
          ...(event.durationMs === undefined ? {} : { modelDurationMs: event.durationMs }),
        });
      }
    }
    const remaining = findSummaryById(next, next.currentThoughtSummaryId);
    const resumed = remaining
      ? replaceBlockById(next, remaining.id, {
          ...remaining,
          modelRequestId: event.requestId,
          active: true,
        })
      : next;
    const completed = clearCompletedModelState(resumed, event.requestId);
    return {
      ...completed,
      toolBearingModelRequestId: event.requestId,
      toolBearingPresentationGroupId: event.messageId,
    };
  }
  if (
    streamedAnswer === undefined &&
    (event.summary === undefined || !/\S/u.test(event.summary)) &&
    next.currentModelReasoningRequestId === event.requestId &&
    next.currentModelReasoningText !== undefined &&
    findSummaryById(next, next.currentThoughtSummaryId) === undefined
  ) {
    return {
      ...next,
      currentModelRequestId: undefined,
      currentModelTextStreamed: undefined,
      currentModelTextSource: undefined,
      currentModelReasoningSegmentId: undefined,
      currentModelReasoningStreamed: false,
    };
  }
  const summary = findSummaryById(next, next.currentThoughtSummaryId);
  if (summary?.active && event.summary && /\S/u.test(event.summary)) {
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
  return finalizeLastTurnStreaming(
    clearCompletedModelState(annotateModelAnswer(completed, event), event.requestId),
  );
}

function settleUserCancelledTerminal(state: TuiState): TuiState {
  const cancelled = projectDurableUserCancelledTurn(state);
  const settled = settleCurrentThought(cancelled);
  return {
    ...settled,
    interrupt: null,
    pendingToolCalls: {},
    pendingApprovals: new Map(),
    activeApprovalId: null,
    cancelRequestedRunId: undefined,
    exited: false,
    currentModelRequestId: undefined,
    currentModelTextStreamed: undefined,
    currentModelTextSource: undefined,
    toolBearingModelRequestId: undefined,
    toolBearingPresentationGroupId: undefined,
    currentModelReasoningSegmentId: undefined,
    currentModelReasoningStreamed: false,
    currentModelReasoningText: undefined,
    currentModelReasoningRequestId: undefined,
  };
}

function terminalOutcome(
  status: 'completed' | 'cancelled' | 'failed' | 'aborted',
): PresentationTerminalOutcome {
  return status === 'failed' || status === 'aborted'
    ? 'failed'
    : status === 'cancelled'
      ? 'cancelled'
      : 'completed';
}

function settleTerminal(
  state: TuiState,
  summary: string | undefined,
  finalRun: boolean,
  outcome: PresentationTerminalOutcome,
): TuiState {
  const current = findSummaryById(state, state.currentThoughtSummaryId);
  const lastModelTextRequestId = [...(state.turns.at(-1)?.blocks ?? [])]
    .reverse()
    .find((block) => block.kind === 'text' && block.modelRequestId !== undefined);
  const terminalRequestId =
    current?.modelRequestId ??
    state.currentModelRequestId ??
    (lastModelTextRequestId?.kind === 'text' ? lastModelTextRequestId.modelRequestId : undefined);
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
  const ownedText = terminalRequestId ? modelTextBlocks(settled, terminalRequestId) : [];
  const alreadyRendered =
    summary !== undefined &&
    ownedText.length > 0 &&
    (ownedText.map((block) => block.content).join('') === summary ||
      ownedText.map((block) => block.content).join('\n') === summary);
  let next = summary === undefined || alreadyRendered ? settled : appendFinalOnce(settled, summary);
  const answer = next.turns.at(-1)?.blocks.at(-1);
  if (
    answer?.kind === 'text' &&
    terminalRequestId !== undefined &&
    answer.modelRequestId !== terminalRequestId
  ) {
    next = replaceBlockById(next, answer.id, {
      ...answer,
      modelRequestId: terminalRequestId,
    });
  } else if (answer?.kind === 'text' && terminalRequestId !== undefined) {
    next = replaceBlockById(next, answer.id, {
      ...answer,
      streaming: false,
    });
  }
  next = finalizeLastTurnStreaming(
    finalRun
      ? sealAllPresentationBlocks(next, outcome)
      : sealLastTurnPresentationBlocks(next, outcome),
  );
  return finalRun
    ? {
        ...next,
        cancelRequestedRunId: undefined,
        runStartTime: undefined,
        exited: true,
        currentModelRequestId: undefined,
        currentModelTextStreamed: undefined,
        currentModelTextSource: undefined,
        toolBearingModelRequestId: undefined,
        toolBearingPresentationGroupId: undefined,
        currentModelReasoningRequestId: undefined,
        currentModelReasoningSegmentId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
      }
    : next;
}

function settlePresentationBoundary(state: TuiState): TuiState {
  let prepared = state;
  if (
    state.currentThoughtSummaryId === undefined &&
    state.currentModelReasoningRequestId !== undefined &&
    state.currentModelReasoningText !== undefined
  ) {
    prepared = ensureContentFreeThought(state, state.currentModelReasoningRequestId);
  }
  const summary = findSummaryById(prepared, prepared.currentThoughtSummaryId);
  const settled = summary?.pendingCaption
    ? detachFinalCaption(prepared, summary.pendingCaption)
    : settleCurrentThought(prepared);
  // An interaction or standalone tool consumes the preceding reasoning as a
  // presentation phase. Later boundaries in the same tool batch must not
  // materialize that request-scoped payload again.
  return {
    ...settled,
    currentModelReasoningRequestId: undefined,
    currentModelReasoningSegmentId: undefined,
    currentModelReasoningStreamed: false,
    currentModelReasoningText: undefined,
  };
}

/**
 * Canonical projector boundary used by authoritative snapshots and process
 * lifecycle actions. Non-event reducers must not derive terminality from
 * OutputBlock variant fields themselves; they delegate this transition to
 * the same projector that owns live Runtime event settlement.
 */
export function projectPresentationBoundary(state: TuiState): TuiState {
  return finalizeLastTurnStreaming(settlePresentationBoundary(state));
}

function settleCurrentThought(state: TuiState): TuiState {
  const turnIndex = state.turns.length - 1;
  const turn = state.turns[turnIndex];
  if (!turn) {
    return {
      ...state,
      currentThoughtSummaryId: undefined,
    };
  }
  let changed = false;
  const blocks = turn.blocks.map((block) => {
    if (block.kind !== 'tool_summary' || !block.active) return block;
    changed = true;
    const toolsTerminal =
      block.tools.length > 0 &&
      block.tools.every((tool) => tool.status !== 'queued' && tool.status !== 'running');
    return {
      ...block,
      active: false,
      ...(block.tools.length === 0 || toolsTerminal
        ? { presentationState: 'sealed' as const }
        : { presentationState: 'live' as const }),
      ...(toolsTerminal ? { result: deriveToolSummaryResult(block.tools) } : {}),
    };
  });
  if (!changed && state.currentThoughtSummaryId === undefined) {
    return state;
  }
  const turns = state.turns.slice();
  turns[turnIndex] = { blocks };
  return { ...state, turns, currentThoughtSummaryId: undefined };
}

function awaitSafeThoughtTerminal(state: TuiState): TuiState {
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary?.active) return state;
  return {
    ...replaceBlockById(state, summary.id, {
      ...summary,
      active: false,
    }),
  };
}

function ensureContentFreeThought(state: TuiState, requestId?: string): TuiState {
  const current = findSummaryById(state, state.currentThoughtSummaryId);
  const currentOwnsRequest =
    current?.active === true &&
    (requestId === undefined ||
      current.modelRequestId === requestId ||
      (current.modelRequestId === undefined && current.tools.length === 0));
  if (current?.active && currentOwnsRequest) {
    return replaceBlockById(state, current.id, {
      ...current,
      ...(requestId === undefined ? {} : { modelRequestId: requestId }),
      ...(current.liveModelStartedAt === undefined ? { liveModelStartedAt: Date.now() } : {}),
      hasThought: true,
      hasThinking: true,
    });
  }
  const resumable =
    requestId === undefined
      ? undefined
      : findBlock(
          state,
          (block) =>
            block.kind === 'tool_summary' &&
            block.modelRequestId === requestId &&
            block.tools.length === 0 &&
            block.hasThinking === true,
        );
  if (resumable?.kind === 'tool_summary') {
    return {
      ...replaceBlockById(state, resumable.id, {
        ...resumable,
        active: true,
      }),
      currentThoughtSummaryId: resumable.id,
    };
  }
  const base = current?.active ? settleCurrentThought(state) : state;
  const block: Extract<OutputBlock, { kind: 'tool_summary' }> = {
    id: base.nextBlockId,
    kind: 'tool_summary',
    presentationState: 'live',
    tools: [],
    totalElapsedMs: 0,
    createdAt: Date.now(),
    liveModelStartedAt: Date.now(),
    summaryLine: '',
    active: true,
    ...(requestId === undefined ? {} : { modelRequestId: requestId }),
    hasThought: true,
    hasThinking: true,
  };
  const next = appendBlock(base, block);
  return {
    ...next,
    currentThoughtSummaryId: block.id,
  };
}

function addSafeThoughtDuration(state: TuiState, durationMs: number | undefined): TuiState {
  if (durationMs === undefined || durationMs < 0) return state;
  const summary = findSummaryById(state, state.currentThoughtSummaryId);
  if (!summary) return state;
  const visibleAnswerStarted =
    summary.modelRequestId !== undefined &&
    modelTextBlocks(state, summary.modelRequestId).length > 0;
  if (!summary.active && visibleAnswerStarted) return state;
  const modelMs = (summary.modelMs ?? 0) + durationMs;
  return replaceBlockById(state, summary.id, {
    ...summary,
    modelMs,
    totalElapsedMs: modelMs,
    liveModelStartedAt: undefined,
  });
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
    presentationState: isTerminalToolStatus(status) ? 'sealed' : 'live',
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
  if (existing?.kind !== 'tool_card') {
    return appendSafeTool(state, toolId, toolName, status, summary, args ?? {});
  }
  // Tool lifecycle is monotonic. Once terminal, a late progress/retry or
  // duplicate terminal fact cannot mutate the visible card.
  if (isTerminalToolStatus(existing.status)) return state;
  return replaceBlockById(state, existing.id, {
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
    presentationState: isTerminalToolStatus(status) ? 'sealed' : 'live',
    summary,
  });
}

type SafeToolStatus = Extract<OutputBlock, { kind: 'tool_card' }>['status'];
type ClientToolPresentation = RuntimeToolPresentation;

function isTerminalToolStatus(status: SafeToolStatus): boolean {
  return (
    status === 'done' ||
    status === 'error' ||
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'timeout' ||
    status === 'exhausted'
  );
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
  return event.presentation;
}

function eventPresentationGroupId(
  event: Extract<
    RuntimeClientEvent,
    { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
  >,
): string | undefined {
  const value = (event as unknown as { presentationGroupId?: unknown }).presentationGroupId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  if (state.pendingToolCalls[event.toolId] !== undefined) return state;
  const terminalCard = findBlock(
    state,
    (block) =>
      block.kind === 'tool_card' &&
      block.callId === event.toolId &&
      isTerminalToolStatus(block.status),
  );
  const terminalSummary = findBlock(
    state,
    (block) =>
      block.kind === 'tool_summary' &&
      block.tools.some((tool) => tool.callId === event.toolId && isTerminalToolStatus(tool.status)),
  );
  if (terminalCard !== undefined || terminalSummary !== undefined) return state;
  return {
    ...state,
    pendingToolCalls: {
      ...state.pendingToolCalls,
      [event.toolId]: {
        name: event.toolName ?? 'other',
        ...(event.displayLabel === undefined ? {} : { displayName: event.displayLabel }),
        args: { ...event.arguments },
        presentation: queuedToolPresentation(event),
        ...(event.presentationGroupId === undefined
          ? {}
          : { presentationGroupId: event.presentationGroupId }),
        ...(event.presentationGroupId !== undefined &&
        event.presentationGroupId === state.toolBearingPresentationGroupId &&
        state.toolBearingModelRequestId !== undefined
          ? { modelRequestId: state.toolBearingModelRequestId }
          : {}),
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
  toolName?: string,
  toolArgs?: Record<string, unknown>,
): TuiState {
  const current = summary.tools.find((tool) => tool.callId === toolId);
  if (current && isTerminalToolStatus(current.status)) return state;
  if (!current && !summary.active) return state;
  const nextTool: ConsolidatedToolEntry = {
    callId: toolId,
    name: toolName ?? 'other',
    args: toolArgs ?? {},
    status,
    ok: status === 'done',
    summary: toolSummary,
    ...(totalLines === undefined ? {} : { totalLines }),
  };
  const tools = current
    ? summary.tools.map((tool) =>
        tool.callId === toolId
          ? {
              ...tool,
              status,
              ok: status === 'done',
              summary: toolSummary,
              ...(totalLines === undefined ? {} : { totalLines }),
            }
          : tool,
      )
    : [...summary.tools, nextTool];
  const toolsTerminal = tools.every(
    (tool) => tool.status !== 'queued' && tool.status !== 'running',
  );
  return replaceBlockById(state, summary.id, {
    ...summary,
    tools,
    summaryLine: buildToolSummaryLine(tools),
    latestActivity: { kind: 'tool', callId: toolId },
    ...(toolsTerminal && !summary.active
      ? { presentationState: 'sealed' as const }
      : { presentationState: 'live' as const }),
    ...(summary.active ? {} : { result: deriveToolSummaryResult(tools) }),
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
  presentationGroupId?: string,
  modelRequestId?: string,
): TuiState {
  let withoutPending = removePendingTool(state, toolId);
  if (
    withoutPending.currentThoughtSummaryId === undefined &&
    modelRequestId !== undefined &&
    withoutPending.currentModelReasoningRequestId === modelRequestId &&
    withoutPending.currentModelReasoningText !== undefined
  ) {
    withoutPending = ensureContentFreeThought(withoutPending, modelRequestId);
  }
  const existing = findSummaryById(
    withoutPending,
    presentationGroupId === undefined
      ? withoutPending.explorationSummaryIds[toolId]
      : withoutPending.presentationGroupSummaryIds?.[presentationGroupId],
  );
  if (existing) {
    const updated = updateSafeSummaryEntry(
      withoutPending,
      existing,
      toolId,
      status,
      toolSummary,
      totalLines,
      toolName,
      args,
    );
    return {
      ...updated,
      explorationSummaryIds: {
        ...updated.explorationSummaryIds,
        [toolId]: existing.id,
      },
      ...(presentationGroupId === undefined
        ? {}
        : {
            presentationGroupSummaryIds: {
              ...updated.presentationGroupSummaryIds,
              [presentationGroupId]: existing.id,
            },
          }),
    };
  }

  let active = findSummaryById(withoutPending, withoutPending.currentThoughtSummaryId);
  if (
    active?.active === true &&
    presentationGroupId !== undefined &&
    active.presentationGroupId !== undefined &&
    active.presentationGroupId !== presentationGroupId
  ) {
    // Explicit Server group boundaries are stronger than arrival adjacency.
    // Close the previous read-only group before opening this one. A buffered
    // tool-bearing caption is progress owned by that group, not an answer to
    // detach as standalone text at the group boundary.
    const previousGroup = active.pendingCaption
      ? replaceBlockById(withoutPending, active.id, { ...active, pendingCaption: undefined })
      : withoutPending;
    withoutPending = settlePresentationBoundary(previousGroup);
    active = findSummaryById(withoutPending, withoutPending.currentThoughtSummaryId);
  }
  if (modelRequestId === undefined && active?.active === true && active.hasThought === true) {
    withoutPending = settlePresentationBoundary(withoutPending);
    active = findSummaryById(withoutPending, withoutPending.currentThoughtSummaryId);
  }
  const activeOwnsRequest =
    modelRequestId === undefined
      ? active?.modelRequestId === undefined &&
        active?.hasThought !== true &&
        (presentationGroupId === undefined || active?.presentationGroupId === presentationGroupId)
      : active?.modelRequestId === modelRequestId &&
        (presentationGroupId === undefined ||
          active?.presentationGroupId === undefined ||
          active?.presentationGroupId === presentationGroupId);
  if (active?.active && activeOwnsRequest) {
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
        ...(presentationGroupId === undefined || active.presentationGroupId !== undefined
          ? {}
          : { presentationGroupId }),
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
      ...(presentationGroupId === undefined
        ? {}
        : {
            presentationGroupSummaryIds: {
              ...withoutPending.presentationGroupSummaryIds,
              [presentationGroupId]: active.id,
            },
          }),
    };
  }

  const detachedFromActiveThought = active?.active === true && !activeOwnsRequest;
  const block: Extract<OutputBlock, { kind: 'tool_summary' }> = {
    id: withoutPending.nextBlockId,
    kind: 'tool_summary',
    presentationState: 'live',
    ...(presentationGroupId === undefined ? {} : { presentationGroupId }),
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
    active: !detachedFromActiveThought,
    ...(modelRequestId === undefined ? {} : { modelRequestId }),
    hasThought: false,
    latestActivity: { kind: 'tool', callId: toolId },
  };
  const next = appendBlock(withoutPending, block);
  if (detachedFromActiveThought) {
    return {
      ...next,
      explorationSummaryIds: { ...withoutPending.explorationSummaryIds, [toolId]: block.id },
      ...(presentationGroupId === undefined
        ? {}
        : {
            presentationGroupSummaryIds: {
              ...withoutPending.presentationGroupSummaryIds,
              [presentationGroupId]: block.id,
            },
          }),
    };
  }
  return {
    ...next,
    explorationSummaryIds: { ...withoutPending.explorationSummaryIds, [toolId]: block.id },
    ...(presentationGroupId === undefined
      ? {}
      : {
          presentationGroupSummaryIds: {
            ...withoutPending.presentationGroupSummaryIds,
            [presentationGroupId]: block.id,
          },
        }),
    currentThoughtSummaryId: block.id,
  };
}

function startSafeClientTool(state: TuiState, toolId: string, summary: string): TuiState {
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
      undefined,
      pending.presentationGroupId,
      pending.modelRequestId,
    );
  }
  let standaloneState = settlePresentationBoundary(removePendingTool(state, toolId));
  if (pending.presentationGroupId !== undefined) {
    const presentationGroupSummaryIds = { ...standaloneState.presentationGroupSummaryIds };
    delete presentationGroupSummaryIds[pending.presentationGroupId];
    standaloneState = { ...standaloneState, presentationGroupSummaryIds };
  }
  return appendSafeTool(
    standaloneState,
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
  status: Extract<SafeToolStatus, 'done' | 'error' | 'rejected' | 'cancelled' | 'exhausted'>,
): TuiState {
  const toolId = event.toolId;
  const toolName = 'toolName' in event ? event.toolName : undefined;
  const displayName = 'displayLabel' in event ? event.displayLabel : undefined;
  const pending = state.pendingToolCalls[toolId];
  // The queued admission carries the canonical descriptor label. Prefer it
  // over a terminal fallback category so a dynamic MCP tool keeps its exact
  // safe label through `started` and `finished` without re-decoding the
  // hashed model binding name.
  const resolvedDisplayName = pending?.displayName ?? displayName ?? toolName ?? pending?.name;
  const result = event.type === 'tool.finished' ? event.result : undefined;
  const resultName = toolName ?? pending?.name ?? 'other';
  const summary =
    result === undefined
      ? (event.summary ?? (status === 'cancelled' ? 'Cancelled.' : 'Tool execution failed.'))
      : formatToolResultForDisplay(resultName, result.stdout, result.stderr);
  const presentation = terminalToolPresentation(event);
  if (
    pendingPresentation(pending) === 'hidden' ||
    presentation === 'hidden' ||
    presentation === undefined
  ) {
    return removePendingTool(state, toolId);
  }
  const groupId = pending?.presentationGroupId ?? eventPresentationGroupId(event);
  const existing = findSummaryById(
    state,
    groupId === undefined
      ? state.explorationSummaryIds[toolId]
      : state.presentationGroupSummaryIds?.[groupId],
  );
  if (existing)
    return updateSafeSummaryEntry(
      removePendingTool(state, toolId),
      existing,
      toolId,
      status,
      summary,
      result?.totalLines,
      resolvedDisplayName,
      pending?.args,
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
      pending.presentationGroupId,
      pending.modelRequestId,
    );
  }
  if (pending) {
    // Cancellation remains invisible before dispatch. A rejection is retained
    // as a terminal diagnostic because policy rejection may have no separate
    // approval notice and must not disappear from the transcript.
    if (status === 'cancelled') {
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
      eventPresentationGroupId(event),
    );
  }
  if (
    event.type === 'tool.rejected' &&
    findBlock(state, (block) => block.kind === 'tool_card' && block.callId === toolId) === undefined
  ) {
    // A gap may omit the queued metadata for a call that never started. The
    // approval/interaction notice is still visible; inventing an anonymous
    // execution card would falsely imply dispatch.
    return state;
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
  const groupId = state.pendingToolCalls[event.toolId]?.presentationGroupId;
  const summary = findSummaryById(
    state,
    groupId === undefined
      ? state.explorationSummaryIds[event.toolId]
      : state.presentationGroupSummaryIds?.[groupId],
  );
  if (summary) {
    return updateSafeSummaryEntry(state, summary, event.toolId, 'running', event.summary);
  }
  const existing = findBlock(
    state,
    (block) => block.kind === 'tool_card' && block.callId === event.toolId,
  );
  if (existing?.kind !== 'tool_card') {
    // Progress is an ephemeral supplement, never an admission fact. Without
    // a durable queued/started projection there is no safe tool name,
    // presentation class, or execution state to render. Drop late progress
    // instead of inventing an anonymous card that could imply dispatch.
    return state;
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
      return projectQuestionInteraction(state, interaction, {
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
            projectionIdentity: interactionProjectionIdentity(interaction),
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
        interaction,
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
      return projectQuestionInteraction(state, interaction, {
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
  interaction: Exclude<RuntimeClientInteraction, { kind: 'approval' | 'plan_review' }>,
  question: Extract<OutputBlock, { kind: 'question' }>['question'],
): TuiState {
  const projectionIdentity = interactionProjectionIdentity(interaction);
  const existing = findBlock(
    state,
    (block) =>
      block.kind === 'question' &&
      block.interactionId === interaction.interactionId &&
      block.projectionIdentity === projectionIdentity,
  );
  if (existing?.kind === 'question') {
    if (existing.resolved !== undefined) return state;
    return {
      ...state,
      interrupt: {
        kind: 'input',
        blockId: existing.id,
        interactionId: interaction.interactionId,
        projectionIdentity,
      },
    };
  }
  if (
    state.interrupt?.kind === 'input' &&
    state.interrupt.interactionId === interaction.interactionId &&
    state.interrupt.projectionIdentity === projectionIdentity
  ) {
    return state;
  }
  const block: OutputBlock = {
    id: state.nextBlockId,
    kind: 'question',
    question,
    presentationState: 'live',
    interactionId: interaction.interactionId,
    projectionIdentity,
  };
  return {
    ...appendBlock(state, block),
    interrupt: {
      kind: 'input',
      blockId: block.id,
      interactionId: interaction.interactionId,
      projectionIdentity,
    },
  };
}

function interactionProjectionIdentity(interaction: RuntimeClientInteraction): string {
  const { sessionRevision: _sessionRevision, ...stable } = interaction;
  return JSON.stringify(stable);
}

function eventOwner(
  value: Extract<RuntimeClientEvent, { type: 'approval.granted' | 'approval.rejected' }>,
): TuiInteractionOwner {
  return value.owner;
}

function sameInteractionOwner(left: TuiInteractionOwner, right: TuiInteractionOwner): boolean {
  if (left.kind !== right.kind || left.toolCallId !== right.toolCallId) return false;
  return left.kind === 'root_tool'
    ? true
    : left.subagentId ===
        (right as Extract<TuiInteractionOwner, { kind: 'subagent_tool' }>).subagentId &&
        left.parentToolCallId ===
          (right as Extract<TuiInteractionOwner, { kind: 'subagent_tool' }>).parentToolCallId;
}

function projectApproval(
  state: TuiState,
  interaction: Extract<RuntimeClientInteraction, { kind: 'approval' }>,
  sequence: number,
): TuiState {
  const queue = new Map(state.pendingApprovals ?? []);
  const existing = queue.get(interaction.interactionId);
  const owner = interaction.owner;
  const childApprovalState =
    owner.kind === 'subagent_tool'
      ? findBlock(
          state,
          (candidate) => candidate.kind === 'subagent' && candidate.subagentId === owner.subagentId,
        )
      : undefined;
  const childQueueStatus =
    childApprovalState?.kind === 'subagent'
      ? childApprovalState.approvalState === 'queued_auto_review'
        ? ('queued_auto' as const)
        : childApprovalState.approvalState === 'auto_reviewing'
          ? ('auto_reviewing' as const)
          : childApprovalState.approvalState === 'queued_user_approval'
            ? ('queued_user' as const)
            : childApprovalState.approvalState === 'authorized_queued'
              ? ('authorized_queued' as const)
              : undefined
      : undefined;
  const sameIdentity =
    existing !== undefined &&
    existing.generation === interaction.generation &&
    sameInteractionOwner(existing.owner, owner);
  const pending: TuiPendingApproval = {
    interactionId: interaction.interactionId,
    toolCallId: owner.toolCallId,
    owner,
    route: sameIdentity ? (existing?.route ?? 'user') : 'user',
    status: sameIdentity
      ? (existing?.status ?? childQueueStatus ?? 'awaiting_user')
      : (childQueueStatus ?? 'awaiting_user'),
    sequence: sameIdentity ? (existing?.sequence ?? sequence) : sequence,
    generation: interaction.generation,
    clientInteraction: interaction,
    ...(sameIdentity && existing?.result !== undefined ? { result: existing.result } : {}),
  };
  queue.set(interaction.interactionId, pending);
  const focusable = pending.status === 'queued_user' || pending.status === 'awaiting_user';
  const replacingFocusedGeneration =
    !sameIdentity && state.activeApprovalId === interaction.interactionId;
  const next = {
    ...state,
    pendingApprovals: queue,
    ...(replacingFocusedGeneration ? { activeApprovalId: null, interrupt: null } : {}),
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
  return childQueueStatus === 'queued_auto' ||
    childQueueStatus === 'auto_reviewing' ||
    childQueueStatus === 'authorized_queued'
    ? next
    : updateSubagentApproval(next, owner, 'queued');
}

function settleApproval(
  state: TuiState,
  interactionId: string,
  result: 'authorized' | 'rejected',
  generation: number,
  owner: TuiInteractionOwner,
  summary?: string,
): TuiState {
  const queue = new Map(state.pendingApprovals ?? []);
  const pending = queue.get(interactionId);
  if (!pending) return state;
  if (pending.generation !== generation) return state;
  if (!sameInteractionOwner(pending.owner, owner)) return state;
  if (pending.result !== undefined) {
    // A duplicate terminal is idempotent; a contradictory terminal belongs
    // to another generation/owner and must not change this projection.
    return state;
  }
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
  const withChild = updateSubagentApproval(next, pending.owner, result, summary);
  return summary ? appendNotice(withChild, summary) : withChild;
}

function updateSubagentApproval(
  state: TuiState,
  owner: TuiInteractionOwner,
  phase: 'queued' | 'authorized' | 'rejected',
  summary?: string,
): TuiState {
  if (owner.kind !== 'subagent_tool') return state;
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'subagent' && candidate.subagentId === owner.subagentId,
  );
  if (block?.kind !== 'subagent') return state;
  if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') {
    return state;
  }
  const steps = block.steps.map((step) =>
    step.toolCallId === owner.toolCallId
      ? {
          ...step,
          status:
            phase === 'rejected'
              ? ('rejected' as const)
              : phase === 'authorized'
                ? ('pending' as const)
                : ('awaiting_approval' as const),
          ...(summary === undefined ? {} : { summary }),
          ...(phase === 'rejected' ? { ok: false } : {}),
        }
      : step,
  );
  return replaceBlockById(state, block.id, {
    ...block,
    status: 'suspended',
    parentToolCallId: owner.parentToolCallId,
    approvalState:
      phase === 'queued'
        ? 'awaiting_user'
        : phase === 'authorized'
          ? 'authorized_queued'
          : 'awaiting_user',
    awaitingApproval: true,
    steps,
  });
}

function settleInteraction(
  state: TuiState,
  interactionId: string,
  outcome: 'completed' | 'rejected' | 'cancelled' | 'expired',
  summary?: string,
): TuiState {
  const active = state.interrupt;
  let cleared = state;
  if (active?.interactionId === interactionId) {
    cleared = { ...state, interrupt: null };
  }
  const question = findBlock(
    cleared,
    (block) => block.kind === 'question' && block.interactionId === interactionId,
  );
  if (question?.kind === 'question' && question.resolved !== undefined) {
    // A durable interaction is a one-way presentation settlement. A replayed
    // or late answer/cancel packet must not append a second local notice or
    // reopen the Footer after the question item was sealed.
    return state;
  }
  if (question?.kind === 'question' && question.resolved === undefined) {
    const resolved = summary ?? (outcome === 'completed' ? '' : outcome);
    cleared = replaceBlockById(cleared, question.id, {
      ...question,
      resolved,
      presentationState: 'sealed',
    });
  }
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
  if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') {
    // A child terminal is a one-way fence.  Replayed/late child tool facts
    // remain diagnostic-only and can never reopen the sealed card.
    return state;
  }
  // Contract validation guarantees both stable identities. Keep a defensive
  // guard here so a malformed in-process value cannot create an unaddressable
  // step even if it bypasses the envelope validator.
  if (
    typeof event.stepId !== 'string' ||
    typeof event.toolCallId !== 'string' ||
    event.stepId.length === 0 ||
    event.toolCallId.length === 0
  ) {
    return state;
  }
  const { stepId, toolCallId } = event;
  const eventStatus = event.status;
  const stepStatus =
    eventStatus === 'started'
      ? ('pending' as const)
      : eventStatus === 'completed'
        ? ('success' as const)
        : eventStatus === 'cancelled'
          ? ('cancelled' as const)
          : ('error' as const);
  const visibleToolName = event.displayLabel ?? event.toolName;
  const stepIdentityIndex = block.steps.findIndex((step) => step.stepId === stepId);
  const toolIdentityIndex = block.steps.findIndex((step) => step.toolCallId === toolCallId);
  // Existing steps are addressed by the pair, never by either half. A packet
  // that matches only stepId or only toolCallId is ambiguous and must not
  // mutate the card.
  if (
    (stepIdentityIndex >= 0 || toolIdentityIndex >= 0) &&
    (stepIdentityIndex < 0 || toolIdentityIndex < 0 || stepIdentityIndex !== toolIdentityIndex)
  ) {
    return state;
  }
  const identityIndex = stepIdentityIndex >= 0 ? stepIdentityIndex : undefined;
  const pendingIndex = identityIndex;
  const existingAtIdentity = identityIndex === undefined ? undefined : block.steps[identityIndex];
  if (
    existingAtIdentity &&
    existingAtIdentity.status !== 'pending' &&
    existingAtIdentity.status !== 'awaiting_approval'
  ) {
    return state;
  }
  const steps =
    pendingIndex === undefined
      ? [
          ...block.steps,
          {
            stepId,
            toolCallId,
            toolName: visibleToolName,
            toolArgs: { ...(event.arguments ?? {}) },
            status: stepStatus,
            ...(eventStatus === 'completed'
              ? { ok: true }
              : eventStatus === 'failed'
                ? { ok: false }
                : eventStatus === 'cancelled'
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
                ...(eventStatus === 'completed'
                  ? { ok: true }
                  : eventStatus === 'failed'
                    ? { ok: false }
                    : eventStatus === 'cancelled'
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

function projectSubagentPhase(state: TuiState, event: SubagentPhaseEvent): TuiState {
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'subagent' && candidate.subagentId === event.subagentId,
  );
  if (block?.kind !== 'subagent') return state;
  if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') {
    return state;
  }
  const waiting =
    event.status === 'suspended' ||
    event.approvalState === 'queued_auto_review' ||
    event.approvalState === 'auto_reviewing' ||
    event.approvalState === 'queued_user_approval' ||
    event.approvalState === 'awaiting_user' ||
    event.approvalState === 'authorized_queued';
  const clearApprovalState = event.status === 'running' && event.approvalState === undefined;
  let next = replaceBlockById(state, block.id, {
    ...block,
    status: event.status,
    parentToolCallId: event.parentToolCallId,
    ...(clearApprovalState
      ? { approvalState: undefined }
      : event.approvalState === undefined
        ? {}
        : { approvalState: event.approvalState }),
    awaitingApproval: waiting,
  });
  if (event.interactionId !== undefined && event.approvalState !== undefined) {
    const approval = next.pendingApprovals?.get(event.interactionId);
    if (approval) {
      const queue = new Map(next.pendingApprovals);
      const status =
        event.approvalState === 'queued_auto_review'
          ? ('queued_auto' as const)
          : event.approvalState === 'auto_reviewing'
            ? ('auto_reviewing' as const)
            : event.approvalState === 'queued_user_approval'
              ? ('queued_user' as const)
              : event.approvalState === 'authorized_queued'
                ? ('authorized_queued' as const)
                : ('awaiting_user' as const);
      queue.set(event.interactionId, { ...approval, status });
      next = {
        ...next,
        pendingApprovals: queue,
        ...(status === 'queued_auto' ||
        status === 'auto_reviewing' ||
        status === 'authorized_queued'
          ? next.activeApprovalId === event.interactionId
            ? { activeApprovalId: null, interrupt: null }
            : {}
          : {}),
      };
    }
  }
  return next;
}

function projectSubagentReview(state: TuiState, event: SubagentReviewEvent): TuiState {
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'subagent' && candidate.subagentId === event.subagentId,
  );
  if (block?.kind !== 'subagent') return state;
  if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') {
    return state;
  }
  const stepIndex = [...block.steps]
    .map((step, index) => ({ step, index }))
    .reverse()
    .find(({ step }) => step.toolCallId === event.toolCallId)?.index;
  const nextStepStatus =
    event.status === 'rejected'
      ? ('rejected' as const)
      : event.status === 'failed'
        ? ('error' as const)
        : ('awaiting_approval' as const);
  const steps =
    stepIndex === undefined
      ? block.steps
      : block.steps.map((step, index) =>
          index === stepIndex
            ? {
                ...step,
                status: event.status === 'approved' ? ('pending' as const) : nextStepStatus,
                ...(event.summary === undefined ? {} : { summary: event.summary }),
                ...(event.status === 'rejected' || event.status === 'failed' ? { ok: false } : {}),
              }
            : step,
        );
  const approvalState =
    event.status === 'queued'
      ? ('queued_auto_review' as const)
      : event.status === 'reviewing'
        ? ('auto_reviewing' as const)
        : event.status === 'approved'
          ? ('authorized_queued' as const)
          : ('awaiting_user' as const);
  return replaceBlockById(state, block.id, {
    ...block,
    status: 'suspended',
    parentToolCallId: event.parentToolCallId,
    approvalState,
    awaitingApproval: true,
    steps,
    ...(event.summary === undefined ? {} : { summary: event.summary }),
  });
}

function settleSubagent(
  state: TuiState,
  subagentId: string,
  status: 'done' | 'error',
  event: Extract<RuntimeClientEvent, { type: 'subagent.completed' | 'subagent.failed' }>,
  envelope: AcceptedPresentationEnvelope,
): TuiState {
  const block = findBlock(
    state,
    (candidate) => candidate.kind === 'subagent' && candidate.subagentId === subagentId,
  );
  if (block?.kind === 'subagent') {
    // Child terminality is monotonic.  A reconnect/replay duplicate and a
    // contradictory late terminal must not rewrite a sealed child card.
    if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') {
      return state;
    }
    return replaceBlockById(state, block.id, {
      ...block,
      status,
      presentationState: 'sealed',
      summary: event.summary,
      ...(event.toolCallCount === undefined ? {} : { toolCallCount: event.toolCallCount }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(status === 'error' ? { error: event.summary } : {}),
      ...(event.type === 'subagent.failed' && event.diagnostic !== undefined
        ? { failureDiagnostic: event.diagnostic }
        : {}),
    });
  }

  // A terminal can win delivery order over subagent.started after a receipt
  // join.  Keep a bounded identity-keyed pending terminal instead of emitting
  // an anonymous notice; started will consume it and create exactly one card.
  const pendingSubagentTerminals = new Map(state.pendingSubagentTerminals ?? []);
  if (pendingSubagentTerminals.has(subagentId)) return state;
  pendingSubagentTerminals.set(subagentId, {
    status,
    summary: event.summary,
    ...(envelope.durability === 'durable' && envelope.revision !== undefined
      ? { revision: envelope.revision }
      : {}),
    ...(event.toolCallCount === undefined ? {} : { toolCallCount: event.toolCallCount }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.type === 'subagent.failed' && event.diagnostic !== undefined
      ? { diagnostic: event.diagnostic }
      : {}),
  });
  while (pendingSubagentTerminals.size > 64) {
    const first = pendingSubagentTerminals.keys().next().value;
    if (first === undefined) break;
    pendingSubagentTerminals.delete(first);
    // A terminal that cannot be joined to a started child is still a
    // Runtime fact. Once the bounded join window is full, preserve an
    // explicit, sealed diagnostic rather than silently losing the outcome or
    // inventing an anonymous child card.
    const withDiagnostic = appendNotice(
      state,
      'Runtime update unavailable: a subagent result arrived before its start and exceeded the recovery window.',
    );
    state = withDiagnostic;
  }
  return { ...state, pendingSubagentTerminals };
}

function appendNotice(state: TuiState, text: string): TuiState {
  return appendBlock(state, {
    id: state.nextBlockId,
    kind: 'text',
    content: text,
    streaming: false,
    presentationState: 'sealed',
  });
}
