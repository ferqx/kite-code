import type { RuntimeEffect } from './effects';
import type { RuntimeEvent } from './events';
import { reduce } from './kernel';
import { normalizeAgentEvent } from './normalization';
import type { AgentState } from './state';

export interface AgentEffectLeaseIdentity {
  readonly turnId: string;
  readonly effect: RuntimeEffect;
}

export interface SuspendedCapabilityTerminalRequirement {
  readonly invocationId: string;
  readonly toolCallId: string;
}

type CapabilityTerminalEvent = Extract<
  RuntimeEvent,
  {
    type:
      | 'capability.execution_succeeded'
      | 'capability.execution_failed'
      | 'capability.execution_unknown'
      | 'capability.reconciliation_resolved';
  }
>;

function isCapabilityTerminalEvent(event: RuntimeEvent): event is CapabilityTerminalEvent {
  return (
    event.type === 'capability.execution_succeeded' ||
    event.type === 'capability.execution_failed' ||
    event.type === 'capability.execution_unknown' ||
    event.type === 'capability.reconciliation_resolved'
  );
}

function isToolTerminalEvent(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
> {
  return (
    event.type === 'tool.finished' ||
    event.type === 'tool.failed' ||
    event.type === 'tool.rejected' ||
    event.type === 'tool.cancelled'
  );
}

/**
 * Determine which suspended capability receipts require Host-supplied terminal timestamps.
 * The Kernel never reads a clock; callers must bind every returned invocation exactly once.
 */
export function suspendedCapabilityTerminalRequirements(
  state: Readonly<AgentState>,
  events: readonly RuntimeEvent[],
): readonly SuspendedCapabilityTerminalRequirement[] {
  const terminalInvocationIds = new Set(
    events.filter(isCapabilityTerminalEvent).map((event) => event.invocationId),
  );
  const requirements: SuspendedCapabilityTerminalRequirement[] = [];
  for (const event of events) {
    if (!isToolTerminalEvent(event)) continue;
    for (const invocation of Object.values(state.capabilities.invocations)) {
      if (
        invocation.toolCallId !== event.toolCallId ||
        (invocation.status !== 'recorded' && invocation.status !== 'running') ||
        terminalInvocationIds.has(invocation.invocationId)
      ) {
        continue;
      }
      terminalInvocationIds.add(invocation.invocationId);
      requirements.push({
        invocationId: invocation.invocationId,
        toolCallId: invocation.toolCallId,
      });
    }
  }
  return requirements;
}

/** Close every live capability in the same atomic Tool-terminal batch. */
export function attachSuspendedCapabilityTerminals(
  state: Readonly<AgentState>,
  events: readonly RuntimeEvent[],
  finishedAtByInvocationId: Readonly<Record<string, string>>,
): readonly RuntimeEvent[] {
  const output: RuntimeEvent[] = [];
  const suppliedTerminals = new Map(
    events.filter(isCapabilityTerminalEvent).map((event) => [event.invocationId, event]),
  );
  const emittedTerminalIds = new Set<string>();
  for (const event of events) {
    if (isCapabilityTerminalEvent(event)) {
      if (!emittedTerminalIds.has(event.invocationId)) {
        output.push(event);
        emittedTerminalIds.add(event.invocationId);
      }
      continue;
    }
    if (!isToolTerminalEvent(event)) {
      output.push(event);
      continue;
    }
    for (const invocation of Object.values(state.capabilities.invocations)) {
      if (
        invocation.toolCallId !== event.toolCallId ||
        (invocation.status !== 'recorded' && invocation.status !== 'running') ||
        emittedTerminalIds.has(invocation.invocationId)
      ) {
        continue;
      }
      const supplied = suppliedTerminals.get(invocation.invocationId);
      if (supplied) {
        output.push(supplied);
        emittedTerminalIds.add(invocation.invocationId);
        continue;
      }
      const finishedAt = finishedAtByInvocationId[invocation.invocationId];
      if (!finishedAt || !Number.isFinite(Date.parse(finishedAt))) {
        throw new Error(
          `Suspended capability terminal ${invocation.invocationId} requires a valid Host timestamp.`,
        );
      }
      if (!invocation.artifact || !invocation.resultDigest || !invocation.evidenceDigest) {
        output.push({
          type: 'capability.execution_unknown',
          invocationId: invocation.invocationId,
          reason: 'Suspended Tool terminal has no committed capability result evidence.',
          finishedAt,
        });
      } else if (event.type === 'tool.finished' && event.result.ok) {
        output.push({
          type: 'capability.execution_succeeded',
          invocationId: invocation.invocationId,
          resultDigest: invocation.resultDigest,
          evidenceDigest: invocation.evidenceDigest,
          finishedAt,
          artifact: invocation.artifact,
          ...(invocation.externalReferences
            ? { externalReferences: invocation.externalReferences }
            : {}),
        });
      } else {
        const error =
          event.type === 'tool.finished'
            ? event.result.stderr || 'Suspended Tool interaction did not succeed.'
            : event.type === 'tool.failed'
              ? event.failure.message
              : event.reason;
        output.push({
          type: 'capability.execution_failed',
          invocationId: invocation.invocationId,
          error,
          resultDigest: invocation.resultDigest,
          evidenceDigest: invocation.evidenceDigest,
          finishedAt,
          artifact: invocation.artifact,
        });
      }
      emittedTerminalIds.add(invocation.invocationId);
    }
    output.push(event);
  }
  return output;
}

/** Enforce governed capability receipt + Tool terminal atomicity. */
export function assertCapabilityToolTerminalBatch(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentity,
  events: readonly RuntimeEvent[],
): void {
  if (lease.effect.type !== 'run_tools') return;
  const capabilityTerminals = events.filter(isCapabilityTerminalEvent);
  for (const terminal of capabilityTerminals) {
    const invocation = state.capabilities.invocations[terminal.invocationId];
    if (!invocation?.receiptRequirement) continue;
    if (
      (terminal.type === 'capability.execution_succeeded' ||
        terminal.type === 'capability.execution_failed') &&
      terminal.artifact?.kind !== 'capability_result'
    ) {
      throw new Error('Governed capability terminal requires a private result Artifact.');
    }
    const matchingToolTerminal = events.some(
      (event) => isToolTerminalEvent(event) && event.toolCallId === invocation.toolCallId,
    );
    if (!matchingToolTerminal) {
      throw new Error('Capability receipt and Tool terminal must commit in one atomic batch.');
    }
  }
  for (const event of events) {
    if (event.type !== 'verification.requested') continue;
    const sourceIds = event.spec.checks.flatMap((check) => {
      if (check.type === 'schema' && check.subject.kind === 'capability_artifact') {
        return [check.subject.invocationId];
      }
      if (
        check.type === 'mcp_read_after_write' ||
        check.type === 'external_reference' ||
        check.type === 'receipt'
      ) {
        return [check.invocationId];
      }
      return [];
    });
    for (const invocationId of sourceIds) {
      const invocation = state.capabilities.invocations[invocationId];
      if (!invocation?.receiptRequirement) continue;
      if (
        !capabilityTerminals.some(
          (terminal) =>
            terminal.type === 'capability.execution_succeeded' &&
            terminal.invocationId === invocationId,
        )
      ) {
        throw new Error('Verification cannot reference an uncommitted capability receipt.');
      }
    }
  }
}

/** Reject late success/failure/rejection for a Tool already durably cancelled. */
export function hasLateTerminalEventForCancelledTool(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentity,
  events: readonly RuntimeEvent[],
): boolean {
  if (lease.effect.type !== 'run_tools') return false;
  return events.some(
    (event) =>
      (event.type === 'tool.finished' ||
        event.type === 'tool.failed' ||
        event.type === 'tool.rejected') &&
      state.tools.calls[event.toolCallId]?.status === 'cancelled',
  );
}

/**
 * Shell siblings from one response may finish across unrelated revisions, but
 * only while the exact Tool/capability identity is still live.
 */
export function isConcurrentShellEffectEventCurrent(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentity,
  event: RuntimeEvent,
): boolean {
  if (lease.turnId !== state.turn.turnId || lease.effect.type !== 'run_tools') return false;
  if (
    event.type === 'capability.execution_started' ||
    event.type === 'capability.execution_succeeded' ||
    event.type === 'capability.execution_failed' ||
    event.type === 'capability.execution_unknown' ||
    event.type === 'capability.sandbox_preparation_intent_recorded' ||
    event.type === 'capability.sandbox_preparation_ready' ||
    event.type === 'capability.sandbox_execution_dispatch_intent_recorded' ||
    event.type === 'capability.sandbox_execution_supervisor_started' ||
    event.type === 'capability.sandbox_disposal_started' ||
    event.type === 'capability.sandbox_disposal_completed' ||
    event.type === 'capability.sandbox_preparation_abandonment_started' ||
    event.type === 'capability.sandbox_preparation_abandonment_completed'
  ) {
    const invocation = state.capabilities.invocations[event.invocationId];
    if (!invocation || !lease.effect.toolCallIds.includes(invocation.toolCallId)) return false;
    const call = state.tools.calls[invocation.toolCallId];
    return (
      call?.name === 'shell_execute' &&
      (call.status === 'queued' ||
        call.status === 'approved' ||
        call.status === 'authorized_queued' ||
        call.status === 'running')
    );
  }
  if (!('toolCallId' in event) || typeof event.toolCallId !== 'string') return false;
  if (!lease.effect.toolCallIds.includes(event.toolCallId)) return false;
  const call = state.tools.calls[event.toolCallId];
  if (call?.name !== 'shell_execute') return false;
  switch (event.type) {
    case 'approval.requested':
    case 'auto_review.requested':
      return call.status === 'queued';
    case 'tool.started':
      return (
        call.status === 'queued' ||
        call.status === 'approved' ||
        call.status === 'authorized_queued'
      );
    case 'capability.invocation_recorded':
      return (
        call.status === 'queued' ||
        call.status === 'approved' ||
        call.status === 'authorized_queued' ||
        call.status === 'running'
      );
    case 'tool.progress':
    case 'tool.finished':
      return call.status === 'running';
    case 'tool.failed':
    case 'tool.rejected':
      return (
        call.status === 'queued' ||
        call.status === 'approved' ||
        call.status === 'authorized_queued' ||
        call.status === 'running'
      );
    case 'runtime.cancellation_diagnostic':
      return call.status === 'cancelled' || call.status === 'running';
    default:
      return false;
  }
}

/** Validate a concurrent Shell batch against each projected intermediate State value. */
export function isConcurrentShellEffectBatchCurrent(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentity,
  events: readonly RuntimeEvent[],
  occurredAtForEvent: (index: number) => string,
): boolean {
  let projectedState = state;
  for (const [index, event] of events.entries()) {
    if (!isConcurrentShellEffectEventCurrent(projectedState, lease, event)) return false;
    const occurredAt = occurredAtForEvent(index);
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return false;
    const canonicalEvent = normalizeAgentEvent(event, projectedState, occurredAt);
    projectedState = reduce(projectedState, [canonicalEvent]);
  }
  return true;
}

function modelInvocationIdForConcurrentBatch(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentity,
  events: readonly RuntimeEvent[],
): string | undefined {
  if (
    lease.turnId !== state.turn.turnId ||
    state.turn.status !== 'active' ||
    lease.effect.type !== 'call_model'
  ) {
    return undefined;
  }
  const first = events[0];
  if (!first) return undefined;
  if (
    first.type === 'model.reasoning_delta' ||
    first.type === 'model.reasoning_completed' ||
    first.type === 'model.text_delta'
  ) {
    const invocation = state.modelInvocations[first.requestId];
    return events.length === 1 && invocation?.status === 'dispatching'
      ? first.requestId
      : undefined;
  }
  if (first.type === 'model.retry') {
    const invocation = state.modelInvocations[first.invocationId];
    return events.length === 1 && invocation?.status === 'dispatching'
      ? first.invocationId
      : undefined;
  }
  if (
    first.type !== 'model.invocation_completed' &&
    first.type !== 'model.invocation_interrupted'
  ) {
    return undefined;
  }
  const invocation = state.modelInvocations[first.invocationId];
  if (first.type === 'model.invocation_completed' && invocation?.status !== 'dispatching') {
    return undefined;
  }
  if (
    first.type === 'model.invocation_interrupted' &&
    invocation?.status !== 'prepared' &&
    invocation?.status !== 'dispatching'
  ) {
    return undefined;
  }
  return first.invocationId;
}

function isConcurrentModelEffectEvent(
  state: Readonly<AgentState>,
  event: RuntimeEvent,
  invocationId: string,
  terminalType: RuntimeEvent['type'],
  index: number,
): boolean {
  const invocation = state.modelInvocations[invocationId];
  if (index === 0) {
    if (
      terminalType === 'model.reasoning_delta' ||
      terminalType === 'model.reasoning_completed' ||
      terminalType === 'model.text_delta'
    ) {
      return (
        ((terminalType === 'model.reasoning_delta' && event.type === 'model.reasoning_delta') ||
          (terminalType === 'model.reasoning_completed' &&
            event.type === 'model.reasoning_completed') ||
          (terminalType === 'model.text_delta' && event.type === 'model.text_delta')) &&
        event.requestId === invocationId
      );
    }
    if (terminalType === 'model.retry') {
      return event.type === 'model.retry' && event.invocationId === invocationId;
    }
    if (terminalType === 'model.invocation_completed') {
      return event.type === 'model.invocation_completed' && event.invocationId === invocationId;
    }
    return (
      terminalType === 'model.invocation_interrupted' &&
      event.type === 'model.invocation_interrupted' &&
      event.invocationId === invocationId
    );
  }
  if (terminalType === 'model.invocation_interrupted') {
    return (
      (event.type === 'resource_budget.released' || event.type === 'resource_budget.unknown') &&
      invocation?.budget.kind === 'reservation' &&
      event.reservationId === invocation.budget.reservationId
    );
  }
  if (terminalType !== 'model.invocation_completed') return false;
  switch (event.type) {
    case 'model.responded':
      return event.invocationId === invocationId;
    case 'tool.queued':
      return event.modelInvocationId === invocationId;
    case 'model.context_metrics':
    case 'model.cache_metrics':
      return true;
    case 'resource_budget.reconciled':
      return (
        invocation?.budget.kind === 'reservation' &&
        event.reservationId === invocation.budget.reservationId
      );
    default:
      return false;
  }
}

/**
 * A user control event may advance the global State revision while an exact
 * Model invocation is already dispatching. Preserve only that invocation's
 * retry or terminal evidence; preparation and attempt-start remain fenced to
 * the original revision so a stale Model Surface can never begin dispatch.
 */
export function isConcurrentModelEffectBatchCurrent(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentity,
  events: readonly RuntimeEvent[],
  occurredAtForEvent: (index: number) => string,
): boolean {
  const invocationId = modelInvocationIdForConcurrentBatch(state, lease, events);
  if (!invocationId) return false;
  const terminalType = events[0]!.type;
  let projectedState = state;
  for (const [index, event] of events.entries()) {
    if (!isConcurrentModelEffectEvent(projectedState, event, invocationId, terminalType, index)) {
      return false;
    }
    const occurredAt = occurredAtForEvent(index);
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return false;
    const canonicalEvent = normalizeAgentEvent(event, projectedState, occurredAt);
    projectedState = reduce(projectedState, [canonicalEvent]);
  }
  const terminal = events[0];
  const projectedInvocation = projectedState.modelInvocations[invocationId];
  if (terminal?.type === 'model.invocation_completed') {
    return projectedInvocation?.status === 'completed';
  }
  if (terminal?.type === 'model.invocation_interrupted') {
    return projectedInvocation?.status === 'interrupted';
  }
  return (
    terminal?.type === 'model.retry' ||
    terminal?.type === 'model.reasoning_delta' ||
    terminal?.type === 'model.reasoning_completed' ||
    terminal?.type === 'model.text_delta'
  );
}
